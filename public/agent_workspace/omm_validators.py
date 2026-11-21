# -*- coding: utf-8 -*-
"""OMM-ZEN 导入/导出格式校验器（纯 Python，无第三方依赖）。

AI 只需要从 omm_format_template 拿骨架、填好内容，再交给 omm_format_validate 校验；
错误按“路径 + 原因”返回，AI 据此自行修正，不必自己写校验逻辑。

校验规则取自各产品源码（lib/zen-card.js / lib/zen-backup.js / lib/zen-flow.js / json-specs /
MDFORGE AI 规范），只卡真正会导致导入失败的硬约束；可恢复的偏差给 warning。
"""
from __future__ import annotations

import json
import re
import struct
from datetime import date, datetime
from typing import Any, Dict, List, Tuple

from .omm_data import ALL, PRODUCTS, product
from .omm_formats_generated import (
    REGISTRY as FORMAT_REGISTRY,
    TEMPLATES as GENERATED_TEMPLATES,
    declarative_errors,
    detect_kind as generated_detect_kind,
)

# ── 通用工具 ─────────────────────────────────────────────────────────────────


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def _id(value: Any) -> str:
    """把任意形态的 id 归一化为可哈希字符串。

    导入内容来自不可信的 JSON：id 可能是数字、数组甚至对象。直接拿原值做
    set/dict 的键会在对象/数组形态上抛 ``TypeError: unhashable type``，让
    validate() 泄漏成 HTTP 500。所有 id 比较都先经过这里。
    """
    return '' if value is None else str(value)


def _utf16_slice(text: str, start: int, end: int) -> str:
    """按 JavaScript ``String.prototype.slice`` 的 UTF-16 码元语义切片。

    annotate 端用 ``doc.text.slice(start, end)`` 取引文，start/end 是 UTF-16
    码元偏移；Python 字符串按码点切片，emoji 等非 BMP 字符之前二者会错位，
    导致合法备份被误判为 quote 不匹配。这里显式按 UTF-16 码元切片。
    """
    raw = text.encode('utf-16-le', 'surrogatepass')
    return raw[start * 2:end * 2].decode('utf-16-le', 'ignore')


def _base36(number: int) -> str:
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    if number == 0:
        return '0'
    out = ''
    while number:
        number, rem = divmod(number, 36)
        out = digits[rem] + out
    return out


def js_checksum(value: Any) -> str:
    """与 lib/zen-backup.js 完全一致的 FNV-1a（UTF-16 码元）——用于校验 checksum 字段。"""
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    h = 2166136261
    for (unit,) in struct.iter_unpack('<H', text.encode('utf-16-le')):
        h ^= unit
        h = (h * 16777619) & 0xffffffff
    return _base36(h)


def _parse(text: str) -> Tuple[Any, str]:
    try:
        return json.loads(text), ''
    except Exception as exc:
        return None, 'JSON 解析失败：%s（不要包代码围栏，不要加注释或尾随逗号）' % exc


def _is_date(value: Any) -> bool:
    try:
        date.fromisoformat(str(value))
        return True
    except Exception:
        return False


def _is_iso(value: Any) -> bool:
    try:
        datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return True
    except Exception:
        return False


