"""The host contract — the single seam between the engine and an application.

A host does not subclass the engine, and the engine never imports a host. The host supplies data
and capabilities through this one object. Every method has a working default, so a new application
can import the framework, construct ``DefaultHostAdapter`` and already have a complete workspace;
it then overrides only the pieces that carry its own domain knowledge.

The 采析绘-specific knowledge (nodes, datasets, workflows, charts, catbus, ...) is *not* in the
engine. A host that wants it supplies it as context sources, tools and skills — see the migration
guide in ``docs/migration_guide.md``.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

from .i18n import BuiltinTranslator, Translator
from .settings import FileSettings, SettingsStore
from .types import SkillSpec, ToolSpec

# ─── Environment ────────────────────────────────────────────────────────────────


@dataclass
class HostEnvironment:
    """What the server can reach on the user's machine. The server alone decides this."""

    kind: str = 'local'  # 'local' | 'cloud' | 'desktop'
    source_root: str = ''
    extra: dict = field(default_factory=dict)

    @property
    def cloud(self) -> bool:
        return self.kind == 'cloud'

    @property
    def local(self) -> bool:
        return self.kind in ('local', 'desktop')

    def capabilities(self) -> dict:
        """The host feature matrix. Provider capabilities live in the provider catalog."""
        local = self.local
        return {
            'kind': self.kind,
            'label_key': f'workspace.runtime.{self.kind}',
            'chat': True,
            'sessions': True,
            'skills': True,
            'declarative_plugins': True,
            'files_api': True,
            'web_search': True,
            'ollama': local,
            'user_files': local,
            'code_plugins': local,
            'python_exec': local,
            'workspace_folder': local,
            'local_import': local,
            'cmd_exec': local,
            'local_source': bool(self.source_root),
            'cloud': self.cloud,
            'frozen': self.kind == 'desktop',
            **self.extra,
        }

    def prompt_line(self) -> str:
        """One line that tells the model what it may claim to have read."""
        if self.cloud:
            return (
                'Environment: a shared cloud host. Remote providers, uploaded files, server-side '
                'search and fetch, sessions, skills and declarative plugins are available. There is '
                'no local model daemon, no user-local filesystem and no repository source. Never '
                'claim to have read a file on the user machine.'
            )
        if self.kind == 'desktop':
            return (
                "Environment: a packaged desktop app on the user's machine. Local files, a local "
                'Ollama daemon, local code plugins and a read-only source snapshot are available '
                'when the host enables them. A chosen working folder is read/write; commands run '
                'one allow-listed executable at a time, never through a shell.'
            )
        return (
            "Environment: a local source checkout on the user's machine. Local files, a local "
            'Ollama daemon and the repository source are available when the host enables them. '
            'Say what you touched.'
        )


# ─── Context sources ────────────────────────────────────────────────────────────


class ContextSource(Protocol):
    """One named, bounded section of the model context.

    ``build`` may accept a third ``account`` argument. A host source that re-reads live per-account
    data needs it; a static source can keep the original two-argument signature.
    """

    name: str

    def build(self, query: str, payload: dict, account: str = '') -> str: ...


class CallableContextSource:
    def __init__(self, name: str, builder: Callable):
        import inspect

        self.name = name
        self._builder = builder
        self._takes_account = 'account' in inspect.signature(builder).parameters

    def build(self, query: str, payload: dict, account: str = '') -> str:
        if self._takes_account:
            return str(self._builder(query, payload, account) or '')
        return str(self._builder(query, payload) or '')


# ─── Event bus (monitors) ───────────────────────────────────────────────────────


class EventBus:
    """A tiny in-process pub/sub. A host may replace it with its own runtime event stream."""

    def __init__(self):
        self._subscribers: list[Callable[[str, dict], None]] = []
        self._lock = threading.RLock()

    def subscribe(self, callback: Callable[[str, dict], None]) -> None:
        with self._lock:
            self._subscribers.append(callback)

    def publish(self, name: str, payload: dict) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for callback in subscribers:
            callback(name, payload)


# ─── The adapter ────────────────────────────────────────────────────────────────


class HostAdapter:
    """Override only what your application already has. See ``docs/host_integration.md``."""

    def account(self) -> str:
        return 'default'

    def data_dir(self) -> Path:
        return Path.cwd() / '.agent-workspace'

    def settings(self) -> SettingsStore:
        if not hasattr(self, '_settings'):
            self._settings = FileSettings(self.data_dir() / 'settings.json')
        return self._settings

    def i18n(self) -> Translator:
        if not hasattr(self, '_i18n'):
            self._i18n = BuiltinTranslator()
        return self._i18n

    def environment(self) -> HostEnvironment:
        return HostEnvironment()

    def context_sources(self) -> list[ContextSource]:
        """Extra named sections, e.g. a dataset profile or a live canvas draft."""
        return []

    def facts(self) -> dict:
        """Domain facts for the built-in ``project_facts`` source: {heading: text}."""
        return {}

    def doc_roots(self) -> list[str]:
        """Paths (or directory roots ending in '/') the built-in doc search may read."""
        return []

    def tools(self) -> list[ToolSpec]:
        """Domain read-only tools. Control tools and generic tools are added by the engine."""
        return []

    def skills(self) -> list[SkillSpec]:
        """Domain expert modes. The engine's built-ins are added by the registry."""
        return []

    def capabilities(self) -> dict:
        """Domain capability facts shown in prompts and the inspector."""
        return {}

    def command_allowlist(self) -> tuple[str, ...]:
        """Executable basenames the workspace may run. Empty means no command is allowed."""
        return ()

    def apply_artifact(self, kind: str, payload: dict) -> dict:
        """Apply a proposed write. The engine never writes to a host on its own."""
        raise NotImplementedError(f'this host cannot apply artifacts of kind {kind}')

    def event_bus(self) -> EventBus | None:
        return None

    # Optional domain resolvers — used by the generic @reference and monitor machinery.
    def resolve_dataset(self, dataset_id: str):
        return None

    def resolve_run(self, run_id: str):
        return None

    def import_table(self, path: str) -> dict:
        """Import a local table/file into a domain object. Return a dict with at least an id."""
        raise NotImplementedError('this host does not support local imports')

    def search(self, query: str, limit: int = 3) -> list[dict]:
        return []

    def fetch(self, url: str) -> str:
        raise NotImplementedError('this host has no fetch service')


class DefaultHostAdapter(HostAdapter):
    """A fully working, zero-dependency host. Subclass it and override what you have."""

    def __init__(
        self,
        *,
        data_dir: str | Path | None = None,
        lang: str = 'zh',
        environment: HostEnvironment | None = None,
        facts: dict | None = None,
        doc_roots: list[str] | None = None,
    ):
        if data_dir is not None:
            self._data_dir = Path(data_dir)
        if lang:
            self._i18n = BuiltinTranslator(lang=lang)
        self._environment = environment or HostEnvironment()
        self._facts = facts or {}
        self._doc_roots = doc_roots or []

    def data_dir(self) -> Path:
        return getattr(self, '_data_dir', super().data_dir())

    def environment(self) -> HostEnvironment:
        return self._environment

    def facts(self) -> dict:
        return self._facts

    def doc_roots(self) -> list[str]:
        return self._doc_roots
