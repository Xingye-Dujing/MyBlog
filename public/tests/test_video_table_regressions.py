# -*- coding: utf-8 -*-
"""video/table 安全、执行语义与编码矩阵的回归测试。"""
from __future__ import annotations

import importlib.util
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from openpyxl import Workbook

PUBLIC = Path(__file__).resolve().parents[1]
for path in (PUBLIC, PUBLIC / "server"):
    text = str(path)
    if text not in sys.path:
        sys.path.insert(0, text)

import table_engine as te  # noqa: E402

TABLE_SERVE_PATH = PUBLIC / "server" / "table-serve.py"
TABLE_SERVE_SPEC = importlib.util.spec_from_file_location("table_serve_regressions", str(TABLE_SERVE_PATH))
assert TABLE_SERVE_SPEC and TABLE_SERVE_SPEC.loader
table_serve = importlib.util.module_from_spec(TABLE_SERVE_SPEC)
TABLE_SERVE_SPEC.loader.exec_module(table_serve)

VIDEO_PATH = PUBLIC / "server" / "video-serve.py"
VIDEO_SPEC = importlib.util.spec_from_file_location("video_serve_regressions", str(VIDEO_PATH))
assert VIDEO_SPEC and VIDEO_SPEC.loader
video_serve = importlib.util.module_from_spec(VIDEO_SPEC)
VIDEO_SPEC.loader.exec_module(video_serve)


def make_book(path: Path, cells=None) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "S"
    for (row, col), value in (cells or {}).items():
        ws.cell(row=row, column=col, value=value)
    wb.save(path)
    return path


def table_spec(nodes, connections):
    return {"format": "omm-table-workflow", "version": 1,
            "nodes": nodes, "connections": connections}


def chain(*items):
    nodes = [{"id": "n%d" % index, "type": item[0], "data": item[1]}
             for index, item in enumerate(items)]
    connections = [{"from": nodes[index]["id"], "to": nodes[index + 1]["id"]}
                   for index in range(len(nodes) - 1)]
    return table_spec(nodes, connections)


class Client:
    def __init__(self, base):
        self.base = base

    def request(self, path, data=None, headers=None, method=None):
        request = urllib.request.Request(self.base + path, data=data, headers=headers or {},
                                         method=method or ("POST" if data is not None else "GET"))
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read(), dict(response.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), dict(exc.headers)

    def json(self, path, data=None, headers=None):
        payload = None if data is None else json.dumps(data, ensure_ascii=False).encode("utf-8")
        status, body, response_headers = self.request(path, payload, headers)
        return status, json.loads(body.decode("utf-8")), response_headers


@pytest.fixture()
def video_server(tmp_path, monkeypatch):
    uploads = tmp_path / "video-runtime" / "work" / "uploads"
    jobs = tmp_path / "video-runtime" / "work" / "jobs"
    uploads.mkdir(parents=True)
    jobs.mkdir(parents=True)
    monkeypatch.setattr(video_serve, "MAX_UPLOAD", 2 * 1024 * 1024 * 1024)
    monkeypatch.setattr(video_serve, "MAX_BODY", 2 * 1024 * 1024)
    monkeypatch.setattr(video_serve, "MAX_NODES", 200)
    video_serve._jobs.clear()
    video_serve.Handler.root = tmp_path
    httpd = video_serve.ThreadingHTTPServer(("127.0.0.1", 0), video_serve.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield Client("http://127.0.0.1:%d" % httpd.server_address[1]), uploads, jobs
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)


def video_spec(nodes, connections):
    return {"format": "omm-video-workflow", "version": 1,
            "nodes": nodes, "connections": connections}


# ---------------------------------------------------------------------------
# video 路径、HTTP 与任务规模
# ---------------------------------------------------------------------------


