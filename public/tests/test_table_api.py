# -*- coding: utf-8 -*-
"""表格自动化 HTTP API 的 pytest 集成测试。

在线程里启动真实的 ThreadingHTTPServer，覆盖上传、工作簿概览、表达式校验、
运行/轮询/下载、试运行、取消、回环来源校验与路径穿越防护。
"""
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
from openpyxl import Workbook, load_workbook

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

MODULE_PATH = ROOT / "server" / "table-serve.py"
spec = importlib.util.spec_from_file_location("table_serve_under_test", str(MODULE_PATH))
assert spec and spec.loader
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)

FEE_LOOKUP = [
    {"min": "", "max": "18:55", "result": 0},
    {"min": "18:56", "max": "19:24", "result": 1},
    {"min": "19:25", "max": "19:54", "result": 1.5},
    {"min": "19:55", "max": "20:24", "result": 2},
    {"min": "20:25", "max": "20:54", "result": 2.5},
    {"min": "20:55", "max": "", "result": 3},
]


def make_fixture(path):
    wb = Workbook()
    ws = wb.active
    ws.title = "打卡"
    ws["C6"] = "19:30"
    ws["C7"] = "20:30"
    wb.save(path)
    return path


def workflow(fid, filename="result.xlsx"):
    return {
        "format": "omm-table-workflow", "version": 1,
        "nodes": [
            {"id": "f", "type": "file", "data": {
                "fileId": fid, "filename": filename, "sheetMode": "all",
                "rangeMode": "manual", "startCell": "C6", "endCell": "C7"}},
            {"id": "m", "type": "mapCells", "data": {
                "columns": "C", "op": "lastTimeLookup", "lookupKind": "time",
                "lookup": FEE_LOOKUP, "defaultResult": 3}},
            {"id": "w", "type": "write", "data": {
                "columns": "C", "rowMode": "insertBelow", "conflict": "skip",
                "skipEmpty": True, "skipZero": True, "style": "asc"}},
            {"id": "s", "type": "save", "data": {"filename": filename}},
        ],
        "connections": [{"from": "f", "to": "m"}, {"from": "m", "to": "w"}, {"from": "w", "to": "s"}],
    }


class Client:
    def __init__(self, base):
        self.base = base

    def get(self, path, headers=None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), dict(exc.headers)

    def json(self, path, headers=None):
        status, body, _ = self.get(path, headers)
        return status, json.loads(body.decode("utf-8"))

    def post(self, path, data, content_type="application/json", headers=None):
        req = urllib.request.Request(
            self.base + path, data=data,
            headers=dict({"Content-Type": content_type}, **(headers or {})),
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def post_json(self, path, obj, headers=None):
        status, body = self.post(path, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                                 "application/json", headers)
        return status, json.loads(body.decode("utf-8"))


@pytest.fixture()
def server(tmp_path):
    serve.Handler.root = tmp_path
    serve._jobs.clear()
    httpd = serve.ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield Client("http://127.0.0.1:%d" % httpd.server_address[1]), tmp_path
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)