def _is_ts(value: Any) -> bool:
    return bool(re.match(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$', str(value or '')))


def _is_num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class Report:
    def __init__(self) -> None:
        self.errors: List[str] = []
        self.warnings: List[str] = []

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    def require(self, obj: Any, key: str, path: str, kind: type | None = None) -> Any:
        if not isinstance(obj, dict) or key not in obj:
            self.error('%s.%s 缺失' % (path, key))
            return None
        value = obj[key]
        if kind is not None and not isinstance(value, kind):
            self.error('%s.%s 类型应为 %s' % (path, key, kind.__name__))
            return None
        return value

    def array(self, obj: Any, key: str, path: str) -> list:
        value = self.require(obj, key, path, list)
        return value if isinstance(value, list) else []


# ── 各产品校验器 ─────────────────────────────────────────────────────────────

CARD_KINDS = ('quote', 'note', 'word', 'sentence', 'idea', 'todo', 'fact', 'image')
CARD_SOURCES = ('manual', 'writer', 'annotate', 'corpus', 'english', 'search', 'data', 'web', 'clip')
PLANNER_COLORS = ('#888888', '#cc3333', '#3366cc', '#339933', '#cc6600')
VIZ_ENGINES = ('echarts', 'chartjs', 'apexcharts', 'zen')
FLOW_ACTIONS = ('addTag', 'setKind', 'send', 'publish', 'notify', 'highlight')


def _bridge(obj: Any, r: Report, path: str = '') -> None:
    if r.require(obj, 'omm', path) != 'bridge':
        r.error('%s.omm 必须是 "bridge"' % path)
    if r.require(obj, 'v', path) != 1:
        r.error('%s.v 必须是数字 1' % path)
    items = r.array(obj, 'items', path)
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            r.error('%s.items[%d] 必须是对象' % (path, index))
            continue
        if not str(item.get('t') or item.get('kind') or '').strip():
            r.error('%s.items[%d].t 不能为空（word/sentence/template/phrase/doc）' % (path, index))


def _card(obj: Any, r: Report, path: str, *, strict_format: bool = True) -> None:
    if not isinstance(obj, dict):
        r.error('%s 必须是对象' % path)
        return
    if strict_format and obj.get('format') != 'zen-card':
        r.error('%s.format 必须是 "zen-card"' % path)
    if strict_format and obj.get('v') != 1:
        r.error('%s.v 必须是数字 1' % path)
    if not str(obj.get('id') or '').strip():
        r.error('%s.id 不能为空' % path)
    if obj.get('kind', 'note') not in CARD_KINDS:
        r.error('%s.kind 非法，只能是 %s' % (path, '/'.join(CARD_KINDS)))
    if obj.get('source', 'manual') not in CARD_SOURCES:
        r.error('%s.source 非法，只能是 %s' % (path, '/'.join(CARD_SOURCES)))
    if not str(obj.get('content') or '').strip():
        r.error('%s.content 不能为空' % path)
    if 'tags' in obj and not isinstance(obj['tags'], list):
        r.error('%s.tags 必须是数组' % path)
    for key in ('createdAt', 'updatedAt'):
        if obj.get(key) and not _is_iso(obj[key]):
            r.error('%s.%s 不是合法 ISO 时间' % (path, key))
    if 'links' in obj:
        if not isinstance(obj['links'], list):
            r.error('%s.links 必须是数组' % path)
        else:
            for index, link in enumerate(obj['links']):
                if not isinstance(link, dict) or not str(link.get('id') or '').strip():
                    r.error('%s.links[%d].id 不能为空' % (path, index))


def v_annotate(obj: Any, text: str, r: Report) -> str:
    if isinstance(obj, dict) and obj.get('omm') == 'bridge':
        _bridge(obj, r)
        return 'bridge'
    if isinstance(obj, dict) and isinstance(obj.get('project'), dict):
        project = obj['project']
        if obj.get('app') != 'zenmark':
            r.error('app 必须是 "zenmark"')
        if obj.get('version') != 1:
            r.error('version 必须是数字 1')
        if obj.get('exportedAt') and not _is_ts(obj['exportedAt']):
            r.warn('exportedAt 建议为 "YYYY-MM-DD HH:mm" 字符串')
        codes = r.array(project, 'codes', 'project')
        if not codes:
            r.error('project.codes 不能为空 —— 这是标注项目导入的硬门槛')
        docs = r.array(project, 'docs', 'project')
        ids = set()
        for group in ('docs', 'codes', 'anns', 'rels', 'memos', 'marks', 'notes',
                      'cellCodes', 'reliability'):
            for index, item in enumerate(r.array(project, group, 'project')):
                if not isinstance(item, dict):
                    r.error('project.%s[%d] 必须是对象' % (group, index))
                    continue
                if not str(item.get('id') or '').strip():
                    r.error('project.%s[%d].id 不能为空' % (group, index))
                elif _id(item['id']) in ids:
                    r.error('id 重复：%s（id 必须全局唯一）' % item['id'])
                else:
                    ids.add(_id(item['id']))
        doc_map = {str(d.get('id')): str(d.get('text') or '') for d in docs if isinstance(d, dict)}
        code_ids = {str(c.get('id')) for c in codes if isinstance(c, dict)}
        for index, ann in enumerate(r.array(project, 'anns', 'project')):
            if not isinstance(ann, dict):
                continue
            if _id(ann.get('doc')) not in doc_map:
                r.error('project.anns[%d].doc 指向不存在的文档 id' % index)
            if ann.get('code') and _id(ann['code']) not in code_ids:
                r.error('project.anns[%d].code 指向不存在的编码 id' % index)
            start, end = ann.get('start'), ann.get('end')
            if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end < start:
                r.error('project.anns[%d].start/end 必须是非负整数且 start <= end' % index)
            elif _id(ann.get('doc')) in doc_map:
                expected = _utf16_slice(doc_map[_id(ann['doc'])], start, end)
                if str(ann.get('quote') or '') != expected:
                    r.error('project.anns[%d].quote 必须等于 doc.text.slice(start,end)：应为 %r' % (index, expected))
        for index, cc in enumerate(r.array(project, 'cellCodes', 'project')):
            if not isinstance(cc, dict):
                r.error('project.cellCodes[%d] 必须是对象' % index)
                continue
            if _id(cc.get('table')) not in doc_map:
                r.error('project.cellCodes[%d].table 指向不存在的文档 id' % index)
            if cc.get('code') and _id(cc['code']) not in code_ids:
                r.error('project.cellCodes[%d].code 指向不存在的编码 id' % index)
            row = cc.get('row')
            if not isinstance(row, int) or isinstance(row, bool) or row < 0:
                r.error('project.cellCodes[%d].row 必须是非负整数（0 基行号）' % index)
            rd = cc.get('round', 1)
            if not isinstance(rd, int) or isinstance(rd, bool) or rd < 1:
                r.error('project.cellCodes[%d].round 必须是 >=1 的整数' % index)
        for index, rel in enumerate(r.array(project, 'reliability', 'project')):
            if not isinstance(rel, dict):
                r.error('project.reliability[%d] 必须是对象' % index)
                continue
            stat = rel.get('stat')
            if isinstance(stat, dict):
                k = stat.get('kappa')
                if k is not None and (not isinstance(k, (int, float)) or isinstance(k, bool) or k < -1 or k > 1):
                    r.error('project.reliability[%d].stat.kappa 必须在 -1..1 之间' % index)
                po = stat.get('po')
                if po is not None and (not isinstance(po, (int, float)) or isinstance(po, bool) or po < 0 or po > 1):
                    r.error('project.reliability[%d].stat.po 必须在 0..1 之间' % index)
        return 'backup'
    if not text.strip():
        r.error('纯文本导入不能为空')
    return 'text'


def v_corpus(obj: Any, text: str, r: Report) -> str:
    if isinstance(obj, dict) and obj.get('omm') == 'bridge':
        _bridge(obj, r)
        return 'bridge'
    if not isinstance(obj, dict):
        r.error('语料库恢复文件必须是对象')
        return 'restore'
    entries = r.array(obj, 'entries', '')
    categories = r.array(obj, 'categories', '')
    if not entries:
        r.error('entries 不能为空 —— 恢复文件的硬门槛')
    if not categories:
        r.error('categories 不能为空 —— 恢复文件的硬门槛')
    cat_ids = set()
    for index, category in enumerate(categories):
        if not isinstance(category, dict) or not str(category.get('id') or '').strip():
            r.error('categories[%d].id 不能为空' % index)
        else:
            cat_ids.add(_id(category['id']))
    entry_ids = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            r.error('entries[%d] 必须是对象' % index)
            continue
        if not str(entry.get('en') or '').strip():
            r.error('entries[%d].en 不能为空' % index)
        if _id(entry.get('categoryId')) not in cat_ids:
            r.error('entries[%d].categoryId 不在 categories 中' % index)
        if 'tags' in entry and not isinstance(entry['tags'], list):
            r.error('entries[%d].tags 必须是数组' % index)
        identifier = _id(entry.get('id'))
        if identifier in entry_ids:
            r.error('entries[%d].id 重复' % index)
        entry_ids.add(identifier)
    return 'restore'


def _rows(obj: Any, r: Report) -> None:
    if isinstance(obj, dict):
        rows = obj.get('rows')
        if not isinstance(rows, list):
            r.error('缺少 rows[] —— 不要提交 {tables:[…]} 整库结构，它不能作为文件导入')
            return
        if 'tables' in obj:
            r.error('不允许 tables 字段：文件导入只接受行数据')
    elif isinstance(obj, list):
        rows = obj
    else:
        r.error('数据文件必须是行对象数组、二维数组或 {rows:[…]}')
        return
    if not rows:
        r.error('rows 不能为空')
    if all(isinstance(row, dict) for row in rows):
        return
    if all(isinstance(row, list) for row in rows):
        widths = {len(row) for row in rows}
        if len(widths) > 1:
            r.warn('二维数组各行列数不一致：%s' % sorted(widths))
        return
    r.error('行数据混用了对象与数组，会导致导入失败')


def v_data(obj: Any, text: str, r: Report) -> str:
    if isinstance(obj, (dict, list)):
        _rows(obj, r)
        return 'rows'
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        r.error('CSV/TSV 内容不能为空')
        return 'csv'
    delim = '\t' if lines[0].count('\t') >= lines[0].count(',') else ','
    widths = [len(line.split(delim)) for line in lines]
    if len(set(widths)) > 1:
        r.error('CSV/TSV 每行列数不一致：%s' % widths)
    if not str(lines[0].split(delim)[0]).strip():
        r.error('首列（表头）不能为空')
    return 'csv'


def v_english(obj: Any, text: str, r: Report) -> str:
    if isinstance(obj, dict) and obj.get('omm') == 'bridge':
        _bridge(obj, r)
        return 'bridge'
    if isinstance(obj, dict) and isinstance(obj.get('drawings'), dict):
        words = set()
        for word, payload in obj['drawings'].items():
            if str(word) != str(word).lower():
                r.error('drawings 的键 "%s" 必须小写' % word)
            words.add(str(word))
            if not isinstance(payload, dict) or not isinstance(payload.get('strokes'), list):
                r.error('drawings["%s"].strokes 必须是数组' % word)
                continue
            for index, stroke in enumerate(payload['strokes']):
                if not isinstance(stroke, dict):
                    continue
                points = stroke.get('points')
                if points is None:
                    points = []
                if not isinstance(points, list):
                    r.error('drawings["%s"].strokes[%d].points 必须是数组' % (word, index))
                    continue
                for pindex, point in enumerate(points):
                    if not isinstance(point, dict):
                        continue
                    x, y, pressure = point.get('x'), point.get('y'), point.get('p')
                    if not _is_num(x) or not 0 <= x <= 1200:
                        r.error('drawings["%s"].strokes[%d].points[%d].x 超出 [0,1200]' % (word, index, pindex))
                    if not _is_num(y) or not 0 <= y <= 800:
                        r.error('drawings["%s"].strokes[%d].points[%d].y 超出 [0,800]' % (word, index, pindex))
                    if not _is_num(pressure) or not 0.15 <= pressure <= 1:
                        r.error('drawings["%s"].strokes[%d].points[%d].p 超出 [0.15,1]' % (word, index, pindex))
        return 'doodles'
    if isinstance(obj, dict) and 'books' in obj and 'prog' in obj:
        books = obj['books'] if isinstance(obj['books'], dict) else {}
        if not isinstance(obj['books'], dict) or not isinstance(obj['prog'], dict):
            r.error('完整备份的 books 与 prog 必须都是对象')
        for book_id, book in books.items():
            if str(book_id).startswith('u'):
                if not isinstance(book, dict) or 'w' not in book:
                    r.error('books["%s"] 缺少 w 词表' % book_id)
        if not obj['books']:
            r.warn('books 为空：恢复后自定义词库将为空')
        return 'backup'
    words = obj.get('words') if isinstance(obj, dict) else obj
    if not isinstance(words, list):
        r.error('词库必须是数组或 {words:[…]}（也可是涂鸦/完整备份/桥接包）')
        return 'wordbook'
    for index, word in enumerate(words):
        if isinstance(word, list):
            if len(word) < 3:
                r.error('words[%d] 数组至少需要 [word, ph, meaning]' % index)
            if not str(word[0] or '').strip():
                r.error('words[%d][0] 不能为空' % index)
        elif isinstance(word, dict):
            if not str(word.get('w') or '').strip():
                r.error('words[%d].w 不能为空' % index)
        else:
            r.error('words[%d] 必须是对象或四元数组' % index)
    return 'wordbook'


def v_latex(obj: Any, text: str, r: Report) -> str:
    if not text.strip():
        r.error('.tex 内容不能为空')
        return 'tex'
    if '\\documentclass' not in text:
        r.error('缺少 \\documentclass：请输出完整单文件文档')
    if '\\begin{document}' not in text or '\\end{document}' not in text:
        r.error('\\begin{document} 与 \\end{document} 必须成对出现')
    for forbidden in ('\\input', '\\include{', '\\write18', '\\usepackage'):
        if forbidden in text:
            r.error('不允许 %s —— 文档必须自包含' % forbidden)
    if '\\includegraphics' in text:
        r.warn('\\includegraphics 引用本地路径在跨设备时不可用，建议改用 TikZ/pgfplots')
    if text.count('$') % 2:
        r.warn('行内公式 $ 数量为奇数，请检查是否成对闭合')
    if text.count('$$') % 2:
        r.warn('行间公式 $$ 数量为奇数，请检查是否成对闭合')
    begins = len(re.findall(r'\\begin\{', text))
    ends = len(re.findall(r'\\end\{', text))
    if begins != ends:
        r.warn('\\begin{...} 与 \\end{...} 数量不一致（%d / %d）' % (begins, ends))
    return 'tex'


def v_mdforge(obj: Any, text: str, r: Report) -> str:
    lines = text.splitlines()
    if not lines or lines[0].strip() != '---':
        r.error('第一行必须是 YAML frontmatter 起始符 ---')
        return 'markdown'
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == '---'), -1)
    if end < 0:
        r.error('frontmatter 缺少结束符 ---')
        return 'markdown'
    front = '\n'.join(lines[1:end])
    if not re.search(r'(?m)^title:\s*\S', front):
        r.error('frontmatter 必须包含非空 title')
    if not re.search(r'(?m)^template:\s*academic\s*$', front):
        r.error('frontmatter 必须包含 template: academic')
    body = '\n'.join(lines[end + 1:])
    body_lines = body.strip().splitlines()
    fence_lines = [i for i, line in enumerate(body_lines) if line.lstrip().startswith('```')]
    if len(fence_lines) == 2 and fence_lines[0] == 0 and fence_lines[1] == len(body_lines) - 1:
        r.error('整篇正文不要用代码围栏包裹 —— 只输出 Markdown 纯文本')
    if re.search(r'(?m)^#{5,}\s', body):
        r.error('标题不能超过 H4')
    if re.search(r'!\[[^\]]*\]\(\s*https?://', body):
        r.error('不允许远程图片，图片路径应为 images/...')
    for match in re.finditer(r'!\[[^\]]*\]\(([^)]+)\)', body):
        parts = match.group(1).split()
        if not parts:
            continue
        path = parts[0]
        if not path.startswith('images/'):
            r.warn('图片路径 %s 建议使用 images/... 相对路径' % path)
    for block in re.findall(r'```latex-figure[^\n]*\n([\s\S]*?)```', body):
        if '\\begin{figure}' in block and '\\end{figure}' not in block:
            r.error('latex-figure 的 figure 环境未闭合')
        for forbidden in ('\\input', '\\include{', '\\write18', '\\usepackage'):
            if forbidden in block:
                r.error('latex-figure 内禁止 %s' % forbidden)
    open_fences = len(re.findall(r'(?m)^```', body))
    if open_fences % 2:
        r.warn('代码围栏数量为奇数，请检查是否成对闭合')
    tables = [line for line in body.splitlines() if line.lstrip().startswith('|')]
    for line in tables:
        if line.count('|') - 1 > 6:
            r.error('GFM 表格不能超过 6 列')
            break
    refs = [index for index, line in enumerate(lines) if line.strip() == '# 参考文献']
    if len(refs) > 1:
        r.error('# 参考文献 只能出现一次')
    elif refs and any(str(line).strip() for line in lines[refs[0] + 1:]):
        r.error('# 参考文献 必须是正文最后一段，之后不再写内容')
    return 'markdown'