def test_video_upload_id_is_generated_contained_and_not_symlink(video_server, monkeypatch):
    _client, uploads, _jobs = video_server
    fid = "a" * 12 + "_clip.mp4"
    (uploads / fid).write_bytes(b"media")
    assert video_serve.resolve_upload(fid, video_serve.Handler.root) == (uploads / fid).resolve()
    for bad in ("../clip.mp4", str((uploads / fid).resolve()), "not-generated_clip.mp4",
                "a" * 12 + "_../clip.mp4", "a" * 12 + "_dir/clip.mp4"):
        with pytest.raises(RuntimeError):
            video_serve.resolve_upload(bad, video_serve.Handler.root)
    outside = uploads.parent / "outside.mp4"
    outside.write_bytes(b"outside")
    link = uploads / ("b" * 12 + "_link.mp4")
    try:
        link.symlink_to(outside)
    except OSError:
        original = Path.is_symlink
        monkeypatch.setattr(Path, "is_symlink", lambda path: path == link or original(path))
    with pytest.raises(RuntimeError, match="符号链接"):
        video_serve.resolve_upload(link.name, video_serve.Handler.root)


def test_video_http_loopback_guards_cors_and_limits(video_server, monkeypatch):
    client, uploads, _jobs = video_server
    status, body, headers = client.json("/api/job/missing", headers={
        "Origin": client.base,
    })
    assert status == 404
    assert headers.get("Access-Control-Allow-Origin") == client.base
    assert headers.get("Access-Control-Allow-Origin") != "*"

    status, _body, headers = client.json("/api/job/missing", headers={
        "Origin": "http://127.0.0.1:8300",
        "Sec-Fetch-Site": "same-site",
    })
    assert status == 404 and headers.get("Access-Control-Allow-Origin") == "http://127.0.0.1:8300"

    status, _body, _headers = client.json("/api/job/missing", headers={
        "Origin": "http://127.0.0.1:9999",
    })
    assert status == 403
    status, _body, _headers = client.json("/api/job/missing", headers={
        "Origin": "https://evil.example",
    })
    assert status == 403
    status, _body, _headers = client.json("/api/job/missing", headers={"Host": "evil.example"})
    assert status == 403
    status, _body, _headers = client.json("/api/job/missing", headers={"Sec-Fetch-Site": "cross-site"})
    assert status == 403
    status, payload, _headers = client.json("/api/probe?file=..%2Foutside.mp4")
    assert status == 400 and "非法 fileId" in payload["error"]

    monkeypatch.setattr(video_serve, "MAX_UPLOAD", 4)
    status, _body, _headers = client.request("/api/upload?name=clip.mp4", b"12345",
                                             {"Content-Type": "application/octet-stream"})
    assert status == 413
    assert not list(uploads.iterdir())

    monkeypatch.setattr(video_serve, "MAX_NODES", 1)
    spec = video_spec([
        {"id": "in", "type": "input", "data": {"fileId": "x"}},
        {"id": "p", "type": "probe", "data": {}},
    ], [{"from": "in", "to": "p"}])
    status, payload, _headers = client.json("/api/run", spec, {"Content-Type": "application/json"})
    assert status == 400 and "节点过多" in payload["error"]


# ---------------------------------------------------------------------------
# video 编码、拼接、失败与流式分析
# ---------------------------------------------------------------------------


def test_video_http_failed_job_stops_downstream(video_server):
    client, _uploads, _jobs = video_server
    spec = video_spec([
        {"id": "in", "type": "input", "data": {"fileId": "a" * 12 + "_missing.mp4"}},
        {"id": "fmt", "type": "format", "data": {"format": "mp4"}},
        {"id": "out", "type": "export", "data": {"format": "mp4", "filename": "final.mp4"}},
    ], [{"from": "in", "to": "fmt"}, {"from": "fmt", "to": "out"}])
    status, started, _headers = client.json("/api/run", spec, {"Content-Type": "application/json"})
    assert status == 200 and started["ok"]
    deadline = time.time() + 5
    while True:
        _status, job, _headers = client.json("/api/job/" + started["jobId"])
        if job["status"] != "running":
            break
        assert time.time() < deadline
        time.sleep(0.02)
    assert job["status"] == "error"
    assert job["nodes"]["in"]["status"] == "error"
    assert job["nodes"]["fmt"]["status"] == "skipped"
    assert job["nodes"]["out"]["status"] == "skipped"


