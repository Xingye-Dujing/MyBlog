# -*- coding: utf-8 -*-
"""Lambda regressions: request security, bounded snapshots and page bridges."""
from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

PUBLIC = Path(__file__).resolve().parent.parent
ROOT = PUBLIC.parent
PAGE = PUBLIC / "index.html"
ORIGIN = "http://localhost"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def lambda_module(tmp_path_factory):
    temp = tmp_path_factory.mktemp("lambda-import")
    overrides = {
        "LAMBDA_PUBLIC_MODE": "0",
        "LAMBDA_ALLOWED_HOSTS": "",
        "LAMBDA_ALLOWED_ORIGINS": "",
        "LAMBDA_SHARE_DB": "off",
        "LAMBDA_SNAPSHOT_DB": str(temp / "sessions.json"),
        "LAMBDA_PAGE_DB": "off",
        "LAMBDA_TOKEN_DB": "off",
    }
    previous = {key: os.environ.get(key) for key in overrides}
    os.environ.update(overrides)
    try:
        return _load("lambda_regressions_module", PUBLIC / "server" / "lambda-app.py")
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@pytest.fixture
def backend(lambda_module, tmp_path, monkeypatch):
    module = lambda_module
    module._kill_all_sessions()
    module._snapshots.clear()
    module._shares.clear()
    module._pages.clear()
    module._tokens.clear()
    module._rate_buckets.clear()
    module.app.config["TESTING"] = True
    binary = tmp_path / "extension.exe"
    binary.write_bytes(b"test interpreter placeholder")
    monkeypatch.setattr(module, "INTERP_BIN", binary)
    monkeypatch.setattr(module, "SNAPSHOT_DB", str(tmp_path / "sessions.json"))
    monkeypatch.setattr(module, "MAX_SNAPSHOT_LINES", 2000)
    monkeypatch.setattr(module, "PUBLIC_MODE", False)
    monkeypatch.setattr(module, "ALLOWED_HOSTS", module._LOOPBACK_HOSTS)
    monkeypatch.setattr(module, "ALLOWED_ORIGINS", frozenset())
    monkeypatch.setattr(module, "RATE_LIMIT", 0)
    monkeypatch.setattr(module, "SESSION_RATE_LIMIT", 12)
    monkeypatch.setattr(module, "EVAL_RATE_LIMIT", 240)
    yield module, module.app.test_client()
    module._kill_all_sessions()
    module._snapshots.clear()
    module._rate_buckets.clear()


def _headers(**extra):
    headers = {"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}
    headers.update(extra)
    return headers


def test_snapshot_write_failure_is_reported_and_rolled_back(backend, monkeypatch):
    module, client = backend
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: ("persist-fail", RecordingInterpreter()))
    monkeypatch.setattr(module, "_save_snapshots_locked", lambda: False)
    response = client.post("/api/eval", json={"session": "persist-fail", "line": "ONE"}, headers=_headers())
    assert response.status_code == 500
    assert response.get_json()["code"] == "snapshot_write_failed"
    assert "persist-fail" not in module._snapshots


def test_snapshot_delete_failure_keeps_existing_snapshot(backend, monkeypatch):
    module, client = backend
    entry = module._normalize_snapshot_entry({"code": ["ONE"], "lang": "both", "owner": None})
    module._snapshots["delete-fail"] = entry
    monkeypatch.setattr(module, "_save_snapshots_locked", lambda: False)
    response = client.delete("/api/snapshot/delete-fail", json={}, headers=_headers())
    assert response.status_code == 500
    assert "delete-fail" in module._snapshots