def v_message(obj: Any, text: str, r: Report) -> str:
    r.error('消息同步没有文件导入入口：不能在生成文件里恢复加密消息')
    r.warn('只能产出 zmsg-supabase-config-v1 / zmsg-ui-v1 / zmsg-message-cache-v1 等 localStorage 配置，且不得包含密码或 API Key')
    return 'unsupported'


def v_planner(obj: Any, text: str, r: Report) -> str:
    if not isinstance(obj, dict):
        r.error('日程备份必须是对象')
        return 'backup'
    if obj.get('app') != 'zenplan':
        r.error('app 必须是 "zenplan"')
    if not isinstance(obj.get('version'), int) or obj['version'] != 2:
        r.error('version 必须是数字 2（字符串 "2" 会走旧版兼容分支）')
    planners = r.array(obj, 'planners', '')
    planner_ids = set()
    for index, planner in enumerate(planners):
        if not isinstance(planner, dict) or not str(planner.get('id') or '').strip():
            r.error('planners[%d].id 不能为空' % index)
        else:
            planner_ids.add(_id(planner['id']))
    events_by = r.require(obj, 'eventsBy', '', dict)
    recurs_by = r.require(obj, 'recursBy', '', dict)
    for group, mapping in (('eventsBy', events_by), ('recursBy', recurs_by)):
        if not isinstance(mapping, dict):
            continue
        for key in mapping:
            if _id(key) not in planner_ids:
                r.error('%s 的键 "%s" 未在 planners 中声明，数据会被静默丢弃' % (group, key))
    for pid, days in (events_by or {}).items():
        if not isinstance(days, dict):
            r.error('eventsBy["%s"] 必须是 {日期: 事件数组}' % pid)
            continue
        for day, events in days.items():
            if not _is_date(day):
                r.error('eventsBy["%s"] 的日期键 "%s" 必须是 YYYY-MM-DD' % (pid, day))
            if events is None:
                events = []
            if not isinstance(events, list):
                r.error('eventsBy["%s"]["%s"] 必须是事件数组' % (pid, day))
                continue
            for index, event in enumerate(events):
                path = 'eventsBy["%s"]["%s"][%d]' % (pid, day, index)
                if not isinstance(event, dict):
                    r.error('%s 必须是对象' % path)
                    continue
                if not str(event.get('id') or '').strip():
                    r.error('%s.id 不能为空' % path)
                if not str(event.get('title') or '').strip():
                    r.error('%s.title 不能为空' % path)
                if 'color' in event and event['color'] not in PLANNER_COLORS:
                    r.error('%s.color 必须是五种内置色之一：%s' % (path, '/'.join(PLANNER_COLORS)))
                if 'time' in event and event['time'] and not re.match(r'^([01]\d|2[0-3]):[0-5]\d$', str(event['time'])):
                    r.error('%s.time 必须是 "" 或 HH:MM' % path)
                if 'done' in event and not (isinstance(event['done'], bool) or event['done'] == 'failed'):
                    r.error('%s.done 必须是 true/false/"failed"' % path)
    return 'backup'


