"""Where setting values live. The engine only knows this tiny interface."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Protocol

from .config import BY_KEY, defaults, translate_legacy


class SettingsStore(Protocol):
    def get(self, key: str, default=None): ...
    def set(self, key: str, value) -> None: ...
    def all(self) -> dict: ...


class MemorySettings:
    """A process-local store. Useful for tests, embeds and single-user tools."""

    def __init__(self, values: dict | None = None):
        self._lock = threading.RLock()
        self._values = dict(defaults())
        for key, value in (values or {}).items():
            self.set(key, value)

    def get(self, key: str, default=None):
        key = translate_legacy(key)
        setting = BY_KEY.get(key)
        with self._lock:
            value = self._values.get(key, default if default is not None else (setting.default if setting else None))
        return setting.validate(value) if setting else value

    def set(self, key: str, value) -> None:
        key = translate_legacy(key)
        if key not in BY_KEY:
            raise KeyError(f'unknown setting: {key}')
        with self._lock:
            self._values[key] = BY_KEY[key].validate(value)

    def all(self) -> dict:
        with self._lock:
            return dict(self._values)


class FileSettings(MemorySettings):
    """A JSON file behind the same interface. One file, atomic replace, no secrets in it."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        initial: dict = {}
        if self.path.is_file():
            try:
                loaded = json.loads(self.path.read_text(encoding='utf-8'))
                if isinstance(loaded, dict):
                    initial = loaded
            except (ValueError, OSError):
                initial = {}
        super().__init__(initial)

    def set(self, key: str, value) -> None:
        super().set(key, value)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + '.tmp')
        temporary.write_text(json.dumps(self.all(), ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(self.path)


class HostSettings:
    """Adapt a host's own settings system with two callables — no subclassing needed."""

    def __init__(self, getter, setter=None, all_getter=None):
        self._get = getter
        self._set = setter
        self._all = all_getter

    def get(self, key: str, default=None):
        key = translate_legacy(key)
        value = self._get(key, default)
        setting = BY_KEY.get(key)
        return setting.validate(value) if setting else value

    def set(self, key: str, value) -> None:
        key = translate_legacy(key)
        if self._set is None:
            raise NotImplementedError('this host settings adapter is read-only')
        self._set(key, BY_KEY[key].validate(value) if key in BY_KEY else value)

    def all(self) -> dict:
        return dict(self._all()) if self._all else {}
