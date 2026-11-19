"""Installation is machine-wide, use is account-scoped.

A provider/tool/code contribution lives in a process-wide table, but each contribution remembers
the account that installed it. Tool listing, execution, provider lookup and skill catalogs filter
through here, so one account can neither see nor call another account's contribution.
"""

from __future__ import annotations

import threading


class Scopes:
    def __init__(self):
        self._owners: dict[str, str] = {}
        self._lock = threading.RLock()

    def remember(self, contribution_id: str, account: str) -> None:
        with self._lock:
            self._owners[contribution_id] = account

    def forget(self, contribution_id: str) -> None:
        with self._lock:
            self._owners.pop(contribution_id, None)

    def owner(self, contribution_id: str) -> str:
        with self._lock:
            return self._owners.get(contribution_id, '')

    def visible(self, contribution_id: str, account: str) -> bool:
        owner = self.owner(contribution_id)
        return not owner or owner == account

    def filter(self, ids, account: str) -> list:
        return [identifier for identifier in ids if self.visible(identifier, account)]