def v_redact(obj: Any, text: str, r: Report) -> str:
    r.error('文档脱敏工具不接受 JSON 文件导入（.json 在白名单中被拒绝）')
    r.warn('只能产出 zr-settings 这类 UI 配置供手动注入 localStorage，未知字段会回退默认值')
    return 'unsupported'


def v_search(obj: Any, text: str, r: Report) -> str:
    if not isinstance(obj, dict):
        r.error('智能搜索导出文件必须是对象')
        return 'export'
    for key in ('settings', 'history'):
        if key in obj and not isinstance(obj[key], (dict, list)):
            r.error('%s 类型不正确' % key)
    if 'history' in obj and not isinstance(obj['history'], list):
        r.error('history 必须是数组')
    return 'export'


def v_visualization(obj: Any, text: str, r: Report) -> str:
    if isinstance(obj, dict) and obj.get('kind') == 'zenviz-right-properties':
        if obj.get('version') != 1:
            r.error('version 必须是数字 1')
        engines = r.require(obj, 'engines', '', dict)
        for name, payload in (engines or {}).items():
            if name not in VIZ_ENGINES:
                r.error('engines 的键 "%s" 非法，只能是 %s' % (name, '/'.join(VIZ_ENGINES)))
                continue
            if not isinstance(payload, dict):
                r.error('engines["%s"] 必须是对象' % name)
                continue
            for field in ('typeStates', 'chartProps'):
                if field in payload and not isinstance(payload[field], dict):
                    r.error('engines["%s"].%s 必须是对象' % (name, field))
            if 'data' in payload or 'dataSelections' in payload:
                r.error('属性 JSON 不能包含数据；数据请用 CSV/TSV/XLSX 单独提供')
            if 'version' in payload and payload['version'] != 4:
                r.warn('engines["%s"].version 建议为数字 4' % name)
        return 'properties'
    if isinstance(obj, (dict, list)):
        r.error('缺少 kind:"zenviz-right-properties"：这不是可导入的右侧属性文件')
        return 'properties'
    lines = [line for line in text.splitlines() if line.strip()]
    widths = [len(line.split(',')) for line in lines]
    if len(set(widths)) > 1:
        r.error('CSV 每行列数不一致：%s' % widths)
    return 'csv'