def test_video_encoding_matrix_and_output_extension():
    media = {"video": {"codec": "h264", "width": 640, "height": 360, "fps": 30},
             "audio": "aac", "duration": 2}
    webm, _ = video_serve.build_args("format", {"format": "webm"}, "in.mp4", [], "out.webm", media)
    assert "libvpx-vp9" in webm and "libopus" in webm and "libx264" not in webm
    gif, _ = video_serve.build_args("format", {"format": "gif"}, "in.mp4", [], "out.gif", media)
    graph = gif[gif.index("-filter_complex") + 1]
    assert "palettegen" in graph and "paletteuse" in graph and "-an" in gif
    assert "libx264" not in gif
    mp3, _ = video_serve.build_args("export", {"format": "mp3"}, "in.mp4", [], "out.mp3", media)
    assert "libmp3lame" in mp3 and "-vn" in mp3
    mp4, _ = video_serve.build_args("export", {"format": "mp4"}, "in.mp4", [], "out.mp4", media)
    assert "libx264" in mp4 and "aac" in mp4
    assert video_serve._output_filename("clip.mp4", "mp3") == "clip.mp3"
    assert video_serve._output_filename("clip", "webm") == "clip.webm"


def test_video_zero_volume_and_concat_requires_two_inputs():
    args, _ = video_serve.build_args("volume", {"factor": 0}, "in.mp4", [], "out.mp4",
                                     {"video": {}, "audio": "aac"})
    assert "volume=0.000" in args
    with pytest.raises(RuntimeError, match="至少需要 2 个输入"):
        video_serve.build_concat_args(["only.mp4"], "out.mp4")


def test_video_silent_concat_uses_probe_without_audio(monkeypatch):
    def probe(_path):
        return {"duration": 1.5, "video": {"width": 640, "height": 360, "fps": 25},
                "audio": None, "raw": ""}

    monkeypatch.setattr(video_serve, "probe", probe)
    args = video_serve.build_concat_args(["a.mp4", "b.mp4"], "joined.mp4")
    assert args.count("-i") == 2
    graph = args[args.index("-filter_complex") + 1]
    assert "concat=n=2:v=1:a=0[v]" in graph
    assert "[a]" not in args and "-c:a" not in args


def test_video_mixed_concat_fills_missing_streams(monkeypatch):
    infos = {
        "a.mp4": {"duration": 2, "video": {"width": 640, "height": 360, "fps": 25},
                  "audio": "aac", "raw": ""},
        "b.mp4": {"duration": 1, "video": None, "audio": "aac", "raw": ""},
    }
    monkeypatch.setattr(video_serve, "probe", lambda path: infos[path])
    args = video_serve.build_concat_args(["a.mp4", "b.mp4"], "joined.webm")
    graph = args[args.index("-filter_complex") + 1]
    assert "color=c=black" in graph and "concat=n=2:v=1:a=1" in graph
    assert "libvpx-vp9" in args and "libopus" in args


def test_video_node_failure_stops_downstream_and_marks_job_error(video_server, monkeypatch):
    _client, uploads, jobs = video_server
    fid = "c" * 12 + "_clip.mp4"
    (uploads / fid).write_bytes(b"media")
    info = {"duration": 1, "video": {"width": 640, "height": 360, "fps": 25},
            "audio": "aac", "raw": ""}
    monkeypatch.setattr(video_serve, "probe", lambda _path: dict(info))
    monkeypatch.setattr(video_serve, "run_ffmpeg", lambda *args, **kwargs: (1, "ffmpeg failed"))
    spec = video_spec([
        {"id": "in", "type": "input", "data": {"fileId": fid}},
        {"id": "fmt", "type": "format", "data": {"format": "mp4"}},
        {"id": "out", "type": "export", "data": {"format": "mp4", "filename": "final.mp4"}},
    ], [{"from": "in", "to": "fmt"}, {"from": "fmt", "to": "out"}])
    job = {"spec": spec, "status": "running", "progress": 0, "duration": 0,
           "nodes": {node["id"]: {"status": "pending", "progress": 0, "log": ""}
                     for node in spec["nodes"]}, "error": None, "cancelled": False}
    video_serve._jobs["failure"] = job
    video_serve.execute_job("failure")
    assert job["status"] == "error"
    assert job["nodes"]["in"]["status"] == "done"
    assert job["nodes"]["fmt"]["status"] == "error"
    assert job["nodes"]["out"]["status"] == "skipped"
    assert not (jobs / "failure" / "out" / "final.mp4").exists()


