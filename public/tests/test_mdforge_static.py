# -*- coding: utf-8 -*-
"""MdForge 后端静态资源路由：共享样式与 lib 模块必须能由插件服务加载。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from mdforge.server import create_app  # noqa: E402


def test_shared_assets_are_served():
    client = create_app(ROOT).test_client()
    for path in ('/zen/zen.css', '/zen/products/mdforge.css',
                 '/lib/zen-link.js'):
        response = client.get(path)
        assert response.status_code == 200, (path, response.status_code)
    # 只开放共享资源树，不暴露插件清单与后端源码。
    for path in ('/zen/foundation/missing.css', '/lib/missing.js', '/plugin.json'):
        assert client.get(path).status_code == 404, path
