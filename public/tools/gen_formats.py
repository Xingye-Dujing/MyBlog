# -*- coding: utf-8 -*-
"""OMM-ZEN 格式契约代码生成器。

真源是 ``public/json-specs/format-registry.json``。本脚本由它生成：

* ``public/agent_workspace/omm_formats_generated.py`` —— AI 工作区使用的
  ``TEMPLATES`` / ``DETECTION`` / ``detect_kind`` / 声明式校验，全部来自注册表；
* ``public/json-specs/formats.generated.md`` 与 ``omm_knowledge`` 镜像 —— 给人和
  AI 复制即用的格式骨架。

所以“格式 token / 版本 / 模板 / 硬门槛 / AI 骨架”只有一份可编辑真源：注册表。
深度语义校验器（引用完整性、checksum 等）仍在 ``omm_validators.py``，由注册表
的 ``validator`` 字段绑定，并由 golden fixtures + 守卫钉死。

用法::

    python public/tools/gen_formats.py            # 生成（默认）
    python public/tools/gen_formats.py --check    # 只读校验生成物是否最新
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / 'json-specs' / 'format-registry.json'
PY_OUT = ROOT / 'agent_workspace' / 'omm_formats_generated.py'
MD_OUT = ROOT / 'json-specs' / 'formats.generated.md'
MD_MIRROR = ROOT / 'agent_workspace' / 'omm_knowledge' / 'formats.generated.md'

PY_HEADER = '''# -*- coding: utf-8 -*-
"""AUTO-GENERATED from public/json-specs/format-registry.json by public/tools/gen_formats.py.

