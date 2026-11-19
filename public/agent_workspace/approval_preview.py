"""Read-only previews for approval cards: show the exact change, not the model's summary."""

from __future__ import annotations

import difflib

from .errors import AIError


def preview_write(workspace, args: dict) -> dict:
    relative = str(args.get('path') or '')
    target = workspace.resolve(relative)
    proposed = str(args.get('content') or '')
    facts = [('resolved path', str(target)), ('new bytes', str(len(proposed.encode('utf-8'))))]
    try:
        existing = workspace.read(relative)['content']
    except AIError:
        existing = ''
    if existing == proposed:
        return {'facts': facts + [('result', 'identical — no change')], 'diff': []}
    before = existing.splitlines()
    after = proposed.splitlines()
    diff = list(difflib.unified_diff(before, after, fromfile=relative, tofile=relative, lineterm=''))
    truncated = len(diff) > 400
    if truncated:
        diff = diff[:400]
    facts.append(('old bytes', str(len(existing.encode('utf-8')))))
    return {
        'facts': facts,
        'diff': diff,
        'truncated': truncated,
        'note': 'large file — the whole content will be replaced' if len(before) > 400 else '',
    }


def preview_cmd(workspace, args: dict) -> dict:
    cwd = str(args.get('cwd') or '')
    resolved = ''
    if cwd:
        try:
            resolved = str(workspace.resolve(cwd, must_exist=True))
        except AIError:
            resolved = cwd
    return {
        'facts': [
            ('command', str(args.get('command') or '')),
            ('cwd', resolved or workspace.root()),
            ('timeout', str(args.get('timeout') or 30)),
        ],
        'diff': [],
    }


def preview_import(workspace, args: dict) -> dict:
    relative = str(args.get('path') or '')
    try:
        target = workspace.resolve(relative, must_exist=True)
        size = target.stat().st_size if target.is_file() else 0
    except AIError as exc:
        return {'facts': [('error', exc.message)], 'diff': []}
    return {'facts': [('file', str(target)), ('size', str(size))], 'diff': []}


def preview(tool: str, args: dict, workspace) -> dict:
    builders = {
        'workspace_write': preview_write,
        'run_cmd': preview_cmd,
        'workspace_import': preview_import,
    }
    builder = builders.get(tool)
    if builder is None:
        return {'facts': [('tool', tool)] + [(str(key), str(value)) for key, value in (args or {}).items()], 'diff': []}
    try:
        return builder(workspace, args)
    except AIError as exc:
        # A preview never interrupts the conversation; it shows the refusal the tool would give.
        return {'facts': [('error', exc.message)], 'diff': []}
