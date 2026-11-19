"""One error type with a stable ``kind`` so every host can map it to its own HTTP/UI layer."""

from __future__ import annotations


class WorkspaceError(Exception):
    """Base error. ``kind`` is a machine code; ``message`` is a human sentence.

    ``key`` is the stable, translatable name of the failure. A host maps it to its own catalogue,
    so the same refusal reads correctly in every language without the engine guessing a sentence.
    It is optional in ``to_dict()`` so older hosts that did not know about it keep their payload.
    """

    kind = 'error'

    def __init__(self, message: str, *, kind: str = '', status: int = 0, detail: str = '', key: str = '', **fields):
        self.message = str(message)
        self.kind = kind or self.kind
        self.status = status
        self.detail = detail
        # Only an explicit key is published; ``reason`` is a free-form detail and may be any text a
        # host passed in, so it must not silently become a translation key.
        self.key = str(key or '')
        self.fields = fields
        super().__init__(self.message)

    def to_dict(self) -> dict:
        payload = {'ok': False, 'error': self.message, 'kind': self.kind}
        if self.key:
            payload['key'] = self.key
        if self.status:
            payload['status'] = self.status
        if self.detail:
            payload['detail'] = self.detail
        payload.update({key: value for key, value in self.fields.items() if value is not None})
        return payload


class AIError(WorkspaceError):
    """An error in the workspace contract itself (unknown skill/tool, refusal, budget)."""


class AIProviderError(WorkspaceError):
    """An error from a provider transport. ``kind`` is one of the provider error kinds."""

    kind = 'provider'


#: A refusal has a name; the host shows the name instead of guessing what went wrong.
def refused(what: str, reason: str = '') -> AIError:
    return AIError(f'{what}: {reason}' if reason else what, kind='refused', reason=reason)
