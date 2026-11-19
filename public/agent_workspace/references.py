"""``@`` reference resolution: expand a host object into bounded text, never a raw path.

A reference in a prompt or in an answer to a question is resolved on the server with the same code.
The result is clipped per item and per whole round, so a large table or a long console tail can
never flood the prompt.
"""

from __future__ import annotations

import json
import re

from .util import clip

PATTERN = re.compile(r'@([a-z_]+):([A-Za-z0-9_.\-]+)')
ITEM_CHARS = 1200
TOTAL_CHARS = 6000

KINDS = ('dataset', 'run', 'file', 'artifact', 'conversation')


class References:
    def __init__(self, store, host, context):
        self.store = store
        self.host = host
        self.context = context

    def candidates(self, account: str, query: str = '', limit: int = 20) -> list[dict]:
        """Generic candidates come from the store; domain ones come from the host."""
        rows: list[dict] = []
        for file in self.store.list_files(account):
            rows.append({'kind': 'file', 'id': file['id'], 'label': file['name']})
        for conv in self.store.list_conversations(account, limit=10):
            rows.append({'kind': 'conversation', 'id': conv['id'], 'label': conv.get('title') or conv['id']})
        for artifact in self.store.list_artifacts(account, limit=10):
            rows.append({'kind': 'artifact', 'id': artifact['id'], 'label': f'{artifact["kind"]} · {artifact["id"]}'})
        if query:
            rows = [row for row in rows if query.lower() in str(row['label']).lower()]
        return rows[:limit]

    def _expand_one(self, kind: str, identifier: str, account: str) -> str:
        if kind == 'file':
            row = self.store.get_file(identifier)
            if not row or row.get('account') != account:
                return ''
            path = row.get('path') or row.get('name')
            try:
                from pathlib import Path

                body = Path(path).read_text(encoding='utf-8', errors='replace')
                return f'文件 {row["name"]}\n' + clip(body, ITEM_CHARS)
            except OSError:
                return f'文件 {row["name"]}（内容不可读）'
        if kind == 'artifact':
            row = self.store.get_artifact(identifier)
            if not row or row.get('account') != account:
                return ''
            return f'产物 {row["kind"]}\n' + clip(json.dumps(row['payload'], ensure_ascii=False), ITEM_CHARS)
        if kind == 'conversation':
            row = self.store.get_conversation(identifier, account)
            if not row:
                return ''
            messages = self.store.list_messages(identifier, limit=6)
            from .types import message_text

            return f'会话 {row.get("title") or identifier}\n' + clip(
                '\n'.join(f'{message["role"]}: {message_text(message)}' for message in messages), ITEM_CHARS
            )
        if kind == 'dataset':
            obj = self.host.resolve_dataset(identifier)
            return self._describe(obj, f'数据集 {identifier}')
        if kind == 'run':
            obj = self.host.resolve_run(identifier)
            return self._describe(obj, f'运行 {identifier}')
        return ''

    @staticmethod
    def _describe(obj, title: str) -> str:
        if obj is None:
            return ''
        if isinstance(obj, str):
            text = obj
        elif hasattr(obj, 'to_dict'):
            text = json.dumps(obj.to_dict(), ensure_ascii=False, default=str)
        else:
            try:
                text = json.dumps(dict(obj), ensure_ascii=False, default=str)
            except (TypeError, ValueError):
                text = str(obj)
        return f'{title}\n' + clip(text, ITEM_CHARS)

    def resolve(self, text: str, account: str) -> tuple[str, list[str]]:
        """Return ``(expanded_text, unresolved_names)``; the whole block is capped."""
        matches = PATTERN.findall(str(text or ''))
        if not matches:
            return '', []
        chunks: list[str] = []
        unresolved: list[str] = []
        used = 0
        for kind, identifier in matches:
            if kind not in KINDS:
                unresolved.append(f'@{kind}:{identifier}')
                continue
            body = self._expand_one(kind, identifier, account)
            if not body:
                unresolved.append(f'@{kind}:{identifier}')
                continue
            remaining = TOTAL_CHARS - used
            if remaining <= 0:
                break
            body = clip(body, remaining)
            chunks.append(body)
            used += len(body)
        return '\n\n'.join(chunks), unresolved