def v_writer(obj: Any, text: str, r: Report) -> str:
    if not isinstance(obj, dict):
        r.error('画布文件必须是对象')
        return 'canvas'
    if obj.get('format') == 'zenwriter-library':
        if not isinstance(obj.get('docs'), dict):
            r.error('zenwriter-library.docs 必须是对象')
        return 'library'
    if obj.get('format') != 'zenwriter-canvas':
        r.error('format 必须是 "zenwriter-canvas"')
    if obj.get('v') != 2:
        r.error('v 必须是数字 2')
    nodes = r.array(obj, 'nodes', '')
    node_ids = set()
    for index, node in enumerate(nodes):
        path = 'nodes[%d]' % index
        if not isinstance(node, dict):
            r.error('%s 必须是对象' % path)
            continue
        identifier = str(node.get('id') or '')
        if not re.match(r'^node-\d+$', identifier):
            r.error('%s.id 必须形如 node-<数字>' % path)
        if identifier in node_ids:
            r.error('%s.id 重复' % path)
        node_ids.add(identifier)
        for axis, limit in (('x', 1500), ('y', 1000)):
            value = node.get(axis)
            if not _is_num(value) or value == 0 or abs(value) > limit:
                r.error('%s.%s 必须在 [-%d,%d] 且不为 0' % (path, axis, limit, limit))
        for key in ('w', 'h'):
            if key in node and not str(node[key]).endswith('px'):
                r.warn('%s.%s 建议使用 "…px" 字符串' % (path, key))
        if node.get('type') == 'image':
            if node.get('srcMode') != 'url':
                r.error('%s 图片节点必须 srcMode:"url"' % path)
            src = str(node.get('src') or '')
            if not (src.startswith('https://') or src.startswith('data:')):
                r.error('%s 图片必须是 https/data URL，禁止 link 模式、assetId 或 blob:' % path)
        if node.get('type') == 'group' and 'children' in node:
            r.warn('%s group 节点没有 children 字段，成员关系靠连线表达' % path)
    for index, connection in enumerate(r.array(obj, 'connections', '')):
        path = 'connections[%d]' % index
        if not isinstance(connection, dict):
            r.error('%s 必须是对象' % path)
            continue
        endpoints = [connection.get('from'), connection.get('to')]
        if all(not value for value in endpoints):
            endpoints = [connection.get('source'), connection.get('target')]
        if any(_id(value) not in node_ids for value in endpoints):
            r.error('%s 的端点必须指向真实存在的节点 id' % path)
        if _id(endpoints[0]) == _id(endpoints[1]):
            r.error('%s 的两端不能是同一个节点' % path)
    return 'canvas'


def v_zencard(obj: Any, text: str, r: Report) -> str:
    if isinstance(obj, dict) and obj.get('format') == 'zen-card-pack':
        if obj.get('v') != 1:
            r.error('v 必须是数字 1')
        cards = r.array(obj, 'cards', '')
        if not cards:
            r.error('cards 不能为空')
        for index, card in enumerate(cards):
            _card(card, r, 'cards[%d]' % index)
        return 'pack'
    if isinstance(obj, list):
        for index, card in enumerate(obj):
            _card(card, r, '[%d]' % index)
        return 'pack'
    _card(obj, r, '')
    return 'card'