def wait_job(client, jid, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, job = client.json("/api/job/" + jid)
        if job.get("status") != "running":
            return job
        time.sleep(0.05)
    raise AssertionError("任务超时")


# ---------------------------------------------------------------------------
# 测试
# ---------------------------------------------------------------------------

def test_status(server):
    client, _ = server
    status, data = client.json("/api/status")
    assert status == 200 and data["ok"]
    assert data["openpyxl"].startswith("3.")


def test_upload_and_book(server, tmp_path):
    client, _ = server
    path = make_fixture(tmp_path / "src.xlsx")
    status, data = client.post("/api/upload?name=src.xlsx", path.read_bytes(),
                               "application/octet-stream")
    assert status == 200
    payload = json.loads(data.decode("utf-8"))
    assert payload["ok"] and payload["fileId"].endswith("src.xlsx")
    status, book = client.json("/api/book?file=" + payload["fileId"])
    assert status == 200 and book["ok"]
    assert book["sheets"][0]["maxRow"] == 7
    assert book["sheets"][0]["name"] == "打卡"


def test_upload_rejects_unsupported_extension(server, tmp_path):
    client, _ = server
    status, body = client.post("/api/upload?name=bad.txt", b"hello", "application/octet-stream")
    assert status == 400
    assert "只支持" in json.loads(body.decode("utf-8"))["error"]


def test_expression_endpoint(server):
    client, _ = server
    status, res = client.post_json("/api/expr/check", {"expression": "[C]*[D]"})
    assert status == 200 and res["ok"]
    status, res = client.post_json("/api/expr/check", {"expression": "__import__('os')"})
    assert status == 200 and not res["ok"] and res["error"]


def test_run_poll_download(server, tmp_path):
    client, _ = server
    path = make_fixture(tmp_path / "src.xlsx")
    _, up = client.post("/api/upload?name=src.xlsx", path.read_bytes(), "application/octet-stream")
    payload = json.loads(up.decode("utf-8"))
    status, started = client.post_json("/api/run", workflow(payload["fileId"], "done.xlsx"))
    assert status == 200 and started["ok"]
    job = wait_job(client, started["jobId"])
    assert job["status"] == "done", job.get("error")
    assert job["outputs"][0]["name"] == "done.xlsx"
    assert job["outputs"][0]["url"].startswith("/api/file/")
    status, body, headers = client.get(job["outputs"][0]["url"])
    assert status == 200 and len(body) > 0
    assert "attachment" in headers.get("Content-Disposition", "")
    out = tmp_path / "downloaded.xlsx"
    out.write_bytes(body)
    ws = load_workbook(out).active
    assert ws["C7"].value == 1.5
    assert ws["C9"].value == 2.5


def test_dry_run_has_no_outputs(server, tmp_path):
    client, _ = server
    path = make_fixture(tmp_path / "src.xlsx")
    _, up = client.post("/api/upload?name=src.xlsx", path.read_bytes(), "application/octet-stream")
    payload = json.loads(up.decode("utf-8"))
    body = workflow(payload["fileId"], "never.xlsx")
    body["dryRun"] = True
    _, started = client.post_json("/api/run", body)
    job = wait_job(client, started["jobId"])
    assert job["status"] == "done" and job["dryRun"]
    assert job["outputs"] == []
    assert not (tmp_path / "never.xlsx").exists()


def test_preview_node(server, tmp_path):
    client, _ = server
    path = make_fixture(tmp_path / "src.xlsx")
    _, up = client.post("/api/upload?name=src.xlsx", path.read_bytes(), "application/octet-stream")
    payload = json.loads(up.decode("utf-8"))
    body = workflow(payload["fileId"])
    body["previewNode"] = "m"
    _, started = client.post_json("/api/run", body)
    job = wait_job(client, started["jobId"])
    assert job["status"] == "done"
    assert set(job["result"]["nodes"].keys()) == {"f", "m"}
    assert job["outputs"] == []


def test_cancel(server, tmp_path):
    client, _ = server
    path = make_fixture(tmp_path / "src.xlsx")
    _, up = client.post("/api/upload?name=src.xlsx", path.read_bytes(), "application/octet-stream")
    payload = json.loads(up.decode("utf-8"))
    _, started = client.post_json("/api/run", workflow(payload["fileId"]))
    status, res = client.post_json("/api/cancel/" + started["jobId"], {})
    assert status == 200 and res["ok"]
    assert serve._jobs[started["jobId"]]["cancelled"]


def test_job_not_found(server):
    client, _ = server
    status, data = client.json("/api/job/nonexistent")
    assert status == 404 and not data["ok"]


def test_origin_and_host_guards(server):
    client, _ = server
    status, body = client.post("/api/run", b"{}", "application/json",
                               {"Origin": "https://evil.example"})
    assert status == 403
    status, body = client.post("/api/run", b"{}", "application/json",
                               {"Origin": "http://127.0.0.1:9999"})
    assert status != 403  # loopback origin 允许（会因空 spec 失败，但不应被安全拒绝）


def test_static_path_traversal(server):
    client, _ = server
    status, body, _headers = client.get("/../agent_workspace/omm_data.py")
    assert status in (403, 404)
    status, body, _headers = client.get("/api/file/../../omm_data.py")
    assert status in (400, 403, 404)
