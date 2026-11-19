"""Real-machine integration check against a LOCAL Ollama model — strictly one question at a time.

Run it with the project's venv (never the global interpreter):

    .venv/Scripts/python.exe -X utf8 tests/live_ollama_check.py --model qwen3.5:2b
    .venv/Scripts/python.exe -X utf8 tests/live_ollama_check.py --quick      # fewer model turns

Design constraints
------------------
* Every model interaction is a **single** `ask()` call with a **single** question. Calls are made
  sequentially; no concurrency, no batching, no parallel tool calls. A `SerialGate` asserts that
  at most one question is in flight, and the script exits non-zero if that invariant is broken.
* The model questions are deliberately short — the default is a small-but-capable local model
  (``qwen3.5:2b``); override with ``--model``.
* Scenarios that need reliable tool calling can report SKIP when a small model declines to call a
  tool; an engine failure is still a FAIL. This keeps the check honest on modest hardware.
* The script does not modify the global environment: it uses the framework package in this repo
  and the local Ollama daemon at 127.0.0.1:11434 only.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import threading
from pathlib import Path

import requests

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# Running this file directly puts tests/ on sys.path; add the project root so the package resolves.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_workspace import (  # noqa: E402
    AgentWorkspace,
    ChatRequest,
    DefaultHostAdapter,
    EventBus,
    HostEnvironment,
)

OLLAMA = 'http://127.0.0.1:11434'
MODEL = ''
RESULTS: list[tuple[str, str, str]] = []  # (status, name, note)


class LiveHost(DefaultHostAdapter):
    def facts(self) -> dict:
        return {
            'summary': '项目名称是 AgentWorkbench。规则：未知 id 必须按名字拒绝，不能静默降级。',
            '节点': 'source, clean, chart',
        }

    def capabilities(self) -> dict:
        return {'canvas': True, 'local_tools': True}

    def event_bus(self) -> EventBus:
        if not hasattr(self, '_bus'):
            self._bus = EventBus()
        return self._bus

    def apply_artifact(self, kind: str, payload: dict) -> dict:
        return {'kind': kind, 'applied': True}


class SerialGate:
    """Fail loudly if a second question starts while one is still in flight."""

    def __init__(self):
        self.active = 0
        self.peak = 0
        self.questions = 0

    def __enter__(self):
        self.active += 1
        self.peak = max(self.peak, self.active)
        if self.active > 1:
            raise RuntimeError('two questions were in flight at once')
        return self

    def __exit__(self, *exc):
        self.active -= 1
        return False


GATE = SerialGate()


class Skip(Exception):
    pass


def ask_once(
    ws: AgentWorkspace,
    question: str,
    *,
    conversation_id: str = '',
    skill: str = '',
    cancel=None,
    retries: int = 3,
    **kwargs,
) -> tuple[list[dict], str]:
    """One question at a time. A tiny model sometimes returns no answer; retry SEQUENTIALLY."""
    # Plain Q&A scenarios are chat-only: no tools, so a small model cannot wander into a tool
    # round. The tool-round scenario opts back in explicitly with context_payload={'chat_only': False}.
    payload = {'chat_only': True, 'disable_questions': True}
    payload.update(kwargs.pop('context_payload', {}))
    for attempt in range(retries):
        with GATE:
            GATE.questions += 1
            request = ChatRequest(
                text=question,
                account='default',
                provider='ollama',
                model=MODEL,
                conversation_id=conversation_id,
                skill=skill,
                cancel_event=cancel,
                timeout=90,
                context_payload=payload,
                **kwargs,
            )
            events = list(ws.ask(request))
        answer = ''.join(str(item.get('text') or '') for item in events if item['type'] == 'text_delta')
        errored = any(item['type'] == 'error' for item in events)
        if not errored and (answer.strip() or any(item['type'] == 'tool_result' for item in events)):
            return events, answer
        if attempt == retries - 1:
            return events, answer
    return events, answer


def check(name: str, fn):
    try:
        note = fn()
    except Skip as exc:
        status, note = 'SKIP', str(exc)
    except Exception as exc:  # noqa: BLE001 - a real-machine check reports everything
        status, note = 'FAIL', f'{type(exc).__name__}: {exc}'
    else:
        status = 'PASS'
    RESULTS.append((status, name, note))
    print(f'[{status}] {name}' + (f' — {note}' if note else ''), flush=True)


# ── scenarios ───────────────────────────────────────────────────────────────────


def probe_environment():
    response = requests.get(f'{OLLAMA}/api/tags', timeout=10)
    response.raise_for_status()
    models = response.json().get('models') or []
    if not models:
        raise RuntimeError('no local Ollama models are installed')
    names = sorted((item.get('name') or '') for item in models)
    chosen = MODEL or next((name for name in names if name.startswith('qwen3.5:2b')), names[0])
    globals()['MODEL'] = chosen
    info = requests.post(f'{OLLAMA}/api/show', json={'name': chosen}, timeout=10)
    caps = []
    if info.status_code == 200:
        caps = sorted(info.json().get('capabilities') or [])
    # Verify the framework reads the same capability list.
    from agent_workspace.providers.ollama import OllamaProvider

    provider = OllamaProvider()
    seen = sorted(provider.model_caps(chosen, OLLAMA).get('capabilities', set()))
    assert caps == seen, (caps, seen)
    assert provider.context_window(chosen) > 0
    listed = provider.list_models(host=OLLAMA)
    assert any(item['id'] == chosen for item in listed)
    return f'{chosen}; capabilities={caps}; window={provider.context_window(chosen)}'


def make_workspace(data_dir: Path) -> AgentWorkspace:
    ws = AgentWorkspace(LiveHost(data_dir=data_dir, lang='zh'))
    ws.settings.set('chat.default_provider', 'ollama')
    ws.settings.set('chat.default_model', MODEL)
    return ws


WS = None
DATA_DIR = None


def bootstrap():
    data = WS.bootstrap('default', 'ollama')
    ids = {item['id'] for item in data['providers']}
    assert 'ollama' in ids, ids
    names = {item['name'] for item in data['tools']}
    assert 'project_facts' in names and 'ask_user_question' in names
    assert data['runtime']['ollama'] is True
    return f'{len(ids)} providers, {len(names)} tools, runtime={data["runtime"]["kind"]}'


def basic_chat():
    events, answer = ask_once(WS, '请只回答两个字：你好')
    kinds = [item['type'] for item in events]
    assert kinds[0] == 'meta' and kinds[-1] == 'done', kinds[-3:]
    assert answer.strip(), 'the model returned no text'
    assert any(item['type'] == 'user' for item in events)
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    rows = WS.messages(conversation_id)
    assert [row['role'] for row in rows] == ['user', 'assistant']
    return f'answer={answer.strip()[:24]!r}; turn rows={len(rows)}'


def context_visibility():
    events, answer = ask_once(WS, '项目事实里说这个项目叫什么名字？只回答名字。')
    assert 'AgentWorkbench' in answer, f'context did not reach the model: {answer!r}'
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    user_row = WS.messages(conversation_id)[0]
    assert user_row['meta']['context_text'], 'the replay block was not stored on the user row'
    return f'context reached the model; answer={answer.strip()[:32]!r}'


def memory_recall():
    WS.add_memory('default', '我喜欢的颜色是蓝色。')
    _events, answer = ask_once(WS, '我喜欢的颜色是什么？只回答颜色。')
    assert '蓝' in answer, f'memory did not reach the model: {answer!r}'
    return f'answer={answer.strip()[:24]!r}'


def conversation_continuity():
    conversation_id = WS.store.create_conversation('default', title='连续问答')['id']
    ask_once(WS, '我的名字是小明。', conversation_id=conversation_id)
    _events, answer = ask_once(WS, '我叫什么？只回答名字。', conversation_id=conversation_id)
    rows = WS.messages(conversation_id)
    roles = [row['role'] for row in rows]
    assert roles.count('user') >= 2 and roles.count('assistant') >= 2, roles
    assert '小明' in answer, f'the model lost the previous turn: {answer!r}'
    return f'{len(rows)} rows across 2 serial turns; answer={answer.strip()[:24]!r}'


def tool_round():
    """A real tool round. Small models often decline; that is reported as SKIP, not a defect."""
    events, _answer = ask_once(
        WS,
        '请调用 project_facts 工具读取项目事实，然后只回答“完成”。',
        skill='general',
        context_payload={'chat_only': False},
    )
    if not any(item['type'] == 'tool_result' for item in events):
        raise Skip(f'model {MODEL} did not call a tool (no tool_result event); engine path unchanged')
    rows = []
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    for row in WS.messages(conversation_id):
        rows.extend(block.get('type') for block in row['blocks'])
    assert 'tool_use' in rows and 'tool_result' in rows, rows
    return 'tool_use + tool_result persisted in one turn_id'


def stop_cleanly():
    cancel = threading.Event()

    def consume():
        count = 0
        for item in WS.ask(
            ChatRequest(
                text='请慢慢说一段话。',
                account='default',
                provider='ollama',
                model=MODEL,
                cancel_event=cancel,
                timeout=90,
                context_payload={'disable_questions': True},
            )
        ):
            count += 1
            yield item
            if count >= 3 or item['type'] in ('thinking_delta', 'text_delta'):
                cancel.set()

    with GATE:
        GATE.questions += 1
        events = list(consume())
    assert any(item['type'] == 'done' and item.get('stop_reason') == 'cancelled' for item in events), [
        item for item in events if item['type'] == 'done'
    ]
    return 'stop produced a clean done(cancelled), no error event'


def engine_approval():
    data_dir = DATA_DIR / 'approval-work'
    data_dir.mkdir(parents=True, exist_ok=True)
    WS.workspace('default').set_root(str(data_dir))
    from agent_workspace import approval_preview

    preview = approval_preview.preview(
        'workspace_write', {'path': 'x.txt', 'content': 'hello'}, WS.workspace('default')
    )
    assert preview['facts'] and not (data_dir / 'x.txt').exists()
    WS.settings.set('approval.auto', False)
    assert WS.settings.get('approval.auto') is False
    return 'diff preview is read-only; auto-approval toggle works'


def engine_monitor():
    monitor = WS.arm_monitor('alice', 'c1', {'subject': 'run_1', 'events': ['failed'], 'max_triggers': 1})
    WS.publish_event(
        'failed',
        {'account': 'alice', 'subject': 'run_1', 'status': 'failed', 'row_count': 0, 'console': 'secret crawled text'},
    )
    pending = WS.monitors.pending('alice')
    assert len(pending) == 1 and 'secret crawled text' not in json.dumps(pending, ensure_ascii=False)
    assert len(WS.monitors.pending('alice')) == 1
    assert WS.stop_monitor('alice', monitor['id']) is True
    return 'one durable delivery, no crawled text, monitor stopped'


def engine_cloud_refusal():
    WS.host._environment = HostEnvironment(kind='cloud')
    from agent_workspace import AIError

    try:
        WS.tools.execute('run_cmd', {'command': 'echo hi'}, {'account': 'default'})
    except AIError as exc:
        assert exc.kind == 'capability', exc.kind
    else:
        raise AssertionError('cloud host must refuse a local command by name')
    WS.host._environment = HostEnvironment()
    return 'cloud refused run_cmd by name'


def persistence_reload():
    reopened = make_workspace(DATA_DIR)
    try:
        conversations = reopened.conversations('default')
        memories = reopened.store.list_memories('default')
        assert conversations, 'conversations did not survive a reopen'
        assert any('蓝色' in item['text'] for item in memories), 'memories did not survive a reopen'
        return f'{len(conversations)} conversations, {len(memories)} memories reloaded'
    finally:
        reopened.close()


# ── runner ──────────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', default='', help='local Ollama model id (default: smallest qwen3.5)')
    parser.add_argument('--quick', action='store_true', help='skip multi-turn and tool-call scenarios')
    parser.add_argument('--data-dir', default='', help='where the test workspace stores its data')
    args = parser.parse_args()
    globals()['MODEL'] = args.model

    global DATA_DIR, WS
    DATA_DIR = Path(args.data_dir) if args.data_dir else Path(tempfile.mkdtemp(prefix='aw-live-'))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f'Ollama: {OLLAMA}; data dir: {DATA_DIR}', flush=True)

    check('01 local Ollama probe', probe_environment)
    WS = make_workspace(DATA_DIR)
    check('02 bootstrap', bootstrap)
    check('03 one basic question', basic_chat)
    check('04 context reaches the model', context_visibility)
    check('05 long-term memory recall', memory_recall)
    if not args.quick:
        check('06 two serial turns in one conversation', conversation_continuity)
        check('07 real tool round', tool_round)
        check('08 stop mid-answer', stop_cleanly)
    check('09 approval diff preview (engine)', engine_approval)
    check('10 monitor delivery (engine)', engine_monitor)
    check('11 cloud refusal (engine)', engine_cloud_refusal)
    check('12 persistence after reopen', persistence_reload)
    WS.close()

    counts = {status: sum(1 for row in RESULTS if row[0] == status) for status in ('PASS', 'SKIP', 'FAIL')}
    print(
        f'\nSummary: PASS={counts["PASS"]} SKIP={counts["SKIP"]} FAIL={counts["FAIL"]} '
        f'| questions sent={GATE.questions} | peak concurrent={GATE.peak}'
    )
    if GATE.peak != 1:
        print('INVARIANT BROKEN: more than one question was in flight')
        return 2
    return 1 if counts['FAIL'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
