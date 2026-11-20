"""The durable, per-account store: conversations, turns, memory, usage, artifacts and monitors.

One SQLite handle per ``Store`` instance, WAL mode, and a lock around writes. Every id is scoped by
``account`` where it can be, so two accounts sharing one process cannot read each other's history.
Blobs are JSON because a transcript is reloaded, streamed to a client and replayed to a provider —
one shape, three consumers.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

from .util import utc_now

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, title TEXT DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_account ON conversations(account, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    role TEXT NOT NULL, status TEXT DEFAULT 'done', seq INTEGER NOT NULL,
    blocks TEXT NOT NULL, meta TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_account ON memories(account, created_at DESC);
CREATE TABLE IF NOT EXISTS usage (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, account TEXT NOT NULL,
    provider TEXT DEFAULT '', model TEXT DEFAULT '', prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0, calls INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_account ON usage(account, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_conv ON usage(conversation_id);
CREATE TABLE IF NOT EXISTS prefs (
    account TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (account, key)
);
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, account TEXT NOT NULL,
    kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT DEFAULT 'proposed',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, conversation_id TEXT NOT NULL,
    conditions TEXT NOT NULL, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, account TEXT NOT NULL,
    payload TEXT NOT NULL, ack INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, conversation_id TEXT DEFAULT '',
    name TEXT NOT NULL, path TEXT DEFAULT '', size INTEGER DEFAULT 0,
    meta TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, manifest TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS python_scripts (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL,
    inputs TEXT DEFAULT '', outputs TEXT DEFAULT '', tags TEXT DEFAULT '',
    version INTEGER DEFAULT 1, builtin INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
"""

MEMORY_MAX_COUNT = 200
MEMORY_MAX_CHARS = 2000


