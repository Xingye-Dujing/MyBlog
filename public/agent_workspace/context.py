"""What the model may read, and the one place that decides how much of it fits.

Three layers, always in this order: project facts (stable, so a provider's prefix cache can hit),
live context (built by host-supplied sources from server-owned facts), and conversation memory.
Everything is measured before it is sent; a cut is reported in ``meta`` and shown in the inspector,
so the model is never quietly fed a different project.
"""

from __future__ import annotations

import re
from pathlib import Path

from .util import clip, estimate_tokens, redact

LATIN_TERM = re.compile(r'[A-Za-z0-9_]{3,}')
CJK_RUN = re.compile(r'[\u3400-\u9fff]{2,}')

MEMORY_CONTEXT_LIMIT = 20


class ContextBuilder:
    def __init__(self, store, host, settings):
        self.store = store
        self.host = host
        self.settings = settings

    # ── built-in sources ──────────────────────────────────────────────────────

    def project_facts(self) -> str:
        """A compact, generated map of the host's project — never a hand-written second list."""
        facts = self.host.facts()
        lines = ['# 项目事实']
        summary = str(facts.get('summary') or '').strip()
        if summary:
            lines.append(summary)
        rules = str(facts.get('rules') or '').strip()
        if rules:
            lines.append(f'规则：{rules}')
        for heading, body in facts.items():
            if heading in ('summary', 'rules'):
                continue
            text = str(body).strip()
            if not text:
                continue
            lines.append(f'## {heading}')
            lines.append(text if len(text) < 8000 else text[:8000] + '\n…')
        capabilities = self.host.capabilities()
        if capabilities:
            lines.append('## 宿主能力')
            lines.append(', '.join(str(key) for key, value in sorted(capabilities.items()) if value is True))
        return '\n'.join(lines)

    def _doc_files(self) -> list[tuple[str, Path]]:
        files: list[tuple[str, Path]] = []
        for relative in self.host.doc_roots():
            path = Path(relative)
            if not path.is_absolute():
                path = Path.cwd() / path
            key = str(relative)
            if key.endswith('/'):
                if path.is_dir():
                    for child in sorted(path.rglob('*.md')):
                        files.append((f'{key}{child.relative_to(path).as_posix()}', child))
                continue
            if path.is_file():
                files.append((key, path))
        return files

    def _doc_chunks(self) -> list[tuple[str, str]]:
        chunks: list[tuple[str, str]] = []
        for relative, path in self._doc_files():
            try:
                text = path.read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            title = relative
            current: list[str] = []
            for line in text.splitlines():
                if line.startswith('#'):
                    if current:
                        chunks.append((title, '\n'.join(current).strip()))
                    title = line.lstrip('#').strip() or relative
                    current = []
                else:
                    current.append(line)
            if current:
                chunks.append((title, '\n'.join(current).strip()))
        return [(title, body) for title, body in chunks if body]

    def docs_search(self, query: str, limit: int = 3) -> list[dict]:
        """A small keyword retriever over the host's own docs — no embedding model required."""
        terms = {term.lower() for term in LATIN_TERM.findall(query or '')}
        for run in CJK_RUN.findall(query or ''):
            terms.update(run[index : index + 2] for index in range(len(run) - 1))
        if not terms:
            return []
        scored = []
        for title, body in self._doc_chunks():
            haystack = (title + '\n' + body).lower()
            score = sum(haystack.count(term) for term in terms)
            if score:
                scored.append((score, title, body))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [{'title': title, 'text': clip(body, 2400)} for _score, title, body in scored[:limit]]

    @staticmethod
    def _call_source(source, query: str, payload: dict, account: str) -> str:
        """Pass the account only to sources that declared they need it (host back-compat)."""
        import inspect

        try:
            parameters = inspect.signature(source.build).parameters.values()
            positional = [
                param for param in parameters if param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD)
            ]
            if len(positional) >= 3:
                return str(source.build(query, payload, account) or '')
        except (TypeError, ValueError):
            pass
        return str(source.build(query, payload) or '')

    def _memory_section(self, account: str) -> tuple[str, dict]:
        memories = self.store.list_memories(account, limit=MEMORY_CONTEXT_LIMIT + 1)
        total = len(self.store.list_memories(account))
        shown = memories[:MEMORY_CONTEXT_LIMIT]
        text = '\n'.join(f'- {item["text"]}' for item in shown)
        return text, {'total': total, 'shown': len(shown), 'omitted': max(0, total - len(shown))}

    # ── assembly ──────────────────────────────────────────────────────────────

    def build(self, query: str, account: str = 'default', payload: dict | None = None) -> tuple[str, dict]:
        """Return ``(context_text, meta)``. ``meta`` is what the host inspector renders."""
        payload = payload or {}
        scope = str(self.settings.get('context.scope', 'summary'))
        if payload.get('scope') in ('off', 'summary', 'full'):
            scope = str(payload['scope'])
        if scope == 'off':
            return '', {
                'scope': 'off',
                'items': [],
                'chars': 0,
                'tokens': 0,
                'omitted': [],
                'memories': {'total': 0, 'shown': 0, 'omitted': 0},
            }

        parts: list[tuple[str, str]] = []
        memories_meta = {'total': 0, 'shown': 0, 'omitted': 0}
        if scope in ('summary', 'full'):
            parts.append(('项目事实', self.project_facts()))
            memory_text, memories_meta = self._memory_section(account)
            if memory_text:
                parts.append(('项目记忆', memory_text))
        for source in self.host.context_sources():
            try:
                body = self._call_source(source, query, payload, account)
            except Exception:
                # A host source that fails must not take the whole context down.
                continue
            if body:
                parts.append((source.name, body))
        if scope == 'full':
            for index, doc in enumerate(self.docs_search(query, limit=3), 1):
                parts.append((f'文档 {index}：{doc["title"]}', doc['text']))

        budget = max(2000, int(self.settings.get('context.max_chars', 120000)))
        kept: list[str] = []
        items: list[dict] = []
        omitted: list[str] = []
        used = 0
        for title, text in parts:
            text = redact(text)
            if not text:
                continue
            remaining = budget - used
            if remaining <= 200:
                omitted.append(title)
                continue
            clipped = text if len(text) <= remaining else text[:remaining] + '\n…'
            kept.append(f'## {title}\n{clipped}')
            items.append({'title': title, 'chars': len(clipped), 'truncated': len(clipped) < len(text)})
            used += len(clipped)
        joined = '\n\n'.join(kept)
        return joined, {
            'scope': scope,
            'items': items,
            'chars': len(joined),
            'tokens': estimate_tokens(joined),
            'omitted': omitted,
            'budget': budget,
            'memories': memories_meta,
        }

    def preview(self, query: str, account: str = 'default', payload: dict | None = None) -> dict:
        text, meta = self.build(query, account, payload)
        return {'ok': True, 'context': text, 'meta': meta}

    def for_replay(self, text: str) -> tuple[str, dict]:
        """Clamp the block a turn carries for the rest of the conversation.

        The block is stored on that turn's own user row and replayed with it forever. Provider
        prefix caches match bytes: a block that changes after round one invalidates every later
        message. Its size is therefore fixed when written, and what it drops is reported.
        """
        value = str(text or '')
        limit = max(1000, int(self.settings.get('context.replay_chars', 16000)))
        meta = {'replay_limit': limit, 'replay_chars': min(len(value), limit), 'replay_truncated': len(value) > limit}
        if not meta['replay_truncated']:
            return value, meta
        note = f'\n…[context cut at {limit} chars for replay; read the rest with a tool]'
        return value[:limit] + note, meta