def test_stream_continuous_output_uses_idle_timeout(lambda_module, monkeypatch):
    import queue

    class FakeInterpreter:
        alive = True

        def __init__(self):
            self._stream_q = queue.Queue()
            self.proc = type("Process", (), {"stdin": None})()

        def fill(self):
            for item in ({"kind": "result"}, {"kind": "result"}, {"kind": "result"}, None):
                self._stream_q.put(item)

        def _begin_command(self, timeout):
            pass

        def _end_command(self):
            pass

        def kill(self):
            raise AssertionError("continuous output must not hit the idle timeout")

    ticks = iter([0.0, 0.04, 0.04, 0.08, 0.08, 0.12, 0.12, 0.16])
    monkeypatch.setattr(lambda_module.time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(lambda_module, "EVAL_TOTAL_TIMEOUT", 0)
    fake = FakeInterpreter()
    monkeypatch.setattr(lambda_module, "_write_all", lambda *a, **kw: fake.fill())
    outputs = list(lambda_module.Interpreter.send_stream(fake, "ONE", timeout=0.05))
    assert len(outputs) == 3
    assert all(item["kind"] == "result" for item in outputs)


def test_lambda_exposes_desktop_and_share_bridges(backend, monkeypatch, tmp_path):
    module, client = backend
    monkeypatch.setenv("OMM_DESKTOP", "1")
    monkeypatch.setenv("OMM_SHARED_DIR", str(tmp_path / "shared"))
    status = client.get("/__omm/fs/status?app=lambda", headers=_headers())
    assert status.status_code == 200
    assert status.get_json()["desktop"] is True
    assert status.get_json()["app"] == "lambda"
    space = client.get("/__omm/share/space?app=lambda", headers=_headers())
    assert space.status_code == 200
    assert space.get_json()["app"] == "lambda"


def test_static_share_page_uses_neutral_zen_palette_and_square_controls(lambda_module):
    page = lambda_module._render_page("分享", [{"kind": "result", "zh": "结果", "en": "result"}])
    assert "--ac:#000" in page
    assert "border-radius:0" in page
    assert "#2f6f4f" not in page
    assert "border-radius:5px" not in page


def test_source_tree_resolves_bundled_interpreter(lambda_module, monkeypatch):
    monkeypatch.delenv("LAMBDA_INTERP_BIN", raising=False)
    monkeypatch.delenv("LAMBDA_INTERP_DIR", raising=False)
    expected = next(
        (PUBLIC / name for name in ("extension.exe", "extension") if (PUBLIC / name).is_file()),
        None,
    )
    assert expected is not None
    assert lambda_module._resolve_interp() == expected


def test_cross_site_text_plain_post_is_403_without_session(backend, monkeypatch):
    module, client = backend
    created = []
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: created.append((a, kw)))
    response = client.post(
        "/api/session",
        data='{"lang":"en"}',
        content_type="text/plain",
        headers=_headers(Origin="https://evil.example", **{"Sec-Fetch-Site": "cross-site"}),
    )
    assert response.status_code == 403
    assert response.get_json()["code"] == "forbidden"
    assert created == []
    assert module._sessions == {}


def test_same_origin_json_can_create_session(backend, monkeypatch):
    module, client = backend
    calls = []

    def fake_session(*args, **kwargs):
        calls.append((args, kwargs))
        return "session-ok", object()

    monkeypatch.setattr(module, "get_session", fake_session)
    response = client.post("/api/session", json={"lang": "en"}, headers=_headers())
    assert response.status_code == 200
    assert response.get_json()["session"] == "session-ok"
    assert response.get_json()["snapshotMaxLines"] >= 201
    assert calls and calls[0][1]["owner"] is None
    desktop_origin = "http://127.0.0.1:8330"
    desktop = client.post(
        "/api/session",
        json={},
        base_url=desktop_origin,
        headers={"Origin": desktop_origin, "Sec-Fetch-Site": "same-origin"},
    )
    assert desktop.status_code == 200


