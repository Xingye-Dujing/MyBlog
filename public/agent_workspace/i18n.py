"""Translation interface and a small built-in zh/en catalog.

The engine never hard-codes UI text: it asks ``t(key, **fields)``. A host can inject its own
translator (its existing catalogue) via the adapter; the bundled one is enough to run standalone.
A missing key returns the key itself — a visible bug, never a silent empty label.
"""

from __future__ import annotations

import threading
from typing import Protocol

BUILTIN = {
    'zh': {
        'workspace.skill.general.name': '通用助手',
        'workspace.skill.general.desc': '阅读项目上下文、使用只读工具并给出有依据的回答。',
        'workspace.skill.project.name': '项目顾问',
        'workspace.skill.project.desc': '回答关于当前项目结构、能力与约束的问题。',
        'workspace.skill.workspace.name': '文件工作台',
        'workspace.skill.workspace.desc': '在工作文件夹内列出、读取、写入文件并运行白名单命令。',
        'workspace.skill.skill_author.name': '技能编写',
        'workspace.skill.skill_author.desc': '帮助用户把重复的工作流写成可复用的技能。',
        'workspace.skill.developer.name': '开发助手',
        'workspace.skill.developer.desc': '基于源码快照回答代码问题（需要源上下文权限）。',
        'workspace.refusal.capability': '当前供应商不支持能力 {capability}，已按名称拒绝。',
        'workspace.refusal.tool': '工具 {tool} 不可用：{reason}',
        'workspace.artifact.applied': '已应用：{kind}',
        'workspace.budget.exceeded': '已达到 {scope} token 预算（{limit}），本轮不再发起调用。',
        'workspace.runtime.local': '本机',
        'workspace.runtime.cloud': '云端',
        'workspace.runtime.desktop': '桌面版',
    },
    'en': {
        'workspace.skill.general.name': 'General assistant',
        'workspace.skill.general.desc': 'Read project context, use read-only tools and answer with evidence.',
        'workspace.skill.project.name': 'Project advisor',
        'workspace.skill.project.desc': 'Answer questions about the current project structure, capabilities and rules.',
        'workspace.skill.workspace.name': 'File workbench',
        'workspace.skill.workspace.desc': 'List, read and write files in the working folder and run '
        'allow-listed commands.',
        'workspace.skill.skill_author.name': 'Skill author',
        'workspace.skill.skill_author.desc': 'Turn a repeated workflow into a reusable skill.',
        'workspace.skill.developer.name': 'Developer',
        'workspace.skill.developer.desc': 'Answer code questions from a source snapshot (needs source '
        'context permission).',
        'workspace.refusal.capability': 'The current provider does not support capability {capability}; '
        'refused by name.',
        'workspace.refusal.tool': 'Tool {tool} is unavailable: {reason}',
        'workspace.artifact.applied': 'Applied: {kind}',
        'workspace.budget.exceeded': 'The {scope} token budget ({limit}) has been reached; no further call this turn.',
        'workspace.runtime.local': 'Local',
        'workspace.runtime.cloud': 'Cloud',
        'workspace.runtime.desktop': 'Desktop',
    },
}

_LANG = threading.local()


class Translator(Protocol):
    def t(self, key: str, **fields) -> str: ...
    def lang(self) -> str: ...


class BuiltinTranslator:
    def __init__(self, lang: str = 'zh', extra: dict | None = None):
        self._lang = lang
        self._extra = extra or {}

    def t(self, key: str, **fields) -> str:
        text = self._extra.get(self._lang, {}).get(key)
        if text is None:
            text = BUILTIN.get(self._lang, {}).get(key)
        if text is None:
            text = BUILTIN.get('en', {}).get(key, key)
        try:
            return text.format(**fields)
        except (KeyError, IndexError, ValueError):
            return text

    def lang(self) -> str:
        return self._lang

    def set_lang(self, lang: str) -> None:
        self._lang = lang


class HostTranslator:
    """Wrap a host's existing ``t(key, **fields)`` function."""

    def __init__(self, translate, language=lambda: 'en'):
        self._translate = translate
        self._language = language

    def t(self, key: str, **fields) -> str:
        return self._translate(key, **fields)

    def lang(self) -> str:
        return self._language()


def set_lang(lang: str) -> None:
    """Thread-local language, for hosts that translate with process globals."""
    _LANG.lang = lang


def get_lang() -> str:
    return getattr(_LANG, 'lang', 'zh')
