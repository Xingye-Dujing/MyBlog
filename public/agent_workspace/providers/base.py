"""Shared transport plumbing: HTTP, SSE framing, cancellation, context replay and error mapping."""

from __future__ import annotations

import time

import requests

from ..errors import AIError, AIProviderError
from ..types import ProviderSpec

#: The wrapper the model reads as "facts about the project", not as something the user typed.
CONTEXT_OPEN = '<workspace_context>'
CONTEXT_CLOSE = '</workspace_context>'


def event(kind: str, **data) -> dict:
    return {'type': kind, **data}


def replay_context(messages: list) -> list:
    """Put every turn's own context on that turn's own user row, byte-for-byte.

    The context is produced once and stored on the user row's ``meta.context_text``. Keeping those
    bytes unchanged is the whole point: a provider's prefix cache matches bytes, so a block that
    disappears after round one invalidates every later message.
    """
    out = []
    for message in messages:
        stored = str((message.get('meta') or {}).get('context_text') or '') if message.get('role') == 'user' else ''
        content = str(message.get('content') or '')
        if not stored or content.startswith(CONTEXT_OPEN):
            out.append(message)
            continue
        target = dict(message)
        target['content'] = f'{CONTEXT_OPEN}\n{stored}\n{CONTEXT_CLOSE}\n\n{content}'
        out.append(target)
    return out


def check_cancel(cancel_event) -> None:
    if cancel_event is not None and getattr(cancel_event, 'is_set', lambda: False)():
        raise AIError('ai.cancelled', kind='cancelled')


def http_error(status: int, body: str = '') -> AIProviderError:
    text = (body or '')[:400]
    if status in (401, 403):
        return AIProviderError('ai.unauthorized', kind='auth', status=status, detail=text)
    if status == 402:
        return AIProviderError('ai.quota', kind='quota', status=status, detail=text)
    if status == 404:
        return AIProviderError('ai.modelMissing', kind='model', status=status, detail=text)
    if status == 429:
        return AIProviderError('ai.rateLimit', kind='rate_limit', status=status, detail=text)
    if status in (400, 413):
        return AIProviderError('ai.badRequest', kind='bad_request', status=status, detail=text)
    if status >= 500:
        return AIProviderError('ai.server', kind='network', status=status, detail=text)
    return AIProviderError('ai.http', kind='error', status=status, detail=text)


def read_json_error(response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return (response.text or '')[:400]
    error = payload.get('error') if isinstance(payload, dict) else None
    if isinstance(error, dict):
        return str(error.get('message') or error.get('code') or error)[:400]
    return str(error or payload)[:400]


def _nap(cancel_event, seconds: float) -> bool:
    if cancel_event is not None and hasattr(cancel_event, 'wait'):
        cancel_event.wait(seconds)
        return bool(cancel_event.is_set())
    time.sleep(seconds)
    return False


def open_stream(url: str, headers: dict, payload: dict, timeout: int, cancel_event, retries: int = 3):
    """POST a JSON body and return a streaming response.

    Retry only BEFORE the first byte is handed to the caller: once a stream starts, a retry would
    duplicate the answer. 429/5xx and dropped connections are retried with an interruptible backoff;
    auth/model/quota failures are deterministic and raise immediately.
    """
    last: AIProviderError | None = None
    for attempt in range(1, retries + 1):
        check_cancel(cancel_event)
        try:
            response = requests.post(
                url,
                headers={'Accept': 'text/event-stream', **headers},
                json=payload,
                stream=True,
                timeout=(10, timeout),
            )
        except requests.RequestException as exc:
            last = AIProviderError('ai.network', kind='network', detail=str(exc)[:300])
            if attempt < retries and not _nap(cancel_event, 0.8 * attempt):
                continue
            raise last from exc
        if response.status_code == 200:
            return response
        body = read_json_error(response)
        response.close()
        error = http_error(response.status_code, body)
        if error.kind in ('rate_limit', 'network') and attempt < retries:
            last = error
            if not _nap(cancel_event, 1.2 * attempt):
                continue
        raise error
    raise last or AIProviderError('ai.network', kind='network')


class Provider:
    """A transport plus its declared capabilities."""

    spec: ProviderSpec

    def stream(self, request: dict):
        raise NotImplementedError

    def list_models(self, api_key: str = '', host: str = '') -> list[dict]:
        return [{'id': model.id, 'label': model.label or model.id} for model in self.spec.models]

    def balance(self, api_key: str = '') -> dict | None:
        """The provider's own published balance, or ``None`` when it has no such endpoint."""
        return None

    def cost(self, model: str = '', prompt: int = 0, completion: int = 0, cached: int = 0) -> dict | None:
        """Estimated cost in the provider's own prices, or ``None`` when unpublished."""
        return None

    def supports(self, capability: str, model: str = '') -> bool:
        return self.spec.supports(capability, model)

    def context_window(self, model: str = '') -> int:
        spec = self.spec.model(model)
        return int(spec.max_context or 0) if spec else 0

    def public(self) -> dict:
        return self.spec.to_public()