def test_browser_api_requires_json_and_validates_host_origin_and_fetch_site(backend, monkeypatch):
    module, client = backend
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: pytest.fail("session created"))
    plain = client.post(
        "/api/session", data="{}", content_type="text/plain", headers=_headers()
    )
    assert plain.status_code == 415
    assert plain.get_json()["code"] == "unsupported_media_type"

    rebind = client.get("/api/health", headers={"Host": "evil.example"})
    assert rebind.status_code == 403

    sibling_origin = client.post(
        "/api/session", json={}, headers=_headers(Origin="http://127.0.0.1:9999")
    )
    assert sibling_origin.status_code == 403

    no_origin = client.post(
        "/api/session",
        json={},
        headers={"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"},
    )
    assert no_origin.status_code == 403

    embedded_get = client.get(
        "/api/health", headers={"Sec-Fetch-Site": "same-site"}
    )
    assert embedded_get.status_code == 200
    embedded_post = client.post(
        "/api/session",
        json={},
        headers={"Content-Type": "application/json", "Sec-Fetch-Site": "same-site"},
    )
    assert embedded_post.status_code == 403


def test_public_mode_is_explicit_and_does_not_disable_csrf(backend, monkeypatch):
    module, client = backend
    monkeypatch.setattr(module, "PUBLIC_MODE", True)
    monkeypatch.setattr(
        module, "ALLOWED_HOSTS", module._LOOPBACK_HOSTS | frozenset({"lambda.example"})
    )
    monkeypatch.setattr(
        module, "ALLOWED_ORIGINS", frozenset({"https://lambda.example"})
    )
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: ("public-session", object()))

    allowed = client.post(
        "/api/session",
        json={},
        base_url="https://lambda.example",
        headers={"Origin": "https://lambda.example", "Sec-Fetch-Site": "same-origin"},
    )
    assert allowed.status_code == 200

    cross_site = client.post(
        "/api/session",
        data="{}",
        content_type="text/plain",
        base_url="https://lambda.example",
        headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
    )
    assert cross_site.status_code == 403

    unknown_host = client.post(
        "/api/session",
        json={},
        base_url="https://unknown.example",
        headers={"Origin": "https://unknown.example", "Sec-Fetch-Site": "same-origin"},
    )
    assert unknown_host.status_code == 403


def test_session_rate_limit_is_conservative_and_enforced(backend, monkeypatch):
    module, client = backend
    monkeypatch.setattr(module, "SESSION_RATE_LIMIT", 2)
    serial = iter(("one", "two", "three"))
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: (next(serial), object()))
    statuses = [
        client.post("/api/session", json={}, headers=_headers()).status_code
        for _ in range(3)
    ]
    assert statuses == [200, 200, 429]


class RecordingInterpreter:
    def __init__(self):
        self.lines = []

    def send(self, line, timeout=None):
        self.lines.append(line)
        return []


def test_eval_rate_limit_is_enforced(backend, monkeypatch):
    module, client = backend
    monkeypatch.setattr(module, "EVAL_RATE_LIMIT", 1)
    interp = RecordingInterpreter()
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: ("eval-session", interp))
    first = client.post(
        "/api/eval", json={"session": "eval-session", "line": "ONE"}, headers=_headers()
    )
    second = client.post(
        "/api/eval", json={"session": "eval-session", "line": "TWO"}, headers=_headers()
    )
    assert first.status_code == 200
    assert second.status_code == 429
    assert interp.lines == ["ONE"]


def test_default_eval_limit_allows_201_line_replay(backend, monkeypatch):
    module, client = backend
    interp = RecordingInterpreter()
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: ("replay-session", interp))
    lines = [f"-- replay {index}" for index in range(201)]
    for line in lines:
        response = client.post(
            "/api/eval",
            json={"session": "replay-session", "line": line},
            headers=_headers(),
        )
        assert response.status_code == 200, response.get_json()
    snapshot = module._snapshot_get("replay-session")
    assert snapshot["code"] == lines
    assert snapshot["truncated"] is False


