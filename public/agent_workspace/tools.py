"""The tool registry and the generic, domain-free tools.

A tool is a read-only verb, or a mutating verb that produces a proposal the user applies. Missing
ids and unsupported operations are refused by name; a result is bounded before it reaches the model.
Domain tools are registered by the host through ``HostAdapter.tools()`` or a plugin pack.

Two checks happen at *execution*, not just when schemas are offered: the account scope of a
contribution, and the exact allowlist the current turn advertised. Otherwise replayed history or a
narrow skill could still reach a mutating tool the user never saw in the tool list.
"""

from __future__ import annotations

from . import python_runtime
from .errors import AIError
from .types import ToolSpec
from .util import clip

CONTROL_TOOLS = ('ask_user_question', 'update_plan', 'present_artifact', 'request_approval')
GENERIC_NAMES = frozenset(
    {
        'project_facts',
        'capabilities',
        'docs_search',
        'workspace_info',
        'workspace_list',
        'workspace_read',
        'workspace_write',
        'workspace_import',
        'run_cmd',
        'python_status',
        'python_run',
        'python_scripts',
        'python_script',
        'python_save_script',
        'python_fork_script',
        'python_delete_script',
        'python_files',
        'python_read',
        'python_write',
        'web_search',
        'fetch_url',
        'history_search',
    }
)

ASK_USER_SCHEMA = {
    'type': 'object',
    'properties': {
        'question': {'type': 'string'},
        'options': {'type': 'array', 'items': {'type': 'string'}},
        'allow_custom': {'type': 'boolean'},
        'detail': {'type': 'string', 'description': 'Exact facts the user is deciding about.'},
    },
    'required': ['question', 'options'],
}
PLAN_SCHEMA = {
    'type': 'object',
    'properties': {'steps': {'type': 'array', 'items': {'type': 'string'}}},
    'required': ['steps'],
}
ARTIFACT_SCHEMA = {
    'type': 'object',
    'properties': {
        'kind': {'type': 'string'},
        'title': {'type': 'string'},
        'payload': {'type': 'object'},
        'summary': {'type': 'string'},
    },
    'required': ['kind', 'payload'],
}
APPROVAL_SCHEMA = {
    'type': 'object',
    'properties': {
        'tool': {'type': 'string'},
        'args': {'type': 'object'},
        'question': {'type': 'string'},
        'detail': {'type': 'object', 'description': 'The exact arguments about to be used.'},
    },
    'required': ['tool', 'args'],
}


def control_specs() -> list[ToolSpec]:
    return [
        ToolSpec(
            'ask_user_question',
            'Pause and ask the user a question with explicit options.',
            ASK_USER_SCHEMA,
            control=True,
        ),
        ToolSpec('update_plan', 'Show a short execution plan to the user.', PLAN_SCHEMA, control=True),
        ToolSpec(
            'present_artifact',
            'Propose a write for the user to apply; never apply it yourself.',
            ARTIFACT_SCHEMA,
            control=True,
        ),
        ToolSpec('request_approval', 'Ask the user to approve one exact mutating call.', APPROVAL_SCHEMA, control=True),
    ]


# ── generic handlers ────────────────────────────────────────────────────────────


def _tool_project_facts(args, ctx):
    return {'text': ctx['context'].project_facts()}


def _tool_capabilities(args, ctx):
    host = ctx['host']
    return {
        'provider': ctx.get('provider_id', ''),
        'host': host.environment().capabilities(),
        'domain': host.capabilities(),
    }


def _tool_docs_search(args, ctx):
    if not ctx['host'].doc_roots():
        raise AIError('docs.unavailable', kind='capability', key='docs.unavailable', reason='this host exposes no docs')
    return {'results': ctx['context'].docs_search(str(args.get('query') or ''), int(args.get('limit') or 3))}


def _tool_workspace_info(args, ctx):
    return ctx['workspace'].describe()


def _tool_workspace_list(args, ctx):
    return ctx['workspace'].list(str(args.get('path') or ''))


def _tool_workspace_read(args, ctx):
    return ctx['workspace'].read(str(args.get('path') or ''))


def _tool_workspace_write(args, ctx):
    return ctx['workspace'].write(str(args.get('path') or ''), str(args.get('content') or ''))


def _tool_workspace_import(args, ctx):
    relative = str(args.get('path') or '')
    target = ctx['workspace'].resolve(relative, must_exist=True)
    try:
        return {'import': ctx['host'].import_table(str(target)), 'path': relative}
    except NotImplementedError as exc:
        raise AIError('import.unavailable', kind='capability', key='import.unavailable', reason=str(exc)) from exc


