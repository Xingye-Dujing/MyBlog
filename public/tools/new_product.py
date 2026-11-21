# -*- coding: utf-8 -*-
"""从 OMM-ZEN 设计系统模板生成一个新产品的骨架。

    python tools/new_product.py <id> <名称> <字标> [描述] [--port 8335] [--channels documents,notes]

生成：入口页、产品样式、专项测试骨架，并打印需要在注册表补充的条目。
不会自动修改注册表、版本或目录，以免误改现有产品。
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

HTML = '''<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{name}</title>
    <script src="omm-embed.js"></script>
    <script src="omm-desktop.js"></script>
    <script src="omm-share.js"></script>
    <link rel="stylesheet" href="vendor/fonts/literata-alt.css" />
    <link rel="stylesheet" href="zen-style/zen.css">
    <link rel="stylesheet" href="zen-style/products/{pid}.css">
    <link rel="icon" href="icon.ico" type="image/x-icon" />
  </head>
  <body>
    <header class="panel-h">
      <span class="mark">{glyph}</span>
      <span class="panel-t">{name}</span>
    </header>
    <main id="app" class="workspace">
      <section class="panel">
        <div class="panel-head"><span class="panel-title">{name}</span></div>
        <div class="panel-body" id="content"></div>
      </section>
    </main>
    <footer class="status"><span id="statusText">READY</span></footer>
    <script>
      ;(function () {{
        'use strict'
        var $ = function (id) {{ return document.getElementById(id) }}
        function toast(text) {{
          var node = document.createElement('div')
          node.className = 'hint'
          node.textContent = text
          $('content').appendChild(node)
        }}
        $('content').textContent = '在这里实现 {name} 的业务逻辑。'
        window.Zen{cls} = {{ toast: toast }}
      }})()
    </script>
  </body>
</html>
'''

CSS = '''@layer zen.product {{
/* {name} 专有样式；配色与组件复用 zen-style 共享层。 */
.mark {{
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--line);
  font-family: var(--serif);
}}
}}
'''

TEST = '''/* {name} 专项测试骨架。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {{ readFileSync }} from 'node:fs'

const ROOT = new URL('../', import.meta.url)
const html = readFileSync(new URL('public/omm-{pid}.html', ROOT), 'utf8')

test('入口页接入统一入口与桥接', () => {{
  for (const asset of [
    'omm-embed.js', 'omm-desktop.js', 'omm-share.js',
    'zen-style/zen.css', 'zen-style/products/{pid}.css',
  ]) assert.ok(html.includes(asset), '缺少 ' + asset)
  assert.ok(!/<style\\b/.test(html), '不得内联样式')
}})
'''


def build(pid: str, name: str, glyph: str, desc: str, port: int, channels: str) -> dict[str, str]:
    if not re.fullmatch(r'[a-z][a-z0-9-]*', pid):
        raise ValueError('id 必须是小写字母/数字/连字符')
    cls = ''.join(part.capitalize() for part in re.split(r'[-_]', pid))
    files = {
        f'omm-{pid}.html': HTML.format(pid=pid, name=name, glyph=glyph, cls=cls),
        f'zen-style/products/{pid}.css': CSS.format(name=name),
        f'tests/test_{pid}.mjs': TEST.format(pid=pid, name=name),
    }
    return files


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('pid')
    ap.add_argument('name')
    ap.add_argument('glyph')
    ap.add_argument('desc', nargs='?', default='')
    ap.add_argument('--port', type=int, default=8335)
    ap.add_argument('--channels', default='documents')
    ap.add_argument('--out', default=str(ROOT), help='输出根目录（默认 public/）')
    args = ap.parse_args()

    files = build(args.pid, args.name, args.glyph, args.desc, args.port, args.channels)
    out = Path(args.out)
    for rel, content in files.items():
        path = out / rel
        if path.exists():
            raise SystemExit('已存在，拒绝覆盖：' + str(path))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        print('created', path)

    print('\n请在 desktop/plugin_specs.py 的 BUILTIN_PLUGINS 增加：')
    print('  {"id": "%s", "name": "%s", "glyph": "%s", "description": "%s",' %
          (args.pid, args.name, args.glyph, args.desc))
    print('   "entry": "omm-%s.html", "port": %d, "runtime": "static", "order": 200,' %
          (args.pid, args.port))
    print('   "share": {"channels": [{"id": "%s", "role": "both"}]}},' % args.channels)


if __name__ == '__main__':
    main()
