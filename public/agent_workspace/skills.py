"""Built-in expert modes plus host and user skills — one catalog, no code in user skills."""

from __future__ import annotations

from .errors import AIError
from .tools import CONTROL_TOOLS
from .types import SkillSpec, skill_from_manifest

#: Context sections the built-in context builder understands; a host may add its own source names.
CONTEXT_SOURCES = frozenset({'project', 'docs', 'memories'})


def validate_manifest(manifest: dict, known_tools=(), known_contexts=()) -> None:
    """A user/plugin skill is data: no code, no control tools, no unknown capability names."""
    from .types import CAPABILITIES, SKILL_ID_RE

    identifier = str(manifest.get('id') or '').strip()
    if not SKILL_ID_RE.match(identifier):
        raise ValueError('invalid skill id')
    prompt = str(manifest.get('prompt') or '').strip()
    if not prompt:
        raise ValueError('skill.promptRequired')
    if prompt.lstrip().startswith(('import ', 'from ', 'def ', 'class ')):
        raise ValueError('a skill may not contain code')
    for tool in manifest.get('tools') or ():
        if tool in CONTROL_TOOLS:
            raise ValueError('a skill may not name a control tool')
        if known_tools and tool not in known_tools:
            raise ValueError(f'unknown tool: {tool}')
    for source in manifest.get('context') or ():
        if source not in CONTEXT_SOURCES and known_contexts and source not in known_contexts:
            raise ValueError(f'unknown context source: {source}')
    for capability in manifest.get('requires') or ():
        if capability not in CAPABILITIES:
            raise ValueError(f'unknown capability: {capability}')


BUILTIN_SKILLS: dict[str, SkillSpec] = {
    'general': SkillSpec(
        id='general',
        name_key='workspace.skill.general.name',
        description_key='workspace.skill.general.desc',
        prompt=(
            'You are a careful assistant. Read the supplied project context before answering. '
            'Prefer read-only tools and smallest-evidence-first: a small sample beats a whole table. '
            'If a fact is missing, say so; never invent one. Writes are proposals the user applies.'
        ),
        context=('project',),
        tools=('project_facts', 'capabilities', 'docs_search'),
        suggested=('Summarise the project.', 'What can I ask you to do?'),
        group='general',
    ),
    'project': SkillSpec(
        id='project',
        name_key='workspace.skill.project.name',
        description_key='workspace.skill.project.desc',
        prompt=(
            'You are a project advisor. Answer from the generated project facts and the host doc '
            'search. Name the source of a claim; when the context omits something, report the '
            'omission instead of filling the gap.'
        ),
        context=('project', 'docs'),
        tools=('project_facts', 'capabilities', 'docs_search'),
        suggested=('What are the main constraints here?', 'Explain the current context.'),
        group='general',
    ),
    'workspace': SkillSpec(
        id='workspace',
        name_key='workspace.skill.workspace.name',
        description_key='workspace.skill.workspace.desc',
        prompt=(
            "You can work in the user's chosen folder. List before reading, read before writing. "
            'All paths stay inside the folder; a path escape is refused by name. Show a diff before '
            'a write is applied and say exactly what you touched.'
        ),
        context=('project',),
        tools=('workspace_info', 'workspace_list', 'workspace_read', 'workspace_write', 'workspace_import', 'run_cmd'),
        suggested=('List the working folder.', 'Show the diff for this file.'),
        group='extension',
    ),
    'skill_author': SkillSpec(
        id='skill_author',
        name_key='workspace.skill.skill_author.name',
        description_key='workspace.skill.skill_author.desc',
        prompt=(
            'Help the user turn a repeated workflow into a reusable skill. A skill is data: a '
            'prompt, a context list, a tool list and capability requirements. It may not contain '
            'code or write actions. Produce a skill artifact for the user to apply.'
        ),
        context=('project',),
        tools=('project_facts', 'capabilities'),
        group='authoring',
    ),
    'developer': SkillSpec(
        id='developer',
        name_key='workspace.skill.developer.name',
        description_key='workspace.skill.developer.desc',
        prompt=(
            'Answer code questions from the read-only source snapshot the host exposes. You may '
            'cite a file or a line but you cannot change the running program; a reusable script '
            'is the extension path.'
        ),
        context=('project', 'docs'),
        tools=('project_facts', 'docs_search'),
        requires=frozenset(),
        local_only=True,
        group='authoring',
    ),
}