def _tool_run_cmd(args, ctx):
    env = ctx['host'].environment()
    if env.cloud:
        raise AIError('cmd.cloudRefused', kind='capability', key='cmd.cloudRefused')
    return ctx['workspace'].run(
        str(args.get('command') or ''),
        cwd=str(args.get('cwd') or ''),
        allow=ctx['host'].command_allowlist(),
        timeout=int(args.get('timeout') or 30),
        cancel_event=ctx.get('cancel_event'),
    )


def _require_python(ctx) -> None:
    if not ctx['host'].environment().local:
        raise AIError('python.cloudRefused', kind='capability', key='python.cloudRefused')
    if not ctx['settings'].get('python.allowed', False):
        raise AIError('python.disabled', kind='capability', key='python.disabled', reason='python.allowed is off')


def _tool_python_status(args, ctx):
    return python_runtime.status(ctx['settings'])


def _tool_python_scripts(args, ctx):
    _require_python(ctx)
    return {
        'scripts': [
            {key: row[key] for key in ('id', 'name', 'inputs', 'outputs', 'tags', 'version', 'builtin')}
            for row in ctx['library'].all(ctx['account'])
        ]
    }


def _tool_python_script(args, ctx):
    _require_python(ctx)
    row = ctx['library'].get(ctx['account'], str(args.get('id') or ''))
    if not row:
        raise AIError(
            'python.scriptMissing', kind='not_found', key='python.scriptMissing', reason=str(args.get('id') or '')
        )
    return {
        'script': {
            key: row.get(key) for key in ('id', 'name', 'code', 'inputs', 'outputs', 'tags', 'version', 'builtin')
        }
    }


def _tool_python_save_script(args, ctx):
    _require_python(ctx)
    return {'script': ctx['library'].save(ctx['account'], dict(args))}


def _tool_python_fork_script(args, ctx):
    _require_python(ctx)
    return {'script': ctx['library'].fork(ctx['account'], str(args.get('id') or ''))}


def _tool_python_delete_script(args, ctx):
    _require_python(ctx)
    return {'deleted': ctx['library'].delete(ctx['account'], str(args.get('id') or ''))}


def _tool_python_files(args, ctx):
    _require_python(ctx)
    from pathlib import Path

    root = Path(str(ctx['workspace'].describe().get('folder') or ''))
    if not root.exists():
        return {'files': []}
    return {'files': [str(path) for path in root.rglob('*') if path.is_file() and 'runs' not in path.parts][:200]}


def _tool_python_read(args, ctx):
    _require_python(ctx)
    return ctx['workspace'].read(str(args.get('path') or ''))


def _tool_python_write(args, ctx):
    _require_python(ctx)
    return ctx['workspace'].write(str(args.get('path') or ''), str(args.get('content') or ''))


def _tool_python_run(args, ctx):
    _require_python(ctx)
    code = str(args.get('code') or '')
    script_id = str(args.get('script_id') or '')
    if script_id:
        code = ctx['library'].code(ctx['account'], script_id)
        if not code:
            raise AIError('python.scriptMissing', kind='not_found', key='python.scriptMissing', reason=script_id)
    try:
        return python_runtime.run_code(
            code,
            rows=args.get('rows') or [],
            args=args.get('args') or {},
            timeout=int(args.get('timeout') or 10),
            python_bin=str(ctx['settings'].get('python.path', '') or ''),
            cancel_event=ctx.get('cancel_event'),
        )
    except (RuntimeError, ValueError, TimeoutError) as exc:
        raise AIError('python.failed', kind='refused', key='python.failed', reason=str(exc)) from exc


def _tool_web_search(args, ctx):
    results = ctx['host'].search(str(args.get('query') or ''), int(args.get('limit') or 3))
    if not results:
        raise AIError(
            'search.unavailable', kind='capability', key='search.unavailable', reason='this host has no search service'
        )
    return {'results': results}


def _tool_fetch_url(args, ctx):
    try:
        text = ctx['host'].fetch(str(args.get('url') or ''))
    except NotImplementedError as exc:
        raise AIError('fetch.unavailable', kind='capability', key='fetch.unavailable', reason=str(exc)) from exc
    return {'text': clip(text, 8000)}


