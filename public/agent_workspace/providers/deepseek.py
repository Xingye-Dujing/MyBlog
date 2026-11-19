"""DeepSeek's native Chat Completions protocol.

DeepSeek is NOT an Anthropic-compatible transport: thinking is an explicit enabled/disabled object,
the strength is ``reasoning_effort``, thought text arrives in ``delta.reasoning_content``, and a
tool round must echo the previous step's reasoning or the API answers 400. Server-side search tools
come through ``delta.server_tool_event`` and a final complete ``delta.server_tool_calls`` frame;
citations arrive in ``delta.annotations``. The published prices make ``cost()`` a real estimate — a
missing price is reported as unknown, never invented.
"""

from __future__ import annotations

import json

import requests

from ..errors import AIProviderError
from ..types import ModelSpec, ProviderSpec, usage_totals
from .base import check_cancel, event, http_error, read_json_error
from .openai_compat import OpenAICompatibleProvider

#: DeepSeek's published price per 1M tokens, in CNY — cache hit / cache miss / output.
PRICES = {
    'deepseek-chat': {'currency': 'CNY', 'cache_hit': 0.5, 'cache_miss': 2.0, 'output': 8.0},
    'deepseek-reasoner': {'currency': 'CNY', 'cache_hit': 0.5, 'cache_miss': 2.0, 'output': 8.0},
}

EFFORTS = {'low': 'low', 'high': 'high', 'max': 'high'}

STOP_REASONS = {
    'stop': 'end_turn',
    'end_turn': 'end_turn',
    'length': 'max_tokens',
    'max_tokens': 'max_tokens',
    'tool_calls': 'tool_calls',
    'content_filter': 'refusal',
}

CAPABILITIES = frozenset(
    {
        'tools',
        'ask_user',
        'title',
        'web_search',
        'read_url',
        'files',
        'safety',
        'latest_reminder',
    }
)