DO NOT EDIT BY HAND. Edit the registry, then run: python public/tools/gen_formats.py
The GEN_FORMATS guard fails the build if this file drifts from the registry.
"""
from __future__ import annotations

import json

FORMAT_SCHEMA = {schema}
CHECKSUM = {checksum!r}
_DATA = json.loads(r\'\'\'{payload}\'\'\')
REGISTRY = _DATA['formats']
DETECTION = _DATA['detection']
TEMPLATES = {{}}
for _row in REGISTRY:
    TEMPLATES.setdefault(_row['product'], {{}})[_row['kind']] = _row['template']
FORMAT_TOKENS = sorted({{row['format'] for row in REGISTRY if row['format']}})
HARD_GATES = {{(row['product'], row['kind']): row['hard'] for row in REGISTRY}}


def _matches(rule: dict, obj, text: str) -> bool:
    """Interpret one declarative detection rule from the registry."""
    mode = rule['mode']
    value = rule.get('value')
    if mode == 'const':
        return True
    if mode == 'fallback':
        return True
    if mode == 'format':
        return isinstance(obj, dict) and obj.get('format') == value
    if mode == 'omm':
        return isinstance(obj, dict) and obj.get('omm') == value
    if mode == 'kind':
        return isinstance(obj, dict) and obj.get('kind') == value
    if mode == 'key_dict':
        return isinstance(obj, dict) and isinstance(obj.get(value), dict)
    if mode == 'keys':
        return isinstance(obj, dict) and all(key in obj for key in value)
    if mode == 'shape':
        if value == 'array':
            return isinstance(obj, list)
        if value == 'dict':
            return isinstance(obj, dict)
        if value == 'structured':
            return isinstance(obj, (dict, list))
    return False


def detect_kind(product: str, obj, text: str = '') -> str:
    """Deterministically classify a payload using registry detection rules."""
    for rule in DETECTION.get(product, []):
        if _matches(rule, obj, text):
            return rule['kind']
    return 'auto'


def declarative_errors(product: str, kind: str, obj) -> list:
    """Check the machine-declarable contract: format, version, field shapes, enums.

    Deep semantic rules (referential integrity, checksum, cross-field slices)
    stay in the hand-written validators bound by ``validator``; this layer makes
    the common contract drift-proof because it comes straight from the registry.
    """
    errors = []
    rows = [row for row in REGISTRY if row['product'] == product and row['kind'] == kind]
    if not rows:
        return errors
    row = rows[0]
    if not isinstance(obj, dict):
        # Text / array / unsupported formats have their own deep validators.
        return errors
    token = row.get('format')
    if token and token != 'bridge' and row.get('kind') not in ('properties',):
        if obj.get('format') != token:
            errors.append('%s.format 必须是 %r' % (kind, token))
    version = row.get('version')
    if version is not None and 'version' in obj and obj['version'] != version:
        errors.append('%s.version 必须是 %r' % (kind, version))
    for field in row.get('fields', []):
        name = field.get('name')
        if not name or not field.get('required'):
            continue
        if name not in obj:
            errors.append('%s.%s 缺失' % (kind, name))
            continue
        expected = field.get('type')
        value = obj[name]
        ok = True
        if expected == 'string':
            ok = isinstance(value, str)
        elif expected == 'number':
            ok = isinstance(value, (int, float)) and not isinstance(value, bool)
        elif expected == 'boolean':
            ok = isinstance(value, bool)
        elif expected == 'array':
            ok = isinstance(value, list)
        elif expected == 'object':
            ok = isinstance(value, dict)
        if not ok:
            errors.append('%s.%s 类型应为 %s' % (kind, name, expected))
    for name, values in (row.get('enums') or {{}}).items():
        if name in obj and obj[name] not in values:
            errors.append('%s.%s 必须是 %s 之一' % (kind, name, '/'.join(values)))
    return errors
'''


def _json_block(value) -> str:
    text = json.dumps(value, ensure_ascii=False, indent=2)
    assert "'''" not in text, 'registry payload contains triple quotes'
    return text


def render_py(registry: dict) -> str:
    payload = _json_block({
        'formats': registry['formats'],
        'detection': registry['detection'],
    })
    return PY_HEADER.format(schema=registry['schema'],
                            checksum=registry['checksum'],
                            payload=payload)


def _md_escape(cell: str) -> str:
    return str(cell).replace('|', '\\|').replace('\n', ' ')


def render_md(registry: dict) -> str:
    lines = [
        '# OMM-ZEN 格式骨架（自动生成）',
        '',
        '> 本文件由 `public/tools/gen_formats.py` 从 `json-specs/format-registry.json` 生成，',
        '> **请勿手改**。改契约请编辑注册表后运行 `python public/tools/gen_formats.py`。',
        '> 机器可读真源：`public/json-specs/format-registry.json`（schema %d）。' % registry['schema'],
        '> 校验器绑定与深度语义规则见 `omm_validators.py`；本骨架给人和 AI 直接复制使用。',
        '',
        '交付物一律 UTF-8、合法 JSON、无注释、无尾逗号、无代码围栏（Latex/MDFORGE 是纯文本）。',
        '',
        '## 目录',
        '',
    ]
    groups = {}
    for row in registry['formats']:
        groups.setdefault(row['product'], []).append(row)
    for pid, rows in groups.items():
        label = rows[0].get('label') or pid
        lines.append('- [%s · %s](#%s)' % (pid, label, pid))
        for row in rows:
            lines.append('  - %s（%s）' % (row['kind'], row.get('ext', '.json')))
    lines += ['', '---', '']
    for pid, rows in groups.items():
        label = rows[0].get('label') or pid
        lines += ['<a id="%s"></a>' % pid, '', '## %s · %s' % (pid, label), '']
        for row in rows:
            lines += ['### `%s` · %s' % (row['kind'], row.get('ext', '.json')), '']
            token = row.get('format')
            version = row.get('version')
            meta = []
            if token:
                meta.append('format=`%s`' % token)
            if version is not None:
                meta.append('version=`%s`' % version)
            lines.append('- 契约：%s' % ('，'.join(meta) if meta else '无固定 token'))
            lines.append('- 实现源码：`%s`' % row['source'])
            if row.get('validator'):
                lines.append('- 深度校验器：`%s`' % row['validator'])
            if row.get('golden'):
                lines.append('- Golden fixture：`%s`' % row['golden'])
            hard = row.get('hard') or []
            if hard:
                lines.append('- 硬门槛：%s' % '；'.join(hard))
            fields = row.get('fields') or []
            if fields:
                lines += ['', '| 字段 | 类型 | 必需 |', '|---|---|---|']
                for field in fields:
                    lines.append('| `%s` | %s | %s |' % (
                        _md_escape(field.get('name') or '—'),
                        _md_escape(field.get('type') or 'any'),
                        '是' if field.get('required') else '否'))
            enums = row.get('enums') or {}
            if enums:
                lines += ['', '枚举：']
                for name, values in enums.items():
                    lines.append('- `%s`：%s' % (name, '/'.join(values)))
            lines += ['', '最小示例：', '', '```json',
                      json.dumps(row['template'], ensure_ascii=False, indent=2), '```', '']
        lines += ['---', '']
    return '\n'.join(lines).rstrip() + '\n'


def _rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path).replace('\\', '/')


def main(check: bool = False) -> int:
    if not REGISTRY.is_file():
        print('missing registry: %s' % REGISTRY, file=sys.stderr)
        return 2
    registry = json.loads(REGISTRY.read_text(encoding='utf-8'))
    if registry.get('schema') != 1:
        print('unsupported registry schema', file=sys.stderr)
        return 2
    outputs = {
        PY_OUT: render_py(registry),
        MD_OUT: render_md(registry),
        MD_MIRROR: render_md(registry),
    }
    drifted = []
    for path, text in outputs.items():
        current = path.read_text(encoding='utf-8') if path.is_file() else None
        if current != text:
            drifted.append(_rel(path))
    if check:
        if drifted:
            print('generated files are stale: ' + ', '.join(drifted), file=sys.stderr)
            return 1
        print('generated files up to date (%d artifacts)' % len(outputs))
        return 0
    for path, text in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        # Keep LF on disk: the guard reads text with universal-newline
        # translation, so CRLF here would look like permanent drift.
        with path.open('w', encoding='utf-8', newline='\n') as handle:
            handle.write(text)
    print('generated %d artifacts from %d format contracts' % (
        len(outputs), len(registry['formats'])))
    return 0


if __name__ == '__main__':
    raise SystemExit(main('--check' in sys.argv))