def v_zenflow(obj: Any, text: str, r: Report) -> str:
    rules = obj.get('rules') if isinstance(obj, dict) else obj
    if not isinstance(rules, list):
        r.error('规则文件必须是规则数组或 {rules:[…]}')
        return 'rules'
    if not rules:
        r.warn('规则数组为空，运行后不会产生任何效果')
    for index, rule in enumerate(rules):
        path = 'rules[%d]' % index
        if not isinstance(rule, dict):
            r.error('%s 必须是对象' % path)
            continue
        if not str(rule.get('name') or '').strip():
            r.error('%s.name 不能为空' % path)
        # 与 lib/zen-flow.js 的 validateRule 一致：至少需要一条 action，否则规则永不触发。
        actions = rule.get('actions')
        if not isinstance(actions, list) or not actions:
            r.error('%s.actions 至少需要一条 action' % path)
        if 'priority' in rule and not _is_num(rule['priority']):
            r.error('%s.priority 必须是数字（越小越先执行）' % path)
        if 'enabled' in rule and not isinstance(rule['enabled'], bool):
            r.error('%s.enabled 必须是布尔值' % path)
        when = rule.get('when')
        if when is not None and not isinstance(when, dict):
            r.error('%s.when 必须是对象' % path)
        for action_index, action in enumerate(actions if isinstance(actions, list) else []):
            apath = '%s.actions[%d]' % (path, action_index)
            if not isinstance(action, dict):
                r.error('%s 必须是对象' % apath)
                continue
            if action.get('type') not in FLOW_ACTIONS:
                r.error('%s.type 非法，只能是 %s' % (apath, '/'.join(FLOW_ACTIONS)))
            if action.get('type') == 'send' and not str(action.get('to') or '').strip():
                r.error('%s.to 不能为空（必须是真实产品 id）' % apath)
            if action.get('type') == 'publish' and not str(action.get('channel') or '').strip():
                r.error('%s.channel 不能为空（必须是真实频道 id）' % apath)
    return 'rules'


def v_zenclip(obj: Any, text: str, r: Report) -> str:
    return v_zencard(obj, text, r)


def v_zenreview(obj: Any, text: str, r: Report) -> str:
    if isinstance(obj, list):
        for index, row in enumerate(obj):
            if not isinstance(row, dict):
                r.error('[%d] 必须是对象' % index)
                continue
            if 'ts' in row and not _is_iso(row['ts']):
                r.error('[%d].ts 必须是合法时间' % index)
            if 'app' in row and str(row['app']) not in ALL:
                r.warn('[%d].app "%s" 不是已知产品 id' % (index, row['app']))
        return 'timeline'
    if isinstance(obj, dict):
        for key, value in obj.items():
            if not isinstance(value, list):
                r.error('%s 必须是数组（时间线与完成项分别粘贴）' % key)
        return 'inputs'
    if not text.strip():
        r.error('报告内容不能为空')
    return 'markdown'


def v_zenbackup(obj: Any, text: str, r: Report) -> str:
    if not isinstance(obj, dict):
        r.error('备份清单必须是对象')
        return 'manifest'
    if obj.get('format') != 'zen-backup':
        r.error('format 必须是 "zen-backup"')
    if obj.get('v') != 1:
        r.error('v 必须是数字 1')
    products = r.array(obj, 'products', '')
    if not products:
        r.error('products 不能为空')
    seen = set()
    for index, entry in enumerate(products):
        path = 'products[%d]' % index
        if not isinstance(entry, dict):
            r.error('%s 必须是对象' % path)
            continue
        key = str(entry.get('id') or '')
        if not key:
            r.error('%s.id 不能为空（id 就是 localStorage 键）' % path)
        elif key in seen:
            r.error('%s.id 重复，恢复会互相覆盖' % path)
        seen.add(key)
        expected = js_checksum(entry.get('data'))
        if str(entry.get('checksum') or '') != expected:
            r.error('%s.checksum 不匹配：应为 "%s"（data 的 FNV-1a base36）' % (path, expected))
    return 'manifest'


def v_hub(obj: Any, text: str, r: Report) -> str:
    if not isinstance(obj, dict):
        r.error('AI 配置必须是对象')
        return 'ai-config'
    if str(obj.get('apiKey') or '').strip():
        r.error('AI 配置中不允许写入 apiKey：请只在静书房设置界面填写，生成物里必须留空')
    if obj.get('provider') not in ('deepseek', 'openai', 'openrouter', 'zhipu', 'custom', 'ollama', 'complete', ''):
        r.warn('provider "%s" 不是静书房内置选项' % obj.get('provider'))
    for key in ('apiBase', 'apiModel', 'system'):
        if key in obj and not isinstance(obj[key], str):
            r.error('%s 必须是字符串' % key)
    return 'ai-config'


def v_video(obj: Any, text: str, r: Report) -> str:
    if not isinstance(obj, dict):
        r.error('工作流 JSON 必须是对象')
        return 'workflow'
    nodes = obj.get('nodes') if isinstance(obj.get('nodes'), list) else []
    node_ids = set()
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            r.error('nodes[%d] 必须是对象' % index)
            continue
        node_id = str(node.get('id') or '')
        if not node_id:
            r.error('nodes[%d].id 缺失或为空' % index)
        elif node_id in node_ids:
            r.error('nodes[%d].id 重复：%s' % (index, node_id))
        node_ids.add(node_id)
        if not str(node.get('type') or ''):
            r.error('nodes[%d].type 缺失' % index)
        if not isinstance(node.get('data'), dict):
            r.error('nodes[%d].data 必须是对象' % index)
    connections = obj.get('connections') if isinstance(obj.get('connections'), list) else []
    for index, conn in enumerate(connections):
        if not isinstance(conn, dict):
            r.error('connections[%d] 必须是对象' % index)
            continue
        for key in ('from', 'to'):
            value = str(conn.get(key) or '')
            if not value:
                r.error('connections[%d].%s 缺失' % (index, key))
            elif value not in node_ids:
                r.error('connections[%d].%s 指向不存在的节点：%s' % (index, key, value))
    return 'workflow'