class DeepSeekProvider(OpenAICompatibleProvider):
    spec = ProviderSpec(
        id='deepseek',
        label_key='workspace.provider.deepseek',
        notes_key='workspace.providerNote.deepseek',
        protocol='deepseek',
        base_url='https://api.deepseek.com/chat/completions',
        models=(
            ModelSpec('deepseek-chat', 'deepseek-chat', 65536, CAPABILITIES - {'latest_reminder'}),
            ModelSpec(
                'deepseek-reasoner',
                'deepseek-reasoner',
                65536,
                CAPABILITIES - {'files', 'safety', 'latest_reminder'} | {'thinking'},
            ),
        ),
        capabilities=CAPABILITIES,
        models_url='https://api.deepseek.com/models',
    )

    # ── request ───────────────────────────────────────────────────────────────

    def endpoint(self, request: dict) -> str:
        return str(request.get('base_url') or self.spec.base_url)

    def headers(self, request: dict) -> dict:
        return {
            'Authorization': f'Bearer {request.get("api_key") or ""}',
            'Content-Type': 'application/json',
            'User-Agent': 'AgentWorkspace-AI/1.0',
        }

    def build_payload(self, request: dict) -> dict:
        model = str(request.get('model') or self.spec.models[0].id)
        thinking = bool(request.get('thinking')) and self.supports('thinking', model)
        payload = super().build_payload(request)
        # Thinking is opt-in and must be sent explicitly both ways: omitted, the API enables it by
        # default and the user pays for tokens they did not ask for.
        payload['thinking'] = {'type': 'enabled' if thinking else 'disabled'}
        payload.pop('reasoning_effort', None)
        if thinking:
            payload['reasoning_effort'] = EFFORTS.get(str(request.get('reasoning_effort') or 'high').lower(), 'high')
        # Thinking mode ignores temperature; sending it there only misleads about what was honoured.
        temperature = request.get('temperature')
        if temperature is not None and not thinking:
            payload['temperature'] = max(0.0, min(2.0, float(temperature)))
        else:
            payload.pop('temperature', None)
        payload['max_tokens'] = max(1, int(request.get('max_tokens') or 8192))
        server = []
        if request.get('web_search') and self.supports('web_search', model):
            server.append({'type': 'deepseek_web_search'})
            # Fetch is part of the search promise; never send it when search was turned off.
            if self.supports('read_url', model):
                server.append({'type': 'deepseek_read_url'})
        if request.get('safety') and self.supports('safety', model):
            payload['safety_check'] = {'level': str(request.get('safety') or 'high')}
        if request.get('title') and self.supports('title', model):
            payload['title'] = {'enabled': True}
        user_id = str(request.get('user_id') or '')
        if user_id:
            payload['user_id'] = user_id
        if server:
            payload['tools'] = [*payload.get('tools', []), *server]
            payload.setdefault('tool_choice', 'auto')
        return payload

    # ── stream decode ─────────────────────────────────────────────────────────

    def decode(self, response, cancel_event=None):
        from ..util import iter_sse_frames

        calls: dict[int, dict] = {}
        thinking_parts: list[str] = []
        usage: dict = {}
        stop_reason = 'end_turn'
        server_calls: list = []
        citations: list = []
        try:
            for _kind, payload in iter_sse_frames(
                (chunk for chunk in response.iter_content(chunk_size=1024)), cancel_event
            ):
                check_cancel(cancel_event)
                # A generation can fail AFTER the first byte: the stream then ends with a chunk that
                # carries `error` and no choices, and never sends [DONE]. Report it, never a blank.
                if payload.get('error'):
                    detail = payload['error']
                    detail = detail.get('message') if isinstance(detail, dict) else str(detail)
                    raise AIProviderError('ai.server', kind='network', detail=str(detail or '')[:300])
                if payload.get('usage'):
                    usage.update(payload['usage'])
                choices = payload.get('choices') or []
                if not choices:
                    continue
                choice = choices[0]
                delta = choice.get('delta') or {}
                if delta.get('reasoning_content'):
                    text = str(delta['reasoning_content'])
                    thinking_parts.append(text)
                    yield event('thinking_delta', text=text)
                if delta.get('content'):
                    yield event('text_delta', text=str(delta['content']))
                if delta.get('refusal'):
                    yield event('refusal', text=str(delta['refusal']))
                if delta.get('server_tool_event'):
                    yield event(
                        'server_tool',
                        name=str(delta['server_tool_event'].get('type') or ''),
                        payload=delta['server_tool_event'],
                    )
                if delta.get('server_tool_calls'):
                    server_calls = list(delta['server_tool_calls'])
                if delta.get('annotations'):
                    citations = list(delta['annotations'])
                    for annotation in citations:
                        yield event('citation', payload=annotation)
                if delta.get('title'):
                    yield event('title', text=str(delta['title']))
                for tool_delta in delta.get('tool_calls') or []:
                    index = int(tool_delta.get('index') or 0)
                    row = calls.setdefault(index, {'id': '', 'name': '', 'arguments': ''})
                    row['id'] = str(tool_delta.get('id') or row['id'])
                    function = tool_delta.get('function') or {}
                    row['name'] += str(function.get('name') or '')
                    row['arguments'] += str(function.get('arguments') or '')
                if choice.get('finish_reason'):
                    stop_reason = STOP_REASONS.get(str(choice['finish_reason']), str(choice['finish_reason']))
        finally:
            close = getattr(response, 'close', None)
            if close is not None:
                close()

        for block in self._replay_blocks(server_calls):
            yield event('server_tool', block=block)
        for index in sorted(calls):
            row = calls[index]
            try:
                arguments = json.loads(row['arguments'] or '{}')
            except ValueError:
                arguments = None
            # Half a JSON document is what a stream cut by max_tokens leaves. Tell the turn it was
            # truncated instead of silently running a tool with `{}`.
            usable = isinstance(arguments, dict)
            yield event(
                'tool_call',
                id=row['id'],
                name=row['name'],
                arguments=arguments if usable else {},
                raw_arguments=row['arguments'],
                parse_error=None if usable else 'truncated_arguments',
            )
        if thinking_parts:
            yield event('thinking', text=''.join(thinking_parts))
        if usage:
            yield event('usage', usage=usage_totals(usage))
        metadata = {'stop_reason': stop_reason}
        if thinking_parts:
            metadata['reasoning_content'] = ''.join(thinking_parts)
        yield event('done', **metadata)

    @staticmethod
    def _replay_blocks(server_calls: list) -> list[dict]:
        """Keep the search result with the signature the API gave it, so a tool round can echo it."""
        blocks = []
        for item in server_calls or ():
            entry = dict(item or {})
            if not isinstance(entry.get('signature'), str):
                entry['signature'] = ''
            blocks.append(entry)
        return blocks

    # ── account facts ─────────────────────────────────────────────────────────

    def list_models(self, api_key: str = '', host: str = '') -> list[dict]:
        url = str(host or 'https://api.deepseek.com/models').rstrip('/')
        try:
            response = requests.get(url, headers=self.headers({'api_key': api_key}), timeout=10)
        except requests.RequestException as exc:
            raise AIProviderError('ai.network', kind='network', detail=str(exc)[:300]) from exc
        if response.status_code != 200:
            raise http_error(response.status_code, read_json_error(response))
        try:
            rows = (response.json() or {}).get('data') or []
        except ValueError as exc:
            raise AIProviderError('ai.badResponse', kind='bad_response') from exc
        known = {model.id for model in self.spec.models}
        models = []
        for row in rows:
            identifier = str((row or {}).get('id') or '')
            if identifier:
                models.append(
                    {'id': identifier, 'label': str((row or {}).get('id') or identifier), 'known': identifier in known}
                )
        return models or super().list_models(api_key, host)

    def balance(self, api_key: str = '') -> dict | None:
        try:
            response = requests.get(
                'https://api.deepseek.com/user/balance', headers=self.headers({'api_key': api_key}), timeout=10
            )
        except requests.RequestException as exc:
            raise AIProviderError('ai.network', kind='network', detail=str(exc)[:300]) from exc
        if response.status_code != 200:
            raise http_error(response.status_code, read_json_error(response))
        try:
            data = response.json() or {}
        except ValueError as exc:
            raise AIProviderError('ai.badResponse', kind='bad_response') from exc
        return {
            'available': bool(data.get('is_available', True)),
            'balances': data.get('balance_infos') or [],
            'currency': 'CNY',
        }

    def cost(self, model: str = '', prompt: int = 0, completion: int = 0, cached: int = 0) -> dict | None:
        price = PRICES.get(model)
        if not price:
            return None
        cache_hit = int(cached or 0)
        cache_miss = max(0, int(prompt or 0) - cache_hit)
        amount = (
            cache_hit * price['cache_hit'] + cache_miss * price['cache_miss'] + int(completion or 0) * price['output']
        ) / 1_000_000
        return {'amount': round(amount, 8), 'currency': price['currency']}
