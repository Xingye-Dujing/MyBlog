# -*- coding: utf-8 -*-
"""新产品脚手架：生成文件符合设计系统契约。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.new_product import build  # noqa: E402


def test_build_generates_contract_files():
    files = build('demo', '演示产品', '演', '', 8335, 'documents')
    assert set(files) == {
        'omm-demo.html',
        'zen/products/demo.css',
        'tests/test_demo.mjs',
    }
    html = files['omm-demo.html']
    for asset in ('omm-embed.js', 'omm-desktop.js', 'omm-share.js',
                  'zen/zen.css', 'zen/products/demo.css'):
        assert asset in html
    assert '<style' not in html
    assert '<title>演示产品</title>' in html
    assert files['zen/products/demo.css'].startswith('@layer zen.product {')
    assert 'zen/products/demo.css' in files['tests/test_demo.mjs']


def test_build_rejects_invalid_id():
    for bad in ('Demo', '1demo', 'dem o'):
        try:
            build(bad, 'x', 'x', '', 8335, '')
        except ValueError:
            pass
        else:
            raise AssertionError('should reject ' + bad)
