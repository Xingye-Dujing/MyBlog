"""Bounded Python execution — a generic extension surface, NOT a sandbox.

The contract: a script reads its input as JSON Lines, writes JSON Lines to the path named by its
output variable, and receives its arguments as JSON in the environment. Both the generic
``AGENT_*`` names and the original product's ``CIXI_*`` names are exported, so an existing script
library keeps running after a host migrates. Output rows, output bytes and wall time are capped. The
child inherits a *scrubbed* environment: an API key in the parent process is never handed to a
script. A host that needs isolation must supply its own runner; this is not a security boundary.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

MAX_ROWS = 1000
MAX_BYTES = 1024 * 1024
CAPTURE_BYTES = 256 * 1024
SECRET_MARKERS = ('KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL')
CONTRACT = {
    'input': 'AGENT_INPUT / CIXI_INPUT (JSON Lines on stdin)',
    'output': 'AGENT_OUTPUT / CIXI_OUTPUT (path to a JSON Lines file)',
    'args': 'AGENT_ARGS / CIXI_ARGS (JSON in the environment)',
}


def interpreter(settings=None) -> str:
    """Resolve the interpreter in one documented order. Empty means 'not available'."""
    if settings:
        configured = str(settings.get('python.path', '') or '').strip()
        if configured and Path(configured).exists():
            return configured
    bin_dir = 'Scripts' if os.name == 'nt' else 'bin'
    candidates = [Path(sys.prefix) / bin_dir / name for name in ('python.exe', 'python', 'python3')]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    for name in ('python3', 'python'):
        found = shutil.which(name)
        if found and 'WindowsApps' not in found:  # the Microsoft Store stub is not an interpreter
            return found
    return ''


def status(settings=None) -> dict:
    binary = interpreter(settings)
    return {
        'available': bool(binary),
        'interpreter': binary,
        'enabled': bool(settings and settings.get('python.allowed', False)),
        'contract': CONTRACT,
        'sandbox': False,
    }


def clean_env(extra: dict | None = None) -> dict:
    """Copy the parent environment without anything that looks like a credential."""
    env = {}
    for key, value in os.environ.items():
        upper = key.upper()
        if any(marker in upper for marker in SECRET_MARKERS):
            continue
        env[key] = value
    env.pop('PYTHONPATH', None)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env.update(extra or {})
    return env


def _drain(stream, sink: dict) -> None:
    """Drain a pipe past the capture cap so a chatty child never blocks on a full pipe."""
    kept: list[bytes] = []
    size = 0
    try:
        while True:
            chunk = stream.read(8192)
            if not chunk:
                break
            if size < CAPTURE_BYTES:
                take = chunk[: CAPTURE_BYTES - size]
                kept.append(take)
                size += len(take)
    finally:
        with contextlib.suppress(Exception):
            stream.close()
        sink['data'] = b''.join(kept)


def _read_output(path: Path, max_rows: int) -> tuple[list, bool]:
    produced: list = []
    if not path.exists():
        return produced, False
    with path.open('rb') as stream:
        raw = stream.read(MAX_BYTES)
    lines = raw.decode('utf-8', errors='replace').splitlines()
    try:
        size = path.stat().st_size
    except OSError:
        size = len(raw)
    truncated = size > MAX_BYTES or len(lines) > max_rows
    for line in lines[:max_rows]:
        try:
            produced.append(json.loads(line))
        except ValueError:
            produced.append({'raw': line[:500]})
    return produced, truncated


def run_code(
    code: str,
    *,
    rows=None,
    args=None,
    timeout: int = 10,
    max_rows: int = MAX_ROWS,
    python_bin: str = '',
    cancel_event=None,
    register=None,
    scope: str = '',
) -> dict:
    """Run one script over bounded rows. Refuse by name when no interpreter exists.

    ``register`` is an optional ``(kind, command, proc, scope) -> id`` hook a host uses to show and
    stop the child from its own process panel. Pipes are drained in threads because stopping the
    read at the byte cap is the classic way to deadlock a script that writes a lot of diagnostics.
    """
    binary = python_bin or interpreter()
    if not binary:
        raise RuntimeError('python.interpreterMissing')
    if not str(code or '').strip():
        raise ValueError('python.emptyCode')
    rows = list(rows or [])
    if len(rows) > max_rows:
        raise ValueError('python.tooManyInputRows')
    payload = '\n'.join(json.dumps(row, ensure_ascii=False, default=str) for row in rows)
    with tempfile.TemporaryDirectory(prefix='agent-python-') as directory:
        output = Path(directory) / 'output.jsonl'
        script = Path(directory) / 'script.py'
        script.write_text(str(code), encoding='utf-8')
        variables = {
            'AGENT_INPUT': 'stdin',
            'CIXI_INPUT': 'stdin',
            'AGENT_OUTPUT': str(output),
            'CIXI_OUTPUT': str(output),
            'AGENT_ARGS': json.dumps(args or {}, ensure_ascii=False),
            'CIXI_ARGS': json.dumps(args or {}, ensure_ascii=False),
        }
        environment = clean_env(variables)
        command = [binary, str(script)]
        started = time.monotonic()
        proc = None
        sinks = ({}, {})
        threads: list[threading.Thread] = []
        try:
            try:
                proc = subprocess.Popen(
                    command,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=environment,
                    cwd=directory,
                )
            except OSError as exc:
                raise RuntimeError('python.spawnFailed') from exc
            if register is not None:
                try:
                    register('python', ' '.join(command), proc, scope)
                except Exception:
                    pass  # the process panel is a host convenience, not part of the contract
            threads = [
                threading.Thread(target=_drain, args=(proc.stdout, sinks[0]), daemon=True),
                threading.Thread(target=_drain, args=(proc.stderr, sinks[1]), daemon=True),
            ]
            for thread in threads:
                thread.start()
            try:
                proc.stdin.write(payload.encode('utf-8'))
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                with contextlib.suppress(Exception):
                    proc.stdin.close()
            while proc.poll() is None:
                if cancel_event is not None and getattr(cancel_event, 'is_set', lambda: False)():
                    _terminate(proc)
                    raise TimeoutError('python.cancelled')
                if time.monotonic() - started > max(1, int(timeout)):
                    _terminate(proc)
                    raise TimeoutError('python.timeout')
                time.sleep(0.05)
            proc.wait()
        finally:
            for thread in threads:
                thread.join(timeout=5)
            if proc is not None and proc.poll() is None:
                _terminate(proc)
        produced, truncated = _read_output(output, max_rows)
        return {
            'rows': produced[:max_rows],
            'row_count': len(produced),
            'truncated': truncated,
            'stdout': sinks[0].get('data', b'')[:MAX_BYTES].decode('utf-8', errors='replace'),
            'stderr': sinks[1].get('data', b'')[:MAX_BYTES].decode('utf-8', errors='replace'),
            'returncode': proc.returncode if proc is not None else -1,
        }


def _terminate(proc) -> None:
    with contextlib.suppress(Exception):
        proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(Exception):
            proc.kill()


def run_script(code_by_id, script_id: str, *, rows=None, args=None, **kwargs) -> dict:
    """Run a saved script by id. A missing id is a named refusal, never an empty result."""
    code = code_by_id(script_id)
    if not code:
        raise ValueError('python.scriptMissing')
    return run_code(code, rows=rows, args=args, **kwargs)
