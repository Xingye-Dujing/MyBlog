# -*- coding: utf-8 -*-
"""桌面模式下两个回环 Flask 服务必须复用桌面桥的 Host/Origin 校验。

缺少该校验时，外部网页可用 no-cors 的 text/plain POST 把 JSON 写进
/__omm/fs/* 与 /__omm/share/*，而磁盘桥解析的是裸请求体，不关心 Content-Type。
"""
from __future__ import annotations

import sys
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent.parent
DESKTOP = PUBLIC / "desktop"
for _p in (str(DESKTOP), str(PUBLIC)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest  # noqa: E402

from agent_workspace.omm_server import create_app as create_ai_app  # noqa: E402
from mdforge.server import create_app as create_mdforge_app  # noqa: E402


@pytest.mark.parametrize("factory", [create_ai_app, create_mdforge_app])
def test_foreign_origin_post_is_rejected(factory, tmp_path, monkeypatch):
    monkeypatch.setenv("OMM_DESKTOP", "1")
    kwargs = {"data_dir": tmp_path} if factory is create_ai_app else {"public_root": PUBLIC}
    client = factory(**kwargs).test_client()
    resp = client.post(
        "/__omm/fs/config",
        data="{}",
        content_type="text/plain",
        headers={"Origin": "https://evil.example"},
    )
    assert resp.status_code == 403


@pytest.mark.parametrize("factory", [create_ai_app, create_mdforge_app])
def test_loopback_origin_is_allowed(factory, tmp_path, monkeypatch):
    monkeypatch.setenv("OMM_DESKTOP", "1")
    kwargs = {"data_dir": tmp_path} if factory is create_ai_app else {"public_root": PUBLIC}
    client = factory(**kwargs).test_client()
    resp = client.get("/", headers={"Host": "127.0.0.1:8316", "Origin": "http://127.0.0.1:8316"})
    assert resp.status_code == 200


@pytest.mark.parametrize("factory", [create_ai_app, create_mdforge_app])
def test_opaque_origin_is_rejected(factory, tmp_path, monkeypatch):
    monkeypatch.setenv("OMM_DESKTOP", "1")
    kwargs = {"data_dir": tmp_path} if factory is create_ai_app else {"public_root": PUBLIC}
    client = factory(**kwargs).test_client()
    assert client.get("/", headers={"Origin": "null"}).status_code == 403


@pytest.mark.parametrize("factory", [create_ai_app, create_mdforge_app])
def test_web_preview_is_unaffected(factory, tmp_path, monkeypatch):
    monkeypatch.delenv("OMM_DESKTOP", raising=False)
    kwargs = {"data_dir": tmp_path} if factory is create_ai_app else {"public_root": PUBLIC}
    client = factory(**kwargs).test_client()
    assert client.get("/", headers={"Origin": "https://evil.example"}).status_code == 200