@pytest.mark.parametrize("storage", ("file", "sqlite"))
def test_restore_keeps_complete_201_line_history(backend, monkeypatch, tmp_path, storage):
    module, client = backend
    suffix = ".sqlite" if storage == "sqlite" else ".json"
    monkeypatch.setattr(module, "SNAPSHOT_DB", str(tmp_path / ("snapshots" + suffix)))
    module._snapshots.clear()
    lines = [f"-- line {index}" for index in range(201)]

    recorded = module._snapshot_record("old-session", lines, "both")
    assert recorded["truncated"] is False
    assert recorded["totalLines"] == 201
    assert recorded["storedLines"] == 201
    assert module._snapshot_get("old-session")["code"] == lines

    interp = RecordingInterpreter()
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: ("new-session", interp))
    response = client.post(
        "/api/session/old-session/restore",
        json={"lang": "both", "localLines": 201},
        headers=_headers(),
    )
    body = response.get_json()
    assert response.status_code == 200, body
    assert body["code"] == lines
    assert body["truncated"] is False
    assert body["snapshot"]["totalLines"] == 201
    assert body["snapshot"]["droppedLines"] == 0
    assert interp.lines == [":lang both", *lines]
    assert module._snapshot_get("old-session") is None
    assert module._snapshot_get("new-session")["code"] == lines


def test_capacity_overflow_is_explicit_and_truncated_restore_is_refused(backend, monkeypatch):
    module, client = backend
    monkeypatch.setattr(module, "MAX_SNAPSHOT_LINES", 2)
    metadata = module._snapshot_record("old-session", ["ONE", "TWO", "THREE"], "both")
    assert metadata["truncated"] is True
    assert metadata["totalLines"] == 3
    assert metadata["storedLines"] == 2
    assert metadata["droppedLines"] == 1
    appended = module._snapshot_record("old-session", ["FOUR"], "both")
    assert appended["totalLines"] == 4
    assert appended["droppedLines"] == 2
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: pytest.fail("restore created session"))

    response = client.post(
        "/api/session/old-session/restore", json={"localLines": 3}, headers=_headers()
    )
    assert response.status_code == 413
    assert response.get_json()["code"] == "snapshot_truncated"
    assert response.get_json()["snapshot"]["truncated"] is True


def test_eval_capacity_is_refused_before_interpreter_runs(backend, monkeypatch):
    module, client = backend
    monkeypatch.setattr(module, "MAX_SNAPSHOT_LINES", 2)
    module._snapshot_record("full-session", ["ONE", "TWO"], "both")
    interp = RecordingInterpreter()
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: ("new", interp))
    response = client.post(
        "/api/eval",
        json={"session": "full-session", "line": "THREE"},
        headers=_headers(),
    )
    assert response.status_code == 413
    assert response.get_json()["code"] == "snapshot_full"
    assert response.get_json()["maxLines"] == 2
    assert interp.lines == []


def test_restore_rejects_shorter_snapshot_before_rebuilding(backend, monkeypatch):
    module, client = backend
    module._snapshot_record("short-session", ["ONE", "TWO"], "both")
    monkeypatch.setattr(module, "get_session", lambda *a, **kw: pytest.fail("restore created session"))
    response = client.post(
        "/api/session/short-session/restore",
        json={"localLines": 3},
        headers=_headers(),
    )
    assert response.status_code == 409
    assert response.get_json()["code"] == "snapshot_shorter"
    assert module._snapshot_get("short-session")["code"] == ["ONE", "TWO"]


