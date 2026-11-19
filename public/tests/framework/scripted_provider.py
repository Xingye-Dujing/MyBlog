"""A deterministic transport used by the suite: one tool call, then an answer."""

from __future__ import annotations

from agent_workspace.providers.base import Provider, event
from agent_workspace.types import ModelSpec, ProviderSpec


class ScriptedProvider(Provider):
    spec = ProviderSpec(
        id='scripted',
        label_key='n',
        notes_key='n',
        protocol='scripted',
        base_url='',
        models=(ModelSpec('scripted', 'scripted', 32000, frozenset({'tools', 'ask_user', 'title'})),),
        requires_key=False,
        capabilities=frozenset({'tools', 'ask_user', 'title'}),
    )

    def __init__(self, tool='ping', args=None):
        self.tool = tool
        self.args = args or {}

    def stream(self, request):
        messages = request.get('messages') or []
        has_result = any(message.get('role') == 'tool' for message in messages)
        yield event('meta', provider='scripted', model='scripted')
        if not has_result:
            yield event('tool_call', id='call_1', name=self.tool, arguments=self.args)
            yield event('done', stop_reason='tool_calls')
        else:
            yield event('text_delta', text='answer after tool')
            yield event('title', text='A title')
            yield event('usage', usage={'prompt_tokens': 10, 'completion_tokens': 2})
            yield event('done', stop_reason='end_turn')
