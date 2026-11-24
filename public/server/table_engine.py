# -*- coding: utf-8 -*-
"""table_engine.py — OMM-ZEN 表格自动化的纯 Python 引擎。

设计要点：
- 不依赖任何 GUI / HTTP / Tkinter；只依赖 openpyxl 与标准库。
- 一张“表”是行的集合，行带 sheet / src_row / values；Excel 的逐行逐表循环由引擎隐式完成。
- 所有节点是“表 -> 表”的纯变换；写节点只收集写计划，save 时统一按表自底向上插行再写入。
- 表达式求值走 AST 白名单，不能访问属性、任意函数或导入。

本文件从 F:/python_project/ASC/gui_deepseek.py 中只继承了纯计算语义
（真实范围、最后时间、时间区间分档、浮点归一化、汇总表），GUI 代码一行未搬。
"""
from __future__ import annotations

import ast
import math
import operator
import os
import re
from copy import copy as shallow_copy
from dataclasses import dataclass, field
from datetime import datetime, time as dtime
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, Side
from openpyxl.utils import column_index_from_string, get_column_letter
from openpyxl.utils.cell import range_boundaries

# ---------------------------------------------------------------------------
# 异常与哨兵
# ---------------------------------------------------------------------------


class WorkflowError(Exception):
    """面向用户的流程错误。"""

    def __init__(self, message: str, node: str = "", hint: str = ""):
        super().__init__(message)
        self.message = message
        self.node = node
        self.hint = hint

    def as_dict(self) -> Dict[str, str]:
        out = {"message": self.message}
        if self.node:
            out["node"] = self.node
        if self.hint:
            out["hint"] = self.hint
        return out


class _Skip:
    pass


class _Cancelled(Exception):
    """内部控制信号：取消不是普通节点错误，也不能触发写计划应用。"""

    def __init__(self, node: str = ""):
        super().__init__("任务已取消")
        self.node = node


SKIP = _Skip()

_FORCED_BORDER = Border(
    left=Side(style="thin"), right=Side(style="thin"),
    top=Side(style="thin"), bottom=Side(style="thin"),
)
_FORCED_ALIGNMENT = Alignment(horizontal="center", vertical="center")
_FORCED_FONT = Font(size=11, bold=False, color="00000000")

_COL_RE = re.compile(r"^([A-Z]{1,3})(\d+)$")
_TIME_RE = re.compile(r"(\d{1,2}):(\d{2})(?::(\d{2}))?")
_SAFE_EXT = (".xlsx", ".xlsm")
_LOOPBACK = ("127.0.0.1", "localhost", "::1", "[::1]")

# ---------------------------------------------------------------------------
# 基础解析
# ---------------------------------------------------------------------------


def safe_filename(name: str, default: str = "output.xlsx") -> str:
    # 先按正斜杠切分，避免 Windows 下 os.path.basename 把盘符冒号当成路径分隔符。
    base = str(name or "").replace("\\", "/").strip().split("/")[-1]
    base = re.sub(r'[<>:"|?*\x00-\x1f]', "_", base).strip(". ")
    if not base:
        return default
    return base[:150]


def col_number(letter: str) -> int:
    return column_index_from_string(str(letter or "").strip().upper())


def col_letter(number: int) -> str:
    return get_column_letter(max(1, int(number)))


def cell_ref(ref: str) -> Tuple[int, int]:
    """'C6' -> (列号 3, 行号 6)。"""
    m = _COL_RE.match(str(ref or "").strip().upper().replace("$", ""))
    if not m:
        raise WorkflowError("单元格坐标无效：%s（应写成 C6 这种形式）" % ref)
    return col_number(m.group(1)), int(m.group(2))


def column_list(spec: Any, step: int = 1) -> List[str]:
    """'C:AG' / 'C,D,F' / ['C','D'] -> 列字母列表。"""
    step = max(1, int(step or 1))
    if isinstance(spec, (list, tuple)):
        letters = [str(x).strip().upper() for x in spec if str(x).strip()]
    else:
        text = str(spec or "").strip().upper().replace(" ", "")
        if not text:
            return []
        if ":" in text:
            a, b = text.split(":", 1)
            if not a or not b:
                return []
            start, end = col_number(a), col_number(b)
            if start > end:
                raise WorkflowError("列范围起始列不能在结束列之后：%s" % text)
            letters = [col_letter(i) for i in range(start, end + 1, step)]
        else:
            letters = [x for x in re.split(r"[,，]", text) if x]
    for letter in letters:
        try:
            col_number(letter)
        except Exception:
            raise WorkflowError("列字母无效：%s" % letter)
    return letters


def key_list(value: Any) -> List[str]:
    """把前端文本框或 JSON 数组统一成字段名列表。"""
    if isinstance(value, (list, tuple)):
        items = value
    else:
        items = re.split(r"[,，]", str(value or ""))
    return [str(item).strip() for item in items if str(item).strip()]