@pytest.mark.parametrize("op,lines,expected", [
    ("scene", ["pts_time:1.0", "pts_time:2.0"] + ["noise"] * 100,
     lambda result: result["scenes"] == [1.0, 2.0]),
    ("silence", ["silence_start: 1.0", "silence_end: 2.0", "silence_start: 3.0"] + ["noise"] * 100,
     lambda result: result["silences"] == [{"start": 1.0, "end": 2.0}, {"start": 3.0, "end": None}]),
    ("black", ["black_start: 1.0", "black_end: 2.0", "black_start: 3.0"] + ["noise"] * 100,
     lambda result: result["black"] == [{"start": 1.0, "end": 2.0}, {"start": 3.0, "end": None}]),
])
def test_video_analysis_events_accumulate_beyond_log_tail(monkeypatch, op, lines, expected):
    class Process:
        def __init__(self, *_args, **_kwargs):
            self.stderr = iter(lines)
            self.returncode = 0

        def wait(self, timeout=0):
            return self.returncode

    monkeypatch.setattr(video_serve.subprocess, "Popen", Process)
    job = {"nodes": {"analysis": {"status": "running", "progress": 0}}, "cancelled": False}
    analysis = video_serve._new_analysis()
    code, _log = video_serve.run_ffmpeg(job, "analysis", ["-f", "null", "-"], 1, op, analysis)
    assert code == 0
    assert expected(job["nodes"]["analysis"]["result"])


# ---------------------------------------------------------------------------
# table 预检、取消、查表、factor/pivot 与 HTTP 状态
# ---------------------------------------------------------------------------


def test_table_dry_run_and_preview_check_conflicts_without_applying(tmp_path, monkeypatch):
    path = make_book(tmp_path / "in.xlsx", {(1, 1): "occupied"})
    spec = chain(("file", {"fileId": "x", "sheet": "S"}),
                 ("write", {"columns": "A", "conflict": "skip"}),
                 ("save", {"filename": "never.xlsx"}))
    applied = []
    original = te.Engine._apply_all

    def spy(engine):
        applied.append(engine)
        return original(engine)

    monkeypatch.setattr(te.Engine, "_apply_all", spy)
    dry = te.run_workflow(spec, options={"dryRun": True, "outDir": str(tmp_path)},
                          resolver=lambda _fid: str(path))
    assert dry["ok"] and dry["conflicts"][0]["action"] == "skip"
    preview = te.run_workflow(spec, options={"previewNode": "n1", "outDir": str(tmp_path)},
                              resolver=lambda _fid: str(path))
    assert preview["ok"] and preview["stopped"]
    assert preview["conflicts"][0]["action"] == "skip"
    assert applied == []
    assert not (tmp_path / "never.xlsx").exists()

    formal = te.run_workflow(spec, options={"outDir": str(tmp_path)},
                             resolver=lambda _fid: str(path))
    assert formal["ok"] and len(applied) == 1
    assert (tmp_path / "never.xlsx").exists()


def test_table_preview_conflict_error_is_independent_and_does_not_save(tmp_path):
    path = make_book(tmp_path / "in.xlsx", {(1, 1): "occupied"})
    spec = chain(("file", {"fileId": "x", "sheet": "S"}),
                 ("write", {"columns": "A", "conflict": "error"}),
                 ("save", {"filename": "never.xlsx"}))
    result = te.run_workflow(spec, options={"previewNode": "n1", "outDir": str(tmp_path)},
                             resolver=lambda _fid: str(path))
    assert not result["ok"]
    assert result["conflicts"][0]["action"] == "error"
    assert not (tmp_path / "never.xlsx").exists()


