"""OpenRouter: an OpenAI-compatible gateway with per-model capabilities."""

from __future__ import annotations

from ..types import ModelSpec, ProviderSpec
from .openai_compat import OpenAICompatibleProvider


class OpenRouterProvider(OpenAICompatibleProvider):
    spec = ProviderSpec(
        id='openrouter',
        label_key='workspace.provider.openrouter',
        notes_key='workspace.providerNote.openrouter',
        protocol='openai',
        base_url='https://openrouter.ai/api/v1',
        models=(
            ModelSpec('openai/gpt-4o-mini', 'GPT-4o mini', 128000, frozenset({'tools', 'vision', 'title', 'thinking'})),
            ModelSpec(
                'anthropic/claude-3.5-sonnet',
                'Claude 3.5 Sonnet',
                200000,
                frozenset({'tools', 'vision', 'title', 'thinking'}),
            ),
        ),
        capabilities=frozenset({'tools', 'vision', 'title', 'thinking'}),
    )

    def endpoint(self, request: dict) -> str:
        return f'{str(request.get("base_url") or self.spec.base_url).rstrip("/")}/chat/completions'

    def headers(self, request: dict) -> dict:
        headers = super().headers(request)
        host = str(request.get('host') or '').strip()
        if host:
            headers['HTTP-Referer'] = host
            headers['X-Title'] = host
        return headers
