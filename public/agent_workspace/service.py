"""The public API of the framework: one object a host constructs and calls.

Nothing here imports a web framework. A host maps its HTTP body onto ``ChatRequest``, iterates the
events from ``ask()`` (writing SSE or forwarding them to a UI), and calls the other CRUD methods
from its own routes. ``adapters.flask`` is an optional thin example of that mapping.

The SQLite path is resolved through the host at call time, so a host whose ``data_dir()`` follows
the signed-in account gets real per-account isolation from one service instance.
"""

from __future__ import annotations

import threading
from pathlib import Path

from . import config, python_runtime
from .agent import Agent
from .approvals import Approvals
from .context import ContextBuilder
from .costs import Costs
from .errors import AIError
from .host import DefaultHostAdapter, HostAdapter
from .monitors import Monitors
from .plugins import PluginHost
from .providers.registry import ProviderCatalog
from .python_scripts import ScriptLibrary
from .references import References
from .scopes import Scopes
from .skills import SkillRegistry
from .store import Store
from .tools import ToolRegistry
from .types import ChatRequest
from .workspace import Workspace


class AgentWorkspace:
    """Construct once per process. All state is either in the host or in the store."""

    def __init__(self, host: HostAdapter | None = None, *, data_dir: str | Path | None = None):
        if host is None:
            host = DefaultHostAdapter(data_dir=data_dir)
        self.host = host
        Path(host.data_dir()).mkdir(parents=True, exist_ok=True)
        self.scopes = Scopes()
        self.store = Store(lambda: Path(self.host.data_dir()) / 'ai.db')
        self.library = ScriptLibrary(self.store)
        self.settings = host.settings()
        self.i18n = host.i18n()
        self.catalog = ProviderCatalog(self.settings, host, self.scopes)
        self.context = ContextBuilder(self.store, host, self.settings)
        self.skills = SkillRegistry(self.store, host, self.settings, self.catalog, self.scopes)
        self.tools = ToolRegistry(
            self.store, host, self.settings, self.context, self.workspace, scopes=self.scopes, library=self.library
        )
        self.skills.tools = self.tools
        self.approvals = Approvals()
        self.references = References(self.store, host, self.context)
        self.costs = Costs(self.store, self.settings, self.catalog)
        self.monitors = Monitors(self.store, host)
        self.plugins = PluginHost(
            self.store,
            host,
            self.settings,
            self.scopes,
            self.skills,
            self.tools,
            self.catalog,
            {'openai_compat': self._openai_factory, 'deepseek': self._deepseek_factory, 'ollama': self._ollama_factory},
        )
        self.agent = Agent(self)
        self.pending: dict = {}
        self._cancels: dict[str, threading.Event] = {}
        self._lock = threading.RLock()
        # A kill between a text delta and the assistant row's settle leaves a `streaming` row.
        # Boot recovery settles those before any history is replayed to a provider.
        self.recover_streams()

    # ── small helpers ──────────────────────────────────────────────────────────

    def t(self, key: str, **fields) -> str:
        return self.i18n.t(key, **fields)

    def workspace(self, account: str = 'default') -> Workspace:
        return Workspace(self.store, account)

    def recover_streams(self) -> int:
        total = 0
        for conversation in self.store.list_conversations_all():
            total += self.store.settle_streams(conversation['id'])
        return total

    def _openai_factory(self, payload: dict):
        from .providers.openai_compat import OpenAICompatibleProvider
        from .types import ModelSpec, ProviderSpec

        spec = ProviderSpec(
            id=str(payload.get('id') or ''),
            label_key=str(payload.get('label_key') or ''),
            notes_key=str(payload.get('notes_key') or ''),
            protocol='openai',
            base_url=str(payload.get('base_url') or ''),
            models=tuple(
                ModelSpec(str(model.get('id') or ''), str(model.get('label') or ''))
                for model in payload.get('models') or ()
            ),
            requires_key=bool(payload.get('requires_key', True)),
            local_only=bool(payload.get('local_only', False)),
            capabilities=frozenset(payload.get('capabilities') or ()),
        )
        provider = OpenAICompatibleProvider()
        provider.spec = spec
        return provider

    def _deepseek_factory(self, payload: dict):
        from .providers.deepseek import DeepSeekProvider

        provider = DeepSeekProvider()
        provider.spec = self._openai_factory(payload).spec
        return provider

    def _ollama_factory(self, payload: dict):
        from .providers.ollama import OllamaProvider

        provider = OllamaProvider()
        provider.spec = self._openai_factory(payload).spec
        return provider

    # ── chat ───────────────────────────────────────────────────────────────────

    def ask(self, request: ChatRequest):
        """Iterate canonical events for one turn. A host may wrap this as SSE."""
        # The host's account() is the default; an explicit request account still wins.
        if not request.account or request.account == 'default':
            host_account = ''
            try:
                host_account = str(self.host.account() or '')
            except Exception:
                pass
            request.account = host_account or request.account or 'default'
        if not request.conversation_id:
            request.conversation_id = self.store.create_conversation(
                request.account or 'default', title=request.text[:40] or 'New conversation'
            )['id']
        with self._lock:
            cancel = threading.Event()
            self._cancels[request.conversation_id] = cancel
        if request.cancel_event is None:
            request.cancel_event = cancel
        try:
            yield from self.agent.run(request)
        finally:
            with self._lock:
                self._cancels.pop(request.conversation_id, None)

    def ask_text(
        self,
        text: str,
        *,
        account: str = 'default',
        conversation_id: str = '',
        skill: str = '',
        provider: str = '',
        api_key: str = '',
        **kwargs,
    ) -> tuple[list[dict], str]:
        """Convenience for tests and simple hosts: return all events and the assistant text."""
        request = ChatRequest(
            text=text,
            account=account,
            conversation_id=conversation_id,
            skill=skill,
            provider=provider,
            api_key=api_key,
            **kwargs,
        )
        events = list(self.ask(request))
        answer = ''.join(str(item.get('text') or '') for item in events if item.get('type') == 'text_delta')
        return events, answer

    def chat_once(self, provider_id: str, model: str, api_key: str, prompt: str, **kwargs) -> str:
        """One non-streaming prompt for row analyzers — no conversation rows, one provider call."""
        return self.catalog.chat_once(provider_id, model, api_key, prompt, **kwargs)

    def retry(self, conversation_id: str, account: str = 'default', api_key: str = ''):
        """Re-run the last user turn as a NEW paid run — no second user row, budget re-checked."""
        last = self.store.last_message(conversation_id, 'user')
        if not last:
            raise AIError('retry.noUserTurn', kind='not_found', key='retry.noUserTurn', reason=conversation_id)
        request = ChatRequest(
            text='',
            conversation_id=conversation_id,
            account=account,
            api_key=api_key,
            context_payload={'resume_mode': True, 'retry': True},
        )
        return self.ask(request)

    def answer(self, conversation_id: str, call_id: str, answers, *, account: str = 'default', custom: str = ''):
        """Resume a paused turn. The answer is a tool result, never a new user message."""
        payload = {'call_id': call_id}
        if isinstance(answers, dict):
            payload.update(answers)
            if custom:
                payload['custom'] = custom
        request = ChatRequest(
            text='', conversation_id=conversation_id, account=account, answers=payload, resume_call_id=call_id
        )
        return self.ask(request)

    def stop(self, conversation_id: str) -> bool:
        with self._lock:
            event = self._cancels.get(conversation_id)
        if event is None:
            return False
        event.set()
        return True

    # ── bootstrap / catalog ────────────────────────────────────────────────────

    def bootstrap(self, account: str = 'default', provider_id: str = '') -> dict:
        provider_id = provider_id or self.catalog.default_id()
        return {
            'ok': True,
            'providers': self.catalog.available(account, scopes=self.scopes),
            'default_provider': provider_id,
            'models': self.catalog.list_models(provider_id),
            'skills': self.skills.list(account, provider_id),
            'tools': self.tools.schemas(),
            'conversations': self.store.list_conversations(account, limit=20),
            'memories': self.store.list_memories(account),
            'runtime': self.host.environment().capabilities(),
            'settings': self.settings.all(),
            'settings_schema': config.schema(),
            'monitors': self.monitors.list(account),
            'python': python_runtime.status(self.settings),
            'workspace': self.workspace(account).describe(),
            'scripts': self.library.all(account),
        }

    def providers(self, account: str = 'default') -> list[dict]:
        return self.catalog.available(account, scopes=self.scopes)

    def models(self, provider_id: str, api_key: str = '', account: str = 'default') -> list[dict]:
        self.catalog.require(provider_id, account)
        return self.catalog.list_models(provider_id, api_key, str(self.host.data_dir()))

    def test_provider(self, provider_id: str, model: str = '', api_key: str = '', account: str = 'default') -> dict:
        provider = self.catalog.require(provider_id, account)
        for item in provider.stream(
            {
                'model': model or (provider.spec.models[0].id if provider.spec.models else ''),
                'messages': [{'role': 'user', 'content': 'ping'}],
                'tools': [],
                'api_key': api_key,
                'timeout': 20,
                'title': False,
            }
        ):
            if item.get('type') == 'done':
                return {'ok': True, 'provider': provider_id}
        return {'ok': True, 'provider': provider_id}

    def balance(self, provider_id: str, api_key: str = '', account: str = 'default') -> dict:
        provider = self.catalog.require(provider_id, account)
        value = provider.balance(api_key)
        if value is None:
            raise AIError('provider.noBalance', kind='capability', key='provider.noBalance', reason=provider_id)
        return {'ok': True, 'provider': provider_id, **value}

    # ── conversations ──────────────────────────────────────────────────────────

    def conversations(
        self, account: str, *, query: str = '', archived: bool = False, limit: int = 50, offset: int = 0
    ) -> list[dict]:
        return self.store.list_conversations(account, query=query, archived=archived, limit=limit, offset=offset)

    def patch_conversation(self, conversation_id: str, account: str, **fields) -> dict:
        return self.store.patch_conversation(conversation_id, account, **fields)

    def delete_conversation(self, conversation_id: str, account: str) -> bool:
        self.approvals.revoke(conversation_id)
        return self.store.delete_conversation(conversation_id, account)

    def export_conversation(self, conversation_id: str, account: str, fmt: str = 'json') -> str:
        return self.store.export_conversation(conversation_id, account, fmt)

    def messages(self, conversation_id: str) -> list[dict]:
        return self.store.list_messages(conversation_id)

    # ── memories / artifacts ───────────────────────────────────────────────────

    def add_memory(self, account: str, text: str) -> dict:
        try:
            return self.store.add_memory(account, text)
        except ValueError as exc:
            raise AIError(str(exc), kind='refused', key=str(exc)) from exc

    def delete_memory(self, account: str, memory_id: str) -> bool:
        return self.store.delete_memory(account, memory_id)

    def artifacts(self, account: str, conversation_id: str = '') -> list[dict]:
        return self.store.list_artifacts(account, conversation_id)

    def apply_artifact(self, account: str, artifact_id: str) -> dict:
        artifact = self.store.get_artifact(artifact_id)
        if not artifact or artifact.get('account') != account:
            raise AIError('artifact.unknown', kind='not_found', key='artifact.unknown', reason=artifact_id)
        result = self.host.apply_artifact(artifact['kind'], artifact['payload'])
        self.store._run("UPDATE artifacts SET status='applied' WHERE id=?", (artifact_id,))
        return {'ok': True, 'artifact_id': artifact_id, 'result': result}

    # ── context / usage / files / references ───────────────────────────────────

    def context_preview(self, query: str, account: str = 'default', payload: dict | None = None) -> dict:
        return self.context.preview(query, account, payload)

    def usage(self, conversation_id: str) -> dict:
        return self.costs.conversation_cost(conversation_id)

    def add_file(self, account: str, name: str, path: str = '', size: int = 0, conversation_id: str = '') -> dict:
        return self.store.add_file(account, name, path, size, conversation_id)

    def files(self, account: str, conversation_id: str = '') -> list[dict]:
        return self.store.list_files(account, conversation_id)

    def delete_file(self, account: str, file_id: str) -> bool:
        return self.store.delete_file(account, file_id)

    def reference_candidates(self, account: str, query: str = '') -> list[dict]:
        return self.references.candidates(account, query)

    # ── python script library ──────────────────────────────────────────────────

    def scripts(self, account: str) -> list[dict]:
        return self.library.all(account)

    def get_script(self, account: str, script_id: str) -> dict:
        return self.library.get(account, script_id)

    def save_script(self, account: str, payload: dict) -> dict:
        return self.library.save(account, payload)

    def fork_script(self, account: str, script_id: str) -> dict:
        return self.library.fork(account, script_id)

    def delete_script(self, account: str, script_id: str) -> bool:
        return self.library.delete(account, script_id)

    # ── settings / skills / plugins / monitors ─────────────────────────────────

    def set_setting(self, key: str, value) -> dict:
        self.settings.set(key, value)
        return {'key': key, 'value': self.settings.get(key)}

    def save_skill(self, account: str, manifest: dict) -> dict:
        return self.skills.save_user(account, manifest)

    def fork_skill(self, account: str, skill_id: str) -> dict:
        return self.skills.fork(account, skill_id)

    def delete_skill(self, account: str, skill_id: str) -> bool:
        return self.skills.delete_user(account, skill_id)

    def install_plugin(self, manifest: dict, account: str, *, admin: bool = False) -> dict:
        return self.plugins.install(manifest, account, admin=admin)

    def plugins_list(self) -> list[dict]:
        return self.plugins.list()

    def toggle_plugin(self, plugin_id: str, account: str, enabled: bool) -> dict:
        return self.plugins.enable(plugin_id, account, enabled=enabled)

    def uninstall_plugin(self, plugin_id: str, account: str = '') -> bool:
        return self.plugins.uninstall(plugin_id, account)

    def arm_monitor(self, account: str, conversation_id: str, conditions: dict) -> dict:
        return self.monitors.arm(account, conversation_id, conditions)

    def monitors_list(self, account: str) -> list[dict]:
        return self.monitors.list(account)

    def stop_monitor(self, account: str, monitor_id: str) -> bool:
        return self.monitors.stop(account, monitor_id)

    def publish_event(self, name: str, payload: dict) -> None:
        bus = self.host.event_bus()
        if bus is None:
            raise AIError('events.unavailable', kind='capability', key='events.unavailable')
        bus.publish(name, payload)

    def close(self) -> None:
        self.store.close()


# A shorter alias for hosts that prefer the domain name.
WorkspaceService = AgentWorkspace