class SkillRegistry:
    def __init__(self, store, host, settings, catalog, scopes=None, tools=None):
        self.store = store
        self.host = host
        self.settings = settings
        self.catalog = catalog
        self.scopes = scopes
        self.tools = tools
        self._extra: dict[str, SkillSpec] = {}

    def register(self, spec: SkillSpec) -> None:
        self._extra[spec.id] = spec

    def unregister(self, skill_id: str) -> None:
        self._extra.pop(skill_id, None)

    def _all(self, account: str) -> dict[str, SkillSpec]:
        result = dict(BUILTIN_SKILLS)
        visible = (
            (lambda identifier: self.scopes.visible(identifier, account)) if self.scopes else (lambda identifier: True)
        )
        result.update({skill.id: skill for skill in self.host.skills() if visible(skill.id)})
        result.update({identifier: skill for identifier, skill in self._extra.items() if visible(identifier)})
        for manifest in self.store.list_user_skills(account):
            try:
                skill = skill_from_manifest(manifest, account=account, builtin=False)
            except ValueError:
                continue
            result[skill.id] = skill
        return result

    def get(self, skill_id: str, account: str) -> SkillSpec | None:
        return self._all(account).get(skill_id)

    def availability(self, skill: SkillSpec, provider_id: str = '', model: str = '') -> tuple[bool, str]:
        env = self.host.environment()
        if skill.local_only and env.cloud:
            return False, 'workspace.skill.cloudRefused'
        for source in skill.context:
            if source not in CONTEXT_SOURCES and source not in {item.name for item in self.host.context_sources()}:
                return False, f'skill.contextUnknown:{source}'
        for tool in skill.tools:
            if tool in CONTROL_TOOLS:
                continue
            if self.tools is not None and self.tools.get(tool) is None:
                return False, f'skill.toolUnknown:{tool}'
        for capability in sorted(skill.requires):
            if not self.catalog.supports(provider_id, capability, model):
                return False, capability
        return True, ''

    def route(self, text: str, account: str = 'default') -> str:
        """A deterministic keyword router: it always names the skill it chose."""
        lowered = str(text or '').lower()
        best = ('general', 0)
        for identifier, skill in self._all(account).items():
            score = sum(1 for word in identifier.replace('_', ' ').split() if word in lowered)
            score += sum(1 for word in skill.suggested if str(word).lower() in lowered)
            if score > best[1]:
                best = (identifier, score)
        return best[0]

    def list(self, account: str = 'default', provider_id: str = '', model: str = '') -> list[dict]:
        rows = []
        for skill in self._all(account).values():
            available, reason = self.availability(skill, provider_id, model)
            row = skill.to_public()
            row['available'] = available
            row['reason'] = reason
            row['why_not'] = reason
            row['why_not_text'] = self.host.i18n().t(reason) if reason else ''
            rows.append(row)
        rows.sort(key=lambda row: (not row['builtin'], row['group'], row['id']))
        return rows

    def manifests(self, account: str = 'default') -> list[dict]:
        return [skill.to_manifest() for skill in self._all(account).values()]

    def save_user(self, account: str, manifest: dict) -> dict:
        if str(manifest.get('id') or '') in BUILTIN_SKILLS:
            raise AIError('skill.builtinReadOnly', kind='refused', key='skill.builtinReadOnly')
        known_tools = set(self._specs_names())
        known_contexts = {item.name for item in self.host.context_sources()}
        try:
            validate_manifest(manifest, known_tools=known_tools, known_contexts=known_contexts)
            return self.store.save_skill(account, manifest)
        except ValueError as exc:
            raise AIError('skill.invalid', kind='refused', key='skill.invalid', reason=str(exc)) from exc

    def _specs_names(self):
        if self.tools is None:
            return set()
        return set(self.tools._specs) | set(self.tools._extra)

    def fork(self, account: str, skill_id: str) -> dict:
        source = self.get(skill_id, account)
        if source is None:
            raise AIError('skill.unknown', kind='not_found', reason=skill_id)
        manifest = source.to_manifest()
        manifest['id'] = f'{skill_id}_copy'
        manifest['builtin'] = False
        manifest['name'] = f'{source.name or source.name_key} (copy)'
        while self.get(str(manifest['id']), account):
            manifest['id'] += '_copy'
        return self.store.save_skill(account, manifest)

    def delete_user(self, account: str, skill_id: str) -> bool:
        return self.store.delete_skill(account, skill_id)
