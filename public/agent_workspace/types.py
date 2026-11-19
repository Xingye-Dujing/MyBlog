"""Small, JSON-shaped value types shared by every layer of the workspace.

A conversation is written to SQLite, streamed to a client and replayed to a provider. A class
hierarchy would need three serializers, and one of them would eventually disagree with the other
two. Everything here is deliberately a plain dict or a thin dataclass with a ``to_dict``.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field

#: Ids are constrained so a skill from a manifest can never be used to escape a namespace.
SKILL_ID_RE = re.compile(r'^[a-z][a-z0-9._-]{1,63}$')
PLUGIN_ID_RE = re.compile(r'^[a-z][a-z0-9._-]{1,63}$')

#: Capabilities a provider may declare. A skill may require any of them; both the agent and the
#: host UI consult this one set, and an unknown capability is never treated as "supported".
CAPABILITIES = (
    'thinking',
    'web_search',
    'read_url',
    'files',
    'safety',
    'title',
    'latest_reminder',
    'tools',
    'ask_user',
    'vision',
    'tts',
    'asr',
    'ocr',
    'continue',
)


def new_id(prefix: str) -> str:
    """A short, collision-resistant id with a readable prefix."""
    return f'{prefix}_{uuid.uuid4().hex[:24]}'


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str = ''
    max_context: int = 128000
    capabilities: frozenset = frozenset()

    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'label': self.label or self.id,
            'max_context': self.max_context,
            'capabilities': sorted(self.capabilities),
        }


@dataclass(frozen=True)
class ProviderSpec:
    """Transport metadata. Capabilities are a promise the transport must keep."""

    id: str
    label_key: str
    notes_key: str
    protocol: str
    base_url: str
    models: tuple = ()
    requires_key: bool = True
    local_only: bool = False
    capabilities: frozenset = frozenset()
    models_url: str = ''

    def supports(self, capability: str, model: str = '') -> bool:
        chosen = self.model(model)
        if chosen is not None and chosen.capabilities:
            return capability in chosen.capabilities
        return capability in self.capabilities

    def model(self, model_id: str) -> ModelSpec | None:
        for model in self.models:
            if model.id == model_id:
                return model
        return None

    def to_public(self) -> dict:
        return {
            'id': self.id,
            'label_key': self.label_key,
            'notes_key': self.notes_key,
            'protocol': self.protocol,
            'requires_key': self.requires_key,
            'local_only': self.local_only,
            'capabilities': sorted(self.capabilities),
            'models': [model.to_dict() for model in self.models],
            'models_url': self.models_url,
        }


@dataclass
class ToolSpec:
    """A verb the assistant may call. ``control`` tools are owned by the agent, not a host."""

    name: str
    description: str
    parameters: dict
    permission: str = 'read:project'
    handler: object = None
    control: bool = False
    #: Tools with a side effect must be approved unless the host auto-approves.
    mutating: bool = False
    local_only: bool = False

    def schema(self) -> dict:
        return {'name': self.name, 'description': self.description, 'input_schema': self.parameters}


@dataclass
class SkillSpec:
    """An expert mode: a prompt, the context it reads and the tools it may use."""

    id: str
    name_key: str
    description_key: str
    prompt: str
    context: tuple = ()
    tools: tuple = ()
    requires: frozenset = frozenset()
    suggested: tuple = ()
    ask_policy: str = 'auto'
    builtin: bool = True
    local_only: bool = False
    version: int = 1
    account: str = ''
    icon: str = 'spark'
    name: str = ''
    description: str = ''
    #: Stable ordering for the catalog; the UI can also group on it.
    group: str = 'general'

    def to_public(self) -> dict:
        return {
            'id': self.id,
            'name_key': self.name_key,
            'description_key': self.description_key,
            'name': self.name,
            'description': self.description,
            'context': list(self.context),
            'tools': list(self.tools),
            'requires': sorted(self.requires),
            'suggested': list(self.suggested),
            'ask_policy': self.ask_policy,
            'builtin': self.builtin,
            'local_only': self.local_only,
            'version': self.version,
            'icon': self.icon,
            'group': self.group,
        }

    def to_manifest(self) -> dict:
        return {
            'id': self.id,
            'name_key': self.name_key,
            'description_key': self.description_key,
            'name': self.name,
            'description': self.description,
            'prompt': self.prompt,
            'context': list(self.context),
            'tools': list(self.tools),
            'requires': sorted(self.requires),
            'suggested': list(self.suggested),
            'ask_policy': self.ask_policy,
            'local_only': self.local_only,
            'version': self.version,
            'icon': self.icon,
            'group': self.group,
        }


def skill_from_manifest(payload: dict, *, account: str = '', builtin: bool = False) -> SkillSpec:
    """Build a skill from a portable manifest, validating its id."""
    skill_id = str(payload.get('id') or '').strip()
    if not SKILL_ID_RE.match(skill_id):
        raise ValueError(f'invalid skill id: {skill_id!r}')
    return SkillSpec(
        id=skill_id,
        name_key=str(payload.get('name_key') or f'workspace.skillName.{skill_id}'),
        description_key=str(payload.get('description_key') or f'workspace.skillDesc.{skill_id}'),
        prompt=str(payload.get('prompt') or '').strip(),
        context=tuple(payload.get('context') or ()),
        tools=tuple(payload.get('tools') or ()),
        requires=frozenset(payload.get('requires') or ()),
        suggested=tuple(payload.get('suggested') or ()),
        ask_policy=str(payload.get('ask_policy') or 'auto'),
        builtin=builtin,
        local_only=bool(payload.get('local_only')),
        version=int(payload.get('version') or 1),
        account=account,
        icon=str(payload.get('icon') or 'spark'),
        name=str(payload.get('name') or ''),
        description=str(payload.get('description') or ''),
        group=str(payload.get('group') or 'general'),
    )


def text_block(text: str) -> dict:
    return {'type': 'text', 'text': text}


def thinking_block(text: str, signature: str = '') -> dict:
    return {'type': 'thinking', 'thinking': text, 'signature': signature}


def tool_use_block(call_id: str, name: str, arguments: dict) -> dict:
    return {'type': 'tool_use', 'id': call_id, 'name': name, 'input': arguments}


def tool_result_block(call_id: str, content, is_error: bool = False) -> dict:
    return {'type': 'tool_result', 'tool_use_id': call_id, 'content': content, 'is_error': is_error}


def block_text(blocks) -> str:
    return ''.join(str(block.get('text') or '') for block in blocks or () if block.get('type') == 'text')


def message_text(message: dict) -> str:
    return block_text(message.get('blocks') or ())


@dataclass
class ChatRequest:
    """One turn request. Hosts map their HTTP body onto this and nothing else."""

    text: str
    conversation_id: str = ''
    account: str = 'default'
    host: str = ''
    skill: str = ''
    provider: str = ''
    model: str = ''
    api_key: str = ''
    context_payload: dict = field(default_factory=dict)
    thinking: bool | None = None
    web_search: bool | None = None
    safety: str = ''
    title: bool = True
    max_tokens: int = 0
    timeout: int = 120
    cancel_event: object = None
    answers: dict | None = None
    resume_call_id: str = ''

    def to_dict(self) -> dict:
        return {
            'text': self.text,
            'conversation_id': self.conversation_id,
            'account': self.account,
            'skill': self.skill,
            'provider': self.provider,
            'model': self.model,
            'context_payload': dict(self.context_payload),
            'thinking': self.thinking,
            'web_search': self.web_search,
        }


@dataclass
class ProviderReply:
    """Non-streaming answer shape used by tests and by ``?stream=0`` style fallbacks."""

    blocks: list = field(default_factory=list)
    usage: dict = field(default_factory=dict)
    title: str = ''
    stop_reason: str = 'end_turn'


def usage_totals(usage: dict) -> dict:
    """Normalize the three provider usage dialects to the few numbers the host UI shows."""
    usage = usage or {}
    prompt = int(usage.get('prompt_tokens') or usage.get('input_tokens') or 0)
    completion = int(usage.get('completion_tokens') or usage.get('output_tokens') or 0)
    details = usage.get('prompt_tokens_details') or {}
    completion_details = usage.get('completion_tokens_details') or {}
    return {
        'prompt_tokens': prompt,
        'completion_tokens': completion,
        'cached_tokens': int(
            details.get('cached_tokens')
            or usage.get('prompt_cache_hit_tokens')
            or usage.get('cache_read_input_tokens')
            or 0
        ),
        'reasoning_tokens': int(completion_details.get('reasoning_tokens') or 0),
        'total_tokens': int(usage.get('total_tokens') or prompt + completion),
    }