def test_table_mid_cancel_skips_apply_and_returns_cancelled(tmp_path, monkeypatch):
    path = make_book(tmp_path / "in.xlsx", {(1, 1): 3})
    spec = chain(("file", {"fileId": "x", "sheet": "S"}),
                 ("write", {"columns": "A", "conflict": "overwrite"}),
                 ("save", {"filename": "cancelled.xlsx"}))
    state = {"cancelled": False}
    applied = []

    def on_event(name, payload):
        if name == "node_done" and payload["id"] == "n1":
            state["cancelled"] = True

    monkeypatch.setattr(te.Engine, "_apply_all", lambda engine: applied.append(engine))
    result = te.run_workflow(spec, options={"outDir": str(tmp_path)},
                             resolver=lambda _fid: str(path), on_event=on_event,
                             cancelled=lambda: state["cancelled"])
    assert result["ok"] is False and result["cancelled"] is True
    assert result["nodes"]["n1"]["status"] == "done"
    assert "n2" not in result["nodes"]
    assert applied == []
    assert not (tmp_path / "cancelled.xlsx").exists()


def test_table_http_job_maps_mid_cancel_to_cancelled(tmp_path, monkeypatch):
    path = make_book(tmp_path / "in.xlsx", {(1, 1): 3})
    fid = "a" * 12 + "_in.xlsx"
    (table_serve.uploads_dir(tmp_path) / fid).write_bytes(path.read_bytes())
    spec = chain(("file", {"fileId": fid, "sheet": "S"}),
                 ("write", {"columns": "A", "conflict": "overwrite"}),
                 ("save", {"filename": "cancelled.xlsx"}))
    job = {"spec": spec, "status": "running", "progress": 0,
           "nodes": {node["id"]: {"status": "pending", "progress": 0} for node in spec["nodes"]},
           "outputs": [], "conflicts": [], "warnings": [], "error": None, "cancelled": False,
           "dryRun": False, "previewNode": ""}
    table_serve._jobs["cancelled"] = job
    original = te.Engine._op_write

    def cancel_after_write(engine, data, nid):
        result = original(engine, data, nid)
        job["cancelled"] = True
        return result

    monkeypatch.setattr(te.Engine, "_op_write", cancel_after_write)
    table_serve.execute_job("cancelled", tmp_path)
    assert job["status"] == "cancelled"
    assert job["result"]["cancelled"] is True
    assert job["error"] is None
    assert not (tmp_path / "table-runtime" / "work" / "jobs" / "cancelled" / "out" / "cancelled.xlsx").exists()


def test_table_exact_numeric_time_lookup_normalizes_numbers_and_keeps_text():
    exact = {"lookupKind": "exact", "lookup": [{"value": "001", "result": "低"}],
             "defaultResult": "高"}
    assert te.lookup_value("001", exact, "exact") == "低"
    assert te.lookup_value("missing", exact, "exact") == "高"
    numeric = {"lookupKind": "numeric", "lookup": [{"min": "0", "max": "10", "result": "2.0"}],
               "defaultResult": "3.0"}
    assert te.lookup_value("5", numeric, "numeric") == 2
    assert te.lookup_value("50", numeric, "numeric") == 3
    text_numeric = dict(numeric, lookup=[{"min": 0, "max": 10, "result": "低"}])
    assert te.lookup_value(5, text_numeric, "numeric") == "低"
    explicit_text = dict(numeric, lookupResultType="text",
                         lookup=[{"min": 0, "max": 10, "result": "2"}], defaultResult="0")
    assert te.lookup_value(5, explicit_text, "numeric") == "2"
    assert te.lookup_value(50, explicit_text, "numeric") == "0"
    timed = {"lookupKind": "time", "lookup": [{"min": "18:56", "max": "19:24", "result": "1.5"}],
             "defaultResult": 0}
    assert te.lookup_value("19:24", timed, "time") == 1.5


