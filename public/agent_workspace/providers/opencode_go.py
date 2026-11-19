"""OpenCode Go: an OpenAI-compatible local daemon for tool-capable chat."""

from __future__ import annotations

from ..types import ModelSpec, ProviderSpec
from .openai_compat import OpenAICompatibleProvider


class OpenCodeGoProvider(OpenAICompatibleProvider):
    spec = ProviderSpec(
        id='opencode_go',
        label_key='workspace.provider.opencode_go',
        notes_key='workspace.providerNote.opencode_go',
        protocol='openai',
        base_url='http://127.0.0.1:4096/v1',
        models=(
            ModelSpec('opencode-go', 'OpenCode Go', 128000, frozenset({'tools', 'ask_user', 'vision', 'thinking'})),
        ),
        capabilities=frozenset({'tools', 'ask_user', 'vision', 'thinking'}),
    )

    def endpoint(self, request: dict) -> str:
        base = str(request.get('base_url') or self.spec.base_url).rstrip('/')
        return f'{base}/chat/completions'

    def headers(self, request: dict) -> dict:
        headers = {'Content-Type': 'application/json'}
        if request.get('api_key'):
            headers['Authorization'] = f'Bearer {request["api_key"]}'
        return headers