_TABLE_OPS = {
    'file', 'mapCells', 'mapColumns', 'formula', 'filter', 'sort', 'dedupe',
    'join', 'aggregate', 'pivot', 'write', 'writeFormula', 'exportTable',
    'save', 'preview', 'note',
}
_TABLE_ROW_MODES = {'same', 'next', 'insertBelow', 'offset'}
_TABLE_CONFLICTS = {'skip', 'overwrite', 'error'}
_TABLE_RANGE = re.compile(r'^[A-Z]{1,3}\d+(?::(?:[A-Z]{1,3}\d*|\d+))?$', re.I)


def v_table(obj: Any, text: str, r: Report) -> str:
    """表格自动化工作流：结构、节点、连线与关键字段的硬校验。"""
    if not isinstance(obj, dict):
        r.error('工作流 JSON 必须是对象')
        return 'workflow'
    if str(obj.get('format') or '') != 'omm-table-workflow':
        r.error('format 必须等于 "omm-table-workflow"')
    if not isinstance(obj.get('version'), int) or isinstance(obj.get('version'), bool) or obj['version'] != 1:
        r.error('version 必须是数字 1')

    nodes = obj.get('nodes') if isinstance(obj.get('nodes'), list) else []
    if not nodes:
        r.error('nodes 必须是非空数组')
        nodes = []
    ids = set()
    file_count = 0
    for index, node in enumerate(nodes):
        path = 'nodes[%d]' % index
        if not isinstance(node, dict):
            r.error('%s 必须是对象' % path)
            continue
        nid = str(node.get('id') or '')
        if not nid:
            r.error('%s.id 不能为空' % path)
        elif nid in ids:
            r.error('%s.id 重复：%s' % (path, nid))
        ids.add(nid)
        op = str(node.get('type') or '')
        if op not in _TABLE_OPS:
            r.error('%s.type 不是已知节点类型：%s' % (path, op))
        if op == 'file':
            file_count += 1
        data = node.get('data')
        if not isinstance(data, dict):
            r.error('%s.data 必须是对象' % path)
            continue
        if op == 'file':
            if str(data.get('sheetMode') or 'one') not in ('one', 'all', 'selected'):
                r.error('%s.data.sheetMode 只能是 one / all / selected' % path)
            if data.get('headerRow') is not None and (
                not isinstance(data['headerRow'], int) or data['headerRow'] < 0
            ):
                r.error('%s.data.headerRow 必须是非负整数' % path)
            for key in ('startCell', 'endCell'):
                value = data.get(key)
                if value in (None, '', 'auto'):
                    continue
                if not re.match(r'^[A-Z]{1,3}\d{1,7}$', str(value).replace('$', '').upper()):
                    r.error('%s.data.%s 必须是 A1 坐标：%s' % (path, key, value))
        if op in ('mapCells', 'mapColumns', 'write', 'writeFormula', 'aggregate'):
            for key in ('columns', 'targetColumns', 'valueColumns'):
                value = data.get(key)
                if value in (None, ''):
                    continue
                text_value = str(value).upper().replace('$', '').replace(' ', '')
                for part in re.split(r'[,，]', text_value):
                    if not part:
                        continue
                    if ':' in part:
                        if not re.match(r'^[A-Z]{1,3}:[A-Z]{1,3}$', part):
                            r.error('%s.data.%s 列范围无效：%s' % (path, key, part))
                    elif not re.match(r'^[A-Z]{1,3}$', part):
                        r.error('%s.data.%s 列字母无效：%s' % (path, key, part))
        if op == 'write' and str(data.get('rowMode') or 'same') not in _TABLE_ROW_MODES:
            r.error('%s.data.rowMode 无效：%s' % (path, data.get('rowMode')))
        if op in ('write', 'writeFormula') and str(data.get('conflict') or 'skip') not in _TABLE_CONFLICTS:
            r.error('%s.data.conflict 只能是 skip / overwrite / error' % path)
        if op in ('mapCells', 'mapColumns') and data.get('op') in ('lastTimeLookup', 'lookup'):
            lookup = data.get('lookup')
            if not isinstance(lookup, list) or not lookup:
                r.error('%s.data.lookup 必须是非空数组' % path)
            else:
                for j, item in enumerate(lookup):
                    if not isinstance(item, dict) or 'result' not in item:
                        r.error('%s.data.lookup[%d] 缺少 result' % (path, j))
        if op in ('mapCells', 'mapColumns', 'formula') and data.get('op') == 'formula':
            expr = str(data.get('expression') or '')
            if not expr.strip():
                r.error('%s.data.expression 不能为空' % path)
            if re.search(r'__|import|eval|exec|open\(|globals|lambda', expr, re.I):
                r.error('%s.data.expression 包含不允许的标识符' % path)
        if op in ('save', 'exportTable'):
            name = str(data.get('filename') or '')
            if not name.lower().endswith(('.xlsx', '.xlsm')):
                r.error('%s.data.filename 必须以 .xlsx / .xlsm 结尾' % path)

    if file_count != 1:
        r.error('必须有且只有一个 file 节点（当前 %d 个）' % file_count)

    connections = obj.get('connections') if isinstance(obj.get('connections'), list) else []
    if not isinstance(obj.get('connections'), list):
        r.error('connections 必须是数组')
    for index, conn in enumerate(connections):
        path = 'connections[%d]' % index
        if not isinstance(conn, dict):
            r.error('%s 必须是对象' % path)
            continue
        for key in ('from', 'to'):
            value = str(conn.get(key) or '')
            if not value:
                r.error('%s.%s 缺失' % (path, key))
            elif value not in ids:
                r.error('%s.%s 指向不存在的节点：%s' % (path, key, value))
        if str(conn.get('from') or '') == str(conn.get('to') or ''):
            r.error('%s 不能连接节点自身' % path)
        if str(conn.get('toPort') or 'left') not in ('left', 'top'):
            r.warn('%s.toPort 建议为 left 或 top' % path)

    # 环检测
    if ids:
        indegree = {nid: 0 for nid in ids}
        adj = {nid: [] for nid in ids}
        for conn in connections:
            a, b = str(conn.get('from') or ''), str(conn.get('to') or '')
            if a in ids and b in ids and a != b:
                indegree[b] += 1
                adj[a].append(b)
        queue = [nid for nid, deg in indegree.items() if deg == 0]
        visited = 0
        while queue:
            cur = queue.pop(0)
            visited += 1
            for nxt in adj[cur]:
                indegree[nxt] -= 1
                if indegree[nxt] == 0:
                    queue.append(nxt)
        if visited != len(ids):
            r.error('工作流存在循环连线')

    # 除 file / note 外都要有上游
    upstream = {str(c.get('to')) for c in connections if isinstance(c, dict)}
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        op = str(node.get('type') or '')
        nid = str(node.get('id') or '')
        if op not in ('file', 'note') and nid not in upstream:
            r.error('nodes[%d] 没有上游输入：%s' % (index, nid))
    return 'workflow'