def test_table_factor_header_and_pivot_rowkeys_string_or_array():
    engine = te.Engine({})
    row = te.Row("S", 2, {"C": 10, "D": 3}, {"D": "系数"}, {})
    value = engine._op_value({"op": "multiply", "factor": {"mode": "header", "header": "系数"}},
                             row.values["C"], row, "map")
    assert value == 30

    table = te.Table(["姓名", "部门", "__sheet", "合计"], [
        te.Row("", 0, {"姓名": "甲", "部门": "一组", "__sheet": "S1", "合计": 2}),
        te.Row("", 0, {"姓名": "甲", "部门": "一组", "__sheet": "S2", "合计": 3}),
    ])
    spec = table_spec([
        {"id": "f", "type": "file", "data": {}},
        {"id": "p", "type": "pivot", "data": {"rowKeys": "姓名,部门", "colKey": "__sheet",
                                               "valueKey": "合计", "rowTotals": False,
                                               "colTotals": False}},
    ], [{"from": "f", "to": "p"}])
    engine = te.Engine(spec)
    engine.nodes = {node["id"]: node for node in spec["nodes"]}
    engine.outputs = {"f": table}
    result = engine._op_pivot(engine.nodes["p"]["data"], "p")
    assert result.columns == ["姓名", "部门", "S1", "S2"]
    assert result.rows[0].values["姓名"] == "甲"
    assert result.rows[0].values["S2"] == 3


# ---------------------------------------------------------------------------
# Handler.root、Range、原子发布、工作流图与任务回收
# ---------------------------------------------------------------------------


def test_video_paths_follow_handler_root(video_server):
    client, uploads, _jobs = video_server
    status, payload, _headers = client.request(
        "/api/upload?name=clip.mp4", b"media", {"Content-Type": "application/octet-stream"})
    assert status == 200
    assert json.loads(payload)["fileId"].endswith("_clip.mp4")
    assert (uploads / json.loads(payload)["fileId"]).read_bytes() == b"media"
    status, payload, _headers = client.request("/api/status")
    assert json.loads(payload)["workdir"] == str(video_serve.work_root(video_serve.Handler.root))


def test_video_range_streaming_head_suffix_and_416(video_server, monkeypatch):
    client, _uploads, jobs = video_server
    target = jobs / ("a" * 12) / "out" / "clip.mp4"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"0123456789")
    url = "/api/file/" + "a" * 12 + "/clip.mp4"

    def forbidden_read_bytes(_self):
        raise AssertionError("媒体响应不得整文件读入内存")

    monkeypatch.setattr(Path, "read_bytes", forbidden_read_bytes)
    cases = [
        ("bytes=2-5", 206, b"2345", "bytes 2-5/10"),
        ("bytes=6-", 206, b"6789", "bytes 6-9/10"),
        ("bytes=-4", 206, b"6789", "bytes 6-9/10"),
        ("bytes=-99", 206, b"0123456789", "bytes 0-9/10"),
    ]
    for value, expected_status, expected_body, expected_range in cases:
        status, body, headers = client.request(url, headers={"Range": value})
        assert status == expected_status and body == expected_body
        assert headers["Content-Range"] == expected_range
        assert headers["Accept-Ranges"] == "bytes"
    for value in ("bytes=10-", "bytes=8-2", "bytes=-0", "bytes=", "bytes=1-2,4-5"):
        status, _body, headers = client.request(url, headers={"Range": value})
        assert status == 416
        assert headers["Content-Range"] == "bytes */10"
    status, body, headers = client.request(url, headers={"Range": "bytes=2-5"}, method="HEAD")
    assert status == 206 and body == b"" and headers["Content-Length"] == "4"
    status, body, headers = client.request(url, method="HEAD")
    assert status == 200 and body == b"" and headers["Content-Length"] == "10"
    status, _body, headers = client.request(url + "?download=1", headers={"Range": "bytes=0-1"})
    assert status == 206 and headers["Content-Disposition"].startswith("attachment;")


def test_video_static_never_exposes_state_or_backend(video_server):
    client, _uploads, _jobs = video_server
    root = video_serve.Handler.root
    (root / "sessions.json").write_text("{}", encoding="utf-8")
    (root / "server").mkdir()
    (root / "server" / "private.py").write_text("secret", encoding="utf-8")
    (root / "video-serve.py").write_text("secret", encoding="utf-8")
    for path in ("/sessions.json", "/server/private.py", "/video-serve.py", "/video-runtime/work/uploads/x"):
        status, _body, _headers = client.request(path)
        assert status == 403, path


