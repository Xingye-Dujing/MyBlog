"""Per-conversation approval grants for mutating tools.

A grant is keyed by (conversation, tool, SHA-256 of canonical arguments). A model allowed to run one
exact command cannot silently run a different one. Nothing is persisted: a restart simply asks
again, and no secret is stored here.
"""

from __future__ import annotations

import threading

from .util import canonical_json

ONCE = 'once'
SESSION = 'session'


class Approvals:
    def __init__(self):
        self._lock = threading.RLock()
        self._grants: dict[tuple[str, str, str], str] = {}
        self._pending: dict[str, dict] = {}

    @staticmethod
    def fingerprint(args) -> str:
        import hashlib

        return hashlib.sha256(canonical_json(args).encode('utf-8')).hexdigest()

    def grant(self, conversation_id: str, tool: str, args, scope: str) -> None:
        with self._lock:
            self._grants[(conversation_id, tool, self.fingerprint(args))] = SESSION if scope == SESSION else ONCE

    def consume(self, conversation_id: str, tool: str, args) -> bool:
        key = (conversation_id, tool, self.fingerprint(args))
        with self._lock:
            scope = self._grants.get(key)
            if scope is None:
                return False
            if scope == ONCE:
                self._grants.pop(key, None)
            return True

    def revoke(self, conversation_id: str) -> int:
        with self._lock:
            keys = [key for key in self._grants if key[0] == conversation_id]
            for key in keys:
                self._grants.pop(key, None)
            for call_id in [cid for cid, row in self._pending.items() if row['conversation_id'] == conversation_id]:
                self._pending.pop(call_id, None)
        return len(keys)

    def request(self, conversation_id: str, tool: str, args, tool_call_id: str, labels: dict) -> None:
        """Capture the labels in the language the user is reading right now."""
        with self._lock:
            self._pending[tool_call_id] = {
                'conversation_id': conversation_id,
                'tool': tool,
                'args': dict(args or {}),
                'labels': dict(labels or {}),
            }

    def settle(self, conversation_id: str, tool_call_id: str, answers, custom: str = '') -> str:
        """Apply one answered approval; a denial, cancel or unrelated answer grants nothing."""
        with self._lock:
            pending = self._pending.pop(tool_call_id, None)
        if pending is None or pending['conversation_id'] != conversation_id:
            return ''
        labels = pending['labels']
        chosen = ''
        for answer in answers or ():
            if not isinstance(answer, dict):
                continue
            selected = answer.get('selected') or []
            chosen = str(selected[0] if selected else '') or str(answer.get('custom') or '')
            break
        if not chosen and custom:
            chosen = custom
        if chosen and chosen == labels.get(SESSION):
            scope = SESSION
        elif chosen and chosen == labels.get(ONCE):
            scope = ONCE
        else:
            return ''
        self.grant(conversation_id, pending['tool'], pending['args'], scope)
        return scope

    def reset(self) -> None:
        with self._lock:
            self._grants.clear()
            self._pending.clear()
