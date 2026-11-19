"""A deterministic, network-free provider for tests, demos and offline hosts.

It emits the same canonical events as a real transport, so the agent loop can be exercised without
a key or a daemon. It is not a language model: it quotes the last user message and, when tools are
offered, calls the first one with empty arguments — a test can drive a whole tool round from here.
"""

from __future__ import annotations

from ..types import ModelSpec, ProviderSpec
from .base import Provider, check_cancel, event


class CompleteProvider(Provider):
    spec = ProviderSpec(
        id='complete',
        label_key='workspace.provider.complete',
        notes_key='workspace.providerNote.complete',
        protocol='complete',
        base_url='',
        models=(ModelSpec('complete', 'Offline echo', 32000, frozenset({'tools', 'ask_user', 'title'})),),
        requires_key=False,
        capabilities=frozenset({'tools', 'ask_user', 'title'}),
    )

    def stream(self, request: dict):
        check_cancel(request.get('cancel_event'))
        yield event('meta', provider=self.spec.id, model='complete')
        messages = request.get('messages') or []
        last = ''
        for message in reversed(messages):
            if message.get('role') == 'user':
                last = str(message.get('content') or '')
                break
        tools = request.get('tools') or []
        control = {'ask_user_question', 'update_plan', 'present_artifact', 'request_approval'}
        domain_tool = next((item for item in tools if item.get('name') not in control), None)
        if domain_tool and str(request.get('tool_mode') or '') == 'call':
            yield event('tool_call', id='call_offline_1', name=domain_tool['name'], arguments={})
        else:
            for chunk in [last[i : i + 120] for i in range(0, len(last), 120)] or ['（空消息）']:
                yield event('text_delta', text=chunk)
        if request.get('title') and last:
            yield event('title', text=last[:40])
        yield event(
            'usage',
            usage={
                'prompt_tokens': 0,
                'completion_tokens': 0,
                'cached_tokens': 0,
                'reasoning_tokens': 0,
                'total_tokens': 0,
            },
        )
        yield event('done', stop_reason='end_turn')
