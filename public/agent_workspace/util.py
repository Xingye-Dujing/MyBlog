"""Small, dependency-free helpers used across layers.

The two non-obvious functions here — ``iter_utf8_lines`` and ``iter_sse_frames`` — exist because
most HTTP clients decode an event-stream per chunk as ISO-8859-1. Chinese text then arrives as
mojibake and a multi-byte character split over two chunks breaks JSON parsing. Decode incrementally
on this side, which is the side that knows the wire is UTF-8.
"""

from __future__ import annotations

import codecs
import json
import os
import re
from datetime import datetime, time, timezone

UTC = timezone.utc

SECRET = re.compile(r'(sk-[A-Za-z0-9_-]{8,}|oc_sk_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})')
CJK = re.compile(r'[\u3400-\u9fff]')


def estimate_tokens(text: str) -> int:
    """A cheap estimate: CJK runs near one token per character, Latin near four."""
    if not text:
        return 0
    cjk = len(CJK.findall(text))
    return max(1, cjk + (len(text) - cjk) // 4)


def redact(text) -> str:
    return SECRET.sub('[redacted]', str(text or ''))


def clip(text, limit: int) -> str:
    text = str(text or '')
    return text if len(text) <= limit else text[:limit] + '\n…'


def safe_filename(name) -> str:
    cleaned = re.sub(r'[^\w.\- ]+', '_', os.path.basename(str(name or 'file')))
    return cleaned[:120] or 'file'


def canonical_json(value) -> str:
    """Stable form for fingerprints: key order is not part of a request."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), default=str)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def local_day_start_utc() -> str:
    """Midnight of the server's LOCAL day, in UTC — a budget's "day" is the operator's day."""
    local = datetime.now().astimezone()
    midnight = datetime.combine(local.date(), time.min, tzinfo=local.tzinfo)
    return midnight.astimezone(UTC).isoformat()


def iter_utf8_lines(chunks, cancel_event=None):
    """Yield text lines from byte chunks, decoding UTF-8 incrementally."""
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    buffer = ''
    for chunk in chunks:
        if cancel_event is not None and getattr(cancel_event, 'is_set', lambda: False)():
            return
        if not chunk:
            continue
        buffer += decoder.decode(chunk)
        while '\n' in buffer:
            line, buffer = buffer.split('\n', 1)
            yield line[:-1] if line.endswith('\r') else line
    tail = buffer + decoder.decode(b'', final=True)
    if tail:
        yield tail[:-1] if tail.endswith('\r') else tail


def iter_sse_frames(chunks, cancel_event=None):
    """Yield ``('message', payload)`` for each SSE data frame; ``[DONE]`` ends the stream."""
    data_lines: list[str] = []
    for line in iter_utf8_lines(chunks, cancel_event):
        if line == '':
            if not data_lines:
                continue
            payload = '\n'.join(data_lines)
            data_lines = []
            if payload.strip() == '[DONE]':
                return
            try:
                yield 'message', json.loads(payload)
            except ValueError as exc:
                raise ValueError(f'bad provider frame: {payload[:200]}') from exc
            continue
        if line.startswith(':'):
            continue
        field, _, value = line.partition(':')
        yield_data = value[1:] if value.startswith(' ') else value
        if field == 'data':
            data_lines.append(yield_data)
    if data_lines:
        payload = '\n'.join(data_lines)
        if payload.strip() != '[DONE]':
            try:
                yield 'message', json.loads(payload)
            except ValueError as exc:
                raise ValueError(f'bad provider frame: {payload[:200]}') from exc


def event(event_type: str, **data) -> dict:
    """Build a canonical event. The payload may itself carry a ``kind`` field."""
    return {'type': event_type, **data}