def _run_node(script: str):
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_lambda_page_bridge_order_app_marker_ai_and_desktop_paths():
    _run_node(
        r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('public/index.html', 'utf8');
assert.ok(html.includes('<html lang="zh-CN" data-omm-app="lambda">'));
const scripts = ['omm-embed.js', 'omm-desktop.js', 'omm-share.js'];
const positions = scripts.map(name => html.indexOf('src="' + name + '"'));
assert.ok(positions.every((value, index) => value >= 0 && (index === 0 || value > positions[index - 1])));
const send = html.slice(html.indexOf('function sendToAI'), html.indexOf('var btn ='));
assert.match(send, /OMMShare\.send/);
assert.doesNotMatch(send, /lambdaDownload|ZenUtil\.download|lambda-sessions\.json/);
assert.match(html, /OMMDesktop\.saveText/);
const exportButton = html.slice(html.indexOf('$("export").addEventListener'), html.indexOf('$("import").addEventListener'));
assert.match(exportButton, /saveBlob\(/);
assert.match(html, /id="file" accept="\.lam,\.txt"/);
assert.match(html, /\$\("file"\)\.addEventListener\("change"/);
assert.doesNotMatch(html, /--(?:zen-)?radius\s*:\s*[1-9]\d*(?:\.\d+)?px/);
assert.doesNotMatch(html, /border-radius\s*:\s*(?:[1-9]\d*(?:\.\d+)?px|99px|999px)/);
"""
    )


def test_frontend_never_replaces_longer_history_with_short_snapshot():
    _run_node(
        r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('public/index.html', 'utf8');
function extract(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error('unclosed function ' + name);
}
const snapshotHistory = new Function('MAX_LOCAL_CODE_LINES', 'return (' + extract('snapshotHistory') + ')')(2000);
const local = Array.from({length: 201}, (_, i) => 'line-' + i);
const short = {code: local.slice(1), snapshot: {truncated: false, totalLines: 200, storedLines: 200, maxLines: 2000}};
assert.equal(snapshotHistory(short, local).reason, 'shorter');
const truncated = {code: local, snapshot: {truncated: true, totalLines: 201, storedLines: 200, maxLines: 2000}};
assert.equal(snapshotHistory(truncated, local).reason, 'truncated');
const complete = {code: local, snapshot: {truncated: false, totalLines: 201, storedLines: 201, maxLines: 2000}};
const accepted = snapshotHistory(complete, local.slice(0, 200));
assert.equal(accepted.ok, true);
assert.deepEqual(accepted.code, local);
assert.notEqual(accepted.code, complete.code);
"""
    )


def test_zen_card_listener_requires_exact_parent_source_and_hub_origin():
    _run_node(
        r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const marker = html.indexOf('// omm:zen-card-request');
const start = html.indexOf(';(function ()', marker);
const block = html.slice(start, html.indexOf('  function sendToAI', start)).trim();
const hub = 'http://127.0.0.1:8300';
const replies = [];
const parent = {postMessage(message, origin) { replies.push({message, origin}); }};
const sibling = {};
const window = {
  parent,
  location: {origin: 'http://127.0.0.1:8330', search: '?omm_embed=1&omm_hub_origin=' + encodeURIComponent(hub)},
  addEventListener(type, handler) { this.listener = handler; },
  ZenLambdaAI: {snapshotMarkdown() { return 'Lambda snapshot'; }},
};
const context = {window, URL, URLSearchParams, Date, console};
vm.createContext(context);
vm.runInContext(fs.readFileSync('public/zen/foundation/util.js', 'utf8'), context);
context.ZenUtil = window.ZenUtil;
vm.runInContext(block, context);
const request = token => ({type: 'omm:zen-card-request', token});
window.listener({source: sibling, origin: hub, data: request('sibling')});
window.listener({source: parent, origin: 'http://127.0.0.1:9999', data: request('non-hub')});
assert.equal(replies.length, 0);
window.listener({source: parent, origin: hub, data: request('hub')});
assert.equal(replies.length, 1);
assert.equal(replies[0].origin, hub);
assert.equal(replies[0].message.token, 'hub');
assert.equal(replies[0].message.cards[0].source, 'lambda');
"""
    )


def test_send_to_ai_has_no_download_fallback():
    _run_node(
        r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const start = html.indexOf('function sendToAI');
const open = html.indexOf('{', start);
let depth = 0, end = -1;
for (let i = open; i < html.length; i++) {
  if (html[i] === '{') depth++;
  if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const source = html.slice(start, end);
(async () => {
  let downloads = 0;
  const make = share => new Function('window', 'toast', 'ZenUtil', 'return (' + source + ')')(
    {ZenLambdaAI: {snapshot() { return {sessionCount: 0}; }}, OMMShare: share},
    () => {},
    {download() { downloads++; }},
  );
  assert.equal(await make(undefined)(), false);
  assert.equal(await make({send() { return Promise.reject(new Error('offline')); }})(), false);
  assert.equal(downloads, 0);
  let sent = null;
  assert.equal(await make({send(options) { sent = options; return Promise.resolve(); }})(), true);
  assert.equal(sent.to, 'ai');
  assert.equal(sent.format, 'omm.lambda.session');
})().catch(error => { console.error(error); process.exit(1); });
"""
    )


def test_lambda_ui_keeps_static_styles_out_and_combobox_aria_on_textarea():
    _run_node(
        r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/zen/products/lambda.css', 'utf8');
assert.doesNotMatch(html, /\sstyle=/i, 'Lambda markup must not carry static style attributes');
const cmd = html.match(/<textarea\b[^>]*id="cmd"[^>]*>/)[0];
const ac = html.match(/<div\b[^>]*id="ac"[^>]*>/)[0];
assert.match(cmd, /role="combobox"/);
assert.match(cmd, /aria-controls="ac"/);
assert.doesNotMatch(ac, /aria-activedescendant/);
const closeAc = html.slice(html.indexOf('function closeAc('), html.indexOf('function openAc('));
assert.doesNotMatch(closeAc, /ac\.removeAttribute\(["']aria-activedescendant/);
assert.match(html, /cmd\.setAttribute\(["']aria-activedescendant/);
const renderTrace = html.slice(html.indexOf('function renderTrace('), html.indexOf('function astNodeHtml('));
assert.doesNotMatch(renderTrace, /style=/);
const renderPanel = html.slice(html.indexOf('function renderPanel('), html.indexOf('async function api('));
assert.match(renderPanel, /range\.style\.setProperty\(["']--p/);
"""
    )


def test_lambda_ui_focus_visibility_and_phone_tabs_keep_content_width():
    _run_node(
        r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const css = fs.readFileSync('public/zen/products/lambda.css', 'utf8');
assert.match(css, /\.line:focus-within \.act\{opacity:1;\}/);
assert.match(css, /\.env-del:focus-visible\{opacity:1;\}/);
assert.match(css, /\.chip:focus-visible/);
assert.match(css, /\.env-name:focus-visible/);
assert.match(css, /\.tabs\{[^}]*overflow-x:auto;/);
for (const selector of ['.subtitle-en', '.lam-mt-1', '.lam-mt-2', '.lam-mt-3', '.lam-mb-2', '.lam-normal', '.type-value', '.chip-hint']) {
  assert.ok(css.includes(selector), 'missing Lambda utility class ' + selector);
}
const phone = css.slice(css.indexOf('@media (max-width:600px)'), css.indexOf('@media (hover:none)'));
assert.match(phone, /\.tab\{flex:0 0 auto;min-width:max-content;/);
assert.doesNotMatch(phone, /\.tab\{flex:1 1 0/);
assert.match(phone, /\.tab\{[^}]*white-space:nowrap;/);
"""
    )


def test_lambda_exported_animation_has_no_green_or_nonzero_radius():
    _run_node(
        r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const animation = html.slice(html.indexOf('function traceAnimation('), html.indexOf('function proofDiamond('));
assert.doesNotMatch(animation, /green|#339933|#0f0|#00ff00/i);
assert.doesNotMatch(animation, /border-radius\s*:\s*(?:[1-9]\d*(?:\.\d+)?px|99px|999px)/i);
assert.doesNotMatch(animation, /\sstyle=/i);
"""
    )


def test_lambda_ui_preserves_semantic_chips_save_failure_and_inspector_reset():
    _run_node(
        r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('public/index.html', 'utf8');
assert.match(html, /elem\("button", "chip"/);
assert.match(html, /class="env-name" type="button"/);
const saveBlob = html.slice(html.indexOf('async function saveBlob('), html.indexOf('var ERR_HELP'));
assert.match(saveBlob, /保存失败|Save failed/);
const clearAll = html.slice(html.indexOf('function clearAll('), html.indexOf('document.addEventListener\("click"'));
assert.match(clearAll, /resetInspector\(\)/);
"""
    )
