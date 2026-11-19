"""The per-account working folder: a strict path sandbox plus bounded local verbs.

Every path is resolved and must stay under the chosen root. ``..``, absolute paths and escaping
symlinks are refused by name — never silently clipped. The folder itself is stored in the account's
preferences, so switching accounts switches folders too.
"""

from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path

from .errors import AIError

MAX_READ_BYTES = 256 * 1024
MAX_LIST = 500


class Workspace:
    def __init__(self, store, account: str, root: str | Path | None = None):
        self.store = store
        self.account = account
        if root is not None:
            self.set_root(str(root))

    def describe(self) -> dict:
        folder = self.root()
        return {
            'folder': folder,
            'configured': bool(folder),
            'exists': bool(folder and Path(folder).is_dir()),
            'capability': 'workspace_folder',
        }

    def root(self) -> str:
        return self.store.get_pref(self.account, 'workspace.root', '')

    def set_root(self, path: str) -> dict:
        candidate = Path(path).expanduser()
        try:
            resolved = candidate.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise AIError('workspace.pathMissing', kind='not_found', reason=str(exc)) from exc
        if not resolved.is_dir():
            raise AIError('workspace.notDirectory', kind='not_found')
        self.store.set_pref(self.account, 'workspace.root', str(resolved))
        return self.describe()

    def clear_root(self) -> dict:
        self.store.set_pref(self.account, 'workspace.root', '')
        return self.describe()

    def resolve(self, relative: str = '', *, must_exist: bool = False) -> Path:
        folder = self.root()
        if not folder:
            raise AIError(
                'workspace.notConfigured', kind='capability', reason='no working folder is configured for this account'
            )
        base = Path(folder).resolve()
        target = Path(str(relative or '.'))
        if target.is_absolute():
            raise AIError('workspace.escape', kind='refused', reason='absolute paths are not allowed')
        resolved = (base / target).resolve()
        try:
            resolved.relative_to(base)
        except ValueError as exc:
            raise AIError('workspace.escape', kind='refused', reason='path escapes the working folder') from exc
        if must_exist and not resolved.exists():
            raise AIError('workspace.pathMissing', kind='not_found')
        return resolved

    def list(self, relative: str = '') -> dict:
        target = self.resolve(relative, must_exist=True)
        if not target.is_dir():
            return {'path': relative, 'entries': [], 'truncated': False}
        entries = []
        for child in sorted(target.iterdir(), key=lambda item: item.name.lower()):
            try:
                stat = child.stat()
                entries.append(
                    {
                        'name': child.name,
                        'type': 'directory' if child.is_dir() else 'file',
                        'size': stat.st_size if child.is_file() else 0,
                    }
                )
            except OSError:
                continue
            if len(entries) >= MAX_LIST:
                return {'path': relative, 'entries': entries, 'truncated': True}
        return {'path': relative, 'entries': entries, 'truncated': False}

    def read(self, relative: str, max_bytes: int = MAX_READ_BYTES) -> dict:
        target = self.resolve(relative, must_exist=True)
        if not target.is_file():
            raise AIError('workspace.notFile', kind='not_found')
        size = target.stat().st_size
        if size > max_bytes:
            raise AIError('workspace.tooLarge', kind='refused', reason=f'{size} bytes > {max_bytes}')
        content = target.read_bytes().decode('utf-8', errors='replace')
        return {
            'path': relative,
            'absolute': str(target),
            'size': size,
            'content': content,
            'truncated': len(content.encode('utf-8')) > max_bytes,
        }

    def write(self, relative: str, content: str) -> dict:
        target = self.resolve(relative)
        if target.exists() and not target.is_file():
            raise AIError('workspace.notFile', kind='refused')
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = str(content).encode('utf-8')
        target.write_bytes(payload)
        return {'path': relative, 'absolute': str(target), 'bytes': len(payload), 'created': not target.exists()}

    def snapshot(self) -> str:
        """A short folder notice for the context builder — names only, never contents."""
        folder = self.root()
        if not folder:
            return ''
        try:
            entries = self.list()['entries'][:40]
        except AIError:
            return ''
        lines = [
            f'工作文件夹：{folder}',
            '条目：' + ', '.join(f'{item["name"]}{"/" if item["type"] == "directory" else ""}' for item in entries),
        ]
        return '\n'.join(lines)

    def run(
        self,
        command: str,
        *,
        cwd: str = '',
        allow: tuple[str, ...] = (),
        timeout: int = 30,
        max_bytes: int = 64 * 1024,
        cancel_event=None,
    ) -> dict:
        """Run ONE allow-listed executable — no shell, no pipes, no redirection."""
        if cancel_event is not None and getattr(cancel_event, 'is_set', lambda: False)():
            raise AIError('ai.cancelled', kind='cancelled')
        if not command or not command.strip():
            raise AIError('workspace.emptyCommand', kind='refused')
        if any(token in command for token in ('|', '>', '<', '&&', ';', '`', '$(')):
            raise AIError('workspace.shellSyntax', kind='refused', reason='shell syntax is not allowed')
        try:
            parts = shlex.split(command, posix=True)
        except ValueError as exc:
            raise AIError('workspace.badCommand', kind='refused', reason=str(exc)) from exc
        if not parts:
            raise AIError('workspace.emptyCommand', kind='refused')
        program = os.path.basename(parts[0]).lower()
        if allow and program not in {str(item).lower() for item in allow}:
            raise AIError('workspace.commandNotAllowed', kind='refused', reason=program)
        workdir = str(self.resolve(cwd, must_exist=True)) if cwd else (self.root() or None)
        try:
            result = subprocess.run(
                parts,
                cwd=workdir,
                capture_output=True,
                timeout=timeout,
                check=False,
                shell=False,
            )
        except FileNotFoundError as exc:
            raise AIError('workspace.commandMissing', kind='not_found', reason=program) from exc
        except subprocess.TimeoutExpired as exc:
            raise AIError('workspace.commandTimeout', kind='timeout', reason=str(timeout)) from exc
        output = (result.stdout or b'')[:max_bytes].decode('utf-8', errors='replace')
        error = (result.stderr or b'')[:max_bytes].decode('utf-8', errors='replace')
        return {
            'command': command,
            'cwd': workdir,
            'returncode': result.returncode,
            'stdout': output,
            'stderr': error,
            'truncated': result.returncode is None,
        }