def v_lambda(obj: Any, text: str, r: Report) -> str:
    """Lambda 演算计算器：会话快照 / 分享链接。"""
    if not isinstance(obj, dict):
        r.error('Lambda JSON 必须是对象')
        return 'session'
    fmt = str(obj.get('format') or '')
    if fmt == 'omm-lambda-session':
        sid = obj.get('sid')
        if not isinstance(sid, str) or not sid.strip():
            r.error('sid 必须是非空字符串')
        code = obj.get('code')
        if not isinstance(code, list) or not code:
            r.error('code 必须是非空数组')
        elif not all(isinstance(x, str) for x in code):
            r.error('code 的元素必须是字符串')
        if 'name' in obj and not isinstance(obj.get('name'), str):
            r.error('name 必须是字符串')
        if 'lang' in obj and obj['lang'] not in ('zh', 'en', 'both'):
            r.error('lang 必须是 zh / en / both')
        return 'session'
    if fmt == 'omm-lambda-share':
        sid = obj.get('id')
        if not isinstance(sid, str) or not sid.strip():
            r.error('id 必须是非空字符串')
        return 'share'
    return 'session'


# Bound from the format registry: which deep validator handles each product is
# a contract fact, not a second handwritten table that can drift.
VALIDATORS = {
    row['product']: globals()[row['validator']]
    for row in FORMAT_REGISTRY
    if row.get('validator')
}


def detect_kind(identifier: str, obj: Any, text: str) -> str:
    """根据内容自动判断导入类型；规则来自格式注册表生成的 DETECTION。"""
    return generated_detect_kind(identifier, obj, text)


def validate(identifier: str, content: Any, kind: str | None = None) -> dict:
    """校验一份生成内容。content 可为字符串（JSON/TeX/Markdown/CSV）或已解析对象。"""
    item = product(identifier)
    if not item:
        return {'ok': False, 'product': identifier, 'kind': kind or '',
                'errors': ['未知产品：%s' % identifier], 'warnings': []}
    key = item['id']
    chosen = str(kind or '').strip()
    if isinstance(content, str):
        text = content
        obj, parse_error = _parse(text.strip())
        # kind 省略时必须先按内容识别：Markdown/TeX/CSV 本就不是 JSON，不能因为
        # 解析失败就提前返回 JSON 错误（返回的 kind 还会显示已识别的类型，自相矛盾）。
        if not chosen:
            chosen = detect_kind(key, obj, text)
        if parse_error and chosen not in ('tex', 'markdown', 'csv', 'text', 'unsupported'):
            # JSON 类格式解析失败：仍交给校验器给出更具体的字段错误不可行，直接回报。
            return {'ok': False, 'product': key, 'kind': chosen,
                    'errors': [parse_error], 'warnings': []}
    else:
        obj = content
        text = _dump(content) if content is not None else ''
    chosen = chosen or detect_kind(key, obj, text)
    report = Report()
    # The registry-owned contract (format token, version, field shapes, enums)
    # is checked before the deep semantic validator, so a template and a
    # validator can never silently disagree about the wire format.
    if chosen not in ('unsupported', 'text', 'csv', 'markdown', 'tex'):
        for message in declarative_errors(key, chosen, obj):
            report.error(message)
    handler = VALIDATORS.get(key)
    if handler is None:
        report.error('该产品暂不支持自动校验')
    else:
        handler(obj, text, report)
    def clean(messages: List[str]) -> List[str]:
        return [message if not message.startswith('.') else '(根)' + message for message in messages]

    return {
        'ok': not report.errors,
        'product': key,
        'product_name': item['name'],
        'kind': chosen,
        'errors': clean(report.errors),
        'warnings': clean(report.warnings),
        'tip': '按 errors 的“路径: 原因”逐条修正；warnings 不阻止导入，但建议一并处理。',
    }


# ── 可直接粘贴给 AI 的生成模板 ───────────────────────────────────────────────

# Single source of truth: public/json-specs/format-registry.json, via the
# generated module. No second handwritten template table can drift away from
# the validator contract.
TEMPLATES: Dict[str, Dict[str, Any]] = GENERATED_TEMPLATES


def formats_for(identifier: str) -> dict:
    item = product(identifier)
    if not item:
        return {'ok': False, 'error': '未知产品：%s' % identifier}
    key = item['id']
    templates = TEMPLATES.get(key, {})
    return {
        'ok': True,
        'product': key,
        'product_name': item['name'],
        'formats': [
            {
                'kind': kind,
                'template': value if isinstance(value, str) else _dump(value),
                'is_json': not isinstance(value, str),
            }
            for kind, value in templates.items()
        ],
        'formats_from_spec': item.get('formats', []),
        'best_practices': item.get('best_practices', []),
    }