def _tool_history_search(args, ctx):
    term = str(args.get('query') or '').strip().lower()
    if not term:
        raise AIError('history.empty', kind='refused', key='history.empty')
    conversation = ctx['store'].get_conversation(ctx.get('conversation_id', ''), ctx.get('account', ''))
    if not conversation:
        return {'results': []}
    results = []
    from .types import message_text

    for message in ctx['store'].list_messages(conversation['id']):
        text = message_text(message)
        if term in text.lower():
            results.append({'role': message['role'], 'text': clip(text, 1200)})
        if len(results) >= 10:
            break
    return {'results': results}


GENERIC_HANDLERS = {
    'project_facts': _tool_project_facts,
    'capabilities': _tool_capabilities,
    'docs_search': _tool_docs_search,
    'workspace_info': _tool_workspace_info,
    'workspace_list': _tool_workspace_list,
    'workspace_read': _tool_workspace_read,
    'workspace_write': _tool_workspace_write,
    'workspace_import': _tool_workspace_import,
    'run_cmd': _tool_run_cmd,
    'python_status': _tool_python_status,
    'python_scripts': _tool_python_scripts,
    'python_script': _tool_python_script,
    'python_save_script': _tool_python_save_script,
    'python_fork_script': _tool_python_fork_script,
    'python_delete_script': _tool_python_delete_script,
    'python_files': _tool_python_files,
    'python_read': _tool_python_read,
    'python_write': _tool_python_write,
    'python_run': _tool_python_run,
    'web_search': _tool_web_search,
    'fetch_url': _tool_fetch_url,
    'history_search': _tool_history_search,
}


def generic_specs() -> list[ToolSpec]:
    """Declare every generic tool in one place. Schemas are intentionally small."""

    def obj(required=(), **props):
        return {
            'type': 'object',
            'properties': {key: {'type': value} for key, value in props.items()},
            'required': list(required),
        }

    # (name, description, properties, mutating). Mutating local tools are local_only so a cloud
    # host hides them from schemas() — a UI entry that cannot work must not be offered.
    declarations = [
        ('project_facts', 'Read the generated project facts. Never hand-write a second list.', {}, False),
        ('capabilities', 'Read host and provider capabilities.', {}, False),
        ('docs_search', 'Keyword-search the host documentation.', {'query': 'string', 'limit': 'integer'}, False),
        ('workspace_info', 'Show whether a working folder is configured.', {}, False),
        ('workspace_list', 'List names in a folder inside the working folder.', {'path': 'string'}, False),
        ('workspace_read', 'Read a text file inside the working folder.', {'path': 'string'}, True),
        (
            'workspace_write',
            'Write a text file inside the working folder.',
            {'path': 'string', 'content': 'string'},
            True,
        ),
        ('workspace_import', 'Import a local file through the host importer.', {'path': 'string'}, True),
        ('run_cmd', 'Run one allow-listed command; no shell, no pipes.', {'command': 'string', 'cwd': 'string'}, True),
        ('python_status', 'Read the Python interpreter status.', {}, False),
        ('python_scripts', 'List the saved Python scripts.', {}, False),
        ('python_script', 'Read one saved script by id.', {'id': 'string'}, False),
        (
            'python_save_script',
            'Save a script to the library.',
            {'id': 'string', 'name': 'string', 'code': 'string'},
            True,
        ),
        ('python_fork_script', 'Fork a saved script without overwriting it.', {'id': 'string'}, True),
        ('python_delete_script', 'Delete a saved script.', {'id': 'string'}, True),
        ('python_files', 'List Python files in the working folder.', {}, False),
        ('python_read', 'Read a text file for the Python workspace.', {'path': 'string'}, True),
        ('python_write', 'Write a text file in the Python workspace.', {'path': 'string', 'content': 'string'}, True),
        (
            'python_run',
            'Run a bounded Python script over JSON Lines rows.',
            {'code': 'string', 'script_id': 'string', 'rows': 'array', 'args': 'object'},
            True,
        ),
        ('web_search', 'Search the web through the host service.', {'query': 'string'}, False),
        ('fetch_url', 'Fetch a URL as text through the host service.', {'url': 'string'}, False),
        ('history_search', 'Search this conversation transcript.', {'query': 'string'}, False),
    ]
    specs = []
    for name, description, props, mutating in declarations:
        required = (
            ('path',)
            if name in ('workspace_read', 'workspace_write', 'workspace_import', 'python_read', 'python_write')
            else ()
        )
        specs.append(
            ToolSpec(
                name,
                description,
                obj(required, **props),
                permission='write:workspace' if mutating else 'read:project',
                handler=GENERIC_HANDLERS[name],
                mutating=mutating,
                local_only=name in LOCAL_ONLY_GENERIC,
            )
        )
    return specs


