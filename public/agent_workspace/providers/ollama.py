"""Local Ollama transport: per-model capabilities, real context length and tool round-tripping.

Ollama serves newline-delimited JSON rather than SSE and answers with ``message.tool_calls`` on a
tool round. What belongs to the daemon — which models exist, what each can do, and how much context
a pulled tag was built with — is asked of the daemon, never hardcoded. ``/api/tags`` and ``/api/show``
answers are cached briefly so a turn does not pay for the same local call twice, and a machine with
no daemon does not pay a socket timeout on every bootstrap.
"""

from __future__ import annotations

import json
import threading
import time

import requests

from ..errors import AIProviderError
from ..types import ModelSpec, ProviderSpec, usage_totals
from ..util import iter_utf8_lines
from .base import Provider, check_cancel, event, open_stream

OLLAMA_CAPABILITIES = frozenset({'tools', 'thinking'})
MAX_NUM_CTX = 32768
CATALOG_TTL = 20.0
INFO_TTL = 300.0
PROBE_TIMEOUT = 1.0

_LOCK = threading.Lock()
_CATALOG: dict[str, tuple[float, list[dict]]] = {}
_INFO: dict[str, tuple[float, dict]] = {}


class OllamaProvider(Provider):
    spec = ProviderSpec(
        id='ollama',
        label_key='workspace.provider.ollama',
        notes_key='workspace.providerNote.ollama',
        protocol='ollama',
        base_url='http://localhost:11434',
        models=(ModelSpec('qwen3.5:9b', 'qwen3.5:9b', MAX_NUM_CTX, OLLAMA_CAPABILITIES),),
        requires_key=False,
        local_only=True,
        capabilities=OLLAMA_CAPABILITIES,
    )

    # The registry injects the host's settings so a daemon-address change needs no restart.
    settings = None

    # ── daemon facts ──────────────────────────────────────────────────────────

    def _configured_host(self) -> str:
        try:
            return str((self.settings.get('ollama.host', '') if self.settings else '') or '')
        except (AttributeError, KeyError):
            return ''

    def _base(self, request_or_host=None) -> str:
        raw = ''
        if isinstance(request_or_host, dict):
            raw = str(request_or_host.get('host') or '')
        elif request_or_host:
            raw = str(request_or_host)
        raw = (raw or self._configured_host() or str(self.spec.base_url)).strip().rstrip('/')
        if not raw.startswith(('http://', 'https://')):
            raw = 'http://' + raw
        return raw

    def _catalog(self, host: str = '') -> list[dict]:
        base = self._base(host)
        now = time.monotonic()
        with _LOCK:
            hit = _CATALOG.get(base)
            if hit and hit[0] > now:
                return hit[1]
        try:
            response = requests.get(base + '/api/tags', timeout=PROBE_TIMEOUT)
            response.raise_for_status()
            rows = (response.json() or {}).get('models') or []
        except (requests.RequestException, ValueError, AttributeError):
            with _LOCK:
                _CATALOG[base] = (now + CATALOG_TTL, [])
            return []
        models = []
        for row in rows:
            name = str((row or {}).get('name') or (row or {}).get('model') or '')
            if not name or 'embed' in name.lower():
                continue
            models.append({'id': name, 'label': name})
        with _LOCK:
            _CATALOG[base] = (now + CATALOG_TTL, models)
        return models

    def _cached_catalog(self) -> list[dict]:
        base = self._base()
        with _LOCK:
            hit = _CATALOG.get(base)
        return hit[1] if hit else []

    def _info(self, model: str, host: str = '') -> dict:
        base = self._base(host)
        key = base + '|' + str(model or '')
        now = time.monotonic()
        with _LOCK:
            hit = _INFO.get(key)
            if hit and hit[0] > now:
                return hit[1]
        info: dict = {}
        try:
            response = requests.post(base + '/api/show', json={'name': model}, timeout=PROBE_TIMEOUT)
            if response.status_code == 200:
                payload = response.json() or {}
                caps = payload.get('capabilities')
                info['capabilities'] = [str(item) for item in caps] if isinstance(caps, list) else []
                context = 0
                for name, value in (payload.get('modelinfo') or {}).items():
                    if str(name).endswith('context_length') and isinstance(value, int) and value > context:
                        context = value
                info['context'] = context
        except (requests.RequestException, ValueError, AttributeError, TypeError):
            info = {}
        with _LOCK:
            _INFO[key] = (now + INFO_TTL, info)
        return info

    def supports(self, capability: str, model: str = '') -> bool:
        if capability in ('tools', 'thinking') and model:
            caps = self._info(model).get('capabilities') or []
            return capability in caps
        return capability in self.spec.capabilities

    def context_window(self, model: str = '') -> int:
        context = int(self._info(model).get('context') or 0) if model else 0
        return min(MAX_NUM_CTX, context) if context else MAX_NUM_CTX

    def public(self) -> dict:
        item = self.spec.to_public()
        models = self._cached_catalog()
        if models:
            item['models'] = [
                {**row, 'max_context': MAX_NUM_CTX, 'capabilities': sorted(self.spec.capabilities)} for row in models
            ]
        return item

    def list_models(self, api_key: str = '', host: str = '') -> list[dict]:
        return self._catalog(host) or super().list_models(api_key, host)

    # ── request ───────────────────────────────────────────────────────────────

    @staticmethod
    def _tool_schemas(tools: list) -> list[dict]:
        return [
            {
                'type': 'function',
                'function': {
                    'name': str(tool.get('name') or ''),
                    'description': str(tool.get('description') or ''),
                    'parameters': tool.get('input_schema') or {'type': 'object', 'properties': {}},
                },
            }
            for tool in tools or ()
            if tool.get('name')
        ]

    @staticmethod
    def _messages(request: dict) -> list[dict]:
        out: list[dict] = []
        if request.get('system'):
            out.append({'role': 'system', 'content': str(request['system'])})
        for message in request.get('messages') or ():
            role = str(message.get('role') or 'user')
            if role == 'assistant':
                blocks = message.get('blocks') or []
                text = ''.join(str(block.get('text') or '') for block in blocks if block.get('type') == 'text')
                calls = []
                for block in blocks:
                    if block.get('type') != 'tool_use' or not block.get('name'):
                        continue
                    arguments = block.get('input')
                    calls.append(
                        {
                            'type': 'function',
                            'function': {
                                'name': str(block['name']),
                                'arguments': arguments if isinstance(arguments, dict) else {},
                            },
                        }
                    )
                item = {'role': 'assistant', 'content': text or str(message.get('content') or '')}
                if calls:
                    item['tool_calls'] = calls
                out.append(item)
                continue
            if role == 'tool':
                block = next((item for item in message.get('blocks') or [] if item.get('type') == 'tool_result'), {})
                content = block.get('content', message.get('content'))
                out.append(
                    {
                        'role': 'tool',
                        'content': json.dumps(content, ensure_ascii=False, default=str)
                        if not isinstance(content, str)
                        else content,
                    }
                )
                continue
            out.append({'role': 'user', 'content': str(message.get('content') or '')})
        return out

    def build_payload(self, request: dict) -> dict:
        model = str(request.get('model') or (self.spec.models[0].id if self.spec.models else ''))
        temperature = request.get('temperature')
        options = {
            # A deliberate 0.0 is a real choice; only a missing value takes the default.
            'temperature': 0.2 if temperature is None else float(temperature),
            'num_ctx': self.context_window(model),
        }
        if request.get('max_tokens'):
            options['num_predict'] = int(request['max_tokens'])
        payload: dict = {'model': model, 'messages': self._messages(request), 'stream': True, 'options': options}
        tools = self._tool_schemas(request.get('tools') or ())
        if tools and self.supports('tools', model):
            payload['tools'] = tools
        # Sent both ways: a reasoning model thinks by default, so "off" must say so.
        payload['think'] = bool(request.get('thinking')) and self.supports('thinking', model)
        return payload

    def stream(self, request: dict):
        check_cancel(request.get('cancel_event'))
        base = self._base(request)
        model = str(request.get('model') or '')
        response = open_stream(
            base + '/api/chat',
            {'Content-Type': 'application/json'},
            self.build_payload(request),
            int(request.get('timeout') or 120),
            request.get('cancel_event'),
        )
        yield event('meta', provider=self.spec.id, model=model)
        calls: dict[int, dict] = {}
        usage: dict = {}
        stop_reason = 'end_turn'
        try:
            for line in iter_utf8_lines(
                (chunk for chunk in response.iter_content(chunk_size=1024)), request.get('cancel_event')
            ):
                check_cancel(request.get('cancel_event'))
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except ValueError as exc:
                    raise AIProviderError('ai.badResponse', kind='bad_response', detail=str(line)[:200]) from exc
                if frame.get('error'):
                    raise AIProviderError('ai.server', kind='network', detail=str(frame['error'])[:300])
                message = frame.get('message') or {}
                if message.get('thinking') or message.get('reasoning'):
                    yield event('thinking_delta', text=str(message.get('thinking') or message.get('reasoning')))
                if message.get('content'):
                    yield event('text_delta', text=str(message['content']))
                for call in message.get('tool_calls') or ():
                    function = (call or {}).get('function') or {}
                    arguments = function.get('arguments')
                    if isinstance(arguments, str):
                        try:
                            arguments = json.loads(arguments or '{}')
                        except ValueError:
                            arguments = {}
                    # The daemon matches results by order; keep its own id so a tool round pairs.
                    calls[len(calls)] = {
                        'id': str((call or {}).get('id') or ''),
                        'name': str(function.get('name') or ''),
                        'arguments': arguments if isinstance(arguments, dict) else {},
                    }
                prompt = int(frame.get('prompt_eval_count') or 0)
                completion = int(frame.get('eval_count') or 0)
                if prompt or completion:
                    usage = {
                        'prompt_tokens': prompt,
                        'completion_tokens': completion,
                        'total_tokens': prompt + completion,
                    }
                if frame.get('done'):
                    stop_reason = 'max_tokens' if str(frame.get('done_reason') or '') == 'length' else 'end_turn'
                    break
        finally:
            close = getattr(response, 'close', None)
            if close is not None:
                close()
        for index in sorted(calls):
            row = calls[index]
            yield event('tool_call', id=row['id'], name=row['name'], arguments=row['arguments'])
        if usage:
            yield event('usage', usage=usage_totals(usage))
        yield event('done', stop_reason=stop_reason)