class Store:
    def __init__(self, path):
        # ``path`` may be a callable. The account's data root is resolved at CALL time, not when the
        # process boots, so one AgentWorkspace can serve several accounts by switching the host's
        # active account. Every read goes through the ``_db`` property, which rebinds on change.
        self._path_provider = path if callable(path) else (lambda: path)
        self.path = Path(self._path_provider())
        self._lock = threading.RLock()
        self._connection = None
        self._connection_path = None
        _ = self._db  # open the first connection now

    @property
    def _db(self):
        target = Path(self._path_provider())
        with self._lock:
            if self._connection is None or target != self._connection_path:
                if self._connection is not None:
                    self._connection.close()
                target.parent.mkdir(parents=True, exist_ok=True)
                connection = sqlite3.connect(str(target), check_same_thread=False)
                connection.row_factory = sqlite3.Row
                connection.execute('PRAGMA journal_mode=WAL')
                connection.executescript(SCHEMA)
                connection.commit()
                self._connection = connection
                self._connection_path = target
                self.path = target
            return self._connection

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
                self._connection_path = None

    def _run(self, sql: str, args=()):
        with self._lock:
            cursor = self._db.execute(sql, args)
            self._db.commit()
            return cursor

    @staticmethod
    def _row(row) -> dict:
        return dict(row) if row is not None else {}

    # ── conversations ──────────────────────────────────────────────────────────

    def create_conversation(self, account: str, title: str = '', conversation_id: str = '') -> dict:
        from .types import new_id

        conversation_id = conversation_id or new_id('conv')
        now = utc_now()
        self._run(
            'INSERT INTO conversations (id, account, title, created_at, updated_at) VALUES (?,?,?,?,?)',
            (conversation_id, account, title, now, now),
        )
        return self.get_conversation(conversation_id, account)

    def get_conversation(self, conversation_id: str, account: str = '') -> dict:
        if not conversation_id:
            return {}
        sql = 'SELECT * FROM conversations WHERE id=?'
        args = [conversation_id]
        if account:
            sql += ' AND account=?'
            args.append(account)
        return self._row(self._db.execute(sql, args).fetchone())

    def list_conversations(
        self, account: str, *, query: str = '', archived: bool = False, limit: int = 50, offset: int = 0
    ) -> list[dict]:
        sql = 'SELECT * FROM conversations WHERE account=? AND archived=?'
        args: list = [account, 1 if archived else 0]
        if query:
            # Escape LIKE metacharacters so a title search is literal.
            escaped = query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
            sql += " AND title LIKE ? ESCAPE '\\'"
            args.append(f'%{escaped}%')
        sql += ' ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?'
        args.extend([limit, offset])
        with self._lock:
            return [self._row(row) for row in self._db.execute(sql, args).fetchall()]

    def patch_conversation(self, conversation_id: str, account: str, **fields) -> dict:
        allowed = {'title', 'pinned', 'archived'}
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return self.get_conversation(conversation_id, account)
        updates['updated_at'] = utc_now()
        assignments = ', '.join(f'{key}=?' for key in updates)
        self._run(
            f'UPDATE conversations SET {assignments} WHERE id=? AND account=?',
            (*updates.values(), conversation_id, account),
        )
        return self.get_conversation(conversation_id, account)

    def delete_conversation(self, conversation_id: str, account: str) -> bool:
        with self._lock:
            self._db.execute('DELETE FROM conversations WHERE id=? AND account=?', (conversation_id, account))
            # Conversation ids are globally unique; only the tables that carry an account column
            # can be scoped by it (messages deliberately have no account column of their own).
            self._db.execute('DELETE FROM messages WHERE conversation_id=?', (conversation_id,))
            for table in ('artifacts', 'usage', 'files'):
                self._db.execute(
                    f'DELETE FROM {table} WHERE conversation_id=? AND account=?', (conversation_id, account)
                )
            self._db.commit()
        return True

    def export_conversation(self, conversation_id: str, account: str, fmt: str = 'json') -> str:
        conv = self.get_conversation(conversation_id, account)
        messages = self.list_messages(conversation_id)
        if fmt == 'md':
            lines = [f'# {conv.get("title") or "Conversation"}', '']
            for message in messages:
                speaker = {'user': 'User', 'assistant': 'Assistant'}.get(message['role'], message['role'])
                from .types import message_text

                lines.extend([f'## {speaker} · {message["created_at"]}', '', message_text(message), ''])
            return '\n'.join(lines)
        return json.dumps({'conversation': conv, 'messages': messages}, ensure_ascii=False, indent=2)

    # ── messages / turns ───────────────────────────────────────────────────────

    def next_seq(self, conversation_id: str) -> int:
        with self._lock:
            row = self._db.execute(
                'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE conversation_id=?',
                (conversation_id,),
            ).fetchone()
        return int(row['n'])

    def append_message(
        self,
        conversation_id: str,
        turn_id: str,
        role: str,
        blocks: list,
        meta: dict | None = None,
        status: str = 'done',
        message_id: str = '',
    ) -> dict:
        from .types import new_id

        message_id = message_id or new_id('msg')
        seq = self.next_seq(conversation_id)
        meta = meta or {}
        self._run(
            """INSERT INTO messages (id, conversation_id, turn_id, role, status, seq, blocks, meta, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                message_id,
                conversation_id,
                turn_id,
                role,
                status,
                seq,
                json.dumps(blocks, ensure_ascii=False),
                json.dumps(meta, ensure_ascii=False),
                utc_now(),
            ),
        )
        self._run('UPDATE conversations SET updated_at=? WHERE id=?', (utc_now(), conversation_id))
        return self.get_message(message_id)

    def get_message(self, message_id: str) -> dict:
        row = self._db.execute('SELECT * FROM messages WHERE id=?', (message_id,)).fetchone()
        return self._decode_message(row)

    def delete_message(self, message_id: str) -> bool:
        cursor = self._run('DELETE FROM messages WHERE id=?', (message_id,))
        return cursor.rowcount > 0

    def list_conversations_all(self) -> list[dict]:
        with self._lock:
            return [self._row(row) for row in self._db.execute('SELECT id FROM conversations').fetchall()]

    @staticmethod
    def _decode_message(row) -> dict:
        data = Store._row(row)
        if not data:
            return {}
        data['blocks'] = json.loads(data.get('blocks') or '[]')
        data['meta'] = json.loads(data.get('meta') or '{}')
        return data

    def list_messages(self, conversation_id: str, limit: int = 0) -> list[dict]:
        sql = 'SELECT * FROM messages WHERE conversation_id=? ORDER BY seq'
        args: list = [conversation_id]
        if limit:
            sql = 'SELECT * FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT ?'
            args.append(limit)
            with self._lock:
                rows = self._db.execute(sql, args).fetchall()
            return [self._decode_message(row) for row in reversed(rows)]
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        return [self._decode_message(row) for row in rows]

    def last_message(self, conversation_id: str, role: str = '') -> dict:
        sql = 'SELECT * FROM messages WHERE conversation_id=?'
        args: list = [conversation_id]
        if role:
            sql += ' AND role=?'
            args.append(role)
        sql += ' ORDER BY seq DESC LIMIT 1'
        return self._decode_message(self._db.execute(sql, args).fetchone())

    def update_message(self, message_id: str, *, blocks=None, meta=None, status: str = '') -> dict:
        updates: dict = {}
        if blocks is not None:
            updates['blocks'] = json.dumps(blocks, ensure_ascii=False)
        if meta is not None:
            updates['meta'] = json.dumps(meta, ensure_ascii=False)
        if status:
            updates['status'] = status
        if updates:
            assignments = ', '.join(f'{key}=?' for key in updates)
            self._run(f'UPDATE messages SET {assignments} WHERE id=?', (*updates.values(), message_id))
        return self.get_message(message_id)

    def settle_streams(self, conversation_id: str, status: str = 'interrupted') -> int:
        """Mark unfinished rows when a client disconnects — no vanished answers on reload."""
        cursor = self._run(
            "UPDATE messages SET status=? WHERE conversation_id=? AND status='streaming'",
            (status, conversation_id),
        )
        return cursor.rowcount

    # ── usage ──────────────────────────────────────────────────────────────────

    def record_usage(
        self,
        account: str,
        conversation_id: str,
        provider: str,
        model: str,
        prompt: int = 0,
        completion: int = 0,
        cached: int = 0,
        reasoning: int = 0,
        calls: int = 1,
    ) -> None:
        from .types import new_id

        self._run(
            """INSERT INTO usage (id, conversation_id, account, provider, model, prompt_tokens,
               completion_tokens, cached_tokens, reasoning_tokens, calls, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                new_id('use'),
                conversation_id,
                account,
                provider,
                model,
                prompt,
                completion,
                cached,
                reasoning,
                calls,
                utc_now(),
            ),
        )

    def token_usage(self, *, account: str = '', conversation_id: str = '', since: str = '') -> dict:
        sql = 'SELECT * FROM usage WHERE 1=1'
        args: list = []
        if account:
            sql += ' AND account=?'
            args.append(account)
        if conversation_id:
            sql += ' AND conversation_id=?'
            args.append(conversation_id)
        if since:
            sql += ' AND created_at>=?'
            args.append(since)
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        prompt = sum(int(row['prompt_tokens']) for row in rows)
        completion = sum(int(row['completion_tokens']) for row in rows)
        return {
            'prompt_tokens': prompt,
            'completion_tokens': completion,
            'tokens': prompt + completion,
            'calls': len(rows),
        }

    def conversation_usage(self, conversation_id: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                """SELECT provider, model, SUM(prompt_tokens) AS prompt_tokens,
                   SUM(completion_tokens) AS completion_tokens, SUM(cached_tokens) AS cached_tokens,
                   SUM(reasoning_tokens) AS reasoning_tokens, SUM(calls) AS calls
                   FROM usage WHERE conversation_id=? GROUP BY provider, model""",
                (conversation_id,),
            ).fetchall()
        return [self._row(row) for row in rows]

    # ── memories ───────────────────────────────────────────────────────────────

    def add_memory(self, account: str, text: str) -> dict:
        """Return ``{... row, 'duplicate': bool}``; caps refuse by name, never truncate."""
        from .types import new_id

        text = str(text or '').strip()
        if not text:
            raise ValueError('empty memory')
        if len(text) > MEMORY_MAX_CHARS:
            raise ValueError('memory.tooLong')
        with self._lock:
            existing = self._db.execute('SELECT * FROM memories WHERE account=? AND text=?', (account, text)).fetchone()
            if existing:
                return {**self._row(existing), 'duplicate': True}
            count = self._db.execute('SELECT COUNT(*) AS n FROM memories WHERE account=?', (account,)).fetchone()['n']
            if int(count) >= MEMORY_MAX_COUNT:
                raise ValueError('memory.full')
            row_id = new_id('mem')
            self._db.execute(
                'INSERT INTO memories (id, account, text, created_at) VALUES (?,?,?,?)',
                (row_id, account, text, utc_now()),
            )
            self._db.commit()
            created = self._db.execute('SELECT * FROM memories WHERE id=?', (row_id,)).fetchone()
        return {**self._row(created), 'duplicate': False}

    def list_memories(self, account: str, limit: int = 0) -> list[dict]:
        sql = 'SELECT * FROM memories WHERE account=? ORDER BY created_at DESC'
        args: list = [account]
        if limit:
            sql += ' LIMIT ?'
            args.append(limit)
        with self._lock:
            return [self._row(row) for row in self._db.execute(sql, args).fetchall()]

    def delete_memory(self, account: str, memory_id: str) -> bool:
        cursor = self._run('DELETE FROM memories WHERE id=? AND account=?', (memory_id, account))
        return cursor.rowcount > 0

    # ── prefs ──────────────────────────────────────────────────────────────────

    def get_pref(self, account: str, key: str, default: str = '') -> str:
        row = self._db.execute('SELECT value FROM prefs WHERE account=? AND key=?', (account, key)).fetchone()
        return row['value'] if row else default

    def set_pref(self, account: str, key: str, value: str) -> None:
        self._run(
            'INSERT INTO prefs (account, key, value) VALUES (?,?,?) '
            'ON CONFLICT(account, key) DO UPDATE SET value=excluded.value',
            (account, key, str(value)),
        )

    # ── artifacts ──────────────────────────────────────────────────────────────

    def save_artifact(self, account: str, conversation_id: str, kind: str, payload: dict) -> dict:
        from .types import new_id

        artifact_id = new_id('art')
        self._run(
            'INSERT INTO artifacts (id, conversation_id, account, kind, payload, created_at) VALUES (?,?,?,?,?,?)',
            (artifact_id, conversation_id, account, kind, json.dumps(payload, ensure_ascii=False), utc_now()),
        )
        return self.get_artifact(artifact_id)

    def get_artifact(self, artifact_id: str) -> dict:
        row = self._db.execute('SELECT * FROM artifacts WHERE id=?', (artifact_id,)).fetchone()
        data = self._row(row)
        if data:
            data['payload'] = json.loads(data.get('payload') or '{}')
        return data

    def list_artifacts(self, account: str, conversation_id: str = '', limit: int = 0) -> list[dict]:
        sql = 'SELECT * FROM artifacts WHERE account=?'
        args: list = [account]
        if conversation_id:
            sql += ' AND conversation_id=?'
            args.append(conversation_id)
        sql += ' ORDER BY created_at DESC'
        if limit:
            sql += ' LIMIT ?'
            args.append(limit)
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        result = []
        for row in rows:
            data = self._row(row)
            data['payload'] = json.loads(data.get('payload') or '{}')
            result.append(data)
        return result

    # ── user skills (data, never code) ─────────────────────────────────────────

    def save_skill(self, account: str, manifest: dict) -> dict:
        from .types import SKILL_ID_RE

        skill_id = str(manifest.get('id') or '').strip()
        if not SKILL_ID_RE.match(skill_id):
            raise ValueError('invalid skill id')
        if str(manifest.get('prompt') or '').strip().startswith(('import ', 'from ')):
            raise ValueError('a user skill may not contain code')
        # ids are globally unique in the table; without this guard a second account
        # using the same id silently overwrites the first account's skill.
        owner = self._db.execute('SELECT account FROM skills WHERE id=?', (skill_id,)).fetchone()
        if owner is not None and owner['account'] != account:
            raise ValueError('skill id belongs to another account')
        self._run(
            'INSERT INTO skills (id, account, manifest, created_at) VALUES (?,?,?,?) '
            'ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest',
            (skill_id, account, json.dumps(manifest, ensure_ascii=False), utc_now()),
        )
        return {'id': skill_id, 'account': account, 'manifest': manifest}

    def list_user_skills(self, account: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                'SELECT manifest FROM skills WHERE account=? ORDER BY created_at', (account,)
            ).fetchall()
        result = []
        for row in rows:
            manifest = json.loads(row['manifest'])
            manifest['id'] = str(manifest.get('id') or '')
            result.append(manifest)
        return result

    def delete_skill(self, account: str, skill_id: str) -> bool:
        cursor = self._run('DELETE FROM skills WHERE id=? AND account=?', (skill_id, account))
        return cursor.rowcount > 0

    # ── monitors and deliveries ────────────────────────────────────────────────

    def create_monitor(self, account: str, conversation_id: str, conditions: dict) -> dict:
        from .types import new_id

        monitor_id = new_id('mon')
        self._run(
            'INSERT INTO monitors (id, account, conversation_id, conditions, created_at) VALUES (?,?,?,?,?)',
            (monitor_id, account, conversation_id, json.dumps(conditions, ensure_ascii=False), utc_now()),
        )
        return self.get_monitor(monitor_id)

    def get_monitor(self, monitor_id: str) -> dict:
        row = self._db.execute('SELECT * FROM monitors WHERE id=?', (monitor_id,)).fetchone()
        data = self._row(row)
        if data:
            data['conditions'] = json.loads(data.get('conditions') or '{}')
        return data

    def list_monitors(self, account: str, status: str = 'active') -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                'SELECT * FROM monitors WHERE account=? AND status=? ORDER BY created_at DESC',
                (account, status),
            ).fetchall()
        result = []
        for row in rows:
            data = self._row(row)
            data['conditions'] = json.loads(data.get('conditions') or '{}')
            result.append(data)
        return result

    def stop_monitor(self, account: str, monitor_id: str) -> bool:
        cursor = self._run("UPDATE monitors SET status='stopped' WHERE id=? AND account=?", (monitor_id, account))
        return cursor.rowcount > 0

    def add_delivery(self, account: str, monitor_id: str, payload: dict) -> dict:
        from .types import new_id

        delivery_id = new_id('del')
        self._run(
            'INSERT INTO deliveries (id, monitor_id, account, payload, created_at) VALUES (?,?,?,?,?)',
            (delivery_id, monitor_id, account, json.dumps(payload, ensure_ascii=False), utc_now()),
        )
        return {'id': delivery_id, 'monitor_id': monitor_id, 'payload': payload}

    def pending_deliveries(self, account: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                'SELECT * FROM deliveries WHERE account=? AND ack=0 ORDER BY created_at', (account,)
            ).fetchall()
        result = []
        for row in rows:
            data = self._row(row)
            data['payload'] = json.loads(data.get('payload') or '{}')
            result.append(data)
        return result

    def ack_delivery(self, account: str, delivery_id: str) -> bool:
        cursor = self._run('UPDATE deliveries SET ack=1 WHERE id=? AND account=?', (delivery_id, account))
        return cursor.rowcount > 0

    # ── files ──────────────────────────────────────────────────────────────────

    def add_file(
        self,
        account: str,
        name: str,
        path: str = '',
        size: int = 0,
        conversation_id: str = '',
        meta: dict | None = None,
    ) -> dict:
        from .types import new_id

        file_id = new_id('file')
        self._run(
            'INSERT INTO files (id, account, conversation_id, name, path, size, meta, created_at) '
            'VALUES (?,?,?,?,?,?,?,?)',
            (
                file_id,
                account,
                conversation_id,
                name,
                path,
                size,
                json.dumps(meta or {}, ensure_ascii=False),
                utc_now(),
            ),
        )
        return self.get_file(file_id)

    def get_file(self, file_id: str) -> dict:
        row = self._db.execute('SELECT * FROM files WHERE id=?', (file_id,)).fetchone()
        data = self._row(row)
        if data:
            data['meta'] = json.loads(data.get('meta') or '{}')
        return data

    def list_files(self, account: str, conversation_id: str = '') -> list[dict]:
        sql = 'SELECT * FROM files WHERE account=?'
        args: list = [account]
        if conversation_id:
            sql += ' AND conversation_id=?'
            args.append(conversation_id)
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        result = []
        for row in rows:
            data = self._row(row)
            data['meta'] = json.loads(data.get('meta') or '{}')
            result.append(data)
        return result

    def delete_file(self, account: str, file_id: str) -> bool:
        cursor = self._run('DELETE FROM files WHERE id=? AND account=?', (file_id, account))
        return cursor.rowcount > 0

    # ── python script library (data, never a sandbox) ──────────────────────────

    def save_script(self, account: str, payload: dict) -> dict:
        from .types import new_id

        script_id = str(payload.get('id') or '').strip() or new_id('script')
        owner = self._db.execute('SELECT account FROM python_scripts WHERE id=?', (script_id,)).fetchone()
        if owner is not None and owner['account'] != account:
            raise ValueError('script id belongs to another account')
        existing = self.get_script(script_id, account)
        version = int(existing.get('version') or 0) + 1
        row = {
            'id': script_id,
            'account': account,
            'name': str(payload.get('name') or script_id),
            'code': str(payload.get('code') or ''),
            'inputs': str(payload.get('inputs') or ''),
            'outputs': str(payload.get('outputs') or ''),
            'tags': str(payload.get('tags') or ''),
            'version': version,
            'builtin': 0,
        }
        self._run(
            """INSERT INTO python_scripts (id, account, name, code, inputs, outputs, tags, version, builtin, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code,
                   inputs=excluded.inputs, outputs=excluded.outputs, tags=excluded.tags,
                   version=excluded.version""",
            (
                row['id'],
                row['account'],
                row['name'],
                row['code'],
                row['inputs'],
                row['outputs'],
                row['tags'],
                row['version'],
                row['builtin'],
                utc_now(),
            ),
        )
        return self.get_script(script_id, account)

    def get_script(self, script_id: str, account: str = '') -> dict:
        sql = 'SELECT * FROM python_scripts WHERE id=?'
        args: list = [script_id]
        if account:
            sql += ' AND account=?'
            args.append(account)
        return self._row(self._db.execute(sql, args).fetchone())

    def list_scripts(self, account: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                'SELECT * FROM python_scripts WHERE account=? ORDER BY builtin DESC, name', (account,)
            ).fetchall()
        return [self._row(row) for row in rows]

    def delete_script(self, account: str, script_id: str) -> bool:
        cursor = self._run('DELETE FROM python_scripts WHERE id=? AND account=? AND builtin=0', (script_id, account))
        return cursor.rowcount > 0