@pytest.mark.parametrize("mutate,message", [
    (lambda spec: spec.update(format="other"), "format"),
    (lambda spec: spec.update(version=2), "version"),
    (lambda spec: spec["connections"][0].update(toPort="top"), "端口"),
    (lambda spec: spec["connections"].append({"from": "in", "to": "p"}), "重复连线"),
])
def test_video_workflow_contract_validation(mutate, message):
    spec = video_spec([
        {"id": "in", "type": "input", "data": {"fileId": "a" * 12 + "_clip.mp4"}},
        {"id": "p", "type": "probe", "data": {}},
    ], [{"from": "in", "to": "p"}])
    mutate(spec)
    with pytest.raises(ValueError, match=message):
        video_serve._validate_spec(spec)


def test_video_non_concat_rejects_multiple_upstream_and_concat_requires_two():
    nodes = [
        {"id": "a", "type": "input", "data": {}},
        {"id": "b", "type": "input", "data": {}},
        {"id": "p", "type": "probe", "data": {}},
        {"id": "c", "type": "concat", "data": {}},
    ]
    with pytest.raises(ValueError, match="probe"):
        video_serve._validate_spec(video_spec(nodes, [
            {"from": "a", "to": "p"}, {"from": "b", "to": "p"},
        ]))
    with pytest.raises(ValueError, match="concat"):
        video_serve._validate_spec(video_spec(nodes, [{"from": "a", "to": "c"}]))
    assert video_serve._validate_spec(video_spec(nodes[:3], []))["nodes"][2]["id"] == "p"


def test_video_unconnected_probe_runs_with_file_id(video_server, monkeypatch):
    client, uploads, _jobs = video_server
    fid = "d" * 12 + "_clip.mp4"
    (uploads / fid).write_bytes(b"media")
    monkeypatch.setattr(video_serve, "probe", lambda _path: {
        "duration": 1, "video": {"width": 640, "height": 360, "fps": 25}, "audio": None, "raw": ""})
    spec = video_spec([{"id": "p", "type": "probe", "data": {"fileId": fid}}], [])
    status, started, _headers = client.json("/api/run", spec, {"Content-Type": "application/json"})
    assert status == 200 and started["ok"]
    deadline = time.time() + 5
    while time.time() < deadline:
        _status, job, _headers = client.json("/api/job/" + started["jobId"])
        if job["status"] != "running":
            break
        time.sleep(0.02)
    assert job["status"] == "done" and job["nodes"]["p"]["result"]["probe"]["duration"] == 1


def test_video_success_publishes_complete_output_without_staging(video_server, monkeypatch):
    client, uploads, jobs = video_server
    fid = "e" * 12 + "_clip.mp4"
    (uploads / fid).write_bytes(b"media")
    monkeypatch.setattr(video_serve, "probe", lambda _path: {
        "duration": 1, "video": {"width": 640, "height": 360, "fps": 25}, "audio": None, "raw": ""})

    def ffmpeg(_job, _nid, args, *_rest):
        Path(args[-1]).write_bytes(b"complete")
        return 0, ""

    monkeypatch.setattr(video_serve, "run_ffmpeg", ffmpeg)
    spec = video_spec([
        {"id": "in", "type": "input", "data": {"fileId": fid}},
        {"id": "fmt", "type": "format", "data": {"format": "mp4"}},
        {"id": "out", "type": "export", "data": {"format": "mp4", "filename": "final.mp4"}},
    ], [{"from": "in", "to": "fmt"}, {"from": "fmt", "to": "out"}])
    status, started, _headers = client.json("/api/run", spec, {"Content-Type": "application/json"})
    assert status == 200
    deadline = time.time() + 5
    while time.time() < deadline:
        _status, job, _headers = client.json("/api/job/" + started["jobId"])
        if job["status"] != "running":
            break
        time.sleep(0.02)
    assert job["status"] == "done"
    assert job["outputs"][0]["name"] == "final.mp4"
    status, body, _headers = client.request(job["outputs"][0]["url"])
    assert status == 200 and body == b"complete"
    assert not (jobs / started["jobId"] / ".staging").exists()


