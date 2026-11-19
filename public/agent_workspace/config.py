"""Typed configuration for the workspace.

Settings are declared once here: a key has a default, a kind, bounds and a group. The host only
decides *where values are stored* (its own settings system, a JSON file, a database). Nothing in
the engine reads an undeclared setting, and an unknown key is refused by name.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Setting:
    key: str
    default: object
    kind: str = 'str'  # str | int | bool | enum
    choices: tuple = ()
    minimum: int = 0
    maximum: int = 0
    group: str = 'general'
    label_key: str = ''
    hint_key: str = ''
    secret: bool = False

    def validate(self, value):
        if self.kind == 'bool':
            if isinstance(value, bool):
                return value
            return str(value).strip().lower() in ('1', 'true', 'yes', 'on')
        if self.kind == 'int':
            try:
                number = int(value)
            except (TypeError, ValueError):
                return self.default
            if self.minimum:
                number = max(self.minimum, number)
            if self.maximum:
                number = min(self.maximum, number)
            return number
        value = str(value)
        if self.choices and value not in self.choices:
            return self.default
        return value


#: The single declaration table. Add a setting here, never inline in an engine module.
SETTINGS: tuple[Setting, ...] = (
    Setting('ollama.host', '', 'str', group='chat', label_key='workspace.setting.ollamaHost'),
    Setting(
        'context.scope',
        'summary',
        'enum',
        ('off', 'summary', 'full'),
        group='context',
        label_key='workspace.setting.contextScope',
        hint_key='workspace.settingHint.contextScope',
    ),
    Setting(
        'context.max_chars', 120000, 'int', minimum=2000, group='context', label_key='workspace.setting.contextMaxChars'
    ),
    Setting(
        'context.replay_chars',
        16000,
        'int',
        minimum=1000,
        group='context',
        label_key='workspace.setting.contextReplayChars',
    ),
    Setting('chat.default_provider', '', 'str', group='chat', label_key='workspace.setting.provider'),
    Setting('chat.default_model', '', 'str', group='chat', label_key='workspace.setting.model'),
    Setting('chat.web_search_default', True, 'bool', group='chat', label_key='workspace.setting.webSearch'),
    Setting(
        'chat.safety_level',
        'standard',
        'enum',
        ('off', 'standard', 'strict'),
        group='chat',
        label_key='workspace.setting.safety',
    ),
    Setting(
        'chat.reasoning_effort',
        'high',
        'enum',
        ('low', 'high', 'max'),
        group='chat',
        label_key='workspace.setting.reasoning',
    ),
    Setting('chat.temperature', 0.3, 'str', group='chat', label_key='workspace.setting.temperature'),
    Setting('chat.timeout', 120, 'int', minimum=10, maximum=600, group='chat', label_key='workspace.setting.timeout'),
    Setting(
        'tools.max_rounds', 30, 'int', minimum=0, maximum=200, group='tools', label_key='workspace.setting.maxRounds'
    ),
    Setting(
        'tools.max_result_chars',
        12000,
        'int',
        minimum=1000,
        group='tools',
        label_key='workspace.setting.maxResultChars',
    ),
    Setting('approval.auto', True, 'bool', group='safety', label_key='workspace.setting.autoApprove'),
    Setting(
        'budget.conversation_tokens', 0, 'int', minimum=0, group='budget', label_key='workspace.setting.convBudget'
    ),
    Setting('budget.daily_tokens', 0, 'int', minimum=0, group='budget', label_key='workspace.setting.dailyBudget'),
    Setting('source.allow_context', False, 'bool', group='safety', label_key='workspace.setting.allowSource'),
    Setting('python.allowed', False, 'bool', group='extension', label_key='workspace.setting.allowPython'),
    Setting('python.path', '', 'str', group='extension', label_key='workspace.setting.pythonPath'),
)

BY_KEY = {setting.key: setting for setting in SETTINGS}

#: 采析绘 → framework key map. A host migrating an old settings store can translate in one line.
LEGACY_KEYS = {
    'ollama_host': 'ollama.host',
    'ai_context_scope': 'context.scope',
    'ai_max_context_chars': 'context.max_chars',
    'ai_context_replay_chars': 'context.replay_chars',
    'ai_web_search_default': 'chat.web_search_default',
    'ai_safety_level': 'chat.safety_level',
    'ai_reasoning_effort': 'chat.reasoning_effort',
    'ai_temperature': 'chat.temperature',
    'ai_request_timeout': 'chat.timeout',
    'ai_max_tool_rounds': 'tools.max_rounds',
    'ai_max_tool_result_chars': 'tools.max_result_chars',
    'ai_auto_approve': 'approval.auto',
    'ai_budget_conversation_tokens': 'budget.conversation_tokens',
    'ai_budget_daily_tokens': 'budget.daily_tokens',
    'ai_allow_code_context': 'source.allow_context',
    'ai_allow_python': 'python.allowed',
    'ai_python_path': 'python.path',
}


def defaults() -> dict:
    return {setting.key: setting.default for setting in SETTINGS}


def schema() -> list[dict]:
    return [
        {
            'key': setting.key,
            'default': setting.default,
            'kind': setting.kind,
            'choices': list(setting.choices),
            'minimum': setting.minimum,
            'maximum': setting.maximum,
            'group': setting.group,
            'label_key': setting.label_key,
            'hint_key': setting.hint_key,
            'secret': setting.secret,
        }
        for setting in SETTINGS
    ]


def translate_legacy(key: str) -> str:
    """Map a legacy 采析绘 setting key onto the framework key."""
    return LEGACY_KEYS.get(key, key)
