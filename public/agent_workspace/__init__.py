"""agent-workspace — a provider-neutral, framework-agnostic agent workspace backend.

The whole framework is one object::

    from agent_workspace import AgentWorkspace, DefaultHostAdapter

    workspace = AgentWorkspace(DefaultHostAdapter(data_dir='./data'))
    events, answer = workspace.ask_text('What does this project do?')

A host supplies its own domain knowledge by overriding a few methods on ``HostAdapter``. Nothing in
the engine imports Flask, Django or any application module.

Layers (each independently importable):

* ``providers`` — transports and the one catalog;
* ``store`` — durable, per-account transcripts, memory, usage and monitors;
* ``context`` — budgeted, redacted context assembled from pluggable sources;
* ``skills`` / ``tools`` — expert modes and read-only verbs;
* ``agent`` — the turn loop that ties them together into canonical events;
* ``service`` — the public API a host calls from its own routes;
* ``adapters`` — optional thin HTTP bindings.
"""

from .agent import Agent
from .approvals import Approvals
from .config import SETTINGS, defaults, schema, translate_legacy
from .context import ContextBuilder
from .costs import Costs
from .errors import AIError, AIProviderError, WorkspaceError
from .host import ContextSource, DefaultHostAdapter, EventBus, HostAdapter, HostEnvironment
from .monitors import Monitors
from .plugins import PluginHost
from .providers import Provider, ProviderCatalog, replay_context
from .references import References
from .scopes import Scopes
from .service import AgentWorkspace, WorkspaceService
from .skills import SkillRegistry
from .store import Store
from .tools import ToolRegistry
from .types import (
    CAPABILITIES,
    ChatRequest,
    ModelSpec,
    ProviderReply,
    ProviderSpec,
    SkillSpec,
    ToolSpec,
    new_id,
    usage_totals,
)
from .workspace import Workspace

API_VERSION = 1

__all__ = [
    'API_VERSION',
    'AIError',
    'AIProviderError',
    'WorkspaceError',
    'Agent',
    'AgentWorkspace',
    'WorkspaceService',
    'Approvals',
    'ContextBuilder',
    'ContextSource',
    'Costs',
    'DefaultHostAdapter',
    'EventBus',
    'HostAdapter',
    'HostEnvironment',
    'Monitors',
    'PluginHost',
    'Provider',
    'ProviderCatalog',
    'References',
    'Scopes',
    'SkillRegistry',
    'Store',
    'ToolRegistry',
    'Workspace',
    'ChatRequest',
    'ModelSpec',
    'ProviderReply',
    'ProviderSpec',
    'SkillSpec',
    'ToolSpec',
    'CAPABILITIES',
    'new_id',
    'usage_totals',
    'replay_context',
    'SETTINGS',
    'defaults',
    'schema',
    'translate_legacy',
]
