"""The one provider catalog. Row analyzers, the workspace and plugins all ask here.

A catalog entry is a promise: a transport declares only the capabilities it actually carries, and a
request for an undeclared capability is refused by name. Installing a machine-wide contribution is
different from using one: a contribution remembered by an account may not be called by another.
"""

from __future__ import annotations

from ..errors import AIError, refused
from .base import Provider
from .complete import CompleteProvider
from .deepseek import DeepSeekProvider
from .ollama import OllamaProvider
from .openai_compat import OpenAICompatibleProvider
from .opencode_go import OpenCodeGoProvider
from .openrouter import OpenRouterProvider

BUILTIN_TRANSPORTS = (
    DeepSeekProvider,
    OpenCodeGoProvider,
    OpenRouterProvider,
    OllamaProvider,
    OpenAICompatibleProvider,
    CompleteProvider,
)
BUILTIN_IDS = frozenset(factory().spec.id for factory in BUILTIN_TRANSPORTS)


def local_transport_refusal(provider_id: str, translator=None) -> AIError:
    """The one named refusal for a local transport on a cloud host."""
    message = (
        translator.t('workspace.provider.localCloud', provider=provider_id)
        if translator
        else f'local provider {provider_id} is unavailable on a cloud host'
    )
    return AIError(message, kind='capability', key='provider.localCloud', reason=provider_id)


class ProviderCatalog:
    def __init__(self, settings, host, scopes=None):
        self.settings = settings
        self.host = host
        self.scopes = scopes
        self._providers: dict[str, Provider] = {}
        for factory in BUILTIN_TRANSPORTS:
            self.register(factory())

    # ── registry ──────────────────────────────────────────────────────────────

    def register(self, provider: Provider, *, owner: str = '') -> None:
        identifier = provider.spec.id
        # A plugin may not shadow a built-in transport, and two installed packs may not mint the
        # same id. Refuse before registering anything rather than silently replacing an entry.
        if identifier in self._providers and identifier in BUILTIN_IDS:
            raise AIError(
                f'provider.builtinConflict: {identifier}',
                kind='refused',
                key='provider.builtinConflict',
                reason=identifier,
            )
        if identifier in self._providers:
            raise AIError(
                f'provider.duplicate: {identifier}', kind='refused', key='provider.duplicate', reason=identifier
            )
        provider.settings = self.settings
        self._providers[identifier] = provider
        if owner and self.scopes is not None:
            self.scopes.remember(identifier, owner)

    def unregister(self, provider_id: str) -> None:
        self._providers.pop(provider_id, None)
        if self.scopes is not None:
            self.scopes.forget(provider_id)

    def get(self, provider_id: str, account: str = '', *, check_scope: bool = True) -> Provider | None:
        provider = self._providers.get(provider_id)
        if provider is None:
            return None
        if check_scope and account and self.scopes is not None:
            if not self.scopes.visible(provider_id, account):
                raise refused('provider.unknown', provider_id)
        return provider

    def require(self, provider_id: str, account: str = '') -> Provider:
        """The calling form that refuses by name instead of returning ``None``."""
        provider = self.get(provider_id, account)
        if provider is None:
            raise refused('provider.unknown', provider_id)
        return provider

    def default_id(self) -> str:
        configured = str(self.settings.get('chat.default_provider', '') or '')
        if configured in self._providers:
            return configured
        for identifier, provider in self._providers.items():
            if not provider.spec.local_only:
                return identifier
        return next(iter(self._providers), '')

    def default_model(self, provider_id: str, api_key: str = '', host: str = '') -> str:
        provider = self.get(provider_id)
        if provider is None:
            return ''
        if provider.spec.models:
            return provider.spec.models[0].id
        try:
            models = provider.list_models(api_key, host)
        except Exception:
            return ''
        return str(models[0].get('id') or '') if models else ''

    def ids(self) -> list[str]:
        return list(self._providers)

    def public(self) -> list[dict]:
        return [provider.public() for provider in self._providers.values()]

    def supports(self, provider_id: str, capability: str, model: str = '') -> bool:
        provider = self.get(provider_id)
        return bool(provider and provider.supports(capability, model))

    def list_models(self, provider_id: str, api_key: str = '', host: str = '') -> list[dict]:
        provider = self.get(provider_id)
        if provider is None:
            return []
        return provider.list_models(api_key, host)

    def available(self, account: str = '', scopes=None) -> list[dict]:
        """Catalog rows filtered by host capability and account scope, with named explanations."""
        scopes = scopes if scopes is not None else self.scopes
        cloud = self.host.environment().cloud
        rows = []
        for provider in self._providers.values():
            if scopes is not None and not scopes.visible(provider.spec.id, account):
                continue
            row = provider.public()
            if provider.spec.local_only and cloud:
                row['available'] = False
                row['why_not'] = 'provider.localCloud'
                row['why_not_text'] = (
                    local_transport_refusal(provider.spec.id, self.host.i18n()).message
                    if hasattr(self.host, 'i18n')
                    else local_transport_refusal(provider.spec.id).message
                )
            else:
                row['available'] = True
                row['why_not'] = ''
            rows.append(row)
        return rows

    # ── one-shot analyzer path ────────────────────────────────────────────────

    def chat_once(
        self,
        provider_id: str,
        model: str,
        api_key: str,
        prompt: str,
        *,
        max_tokens: int = 512,
        timeout: int = 180,
        host: str = '',
        system: str = '',
        temperature: float = 0.1,
        account: str = '',
    ) -> str:
        """One non-streaming prompt, no conversation rows and no tool round.

        Row analyzers (cleaner, emotion, tendency, NER, topic labels) send one prompt per row. They
        must use this same catalog or a run could claim DeepSeek while a table silently used a
        different provider. The returned text is stripped; an empty completion is a named refusal.
        """
        provider = self.require(provider_id, account)
        chosen = (model or '').strip() or (provider.spec.models[0].id if provider.spec.models else '')
        pieces: list[str] = []
        for item in provider.stream(
            {
                'model': chosen,
                'api_key': api_key,
                'system': system,
                'messages': [{'role': 'user', 'content': prompt}],
                'tools': [],
                'thinking': False,
                'web_search': False,
                'safety': 'high',
                'title': False,
                'max_tokens': max(1, int(max_tokens)),
                'temperature': temperature,
                'timeout': max(10, int(timeout)),
                'cancel_event': None,
                'host': host,
            }
        ):
            if item.get('type') == 'text_delta':
                pieces.append(str(item.get('text') or ''))
            elif item.get('type') == 'done':
                break
        text = ''.join(pieces).strip()
        if not text:
            raise AIError('ai.badResponse', kind='bad_response', key='ai.badResponse', detail='empty completion')
        return text