LOCAL_ONLY_GENERIC = frozenset(
    {
        'workspace_info',
        'workspace_list',
        'workspace_read',
        'workspace_write',
        'workspace_import',
        'run_cmd',
        'python_status',
        'python_scripts',
        'python_script',
        'python_save_script',
        'python_fork_script',
        'python_delete_script',
        'python_files',
        'python_read',
        'python_write',
        'python_run',
    }
)


class ToolRegistry:
    def __init__(self, store, host, settings, context, workspace_provider, scopes=None, library=None):
        self.store = store
        self.host = host
        self.settings = settings
        self.context = context
        self.workspace_provider = workspace_provider
        self.scopes = scopes
        self.library = library
        self._extra: dict[str, ToolSpec] = {}
        self._specs: dict[str, ToolSpec] = {spec.name: spec for spec in generic_specs()}
        self._specs.update({spec.name: spec for spec in control_specs()})

    def register(self, spec: ToolSpec, *, owner: str = '') -> None:
        if spec.name in CONTROL_TOOLS:
            raise AIError('tool.reserved', kind='refused', key='tool.reserved', reason=spec.name)
        if spec.name in self._specs or spec.name in self._extra:
            raise AIError('tool.builtinConflict', kind='refused', key='tool.builtinConflict', reason=spec.name)
        self._extra[spec.name] = spec
        if owner and self.scopes is not None:
            self.scopes.remember(spec.name, owner)

    def unregister(self, name: str) -> None:
        self._extra.pop(name, None)
        if self.scopes is not None:
            self.scopes.forget(name)

    def get(self, name: str, account: str = '') -> ToolSpec | None:
        spec = self._extra.get(name) or self._specs.get(name)
        if spec is None:
            return None
        if account and self.scopes is not None and name in self._extra:
            if not self.scopes.visible(name, account):
                raise AIError('tool.unknown', kind='refused', key='tool.unknown', reason=name)
        return spec

    def schemas(self, allowed: set[str] | None = None) -> list[dict]:
        """Control tools are always present; domain/generic tools respect the skill allowlist."""
        specs = [self._specs[name] for name in CONTROL_TOOLS]
        cloud = self.host.environment().cloud
        for name, spec in {**self._specs, **self._extra}.items():
            if name in CONTROL_TOOLS:
                continue
            if allowed is not None and name not in allowed:
                continue
            if spec.local_only and cloud:
                continue
            specs.append(spec)
        return [spec.schema() for spec in specs]

    def check(self, name: str, ctx: dict) -> ToolSpec:
        account = str(ctx.get('account') or '')
        spec = self.get(name, account)
        if spec is None:
            raise AIError(f'tool.unknown: {name}', kind='refused', key='tool.unknown', reason=name)
        if spec.local_only and self.host.environment().cloud:
            raise AIError('tool.cloudRefused', kind='capability', key='tool.cloudRefused', reason=name)
        return spec

    def execute(self, name: str, args: dict, ctx: dict, *, allowed: set[str] | None = None) -> dict:
        if allowed is not None and name not in allowed and name not in CONTROL_TOOLS:
            raise AIError(
                f'tool.notOffered: {name}',
                kind='refused',
                key='tool.notOffered',
                reason=name,
                detail='not offered in this turn',
            )
        spec = self.check(name, ctx)
        handler = spec.handler
        if handler is None:
            raise AIError('tool.noHandler', kind='refused', key='tool.noHandler', reason=name)
        runtime_ctx = {
            'store': self.store,
            'host': self.host,
            'settings': self.settings,
            'context': self.context,
            'workspace': self.workspace_provider(ctx.get('account', 'default')),
            'account': ctx.get('account', 'default'),
            'conversation_id': ctx.get('conversation_id', ''),
            'provider_id': ctx.get('provider_id', ''),
            'cancel_event': ctx.get('cancel_event'),
            'library': self.library,
        }
        try:
            result = handler(args or {}, runtime_ctx)
        except AIError:
            raise
        except (KeyError, TypeError, ValueError, NotImplementedError) as exc:
            raise AIError('tool.badArgs', kind='refused', key='tool.badArgs', reason=f'{name}: {exc}') from exc
        if not isinstance(result, dict):
            result = {'result': result}
        limit = int(self.settings.get('tools.max_result_chars', 12000))
        rendered = str(result)
        if len(rendered) > limit:
            return {'result': rendered[:limit], 'truncated': True, 'tool': name}
        return result
