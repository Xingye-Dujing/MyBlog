"""OpenAI Chat Completions transport — the base for most providers."""

from __future__ import annotations

import json

from ..types import ModelSpec, ProviderSpec, usage_totals
from ..util import iter_sse_frames
from .base import Provider, check_cancel, event, open_stream

THINKING_KEYS = ('reasoning_content', 'reasoning', 'reasoning_text')


def with_reasoning(messages: list) -> list:
    """DeepSeek rejects a tool round unless prior assistant reasoning is echoed back."""
    out = []
    for message in messages:
        row = dict(message)
        if row.get('role') == 'assistant':
            reasoning = str((row.get('meta') or {}).get('reasoning_content') or '')
            if reasoning and not any(row.get(key) for key in THINKING_KEYS):
                row['reasoning_content'] = reasoning
        out.append(row)
    return out


class OpenAICompatibleProvider(Provider):
    spec = ProviderSpec(
        id='openai_compat',
        label_key='workspace.provider.openai_compat',
        notes_key='workspace.providerNote.openai_compat',
        protocol='openai',
        base_url='',
        models=(ModelSpec('gpt-4o-mini', 'gpt-4o-mini'), ModelSpec('gpt-4o', 'gpt-4o')),
        capabilities=frozenset({'tools', 'ask_user', 'vision', 'title'}),
    )

    def endpoint(self, request: dict) -> str:
        base = str(request.get('base_url') or self.spec.base_url or '').rstrip('/')
        return f'{base}/chat/completions' if base else ''

    def build_payload(self, request: dict) -> dict:
        messages = with_reasoning(request.get('messages') or [])
        system = str(request.get('system') or '')
        if system:
            messages = [{'role': 'system', 'content': system}, *messages]
        payload: dict = {
            'model': request.get('model') or self.spec.models[0].id,
            'messages': messages,
            'stream': True,
        }
        tools = request.get('tools') or []
        if tools:
            formatted = []
            for tool in tools:
                schema = tool.get('input_schema') or tool.get('parameters') or {}
                formatted.append(
                    {
                        'type': 'function',
                        'function': {
                            'name': tool['name'],
                            'description': tool.get('description', ''),
                            'parameters': schema,
                        },
                    }
                )
            payload['tools'] = formatted
            payload['tool_choice'] = 'auto'
        if request.get('thinking') and self.supports('thinking', str(request.get('model') or '')):
            self.apply_thinking(payload, request)
        if 'temperature' in request and request['temperature'] is not None:
            payload['temperature'] = request['temperature']
        if request.get('max_tokens'):
            payload['max_tokens'] = int(request['max_tokens'])
        payload['stream_options'] = {'include_usage': True}
        return payload

    def apply_thinking(self, payload: dict, request: dict) -> None:
        effort = str(request.get('reasoning_effort') or 'high')
        payload['reasoning_effort'] = effort

    def headers(self, request: dict) -> dict:
        return {'Authorization': f'Bearer {request.get("api_key") or ""}', 'Content-Type': 'application/json'}

    def stream(self, request: dict):
        endpoint = self.endpoint(request)
        if not endpoint:
            from ..errors import AIError

            raise AIError('provider.noEndpoint', kind='capability', reason=self.spec.id)
        check_cancel(request.get('cancel_event'))
        response = open_stream(
            endpoint,
            self.headers(request),
            self.build_payload(request),
            int(request.get('timeout') or 120),
            request.get('cancel_event', None),
        )
        yield event('meta', provider=self.spec.id, model=request.get('model') or self.spec.models[0].id)
        yield from self.decode(response, request.get('cancel_event'))

    def decode(self, response, cancel_event=None):
        """Decode OpenAI-style frames into canonical events."""
        calls: dict[int, dict] = {}
        thinking_parts: list[str] = []
        usage: dict = {}
        stop_reason = 'end_turn'
        for _kind, payload in iter_sse_frames(
            (chunk for chunk in response.iter_content(chunk_size=1024)), cancel_event
        ):
            check_cancel(cancel_event)
            if payload.get('usage'):
                usage.update(payload['usage'])
            choices = payload.get('choices') or []
            if not choices:
                for server_tool in payload.get('server_tool_calls') or []:
                    yield event('server_tool', name=str(server_tool.get('type') or ''), payload=server_tool)
                continue
            delta = choices[0].get('delta') or {}
            for key in THINKING_KEYS:
                if delta.get(key):
                    thinking_parts.append(str(delta[key]))
                    yield event('thinking_delta', text=str(delta[key]))
            if delta.get('content'):
                yield event('text_delta', text=str(delta['content']))
            if delta.get('refusal'):
                yield event('refusal', text=str(delta['refusal']))
            for server_tool in delta.get('server_tool_calls') or []:
                yield event('server_tool', name=str(server_tool.get('type') or ''), payload=server_tool)
            for tool_delta in delta.get('tool_calls') or []:
                index = int(tool_delta.get('index') or 0)
                row = calls.setdefault(index, {'id': '', 'name': '', 'arguments': ''})
                row['id'] = str(tool_delta.get('id') or row['id'])
                function = tool_delta.get('function') or {}
                row['name'] = str(function.get('name') or row['name'])
                row['arguments'] += str(function.get('arguments') or '')
            finish = choices[0].get('finish_reason')
            if finish:
                stop_reason = str(finish)
        for index in sorted(calls):
            row = calls[index]
            try:
                arguments = json.loads(row['arguments'] or '{}')
            except ValueError:
                arguments = {}
            yield event('tool_call', id=row['id'], name=row['name'], arguments=arguments)
        if thinking_parts:
            yield event('thinking', text=''.join(thinking_parts))
        if usage:
            yield event('usage', usage=usage_totals(usage))
        metadata = {'stop_reason': stop_reason}
        if thinking_parts:
            metadata['reasoning_content'] = ''.join(thinking_parts)
        yield event('done', **metadata)