def test_video_outputs_are_staged_and_failure_cleans_committed_files(video_server, monkeypatch):
    client, uploads, jobs = video_server
    fid = "e" * 12 + "_clip.mp4"
    (uploads / fid).write_bytes(b"media")
    monkeypatch.setattr(video_serve, "probe", lambda _path: {
        "duration": 1, "video": {"width": 640, "height": 360, "fps": 25}, "audio": None, "raw": ""})
    calls = []

    def ffmpeg(_job, _nid, args, *_rest):
        calls.append(args)
        if len(calls) == 2:
            return 1, "failed"
        Path(args[-1]).write_bytes(b"complete")
        return 0, ""

    monkeypatch.setattr(video_serve, "run_ffmpeg", ffmpeg)
    spec = video_spec([
        {"id": "in", "type": "input", "data": {"fileId": fid}},
        {"id": "one", "type": "format", "data": {"format": "mp4"}},
        {"id": "two", "type": "format", "data": {"format": "mp4"}},
        {"id": "out", "type": "export", "data": {"format": "mp4", "filename": "two.mp4"}},
    ], [{"from": "in", "to": "one"}, {"from": "one", "to": "two"}, {"from": "two", "to": "out"}])
    status, started, _headers = client.json("/api/run", spec, {"Content-Type": "application/json"})
    assert status == 200
    deadline = time.time() + 5
    while time.time() < deadline:
        _status, job, _headers = client.json("/api/job/" + started["jobId"])
        if job["status"] != "running":
            break
        time.sleep(0.02)
    assert job["status"] == "error"
    assert not (jobs / started["jobId"]).exists()


def test_video_cancel_cleans_partial_output(video_server, monkeypatch):
    _client, uploads, jobs = video_server
    fid = "f" * 12 + "_clip.mp4"
    (uploads / fid).write_bytes(b"media")
    monkeypatch.setattr(video_serve, "probe", lambda _path: {
        "duration": 1, "video": {"width": 640, "height": 360, "fps": 25}, "audio": None, "raw": ""})
    jid = "1" * 12
    spec = video_spec([
        {"id": "in", "type": "input", "data": {"fileId": fid}},
        {"id": "out", "type": "export", "data": {"format": "mp4", "filename": "partial.mp4"}},
    ], [{"from": "in", "to": "out"}])
    job = {"spec": spec, "status": "running", "progress": 0, "duration": 0,
           "nodes": {node["id"]: {"status": "pending", "progress": 0, "log": ""}
                     for node in spec["nodes"]}, "outputs": [], "error": None, "cancelled": False}
    video_serve._jobs[jid] = job

    def ffmpeg(current, _nid, args, *_rest):
        Path(args[-1]).write_bytes(b"partial")
        current["cancelled"] = True
        return 0, ""

    monkeypatch.setattr(video_serve, "run_ffmpeg", ffmpeg)
    video_serve.execute_job(jid, video_serve.Handler.root)
    assert job["status"] == "cancelled"
    assert not (jobs / jid).exists()


def test_video_job_ttl_capacity_and_detached_snapshot(video_server, monkeypatch):
    client, _uploads, jobs = video_server
    now = time.time()
    video_serve._jobs.clear()
    video_serve._jobs["a" * 12] = {
        "id": "a" * 12, "status": "done", "createdAt": now - 10, "finishedAt": now - 10,
        "progress": 1, "nodes": {"n": {"status": "done", "result": {"rows": [1]}}}, "outputs": []}
    (jobs / ("a" * 12)).mkdir(parents=True)
    status, payload, _headers = client.json("/api/job/" + "a" * 12)
    assert status == 200
    payload["nodes"]["n"]["result"]["rows"].append(2)
    assert video_serve._jobs["a" * 12]["nodes"]["n"]["result"]["rows"] == [1]

    monkeypatch.setattr(video_serve, "JOB_TTL", 1)
    status, _payload, _headers = client.json("/api/job/" + "a" * 12)
    assert status == 404 and "a" * 12 not in video_serve._jobs
    assert not (jobs / ("a" * 12)).exists()

    video_serve._jobs.clear()
    video_serve._jobs["b" * 12] = {"status": "running", "createdAt": now}
    video_serve._jobs["c" * 12] = {"status": "done", "createdAt": now - 5, "finishedAt": now - 5}
    monkeypatch.setattr(video_serve, "MAX_JOBS", 2)
    assert video_serve._prune_jobs_locked(now) == ["c" * 12]
    assert set(video_serve._jobs) == {"b" * 12}