def number_of(value: Any) -> Optional[float]:
    """尽量把单元格转成数字；失败返回 None。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            return None
        return float(value)
    if isinstance(value, (dtime, datetime)):
        return None
    text = str(value).strip().replace(",", "").replace("，", "")
    if not text:
        return None
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def text_of(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dtime):
        return value.strftime("%H:%M:%S") if value.second else value.strftime("%H:%M")
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, float):
        if value == int(value):
            return str(int(value))
    return str(value)


def normalize_result(value: Any) -> Any:
    """去浮点尾部噪声；整数值转 int（沿用 ASC 的 _normalize_result）。"""
    if isinstance(value, float):
        rounded = round(value, 8)
        if rounded == int(rounded):
            return int(rounded)
        return rounded
    return value


def parse_last_time(value: Any) -> Optional[dtime]:
    """兼容 openpyxl 的 time/datetime、Excel 0~1 序列值与文本，取最后一个时间。"""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.time()
    if isinstance(value, dtime):
        return value
    if isinstance(value, (int, float)):
        num = float(value)
        if math.isnan(num) or math.isinf(num):
            return None
        if 0 <= num < 1:  # Excel 的小数表示一天中的时刻
            total = int(round(num * 86400))
            return dtime(total // 3600, (total % 3600) // 60, total % 60)
        return None
    text = str(value).strip().replace("：", ":")
    matches = _TIME_RE.findall(text)
    if not matches:
        return None
    h, m, s = matches[-1]
    try:
        hh, mm, ss = int(h), int(m), int(s or 0)
        if 0 <= hh <= 23 and 0 <= mm <= 59 and 0 <= ss <= 59:
            return dtime(hh, mm, ss)
    except (TypeError, ValueError):
        pass
    return None


def minutes_of(value: Any) -> Optional[float]:
    t = parse_last_time(value)
    if t is None:
        return None
    return t.hour * 60 + t.minute + (t.second or 0) / 60.0


def _cmp_value(value: Any) -> Any:
    n = number_of(value)
    return n if n is not None else text_of(value).lower()


def compare(left: Any, op: str, right: Any) -> bool:
    """条件比较：能按数字比就按数字，否则按文本（忽略大小写）。"""
    op = str(op or "==").strip()
    a, b = _cmp_value(left), _cmp_value(right)
    if isinstance(a, float) and isinstance(b, float):
        pass
    elif isinstance(a, str) and isinstance(b, float):
        b = text_of(right).lower()
    elif isinstance(a, float) and isinstance(b, str):
        a = text_of(left).lower()
    try:
        if op in (">", "gt"):
            return a > b
        if op in (">=", "gte"):
            return a >= b
        if op in ("<", "lt"):
            return a < b
        if op in ("<=", "lte"):
            return a <= b
        if op in ("==", "=", "eq"):
            return a == b
        if op in ("!=", "<>", "ne"):
            return a != b
    except TypeError:
        return text_of(left) == text_of(right)
    if op == "contains":
        return text_of(right) in text_of(left)
    if op == "notContains":
        return text_of(right) not in text_of(left)
    if op == "empty":
        return left is None or str(left).strip() == ""
    if op == "notEmpty":
        return left is not None and str(left).strip() != ""
    if op == "startsWith":
        return text_of(left).startswith(text_of(right))
    if op == "endsWith":
        return text_of(left).endswith(text_of(right))
    return False


def conditions_pass(rules: Any, logic: str, row: "Row", table: "Table") -> bool:
    rules = rules if isinstance(rules, list) else []
    if not rules:
        return True
    results = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        col = str(rule.get("column") or "").strip().upper()
        op = str(rule.get("op") or "==")
        target = rule.get("value")
        if col.startswith("["):
            value = row.values.get(col.strip("[]").upper())
        elif col in ("__row", "row"):
            value = row.src_row
        elif col in ("__sheet", "sheet"):
            value = row.sheet
        else:
            value = row.values.get(col)
        results.append(compare(value, op, target))
    if not results:
        return True
    return all(results) if str(logic or "and").lower() == "and" else any(results)


# ---------------------------------------------------------------------------
# 查表
# ---------------------------------------------------------------------------


def _lookup_result(value: Any, kind: str, result_type: str = "") -> Any:
    """数值区间/时间区间归一化数值结果；显式文本结果保持原样。"""
    if result_type == "text":
        return "" if value is None else str(value)
    if result_type == "number" or kind in ("numeric", "time", "range"):
        number = number_of(value)
        if number is not None:
            return normalize_result(number)
    return value


def lookup_value(value: Any, data: Dict[str, Any], kind: str = "range") -> Any:
    rows = data.get("lookup") if isinstance(data.get("lookup"), list) else []
    default = data.get("defaultResult", 0)
    kind = str(data.get("lookupKind") or kind or "range").strip().lower()
    result_type = str(data.get("lookupResultType") or "").strip().lower()
    for item in rows:
        if not isinstance(item, dict):
            continue
        if kind in ("time", "range"):
            v = minutes_of(value)
            lo = minutes_of(item.get("min")) if item.get("min") not in (None, "") else None
            hi = minutes_of(item.get("max")) if item.get("max") not in (None, "") else None
            if v is None:
                continue
            if (lo is None or v >= lo) and (hi is None or v <= hi):
                return _lookup_result(item.get("result", default), kind, result_type)
        elif kind == "numeric":
            v = number_of(value)
            lo = number_of(item.get("min")) if item.get("min") not in (None, "") else None
            hi = number_of(item.get("max")) if item.get("max") not in (None, "") else None
            if v is None:
                continue
            if (lo is None or v >= lo) and (hi is None or v <= hi):
                return _lookup_result(item.get("result", default), kind, result_type)
        else:  # exact
            if text_of(value).strip().lower() == text_of(item.get("value")).strip().lower():
                return _lookup_result(item.get("result", default), kind, result_type)
    return _lookup_result(default, kind, result_type)


# ---------------------------------------------------------------------------
# 安全表达式
# ---------------------------------------------------------------------------

_BINOPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
}
_CMPOPS = {
    ast.Gt: operator.gt, ast.GtE: operator.ge, ast.Lt: operator.lt,
    ast.LtE: operator.le, ast.Eq: operator.eq, ast.NotEq: operator.ne,
}
_UNARYOPS = {ast.UAdd: operator.pos, ast.USub: operator.neg, ast.Not: operator.not_}


def check_expression(expr: str) -> Optional[str]:
    """返回 None 表示合法，否则返回中文错误。"""
    text = str(expr or "").strip()
    if not text:
        return "表达式不能为空"
    if len(text) > 500:
        return "表达式过长（最多 500 字符）"
    if re.search(r"__|import|eval|exec|open|globals|locals", text, re.I):
        return "表达式包含不允许的标识符"
    # [C] 列引用先改写成 _col("C")，否则 ast 会把它当成 List 字面量。
    text = re.sub(r"\[([A-Z]{1,3})\]", lambda m: '_col("%s")' % m.group(1), text)
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        return "表达式语法错误：%s" % exc.msg
    allowed = (
        ast.Expression, ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.IfExp,
        ast.Call, ast.Name, ast.Load, ast.Constant, ast.Num, ast.Str,
        ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod,
        ast.Gt, ast.GtE, ast.Lt, ast.LtE, ast.Eq, ast.NotEq,
        ast.UAdd, ast.USub, ast.Not, ast.And, ast.Or,
    )
    for node in ast.walk(tree):
        if isinstance(node, (ast.Attribute, ast.Lambda, ast.ListComp, ast.DictComp,
                             ast.SetComp, ast.GeneratorExp, ast.Await, ast.Yield)):
            return "表达式不能使用属性、闭包、推导式、await 或 yield"
        if not isinstance(node, allowed):
            return "表达式包含不支持的语法：%s" % type(node).__name__
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id not in _EXPR_FUNCS and node.func.id != "_col":
                return "不允许的函数：%s" % node.func.id
    return None


def eval_expression(expr: str, row: "Row", value: Any = None) -> Any:
    text = re.sub(r"\[([A-Z]{1,3})\]", lambda m: '_col("%s")' % m.group(1), str(expr or ""))
    tree = ast.parse(text, mode="eval")
    cols = row.values

    def _col(letter: str) -> Any:
        return cols.get(str(letter).strip().upper())

    def _if(cond, a, b):
        return a if cond else b

    def _sum(*args):
        total = 0.0
        for arg in args:
            n = number_of(arg)
            if n is not None:
                total += n
        return normalize_result(total)

    def _regex(text_value, pattern, group=0):
        m = re.search(str(pattern or ""), text_of(text_value))
        if not m:
            return ""
        try:
            return m.group(int(group))
        except (IndexError, ValueError):
            return ""

    def _number(v):
        return number_of(v)

    def _text(v):
        return text_of(v)

    def _lasttime(v):
        return parse_last_time(v)

    funcs: Dict[str, Callable[..., Any]] = {
        "IF": _if, "AND": lambda *a: all(a), "OR": lambda *a: any(a),
        "NOT": lambda a: not a, "ABS": lambda a: abs(number_of(a) or 0),
        "ROUND": lambda a, n=0: round(number_of(a) or 0, int(number_of(n) or 0)),
        "MIN": lambda *a: min([number_of(x) or 0 for x in a] or [0]),
        "MAX": lambda *a: max([number_of(x) or 0 for x in a] or [0]),
        "SUM": _sum, "LEN": lambda a: len(text_of(a)),
        "UPPER": lambda a: text_of(a).upper(), "LOWER": lambda a: text_of(a).lower(),
        "TRIM": lambda a: text_of(a).strip(),
        "LEFT": lambda a, n=1: text_of(a)[:int(number_of(n) or 0)],
        "RIGHT": lambda a, n=1: text_of(a)[-int(number_of(n) or 0):] if number_of(n) else "",
        "MID": lambda a, s=0, n=1: text_of(a)[int(number_of(s) or 0):int(number_of(s) or 0) + int(number_of(n) or 0)],
        "CONTAINS": lambda a, b: text_of(b) in text_of(a),
        "REGEX": _regex, "NUMBER": _number, "TEXT": _text,
        "LASTTIME": _lasttime, "ISBLANK": lambda a: a is None or text_of(a).strip() == "",
        "_col": _col,
    }

    def visit(node: ast.AST) -> Any:
        if isinstance(node, ast.Expression):
            return visit(node.body)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, (ast.Num, ast.Str)):
            return node.n if isinstance(node, ast.Num) else node.s
        if isinstance(node, ast.Name):
            if node.id == "value":
                return value
            if node.id == "row":
                return row.src_row
            if node.id == "sheet":
                return row.sheet
            return None
        if isinstance(node, ast.BinOp):
            fn = _BINOPS.get(type(node.op))
            if fn is None:
                return None
            left, right = visit(node.left), visit(node.right)
            if isinstance(node.op, ast.Div):
                a, b = number_of(left), number_of(right)
                return (a / b) if (a is not None and b) else 0
            if isinstance(node.op, (ast.Add,)) and (
                isinstance(left, str) or isinstance(right, str)):
                return text_of(left) + text_of(right)
            a, b = number_of(left), number_of(right)
            if a is None or b is None:
                return 0
            return fn(a, b)
        if isinstance(node, ast.UnaryOp):
            fn = _UNARYOPS.get(type(node.op))
            return fn(visit(node.operand)) if fn else None
        if isinstance(node, ast.BoolOp):
            vals = [visit(v) for v in node.values]
            return all(vals) if isinstance(node.op, ast.And) else any(vals)
        if isinstance(node, ast.Compare):
            left = visit(node.left)
            for op, comparator in zip(node.ops, node.comparators):
                right = visit(comparator)
                fn = _CMPOPS.get(type(op))
                if fn is None:
                    return False
                try:
                    ok = fn(_cmp_value(left), _cmp_value(right))
                except TypeError:
                    ok = False
                if not ok:
                    return False
                left = right
            return True
        if isinstance(node, ast.IfExp):
            return visit(node.body) if visit(node.test) else visit(node.orelse)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            fn = funcs.get(node.func.id)
            if fn is None:
                return None
            args = [visit(a) for a in node.args]
            for kw in node.keywords:
                if kw.arg:
                    pass  # 表达式不使用关键字参数
            return fn(*args)
        return None

    return visit(tree)


_EXPR_FUNCS = {
    "IF", "AND", "OR", "NOT", "ABS", "ROUND", "MIN", "MAX", "SUM", "LEN",
    "UPPER", "LOWER", "TRIM", "LEFT", "RIGHT", "MID", "CONTAINS", "REGEX",
    "NUMBER", "TEXT", "LASTTIME", "ISBLANK",
}

# ---------------------------------------------------------------------------
# 表与行
# ---------------------------------------------------------------------------


@dataclass
class Row:
    sheet: str
    src_row: int
    values: Dict[str, Any] = field(default_factory=dict)
    headers: Dict[str, Any] = field(default_factory=dict)
    meta: Dict[str, Any] = field(default_factory=dict)

    def copy(self) -> "Row":
        return Row(self.sheet, self.src_row, dict(self.values), dict(self.headers), dict(self.meta))


@dataclass
class Table:
    columns: List[str] = field(default_factory=list)
    rows: List[Row] = field(default_factory=list)
    kind: str = "rows"
    label: str = ""

    def copy(self) -> "Table":
        return Table(list(self.columns), [r.copy() for r in self.rows], self.kind, self.label)

    def as_dict(self) -> Dict[str, Any]:
        return self.sample()

    def sample(self, limit: int = 30) -> Dict[str, Any]:
        rows = self.rows[: max(0, int(limit or 30))]
        return {
            "columns": list(self.columns),
            "rows": [[r.values.get(c) for c in self.columns] for r in rows],
            "rowCount": len(self.rows),
            "colCount": len(self.columns),
            "sheets": sorted({r.sheet for r in self.rows if r.sheet}),
        }


# ---------------------------------------------------------------------------
# 工作簿封装
# ---------------------------------------------------------------------------


class Book:
    """同时持有写模式工作簿与只读数值缓存。"""

    def __init__(self, path: str):
        if not os.path.isfile(path):
            raise WorkflowError("找不到输入文件：%s" % path)
        if not path.lower().endswith(_SAFE_EXT):
            raise WorkflowError(
                "只支持 .xlsx / .xlsm 文件，当前是：%s" % os.path.basename(path),
                hint="请先把 .xls 另存为 .xlsx。",
            )
        self.path = path
        keep_vba = path.lower().endswith(".xlsm")
        try:
            self.wb = load_workbook(path, data_only=False, keep_vba=keep_vba)
            self.wb_values = load_workbook(path, data_only=True, read_only=True)
        except Exception as exc:
            raise WorkflowError("打开工作簿失败：%s" % exc)
        self.sheets = list(self.wb.sheetnames)
        self._cache: Dict[str, Dict[int, Dict[int, Any]]] = {}
        self._extents: Dict[str, Tuple[int, int]] = {}
        self._merged: Dict[str, List[List[int]]] = {}
        self.sheet_ranges: Dict[str, Tuple[int, int, int, int]] = {}
        self.inserts: Dict[str, Set[int]] = {}
        self.writes: List[Dict[str, Any]] = []
        self.exports: List[Dict[str, Any]] = []

    def close(self) -> None:
        for wb in (self.wb, self.wb_values):
            try:
                wb.close()
            except Exception:
                pass

    def ws(self, sheet: str):
        if sheet not in self.wb.sheetnames:
            raise WorkflowError('工作表 "%s" 不存在；可用：%s' % (sheet, ", ".join(self.wb.sheetnames)))
        return self.wb[sheet]

    def values(self, sheet: str) -> Dict[int, Dict[int, Any]]:
        if sheet in self._cache:
            return self._cache[sheet]
        if sheet not in self.wb_values.sheetnames:
            self._cache[sheet] = {}
            return self._cache[sheet]
        grid: Dict[int, Dict[int, Any]] = {}
        try:
            ws = self.wb_values[sheet]
            max_row = 1
            max_col = 1
            # 格式占位可能把 max_column 撑到 16384；限制扫描宽度，避免逐格空转。
            for r, row in enumerate(ws.iter_rows(max_col=1024), start=1):
                for c, cell in enumerate(row, start=1):
                    if cell.value is None:
                        continue
                    grid.setdefault(r, {})[c] = cell.value
                    if r > max_row:
                        max_row = r
                    if c > max_col:
                        max_col = c
            self._extents[sheet] = (max_row, max_col)
        except Exception as exc:
            raise WorkflowError("读取工作表 \"%s\" 失败：%s" % (sheet, exc))
        self._cache[sheet] = grid
        return grid

    def extent(self, sheet: str) -> Tuple[int, int]:
        if sheet not in self._extents:
            self.values(sheet)
        return self._extents.get(sheet, (1, 1))

    def merged(self, sheet: str) -> List[List[int]]:
        if sheet not in self._merged:
            try:
                self._merged[sheet] = [
                    [r.min_row, r.min_col, r.max_row, r.max_col]
                    for r in self.ws(sheet).merged_cells.ranges
                ]
            except Exception:
                self._merged[sheet] = []
        return self._merged[sheet]

    def cell_value(self, sheet: str, row: int, col: int) -> Any:
        return self.values(sheet).get(row, {}).get(col)

    def resolve_range(self, sheet: str, data: Dict[str, Any], prefix: str = "") -> Tuple[int, int, int, int]:
        mr, mc = self.extent(sheet)
        mode = str(data.get(prefix + "rangeMode") or data.get("rangeMode") or "auto")
        start = str(data.get(prefix + "startCell") or data.get("startCell") or "A1")
        end = str(data.get(prefix + "endCell") or data.get("endCell") or "")
        if mode == "manual" and end.strip():
            text = "%s:%s" % (start or "A1", end)
            text = text.upper().replace("$", "").replace(" ", "")
            try:
                a, b = text.split(":", 1)
                c1, r1 = cell_ref(a)
                if re.fullmatch(r"[A-Z]{1,3}", b):
                    c2, r2 = col_number(b), mr
                elif re.fullmatch(r"\d+", b):
                    c2, r2 = mc, int(b)
                else:
                    c2, r2 = cell_ref(b)
            except WorkflowError:
                raise
            except Exception:
                raise WorkflowError("区域范围无效：%s" % text)
        else:
            try:
                c1, r1 = cell_ref(start or "A1")
            except WorkflowError:
                raise
            c2, r2 = mc, mr
        r1, r2 = max(1, r1), max(1, r2)
        c1, c2 = max(1, c1), max(1, c2)
        if r1 > r2 or c1 > c2:
            raise WorkflowError("区域起点不能在终点之后：%s!%s" % (sheet, text if mode == "manual" else start))
        return r1, c1, r2, c2

    def header_of(self, sheet: str, col: int, header_row: int) -> Any:
        if not header_row or header_row < 1:
            return ""
        return self.cell_value(sheet, header_row, col)


def describe_workbook(path: str, sample_rows: int = 30, sample_cols: int = 30) -> Dict[str, Any]:
    """给前端的只读概览：工作表、真实范围、合并区、样本。"""
    book = Book(path)
    try:
        sheets = []
        for name in book.sheets:
            mr, mc = book.extent(name)
            grid = book.values(name)
            rows = []
            for r in range(1, min(mr, sample_rows) + 1):
                rows.append([grid.get(r, {}).get(c) for c in range(1, min(mc, sample_cols) + 1)])
            sheets.append({
                "name": name,
                "maxRow": mr,
                "maxCol": mc,
                "columns": [col_letter(c) for c in range(1, min(mc, sample_cols) + 1)],
                "rows": rows,
                "merged": book.merged(name),
            })
        return {"ok": True, "name": os.path.basename(path), "sheets": sheets}
    finally:
        book.close()


# ---------------------------------------------------------------------------
# 节点执行
# ---------------------------------------------------------------------------


class Engine:
    NODE_TYPES = {
        "file", "mapCells", "mapColumns", "formula", "filter", "sort", "dedupe",
        "join", "aggregate", "pivot", "write", "writeFormula", "exportTable",
        "save", "preview", "note",
    }

    def __init__(self, spec: Dict[str, Any], options: Optional[Dict[str, Any]] = None,
                 resolver: Optional[Callable[[str], str]] = None,
                 on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
                 cancelled: Optional[Callable[[], bool]] = None):
        self.spec = spec if isinstance(spec, dict) else {}
        self.options = options or {}
        self.resolver = resolver or (lambda fid: fid)
        self.on_event = on_event or (lambda name, payload: None)
        self.cancelled = cancelled or (lambda: False)
        self.nodes: Dict[str, Dict[str, Any]] = {}
        self.outputs: Dict[str, Any] = {}
        self.node_results: Dict[str, Dict[str, Any]] = {}
        self.book: Optional[Book] = None
        self.warnings: List[Dict[str, str]] = []
        self.conflicts: List[Dict[str, Any]] = []
        self.outputs_files: List[Dict[str, Any]] = []
        self.executed: Set[str] = set()
        self.dry_run = bool(self.options.get("dryRun"))
        self.stop_node = str(self.options.get("previewNode") or "")
        self.out_dir = str(self.options.get("outDir") or "")
        self.stopped = False

    # ---- 图校验 ----
    def _validate(self) -> List[Dict[str, Any]]:
        raw_nodes = self.spec.get("nodes") if isinstance(self.spec.get("nodes"), list) else []
        raw_conns = self.spec.get("connections") if isinstance(self.spec.get("connections"), list) else []
        ids, nodes = set(), {}
        errors: List[Dict[str, Any]] = []
        for i, node in enumerate(raw_nodes):
            if not isinstance(node, dict):
                errors.append({"message": "nodes[%d] 必须是对象" % i})
                continue
            nid = str(node.get("id") or "")
            if not nid:
                errors.append({"message": "nodes[%d] 缺少 id" % i})
                continue
            if nid in ids:
                errors.append({"message": "节点 id 重复：%s" % nid, "node": nid})
                continue
            ids.add(nid)
            ntype = str(node.get("type") or "")
            if ntype not in self.NODE_TYPES:
                errors.append({"message": "未知节点类型：%s" % ntype, "node": nid})
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            nodes[nid] = {"id": nid, "type": ntype, "data": data}
        for i, conn in enumerate(raw_conns):
            if not isinstance(conn, dict):
                errors.append({"message": "connections[%d] 必须是对象" % i})
                continue
            for key in ("from", "to"):
                value = str(conn.get(key) or "")
                if value not in ids:
                    errors.append({"message": "连线 %s 指向不存在的节点：%s" % (key, value)})
        if errors:
            return errors
        self.nodes = nodes
        files = [n for n in nodes.values() if n["type"] == "file"]
        if len(files) != 1:
            errors.append({"message": "工作流必须有且只有一个 Excel 文件节点（当前 %d 个）" % len(files)})
            return errors
        indegree = {nid: 0 for nid in nodes}
        adj: Dict[str, List[str]] = {nid: [] for nid in nodes}
        for conn in raw_conns:
            a, b = str(conn.get("from") or ""), str(conn.get("to") or "")
            if a in ids and b in ids and a != b:
                indegree[b] += 1
                adj[a].append(b)
        queue = [nid for nid, d in indegree.items() if d == 0]
        order: List[str] = []
        while queue:
            cur = queue.pop(0)
            order.append(cur)
            for nxt in adj[cur]:
                indegree[nxt] -= 1
                if indegree[nxt] == 0:
                    queue.append(nxt)
        if len(order) != len(nodes):
            errors.append({"message": "工作流存在循环连线，请检查节点连接"})
            return errors
        self.order = order
        for nid, node in nodes.items():
            if node["type"] == "file":
                continue
            upstream = [c for c in raw_conns if str(c.get("to")) == nid]
            if not upstream and node["type"] not in ("note",):
                errors.append({
                    "message": "节点没有上游输入：%s" % (node["data"].get("title") or node["type"]),
                    "node": nid,
                })
        return errors

    # ---- 主流程 ----
    def run(self) -> Dict[str, Any]:
        errors = self._validate()
        if errors:
            return {"ok": False, "cancelled": False, "errors": errors, "nodes": self.node_results,
                    "outputs": [], "conflicts": [], "warnings": self.warnings,
                    "dryRun": self.dry_run}
        total = len(self.order)
        try:
            for idx, nid in enumerate(self.order):
                self._raise_if_cancelled(nid)
                node = self.nodes[nid]
                self.on_event("node_start", {"id": nid, "type": node["type"], "index": idx, "total": total})
                try:
                    result = self._execute(node)
                    if isinstance(result, Table):
                        self.outputs[nid] = result
                    else:
                        # 写回/保存/备注等节点把上游表透传，后续节点可以继续加工。
                        self.outputs[nid] = self._input(node)
                    self.executed.add(nid)
                    self.node_results[nid] = {
                        "status": "done", "progress": 1,
                        "result": result.as_dict() if isinstance(result, Table) else (result or {}),
                    }
                    self.on_event("node_done", {"id": nid, "result": self.node_results[nid]["result"]})
                except _Cancelled as exc:
                    self.node_results[nid] = {"status": "cancelled", "progress": 0}
                    self.on_event("node_cancelled", {"id": nid})
                    raise
                except WorkflowError as exc:
                    if self.cancelled():
                        self.node_results[nid] = {"status": "cancelled", "progress": 0}
                        self.on_event("node_cancelled", {"id": nid})
                        raise _Cancelled(nid) from exc
                    if not exc.node:
                        exc.node = nid
                    self.node_results[nid] = {"status": "error", "error": exc.as_dict(), "progress": 0}
                    self.on_event("node_error", {"id": nid, "error": exc.as_dict()})
                    raise
                except Exception as exc:
                    if self.cancelled():
                        self.node_results[nid] = {"status": "cancelled", "progress": 0}
                        self.on_event("node_cancelled", {"id": nid})
                        raise _Cancelled(nid) from exc
                    err = {"message": str(exc), "node": nid}
                    self.node_results[nid] = {"status": "error", "error": err, "progress": 0}
                    self.on_event("node_error", {"id": nid, "error": err})
                    raise WorkflowError(str(exc), nid)
                if self.stop_node and nid == self.stop_node:
                    self.stopped = True
                    break
            self._raise_if_cancelled()
            if self.book is not None:
                self._check_conflicts()
            self._raise_if_cancelled()
            if not self.dry_run and not self.stopped and self.book is not None:
                self._apply_all()
            return {
                "ok": True,
                "cancelled": False,
                "dryRun": self.dry_run,
                "stopped": self.stopped,
                "nodes": self.node_results,
                "outputs": self.outputs_files,
                "conflicts": self.conflicts[:1000],
                "warnings": self.warnings,
            }
        except _Cancelled:
            return {
                "ok": False, "cancelled": True, "error": {"message": "任务已取消"},
                "nodes": self.node_results, "outputs": [], "conflicts": self.conflicts[:1000],
                "warnings": self.warnings, "dryRun": self.dry_run, "stopped": self.stopped,
            }
        except WorkflowError as exc:
            return {
                "ok": False, "cancelled": False, "error": exc.as_dict(), "errors": [exc.as_dict()],
                "nodes": self.node_results, "outputs": [], "conflicts": self.conflicts[:1000],
                "warnings": self.warnings, "dryRun": self.dry_run,
            }
        finally:
            if self.book is not None:
                self.book.close()

    def _raise_if_cancelled(self, nid: str = "") -> None:
        if self.cancelled():
            raise _Cancelled(nid)

    def _input(self, node: Dict[str, Any], port: str = "left") -> Optional[Table]:
        conns = [c for c in (self.spec.get("connections") or [])
                 if str(c.get("to")) == node["id"] and str(c.get("toPort") or "left") == port]
        if not conns:
            return None
        src = self.outputs.get(str(conns[0].get("from")))
        return src if isinstance(src, Table) else None

    def _execute(self, node: Dict[str, Any]) -> Any:
        op, data, nid = node["type"], node["data"], node["id"]
        fn = getattr(self, "_op_" + op, None)
        if fn is None:
            raise WorkflowError("节点类型尚未实现：%s" % op, nid)
        return fn(data, nid)

    def _progress(self, nid: str, ratio: float, message: str = "") -> None:
        self.on_event("progress", {"id": nid, "progress": max(0, min(1, ratio)), "message": message})

    # ---- 输入 ----
    def _op_file(self, data: Dict[str, Any], nid: str) -> Table:
        fid = str(data.get("fileId") or "")
        path = self.resolver(fid)
        self.book = Book(path)
        overrides = {}
        for row in (data.get("overrides") or []):
            if isinstance(row, dict) and row.get("sheet"):
                overrides[str(row["sheet"])] = row
        mode = str(data.get("sheetMode") or "one")
        if mode == "all":
            sheets = list(self.book.sheets)
        elif mode == "selected":
            picked = data.get("selected")
            sheets = [s for s in (picked if isinstance(picked, list) else []) if s in self.book.sheets]
        else:
            only = str(data.get("sheet") or "")
            sheets = [only] if only in self.book.sheets else []
        if not sheets:
            raise WorkflowError("没有可处理的工作表，请在文件节点选择工作表", nid)
        columns: List[str] = []
        rows: List[Row] = []
        for sheet in sheets:
            cfg = dict(data)
            cfg.update(overrides.get(sheet, {}))
            r1, c1, r2, c2 = self.book.resolve_range(sheet, cfg)
            header_row = int(cfg.get("headerRow") or 0)
            if header_row and r1 == header_row:
                r1 = header_row + 1  # 表头行不算数据行
            self.book.sheet_ranges[sheet] = (r1, c1, r2, c2)
            letters = [col_letter(c) for c in range(c1, c2 + 1)]
            for letter in letters:
                if letter not in columns:
                    columns.append(letter)
            grid = self.book.values(sheet)
            for r in range(r1, r2 + 1):
                if r % 200 == 0:
                    self._raise_if_cancelled(nid)
                if header_row and r == header_row:
                    continue
                values = {letter: grid.get(r, {}).get(column_index_from_string(letter)) for letter in letters}
                if all(v is None for v in values.values()):
                    continue
                headers = {
                    letter: self.book.header_of(sheet, column_index_from_string(letter), header_row)
                    for letter in letters
                }
                rows.append(Row(sheet, r, values, headers, {"headerRow": header_row}))
            self._progress(nid, 1, sheet)
        return Table(columns, rows, "rows", "Excel 区域")

    # ---- 计算 ----
    def _op_value(self, data: Dict[str, Any], value: Any, row: Row, nid: str) -> Any:
        op = str(data.get("op") or "copy")
        if op == "copy":
            return value
        if op == "lastTime":
            return parse_last_time(value) or SKIP
        if op == "lastTimeLookup":
            if parse_last_time(value) is None:
                return SKIP
            return lookup_value(value, data, "time")
        if op == "lookup":
            return lookup_value(value, data, str(data.get("lookupKind") or "exact"))
        if op == "number":
            n = number_of(value)
            if n is None:
                return 0 if data.get("zeroOnInvalid", False) else SKIP
            return normalize_result(n)
        if op == "multiply":
            factor = data.get("factor") if isinstance(data.get("factor"), dict) else {}
            mode = str(factor.get("mode") or "constant")
            if mode == "column":
                fv = row.values.get(str(factor.get("column") or "").strip().upper())
            elif mode == "header":
                target = str(factor.get("header") or "")
                fv = next((v for c, v in row.values.items() if text_of(row.headers.get(c)) == target), None)
            else:
                fv = factor.get("value")
            a, b = number_of(value), number_of(fv)
            if a is None or b is None:
                return 0 if data.get("zeroOnInvalid", True) else SKIP
            return normalize_result(a * b)
        if op == "text":
            text_op = str(data.get("textOp") or "trim")
            text = text_of(value)
            if text_op == "trim":
                out = text.strip()
            elif text_op == "upper":
                out = text.upper()
            elif text_op == "lower":
                out = text.lower()
            elif text_op == "left":
                out = text[: int(number_of(data.get("textN")) or 1)]
            elif text_op == "right":
                n = int(number_of(data.get("textN")) or 1)
                out = text[-n:] if n else ""
            elif text_op == "mid":
                start = int(number_of(data.get("textStart")) or 0)
                n = int(number_of(data.get("textN")) or 1)
                out = text[start:start + n]
            elif text_op == "replace":
                out = text.replace(text_of(data.get("textOld")), text_of(data.get("textNew")))
            elif text_op == "regex":
                m = re.search(str(data.get("pattern") or ""), text)
                out = m.group(int(number_of(data.get("group")) or 0)) if m else ""
            else:
                out = text
            prefix, suffix = text_of(data.get("prefix")), text_of(data.get("suffix"))
            return prefix + out + suffix
        if op == "condition":
            cond = data.get("condition") if isinstance(data.get("condition"), dict) else {}
            ok = conditions_pass(cond.get("rules"), cond.get("logic"), row, None)
            return cond.get("then", 1) if ok else cond.get("else", 0)
        if op == "formula":
            expr = str(data.get("expression") or "")
            err = check_expression(expr)
            if err:
                raise WorkflowError(err, nid, hint="请在节点设置里修正表达式。")
            return eval_expression(expr, row, value)
        return value

    def _target_column(self, data: Dict[str, Any], letter: str) -> str:
        mode = str(data.get("target") or "same")
        if mode == "offset":
            return col_letter(col_number(letter) + int(number_of(data.get("targetOffset")) or 0))
        if mode == "new":
            return "%s%s%s" % (text_of(data.get("targetPrefix")), letter, text_of(data.get("targetSuffix")))
        return letter

    def _op_mapCells(self, data: Dict[str, Any], nid: str) -> Table:
        table = self._input(node=self.nodes[nid])
        if table is None:
            raise WorkflowError("逐格计算节点没有上游表格", nid)
        cols = column_list(data.get("columns"), data.get("step", 1))
        if not cols:
            raise WorkflowError("请先设置要处理的列范围", nid)
        out = table.copy()
        for letter in cols:
            target = self._target_column(data, letter)
            if target not in out.columns:
                out.columns.append(target)
        total = max(1, len(out.rows))
        for i, row in enumerate(out.rows):
            if i % 200 == 0:
                self._raise_if_cancelled(nid)
            for letter in cols:
                value = row.values.get(letter)
                if data.get("sourceSkipEmpty", True) and (value is None or text_of(value).strip() == ""):
                    continue
                new_value = self._op_value(data, value, row, nid)
                if new_value is SKIP:
                    continue
                row.values[self._target_column(data, letter)] = new_value
            self._progress(nid, i / total)
        return out

    def _op_mapColumns(self, data: Dict[str, Any], nid: str) -> Table:
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("逐列计算节点没有上游表格", nid)
        targets = column_list(data.get("targetColumns"), data.get("step", 1))
        if not targets:
            raise WorkflowError("请先设置目标列范围", nid)
        mode = str(data.get("sourceMode") or "left")
        out = table.copy()
        for target in targets:
            if target not in out.columns:
                out.columns.append(target)
        total = max(1, len(out.rows) * len(targets))
        done = 0
        for row in out.rows:
            self._raise_if_cancelled(nid)
            for target in targets:
                if mode == "same":
                    source = target
                elif mode == "fixed":
                    source = str(data.get("sourceColumn") or "").strip().upper()
                elif mode == "header":
                    wanted = text_of(data.get("sourceHeader")).strip().lower()
                    source = next((c for c, h in row.headers.items()
                                   if text_of(h).strip().lower() == wanted), "")
                else:
                    source = col_letter(col_number(target) + int(number_of(data.get("sourceOffset")) or -1))
                if not source:
                    done += 1
                    continue
                value = row.values.get(source)
                if data.get("sourceSkipEmpty", False) and (value is None or text_of(value).strip() == ""):
                    done += 1
                    continue
                new_value = self._op_value(data, value, row, nid)
                if new_value is SKIP:
                    done += 1
                    continue
                row.values[target] = new_value
                done += 1
            self._progress(nid, done / total)
        return out

    def _op_formula(self, data: Dict[str, Any], nid: str) -> Table:
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("计算列节点没有上游表格", nid)
        target = str(data.get("outputColumn") or "").strip().upper()
        if not target:
            raise WorkflowError("请填写输出列名", nid)
        expr = str(data.get("expression") or "")
        err = check_expression(expr)
        if err:
            raise WorkflowError(err, nid)
        out = table.copy()
        if target not in out.columns:
            out.columns.append(target)
        for index, row in enumerate(out.rows):
            if index % 200 == 0:
                self._raise_if_cancelled(nid)
            row.values[target] = eval_expression(expr, row)
        return out

    # ---- 整理 ----
    def _op_filter(self, data: Dict[str, Any], nid: str) -> Table:
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("筛选节点没有上游表格", nid)
        out = table.copy()
        keep = data.get("keep", True)
        out.rows = [
            r for r in out.rows
            if conditions_pass(data.get("rules"), data.get("logic"), r, out) == bool(keep)
        ]
        return out

    def _op_sort(self, data: Dict[str, Any], nid: str) -> Table:
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("排序节点没有上游表格", nid)
        keys = [k for k in (data.get("keys") or []) if isinstance(k, dict) and k.get("column")]
        out = table.copy()
        def sort_key(value: Any):
            n = number_of(value)
            if n is not None:
                return (0, n, "")
            return (1, 0.0, text_of(value).lower())

        for key in reversed(keys):
            col = str(key["column"]).strip().upper()
            desc = str(key.get("dir") or "asc").lower() == "desc"
            out.rows.sort(key=lambda r: sort_key(r.values.get(col)), reverse=desc)
        return out

    def _op_dedupe(self, data: Dict[str, Any], nid: str) -> Table:
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("去重节点没有上游表格", nid)
        cols = column_list(data.get("columns"), 1)
        out = table.copy()
        keep = str(data.get("keep") or "first")
        seen = set()
        kept = []
        for row in out.rows:
            key = tuple(text_of(row.values.get(c)) for c in cols)
            if key not in seen:
                seen.add(key)
                kept.append(row)
            elif keep == "last":
                kept = [r for r in kept if tuple(text_of(r.values.get(c)) for c in cols) != key]
                kept.append(row)
        out.rows = kept
        return out

    def _op_join(self, data: Dict[str, Any], nid: str) -> Table:
        left = self._input(self.nodes[nid], "left")
        right = self._input(self.nodes[nid], "top")
        if left is None or right is None:
            raise WorkflowError("连接节点需要两张输入表：左端口和上方端口", nid,
                                hint="把主表连到节点左侧圆点，副表连到上方圆点。")
        lkey, rkey = str(data.get("leftKey") or "").strip().upper(), str(data.get("rightKey") or "").strip().upper()
        if not lkey or not rkey:
            raise WorkflowError("请填写左右两侧的连接列", nid)
        prefix = str(data.get("prefix") or "R_")
        mode = str(data.get("mode") or "left")
        index: Dict[str, List[Row]] = {}
        for row in right.rows:
            index.setdefault(text_of(row.values.get(rkey)).strip().lower(), []).append(row)
        columns = list(left.columns) + [prefix + c for c in right.columns if prefix + c not in left.columns]
        out = Table(columns, [], "rows", "连接结果")
        for row in left.rows:
            matches = index.get(text_of(row.values.get(lkey)).strip().lower(), [])
            if not matches:
                if mode == "inner":
                    continue
                new = row.copy()
                for col in right.columns:
                    new.values[prefix + col] = None
                out.rows.append(new)
                continue
            for match in matches:
                new = row.copy()
                for col in right.columns:
                    new.values[prefix + col] = match.values.get(col)
                out.rows.append(new)
        return out

    # ---- 汇总 ----
    def _op_aggregate(self, data: Dict[str, Any], nid: str) -> Table:
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("汇总节点没有上游表格", nid)
        mode = str(data.get("mode") or "columns")
        agg = str(data.get("agg") or "sum")
        if mode == "columns":
            cols = column_list(data.get("valueColumns"), data.get("step", 1))
            if not cols:
                raise WorkflowError("请设置要汇总的值列范围", nid)
            total_key = str(data.get("totalKey") or "total")
            name_key = str(data.get("nameKey") or "name")
            sheet_key = str(data.get("sheetKey") or "__sheet")
            name_offset = int(number_of(data.get("nameColumnOffset")) or 0)

            def header_name(row: Row, col: str) -> str:
                col_idx = col_number(col) + name_offset
                source = col_letter(col_idx) if col_idx > 0 else col
                return text_of(row.headers.get(source) or row.headers.get(col)
                               or data.get("namePrefix") or col).strip()

            acc: Dict[Tuple[str, str], Dict[str, Any]] = {}
            for col in cols:
                for row in table.rows:
                    name = header_name(row, col)
                    if not name:
                        continue
                    key = (row.sheet, name)
                    state = acc.setdefault(key, {"sum": 0.0, "count": 0, "min": None, "max": None})
                    if agg == "count":
                        state["count"] += 1
                        continue
                    n = number_of(row.values.get(col))
                    if n is None:
                        continue
                    state["sum"] += n
                    state["count"] += 1
                    state["min"] = n if state["min"] is None else min(state["min"], n)
                    state["max"] = n if state["max"] is None else max(state["max"], n)
            out = Table([sheet_key, name_key, total_key], [], "summary", "按列汇总")
            for (sheet, name), state in acc.items():
                if agg == "count":
                    value = float(state["count"])
                elif agg == "avg":
                    value = state["sum"] / state["count"] if state["count"] else 0.0
                elif agg == "min":
                    value = state["min"] if state["min"] is not None else 0.0
                elif agg == "max":
                    value = state["max"] if state["max"] is not None else 0.0
                else:
                    value = state["sum"]
                out.rows.append(Row("", 0, {sheet_key: sheet, name_key: name,
                                             total_key: normalize_result(value)}, {}, {}))
            return out
        # 按行分组
        keys = [c.strip().upper() for c in re.split(r"[,，]", str(data.get("groupBy") or "")) if c.strip()]
        cols = column_list(data.get("valueColumns"), data.get("step", 1))
        groups: Dict[Tuple[str, ...], List[Row]] = {}
        for row in table.rows:
            key = tuple(text_of(row.values.get(c)) for c in keys)
            groups.setdefault(key, []).append(row)
        out_cols = keys + ["%s_%s" % (agg, c) for c in cols]
        out = Table(out_cols, [], "summary", "分组汇总")
        for key, rows in groups.items():
            values = {c: key[i] for i, c in enumerate(keys)}
            for col in cols:
                nums = [number_of(r.values.get(col)) for r in rows]
                nums = [n for n in nums if n is not None]
                if agg == "count":
                    value = float(len(nums))
                elif agg == "avg":
                    value = sum(nums) / len(nums) if nums else 0
                elif agg == "min":
                    value = min(nums) if nums else 0
                elif agg == "max":
                    value = max(nums) if nums else 0
                else:
                    value = sum(nums)
                values["%s_%s" % (agg, col)] = normalize_result(value)
            out.rows.append(Row("", 0, values, {}, {}))
        return out

    def _op_pivot(self, data: Dict[str, Any], nid: str) -> Table:
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("交叉汇总节点没有上游表格", nid)
        row_keys = key_list(data.get("rowKeys"))
        col_key, value_key = str(data.get("colKey") or ""), str(data.get("valueKey") or "")
        if not row_keys or not col_key or not value_key:
            raise WorkflowError("交叉汇总需要行字段、列字段和值字段", nid)
        label = str(data.get("totalLabel") or "合计")
        col_values = []
        for row in table.rows:
            v = text_of(row.values.get(col_key))
            if v and v not in col_values:
                col_values.append(v)
        columns = row_keys + col_values
        if data.get("rowTotals", True):
            columns.append(label)
        cells: Dict[Tuple[str, ...], Dict[str, float]] = {}
        order: List[Tuple[str, ...]] = []
        for row in table.rows:
            key = tuple(text_of(row.values.get(k)) for k in row_keys)
            if key not in cells:
                cells[key] = {}
                order.append(key)
            col = text_of(row.values.get(col_key))
            n = number_of(row.values.get(value_key)) or 0
            cells[key][col] = cells[key].get(col, 0.0) + n
        out = Table(columns, [], "summary", "交叉汇总")
        for key in order:
            values = {k: key[i] for i, k in enumerate(row_keys)}
            row_total = 0.0
            for col in col_values:
                v = normalize_result(cells[key].get(col, 0))
                values[col] = v
                row_total += float(v)
            if data.get("rowTotals", True):
                values[label] = normalize_result(row_total)
            out.rows.append(Row("", 0, values, {}, {}))
        if data.get("colTotals", True):
            values = {k: label for k in row_keys}
            grand = 0.0
            for col in col_values:
                total = sum(cells[key].get(col, 0) for key in order)
                values[col] = normalize_result(total)
                grand += total
            if data.get("rowTotals", True):
                values[label] = normalize_result(grand)
            out.rows.append(Row("", 0, values, {}, {}))
        return out

    # ---- 输出 ----
    def _write_rows(self, data: Dict[str, Any], nid: str, as_formula: bool = False,
                    formula_fn: Optional[Callable[[Row, str], str]] = None) -> Dict[str, Any]:
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("写回节点没有上游表格", nid)
        if self.book is None:
            raise WorkflowError("找不到输入工作簿", nid)
        cols = column_list(data.get("columns"), data.get("step", 1))
        if not cols:
            raise WorkflowError("请设置要写入的列范围", nid)
        row_mode = str(data.get("rowMode") or "same")
        if as_formula:
            skip_empty, skip_zero = False, False
        else:
            skip_empty = bool(data.get("skipEmpty", True))
            skip_zero = bool(data.get("skipZero", False))
        conflict = str(data.get("conflict") or "skip")
        style = str(data.get("style") or "asc")
        written = skipped = 0
        for index, row in enumerate(table.rows):
            if index % 200 == 0:
                self._raise_if_cancelled(nid)
            for col in cols:
                if formula_fn is not None:
                    value = formula_fn(row, col)
                    if value is None:
                        continue
                else:
                    value = row.values.get(col)
                if value is SKIP or value is None:
                    if skip_empty:
                        continue
                    value = ""
                if skip_zero and number_of(value) == 0:
                    continue
                if as_formula and not text_of(value).startswith("="):
                    value = "=" + text_of(value)
                mode_offset = int(number_of(data.get("offset")) or 0)
                if row_mode == "next":
                    target_row = row.src_row + 1
                elif row_mode == "offset":
                    target_row = row.src_row + mode_offset
                else:
                    target_row = row.src_row
                self.book.writes.append({
                    "sheet": row.sheet, "check_row": target_row, "col": col_number(col),
                    "value": value, "row_mode": row_mode, "offset": mode_offset,
                    "style": style, "source_row": row.src_row, "source_col": col_number(col),
                    "conflict": conflict,
                })
                if row_mode == "insertBelow":
                    self.book.inserts.setdefault(row.sheet, set()).add(row.src_row)
                written += 1
        return {"written": written, "skipped": skipped, "columns": cols,
                "rowMode": row_mode, "dryRun": self.dry_run}

    def _op_write(self, data: Dict[str, Any], nid: str) -> Dict[str, Any]:
        return self._write_rows(data, nid)

    def _op_writeFormula(self, data: Dict[str, Any], nid: str) -> Dict[str, Any]:
        kind = str(data.get("kind") or "rowSum")
        if kind == "colSum":
            cols = column_list(data.get("columns"), data.get("step", 1))
            if not cols:
                raise WorkflowError("请设置要求和的列范围", nid)
            if self.book is None:
                raise WorkflowError("找不到输入工作簿", nid)
            sum_row = data.get("sumRow", "auto")
            for sheet, (r1, _c1, r2, _c2) in self.book.sheet_ranges.items():
                target_row = r2 + 1 if str(sum_row) in ("auto", "", "0") else int(number_of(sum_row) or r2 + 1)
                for col in cols:
                    formula = "=SUM(%s%d:%s%d)" % (col, r1, col, r2)
                    self.book.writes.append({
                        "sheet": sheet, "check_row": target_row, "col": col_number(col),
                        "value": formula, "row_mode": "fixed", "offset": 0,
                        "style": str(data.get("style") or "asc"),
                        "source_row": r1, "source_col": col_number(col),
                        "conflict": str(data.get("conflict") or "skip"),
                    })
            return {"written": len(cols) * len(self.book.sheet_ranges), "kind": "colSum",
                    "columns": cols, "dryRun": self.dry_run}
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("写公式节点没有上游表格", nid)
        cols = column_list(data.get("columns"), data.get("step", 1))
        target = str(data.get("targetColumn") or "").strip().upper()
        if not cols or not target:
            raise WorkflowError("请设置求和列范围与结果列", nid)
        first, last = cols[0], cols[-1]

        def formula_fn(row: Row, _col: str) -> str:
            base = row.src_row
            return "=SUM(%s%d:%s%d)" % (first, base, last, base)

        data = dict(data)
        data["columns"] = target
        return self._write_rows(data, nid, as_formula=True, formula_fn=formula_fn)

    def _op_exportTable(self, data: Dict[str, Any], nid: str) -> Dict[str, Any]:
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("导出表节点没有上游表格", nid)
        if self.book is None:
            raise WorkflowError("找不到输入工作簿", nid)
        filename = safe_filename(data.get("filename"), "summary.xlsx")
        if not filename.lower().endswith(_SAFE_EXT):
            filename += ".xlsx"
        self.book.exports.append({
            "filename": filename, "sheet": str(data.get("sheetName") or "汇总"),
            "title": str(data.get("title") or ""), "header": bool(data.get("header", True)),
            "totals": bool(data.get("totals")), "style": str(data.get("style") or "asc"),
            "table": table.copy(),
        })
        return {"filename": filename, "rows": len(table.rows), "columns": table.columns,
                "dryRun": self.dry_run}

    def _op_save(self, data: Dict[str, Any], nid: str) -> Dict[str, Any]:
        if self.book is None:
            raise WorkflowError("找不到输入工作簿", nid)
        filename = safe_filename(data.get("filename"), "result.xlsx")
        if not filename.lower().endswith(_SAFE_EXT):
            filename += ".xlsx"
        return {"filename": filename, "dryRun": self.dry_run}

    def _op_preview(self, data: Dict[str, Any], nid: str) -> Table:
        table = self._input(self.nodes[nid])
        if table is None:
            raise WorkflowError("预览节点没有上游表格", nid)
        return table

    def _op_note(self, data: Dict[str, Any], nid: str) -> Dict[str, Any]:
        return {"text": str(data.get("text") or "")}

    # ---- 写计划预检与应用 ----
    def _check_conflicts(self) -> None:
        """独立冲突预检：dry-run 与 preview 也执行，但不修改工作簿。"""
        assert self.book is not None
        self.conflicts.clear()
        blocked = False
        for plan in self.book.writes:
            if plan["row_mode"] == "insertBelow":
                continue  # 写到新插入的空行，天然不存在冲突
            sheet = plan["sheet"]
            ws = self.book.ws(sheet)
            check_row = max(1, int(plan["check_row"]))
            old = ws.cell(row=check_row, column=plan["col"]).value
            if old is None:
                continue
            policy = plan.get("conflict") or "skip"
            if policy == "error":
                blocked = True
                self.conflicts.append({
                    "sheet": sheet, "row": check_row, "column": col_letter(plan["col"]),
                    "old": text_of(old), "new": text_of(plan["value"]), "action": "error",
                })
            elif policy == "skip":
                self.conflicts.append({
                    "sheet": sheet, "row": check_row, "column": col_letter(plan["col"]),
                    "old": text_of(old), "new": text_of(plan["value"]), "action": "skip",
                })
        if blocked:
            raise WorkflowError("存在不允许覆盖的非空单元格，已中止保存（未写出文件）",
                                hint="把写回节点的冲突策略改为“覆盖已有值”或“跳过已有值”。")

    def _apply_all(self) -> None:
        self._raise_if_cancelled()
        assert self.book is not None
        book = self.book
        if self.dry_run or self.stopped:
            raise RuntimeError("试运行或节点预览不能应用写计划")
        if not book.writes and not book.exports:
            self.warnings.append({"message": "没有产生任何写入或导出，结果文件与原文件相同"})
        # 1. 统一插行（按表、自底向上）
        for sheet, rows in book.inserts.items():
            ws = book.ws(sheet)
            for r in sorted(set(rows), reverse=True):
                ws.insert_rows(max(1, int(r)) + 1)
        inserted = {sheet: sorted(rows) for sheet, rows in book.inserts.items()}

        def count_less(sheet: str, row: int) -> int:
            return sum(1 for r in inserted.get(sheet, []) if r < row)

        def count_le(sheet: str, row: int) -> int:
            return sum(1 for r in inserted.get(sheet, []) if r <= row)

        # 2. 写值与公式
        touched: Set[Tuple[str, int, int]] = set()
        for plan in book.writes:
            sheet = plan["sheet"]
            mode = plan["row_mode"]
            check_row = int(plan["check_row"])
            if mode == "insertBelow":
                final_row = int(plan["source_row"]) + count_le(sheet, int(plan["source_row"]))
            else:
                # check_row 已经是目标原始行；插行后按上方插入数顺延。
                final_row = check_row + count_less(sheet, check_row)
            if plan.get("conflict") == "skip" and any(
                c["sheet"] == sheet and c["row"] == check_row
                and c["column"] == col_letter(plan["col"]) and c["action"] == "skip"
                for c in self.conflicts
            ):
                continue
            key = (sheet, final_row, plan["col"])
            if key in touched:
                self.warnings.append({
                    "message": "%s!%s%d 被多个节点写入，最后一次生效" %
                               (sheet, col_letter(plan["col"]), final_row)
                })
            touched.add(key)
            ws = book.ws(sheet)
            cell = ws.cell(row=final_row, column=plan["col"])
            cell.value = plan["value"]
            style = plan.get("style") or "asc"
            if style == "asc":
                cell.border = shallow_copy(_FORCED_BORDER)
                cell.alignment = shallow_copy(_FORCED_ALIGNMENT)
                cell.font = shallow_copy(_FORCED_FONT)
            elif style == "inherit":
                try:
                    src = book.ws(sheet).cell(row=max(1, int(plan["source_row"])), column=plan["source_col"])
                    cell.border = shallow_copy(src.border)
                    cell.alignment = shallow_copy(src.alignment)
                    cell.font = shallow_copy(src.font)
                    cell.number_format = src.number_format
                except Exception:
                    pass
        # 3. 保存主工作簿（只允许已执行节点触发的保存）
        save_nodes = [n for n in self.nodes.values()
                      if n["type"] == "save" and n["id"] in self.executed]
        if save_nodes:
            for save in save_nodes:
                self._raise_if_cancelled()
                filename = safe_filename(save["data"].get("filename"), "result.xlsx")
                if not filename.lower().endswith(_SAFE_EXT):
                    filename += ".xlsx"
                if not self.out_dir:
                    raise WorkflowError("未配置输出目录")
                os.makedirs(self.out_dir, exist_ok=True)
                path = os.path.join(self.out_dir, filename)
                book.wb.save(path)
                self.outputs_files.append({
                    "name": filename, "path": path, "kind": "workbook",
                    "url": "/api/file/%s" % filename,
                })
        # 4. 导出独立表
        for exp in book.exports:
            self._raise_if_cancelled()
            path = self._write_export(exp)
            self.outputs_files.append({
                "name": exp["filename"], "path": path, "kind": "table",
                "url": "/api/file/%s" % exp["filename"],
            })

    def _write_export(self, exp: Dict[str, Any]) -> str:
        table: Table = exp["table"]
        wb = Workbook()
        ws = wb.active
        ws.title = str(exp.get("sheet") or "汇总")[:31]
        row_index = 1
        if exp.get("title"):
            ncols = max(1, len(table.columns))
            ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncols)
            title_cell = ws.cell(row=1, column=1, value=exp["title"])
            title_cell.font = Font(bold=True, size=14)
            title_cell.alignment = Alignment(horizontal="center", vertical="center")
            row_index = 2
        header_row = row_index
        if exp.get("header", True):
            for c, name in enumerate(table.columns, start=1):
                cell = ws.cell(row=row_index, column=c, value=name)
                cell.font = Font(bold=True)
                cell.alignment = Alignment(horizontal="center", vertical="center")
            row_index += 1
        for row in table.rows:
            for c, name in enumerate(table.columns, start=1):
                ws.cell(row=row_index, column=c, value=row.values.get(name))
            row_index += 1
        if exp.get("totals") and row_index > header_row:
            for c in range(1, len(table.columns) + 1):
                cell = ws.cell(row=row_index, column=c)
                cell.font = Font(bold=True)
                cell.alignment = Alignment(horizontal="center", vertical="center")
        if not self.out_dir:
            raise WorkflowError("未配置输出目录")
        os.makedirs(self.out_dir, exist_ok=True)
        path = os.path.join(self.out_dir, exp["filename"])
        wb.save(path)
        wb.close()
        return path


# ---------------------------------------------------------------------------
# 对外 API
# ---------------------------------------------------------------------------


def run_workflow(spec: Dict[str, Any], options: Optional[Dict[str, Any]] = None,
                 resolver: Optional[Callable[[str], str]] = None,
                 on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
                 cancelled: Optional[Callable[[], bool]] = None) -> Dict[str, Any]:
    engine = Engine(spec, options, resolver, on_event, cancelled)
    return engine.run()
