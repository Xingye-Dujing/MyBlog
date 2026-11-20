"""One script library for the AI tools and the canvas Python node.

A script is data (id, name, code, declared inputs/outputs, version), never inline code stored on a
node. Built-ins are seeded per account on first use and are read-only; a fork never overwrites the
original. The same library feeds ``python_script``/``python_run`` in the chat tools and any host-side
Python node, so a script saved once is runnable everywhere.
"""

from __future__ import annotations

from datetime import datetime, timezone

_PREAMBLE = """import json, os, sys
_rows = [json.loads(x) for x in sys.stdin if x.strip()]
_out = os.environ.get('AGENT_OUTPUT') or os.environ.get('CIXI_OUTPUT') or '/dev/null'
"""

BUILTINS = {
    'passthrough': {
        'name': 'passthrough',
        'inputs': 'any JSON Lines rows',
        'outputs': 'the same rows',
        'tags': 'builtin,utility',
        'code': _PREAMBLE + "\nwith open(_out, 'w', encoding='utf-8') as _f:\n"
        "    for _row in _rows:\n        _f.write(json.dumps(_row, ensure_ascii=False) + '\\n')\n",
    },
    'clean_text': {
        'name': 'clean_text',
        'inputs': 'a text column',
        'outputs': 'a cleaned_text column',
        'tags': 'builtin,text',
        'code': _PREAMBLE
        + """
_args = json.loads(os.environ.get('AGENT_ARGS') or os.environ.get('CIXI_ARGS') or '{}')
_column = str(_args.get('column') or 'text')
with open(_out, 'w', encoding='utf-8') as _f:
    for _row in _rows:
        _row['cleaned_text'] = ' '.join(str(_row.get(_column) or '').split())
        _f.write(json.dumps(_row, ensure_ascii=False) + '\\n')
""",
    },
    'dedupe': {
        'name': 'dedupe',
        'inputs': 'any JSON Lines rows',
        'outputs': 'rows with duplicates removed',
        'tags': 'builtin,utility',
        'code': _PREAMBLE
        + """
_args = json.loads(os.environ.get('AGENT_ARGS') or os.environ.get('CIXI_ARGS') or '{}')
_column = str(_args.get('column') or 'text')
_seen, _kept = set(), []
for _row in _rows:
    _key = str(_row.get(_column) or json.dumps(_row, ensure_ascii=False, sort_keys=True))
    if _key not in _seen:
        _seen.add(_key)
        _kept.append(_row)
with open(_out, 'w', encoding='utf-8') as _f:
    for _row in _kept:
        _f.write(json.dumps(_row, ensure_ascii=False) + '\\n')
""",
    },
    'groupby': {
        'name': 'groupby',
        'inputs': 'a group column and a numeric column',
        'outputs': 'one row per group with a count',
        'tags': 'builtin,analysis',
        'code': _PREAMBLE
        + """
_args = json.loads(os.environ.get('AGENT_ARGS') or os.environ.get('CIXI_ARGS') or '{}')
_by = str(_args.get('column') or 'category')
_groups = {}
for _row in _rows:
    _groups[str(_row.get(_by) or '')] = _groups.get(str(_row.get(_by) or ''), 0) + 1
with open(_out, 'w', encoding='utf-8') as _f:
    for _name, _count in sorted(_groups.items()):
        _f.write(json.dumps({_by: _name, 'count': _count}, ensure_ascii=False) + '\\n')
""",
    },
}


class ScriptLibrary:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def _builtin_id(account: str, identifier: str) -> str:
        # ids are globally unique in the table. Namespace built-ins per account so
        # seeding a second account cannot hit a UNIQUE constraint or overwrite the
        # first account's built-ins.
        return identifier if account in ('', 'default') else '%s:%s' % (account, identifier)

    def _seed(self, account: str) -> None:
        existing = {row['id'] for row in self.store.list_scripts(account)}
        for identifier, payload in BUILTINS.items():
            script_id = self._builtin_id(account, identifier)
            if script_id in existing:
                continue
            self.store._run(
                """INSERT INTO python_scripts
                   (id, account, name, code, inputs, outputs, tags, version, builtin, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    script_id,
                    account,
                    payload['name'],
                    payload['code'],
                    payload['inputs'],
                    payload['outputs'],
                    payload['tags'],
                    1,
                    1,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )

    def all(self, account: str) -> list[dict]:
        self._seed(account)
        rows = self.store.list_scripts(account)
        return [{**row, 'builtin': bool(row.get('builtin'))} for row in rows]

    def get(self, account: str, script_id: str) -> dict:
        self._seed(account)
        row = self.store.get_script(script_id, account)
        if not row and script_id in BUILTINS:
            row = self.store.get_script(self._builtin_id(account, script_id), account)
        return {**row, 'builtin': bool(row.get('builtin'))} if row else {}

    def code(self, account: str, script_id: str) -> str:
        return str(self.get(account, script_id).get('code') or '')

    def save(self, account: str, payload: dict) -> dict:
        script_id = str(payload.get('id') or '').strip()
        if script_id in BUILTINS or script_id in {
            self._builtin_id(account, identifier) for identifier in BUILTINS
        }:
            from .errors import AIError

            raise AIError('python.builtinReadOnly', kind='refused', key='python.builtinReadOnly', reason=script_id)
        return self.store.save_script(account, payload)

    def fork(self, account: str, script_id: str) -> dict:
        source = self.get(account, script_id)
        if not source:
            from .errors import AIError

            raise AIError('python.scriptMissing', kind='not_found', key='python.scriptMissing', reason=script_id)
        payload = {key: source.get(key) for key in ('name', 'code', 'inputs', 'outputs', 'tags')}
        payload['id'] = f'{script_id}_copy'
        payload['name'] = f'{source.get("name") or script_id} (copy)'
        while self.store.get_script(str(payload['id']), account):
            payload['id'] += '_copy'
        return self.store.save_script(account, payload)

    def delete(self, account: str, script_id: str) -> bool:
        return self.store.delete_script(account, script_id)
