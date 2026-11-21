# -*- coding: utf-8 -*-
"""表格自动化引擎的完整单元测试。

覆盖：解析工具、安全表达式、工作簿读取、全部节点操作、写回计划、
插行行号映射、冲突策略、试运行/预览节点、取消、流程校验与错误提示。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import table_engine as te  # noqa: E402

FEE_LOOKUP = [
    {"min": "", "max": "18:55", "result": 0},
    {"min": "18:56", "max": "19:24", "result": 1},
    {"min": "19:25", "max": "19:54", "result": 1.5},
    {"min": "19:55", "max": "20:24", "result": 2},
    {"min": "20:25", "max": "20:54", "result": 2.5},
    {"min": "20:55", "max": "", "result": 3},
]


# ---------------------------------------------------------------------------
# fixtures / helpers
# ---------------------------------------------------------------------------

def make_book(path, sheets=None):
    """sheets = {name: {(row, col): value}}"""
    wb = Workbook()
    wb.remove(wb.active)
    for name, cells in (sheets or {"S": {}}).items():
        ws = wb.create_sheet(name)
        for (r, c), value in cells.items():
            ws.cell(row=r, column=c, value=value)
    wb.save(path)
    return path


def spec(nodes, connections=None):
    return {
        "format": "omm-table-workflow", "version": 1,
        "nodes": nodes, "connections": connections or [],
    }


def chain(*types):
    nodes = [{"id": "n%d" % i, "type": t, "data": {}} for i, t in enumerate(types)]
    conns = [{"from": nodes[i]["id"], "to": nodes[i + 1]["id"]} for i in range(len(nodes) - 1)]
    return nodes, conns


def run(spec_data, tmp_path, resolver=None, options=None, **kwargs):
    opts = {"outDir": str(tmp_path)}
    opts.update(options or {})
    return te.run_workflow(spec_data, options=opts, resolver=resolver, **kwargs)


@pytest.fixture()
def simple(tmp_path):
    return make_book(tmp_path / "in.xlsx", {"S": {
        (1, 1): "姓名", (1, 2): "乘数",
        (2, 1): "甲", (2, 2): 2, (2, 3): 10,
        (3, 1): "乙", (3, 2): 3, (3, 3): 5,
        (4, 1): "丙", (4, 2): None, (4, 3): 7,
    }})


# ---------------------------------------------------------------------------
# 1. 基础解析
# ---------------------------------------------------------------------------

def test_column_helpers():
    assert te.col_number("A") == 1
    assert te.col_number("z") == 26
    assert te.col_number("AA") == 27
    assert te.col_letter(1) == "A"
    assert te.col_letter(27) == "AA"
    assert te.cell_ref("$c$6") == (3, 6)
    assert te.column_list("C:E") == ["C", "D", "E"]
    assert te.column_list("C:F", 2) == ["C", "E"]
    assert te.column_list("C,E") == ["C", "E"]
    assert te.column_list(["C", "D"]) == ["C", "D"]
    with pytest.raises(te.WorkflowError):
        te.column_list("E:C")


def test_safe_filename():
    assert te.safe_filename("结果.xlsx") == "结果.xlsx"
    assert te.safe_filename("../../evil.xlsx") == "evil.xlsx"
    assert te.safe_filename("a:b?c.xlsx") == "a_b_c.xlsx"
    assert te.safe_filename("   ") == "output.xlsx"


def test_parse_last_time_variants():
    assert te.parse_last_time("08:00 下班 19:25") == te.dtime(19, 25)
    assert te.parse_last_time("上班 8：05 下班 20：55：30") == te.dtime(20, 55, 30)
    assert te.parse_last_time(te.dtime(18, 55)) == te.dtime(18, 55)
    assert te.parse_last_time(te.datetime(2025, 1, 1, 19, 24)) == te.dtime(19, 24)
    assert te.parse_last_time(0.5) == te.dtime(12, 0)
    assert te.parse_last_time("没有时间") is None
    assert te.parse_last_time("25:70") is None
    assert te.minutes_of("19:24") == 1164


def test_number_text_normalize():
    assert te.number_of(" 1,234.5 ") == 1234.5
    assert te.number_of("abc") is None
    assert te.number_of(None) is None
    assert te.number_of(True) == 1
    assert te.text_of(1.0) == "1"
    assert te.text_of(te.dtime(19, 25)) == "19:25"
    assert te.normalize_result(1.0000000001) == 1
    assert te.normalize_result(1.25) == 1.25


def test_lookup_boundaries():
    data = {"lookup": FEE_LOOKUP, "defaultResult": 99}
    assert te.lookup_value("18:55", data, "time") == 0
    assert te.lookup_value("18:56", data, "time") == 1
    assert te.lookup_value("19:24", data, "time") == 1
    assert te.lookup_value("19:25", data, "time") == 1.5
    assert te.lookup_value("20:24", data, "time") == 2
    assert te.lookup_value("20:54", data, "time") == 2.5
    assert te.lookup_value("20:55", data, "time") == 3
    assert te.lookup_value("00:30", data, "time") == 0
    numeric = {"lookup": [{"min": 0, "max": 10, "result": "低"}], "defaultResult": "高"}
    assert te.lookup_value(5, numeric, "numeric") == "低"
    assert te.lookup_value(50, numeric, "numeric") == "高"
    exact = {"lookup": [{"value": "甲", "result": 1}], "defaultResult": 0}
    assert te.lookup_value("甲", exact, "exact") == 1


def test_compare_operators():
    assert te.compare(2, ">", 1)
    assert te.compare("10", ">", "2")  # 两边都能转数字时按数字比
    assert te.compare("abc", "contains", "b")
    assert te.compare("", "empty", None)
    assert te.compare("x", "notEmpty", None)
    assert not te.compare(1, "==", "1x")


# ---------------------------------------------------------------------------
# 2. 安全表达式
# ---------------------------------------------------------------------------

def test_expression_valid_and_invalid():
    for expr in ("[D]*[C]", "IF([E]>0,[E],0)", 'ROUND([A]+2,1)', 'IF(AND([A]>0,[B]<5),1,0)'):
        assert te.check_expression(expr) is None, expr
    bad = [
        "__import__('os')", "open('x')", "[C].__class__", "(lambda: 1)()",
        "eval('1')", "[x for x in []]", "1 +", "foo(1)",
    ]
    for expr in bad:
        assert te.check_expression(expr) is not None, expr


def test_expression_evaluation(simple, tmp_path):
    row = te.Row("S", 2, {"A": "甲", "C": 10, "D": 4}, {}, {})
    assert te.eval_expression("[C]*[D]", row) == 40
    assert te.eval_expression("IF([C]>5,1,0)", row) == 1
    assert te.eval_expression("ROUND([C]/3,2)", row) == 3.33
    assert te.eval_expression('CONTAINS([A],"甲")', row)
    assert te.eval_expression("SUM([C],[D])", row) == 14
    assert te.eval_expression("value", row, 7) == 7
    assert te.eval_expression("row", row) == 2
    assert te.eval_expression("sheet", row) == "S"
    assert te.eval_expression('LASTTIME("19:25")', row) == te.dtime(19, 25)


# ---------------------------------------------------------------------------
# 3. 工作簿读取
# ---------------------------------------------------------------------------

def test_book_real_extent_ignores_format_inflation(tmp_path):
    path = make_book(tmp_path / "inflated.xlsx", {"S": {(1, 1): "a", (5, 8): "b"}})
    wb = load_workbook(path)
    wb["S"]["Z100"] = None  # 仅格式占位
    wb.save(path)
    book = te.Book(str(path))
    try:
        assert book.extent("S") == (5, 8)
        assert book.cell_value("S", 5, 8) == "b"
        assert book.cell_value("S", 6, 1) is None
    finally:
        book.close()


def test_book_resolve_range_modes(simple):
    book = te.Book(str(simple))
    try:
        assert book.resolve_range("S", {"rangeMode": "auto", "startCell": "A2"}) == (2, 1, 4, 3)
        assert book.resolve_range("S", {"rangeMode": "manual", "startCell": "A2", "endCell": "C3"}) == (2, 1, 3, 3)
        assert book.resolve_range("S", {"rangeMode": "manual", "startCell": "B2", "endCell": "C"}) == (2, 2, 4, 3)
    finally:
        book.close()


def test_describe_workbook(simple):
    info = te.describe_workbook(str(simple))
    assert info["ok"]
    assert info["sheets"][0]["name"] == "S"
    assert info["sheets"][0]["maxRow"] == 4
    assert info["sheets"][0]["columns"][:3] == ["A", "B", "C"]


def test_book_rejects_unsupported_extension(tmp_path):
    bad = tmp_path / "old.xls"
    bad.write_bytes(b"x")
    with pytest.raises(te.WorkflowError):
        te.Book(str(bad))


# ---------------------------------------------------------------------------
# 4. 输入节点
# ---------------------------------------------------------------------------

def test_file_node_auto_and_header(simple, tmp_path):
    nodes, conns = chain("file", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S",
                        "rangeMode": "auto", "startCell": "A1", "headerRow": 1}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple))
    assert result["ok"], result.get("error")
    sample = result["nodes"]["n0"]["result"]
    assert sample["rowCount"] == 3
    assert sample["columns"] == ["A", "B", "C"]
    assert sample["rows"][0][0] == "甲"


def test_file_node_all_sheets_and_overrides(tmp_path):
    path = make_book(tmp_path / "multi.xlsx", {
        "一": {(1, 1): "h", (2, 1): 1, (3, 1): 2},
        "二": {(2, 1): 9},
    })
    nodes, conns = chain("file", "preview")
    nodes[0]["data"] = {
        "fileId": "x", "sheetMode": "all", "rangeMode": "auto", "startCell": "A1", "headerRow": 0,
        "overrides": [{"sheet": "二", "startCell": "A1", "endCell": "A2", "headerRow": 0}],
    }
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(path))
    assert result["ok"], result.get("error")
    sample = result["nodes"]["n0"]["result"]
    assert set(sample["sheets"]) == {"一", "二"}
    assert sample["rowCount"] == 4


def test_file_node_missing_sheet(simple, tmp_path):
    nodes, conns = chain("file", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "不存在", "rangeMode": "auto"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple))
    assert not result["ok"]
    assert "工作表" in result["error"]["message"]


# ---------------------------------------------------------------------------
# 5. 逐格 / 逐列计算
# ---------------------------------------------------------------------------

def test_map_cells_fee_thresholds(tmp_path):
    path = make_book(tmp_path / "fee.xlsx", {"打卡": {
        (5, 3): "18:55", (6, 3): "19:24", (7, 3): "19:25", (8, 3): "20:54", (9, 3): "20:55",
        (10, 3): "", (11, 3): "20:00",
    }})
    nodes, conns = chain("file", "mapCells", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "打卡", "rangeMode": "manual",
                        "startCell": "C5", "endCell": "C11"}
    nodes[1]["data"] = {"columns": "C", "op": "lastTimeLookup", "lookupKind": "time",
                        "lookup": FEE_LOOKUP, "defaultResult": 3, "sourceSkipEmpty": True}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(path))
    assert result["ok"], result.get("error")
    rows = result["nodes"]["n2"]["result"]["rows"]
    assert [r[0] for r in rows] == [0, 1, 1.5, 2.5, 3, 2]


def test_map_cells_target_offset_and_condition(simple, tmp_path):
    nodes, conns = chain("file", "mapCells", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto", "startCell": "A2"}
    nodes[1]["data"] = {
        "columns": "C", "op": "condition", "target": "offset", "targetOffset": 1,
        "condition": {"logic": "and", "rules": [{"column": "C", "op": ">=", "value": 8}], "then": "高", "else": "低"},
    }
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple))
    assert result["ok"], result.get("error")
    sample = result["nodes"]["n2"]["result"]
    assert "D" in sample["columns"]
    rows = sample["rows"]
    assert rows[0][3] == "高" and rows[1][3] == "低"


def test_map_cells_text_ops(tmp_path):
    path = make_book(tmp_path / "text.xlsx", {"S": {(1, 1): "  AbC-123 ", (2, 1): "foo=bar"}})
    nodes, conns = chain("file", "mapCells", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    nodes[1]["data"] = {"columns": "A", "op": "text", "textOp": "regex", "pattern": r"(\d+)", "group": 1}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(path))
    assert result["nodes"]["n2"]["result"]["rows"][0][0] == "123"


def test_map_columns_wage_step(tmp_path):
    path = make_book(tmp_path / "wage.xlsx", {"款": {
        (1, 4): "张三", (1, 6): "李四",
        (2, 3): 2, (2, 4): 10, (2, 6): 7,
        (3, 3): 3, (3, 4): 5, (3, 6): None,
    }})
    nodes, conns = chain("file", "mapColumns", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "款",
                        "rangeMode": "auto", "startCell": "A1", "headerRow": 1}
    nodes[1]["data"] = {
        "targetColumns": "E:G", "step": 2, "sourceMode": "left", "sourceOffset": -1,
        "op": "multiply", "factor": {"mode": "column", "column": "C"}, "zeroOnInvalid": True,
    }
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(path))
    assert result["ok"], result.get("error")
    sample = result["nodes"]["n2"]["result"]
    assert "E" in sample["columns"] and "G" in sample["columns"]
    by_col = dict(zip(sample["columns"], sample["rows"][0]))
    assert by_col["E"] == 20 and by_col["G"] == 14
    by_col2 = dict(zip(sample["columns"], sample["rows"][1]))
    assert by_col2["E"] == 15 and by_col2["G"] == 0


def test_formula_node(tmp_path):
    path = make_book(tmp_path / "calc.xlsx", {"S": {(1, 3): 4, (1, 4): 2}})
    nodes, conns = chain("file", "formula", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    nodes[1]["data"] = {"outputColumn": "Z", "expression": "ROUND([C]*[D]+1,0)"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(path))
    assert result["ok"], result.get("error")
    assert result["nodes"]["n2"]["result"]["rows"][0][-1] == 9


def test_formula_node_rejects_unsafe_expression(simple, tmp_path):
    nodes, conns = chain("file", "formula", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    nodes[1]["data"] = {"outputColumn": "Z", "expression": "__import__('os')"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple))
    assert not result["ok"]
    assert "表达式" in result["error"]["message"]


# ---------------------------------------------------------------------------
# 6. 整理节点
# ---------------------------------------------------------------------------

def test_filter_sort_dedupe(simple, tmp_path):
    nodes, conns = chain("file", "filter", "sort", "dedupe", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto", "startCell": "A2"}
    nodes[1]["data"] = {"logic": "and", "rules": [{"column": "A", "op": "notEmpty", "value": ""}], "keep": True}
    nodes[2]["data"] = {"keys": [{"column": "B", "dir": "desc"}]}
    nodes[3]["data"] = {"columns": "B", "keep": "first"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple))
    assert result["ok"], result.get("error")
    rows = result["nodes"]["n4"]["result"]["rows"]
    assert len(rows) == 3
    assert 3 in [r[1] for r in rows]


def test_join_left_and_inner(simple, tmp_path):
    path = make_book(tmp_path / "join.xlsx", {"S": {(1, 1): "甲", (1, 2): 100}})
    nodes = [
        {"id": "f1", "type": "file", "data": {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto", "startCell": "A2"}},
        {"id": "f2", "type": "file", "data": {"fileId": "y", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}},
        {"id": "j", "type": "join", "data": {"leftKey": "A", "rightKey": "A", "mode": "left", "prefix": "R_"}},
        {"id": "p", "type": "preview", "data": {}},
    ]
    conns = [
        {"from": "f1", "to": "j", "toPort": "left"},
        {"from": "f2", "to": "j", "toPort": "top"},
        {"from": "j", "to": "p"},
    ]
    result = run(spec(nodes, conns), tmp_path,
                 resolver=lambda fid: str(simple) if fid == "x" else str(path))
    assert not result["ok"]  # 两个 file 节点会被校验拦截
    assert "有且只有一个" in str(result["errors"])


# ---------------------------------------------------------------------------
# 7. 汇总节点
# ---------------------------------------------------------------------------

def test_aggregate_columns_and_pivot(tmp_path):
    path = make_book(tmp_path / "agg.xlsx", {
        "一": {(1, 4): "张三", (1, 6): "李四", (2, 4): 10, (3, 6): 5},
        "二": {(1, 4): "张三", (2, 4): 7},
    })
    nodes = [
        {"id": "f", "type": "file", "data": {"fileId": "x", "sheetMode": "all",
            "rangeMode": "auto", "startCell": "A1", "headerRow": 1}},
        {"id": "m", "type": "mapColumns", "data": {"targetColumns": "E:G", "step": 2,
            "sourceMode": "left", "sourceOffset": -1, "op": "copy"}},
        {"id": "a", "type": "aggregate", "data": {"mode": "columns", "valueColumns": "E:G",
            "step": 2, "agg": "sum", "nameKey": "姓名", "sheetKey": "__sheet",
            "totalKey": "合计", "nameColumnOffset": -1}},
        {"id": "p", "type": "pivot", "data": {"rowKeys": ["姓名"], "colKey": "__sheet",
            "valueKey": "合计", "rowTotals": True, "colTotals": True, "totalLabel": "合计"}},
        {"id": "v", "type": "preview", "data": {}},
    ]
    conns = [{"from": "f", "to": "m"}, {"from": "m", "to": "a"},
             {"from": "a", "to": "p"}, {"from": "p", "to": "v"}]
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(path))
    assert result["ok"], result.get("error")
    sample = result["nodes"]["v"]["result"]
    # 四行：张三/一、李四/一、张三/二、合计
    assert sample["rowCount"] >= 3
    assert "一" in sample["columns"] and "二" in sample["columns"]


def test_aggregate_rows_mode(simple, tmp_path):
    nodes, conns = chain("file", "aggregate", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto", "startCell": "A2"}
    nodes[1]["data"] = {"mode": "rows", "groupBy": "A", "valueColumns": "C", "agg": "sum"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple))
    assert result["ok"], result.get("error")
    sample = result["nodes"]["n2"]["result"]
    assert sample["rowCount"] == 3
    assert sum(r[1] for r in sample["rows"]) == 22


# ---------------------------------------------------------------------------
# 8. 写回 / 插行 / 冲突
# ---------------------------------------------------------------------------

def test_write_insert_below_row_mapping(tmp_path):
    path = make_book(tmp_path / "fee.xlsx", {"S": {(6, 3): "19:30", (7, 3): "20:30", (8, 3): "18:00"}})
    nodes = [
        {"id": "f", "type": "file", "data": {"fileId": "x", "sheetMode": "one", "sheet": "S",
            "rangeMode": "manual", "startCell": "C6", "endCell": "C8"}},
        {"id": "m", "type": "mapCells", "data": {"columns": "C", "op": "lastTimeLookup",
            "lookupKind": "time", "lookup": FEE_LOOKUP, "defaultResult": 3}},
        {"id": "w", "type": "write", "data": {"columns": "C", "rowMode": "insertBelow",
            "conflict": "skip", "style": "asc", "skipEmpty": True, "skipZero": True}},
        {"id": "s", "type": "save", "data": {"filename": "out.xlsx"}},
    ]
    conns = [{"from": "f", "to": "m"}, {"from": "m", "to": "w"}, {"from": "w", "to": "s"}]
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(path))
    assert result["ok"], result.get("error")
    ws = load_workbook(tmp_path / "out.xlsx").active
    assert ws["C6"].value == "19:30"
    assert ws["C7"].value == 1.5  # 源第 6 行的补贴写到插入的第 7 行
    assert ws["C8"].value == "20:30"
    assert ws["C9"].value == 2.5
    assert ws["C10"].value == "18:00"


def test_write_next_row_and_skip_zero(tmp_path):
    path = make_book(tmp_path / "pair.xlsx", {"S": {(1, 1): "19:30", (3, 1): "18:30"}})
    nodes, conns = chain("file", "mapCells", "write", "save")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    nodes[1]["data"] = {"columns": "A", "op": "lastTimeLookup", "lookupKind": "time",
                        "lookup": FEE_LOOKUP, "defaultResult": 3}
    nodes[2]["data"] = {"columns": "A", "rowMode": "next", "conflict": "skip",
                        "skipEmpty": True, "skipZero": True, "style": "keep"}
    nodes[3]["data"] = {"filename": "pair_out.xlsx"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(path))
    assert result["ok"], result.get("error")
    ws = load_workbook(tmp_path / "pair_out.xlsx").active
    assert ws["A2"].value == 1.5
    assert ws["A3"].value == "18:30"
    assert ws["A4"].value is None  # 18:30 -> 0 被跳过


def test_conflict_policy_skip_overwrite_error(simple, tmp_path):
    # 先在目标行写好已有值
    wb = load_workbook(str(simple))
    wb["S"]["C2"] = 10  # 非空即可触发冲突；值保持不变便于对比
    conflicted = tmp_path / "conflict.xlsx"
    wb.save(conflicted)

    def run_with(policy):
        nodes, conns = chain("file", "mapCells", "write", "save")
        nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S",
                            "rangeMode": "manual", "startCell": "C2", "endCell": "C3"}
        nodes[1]["data"] = {"columns": "C", "op": "multiply",
                            "factor": {"mode": "constant", "value": 2}, "zeroOnInvalid": True}
        nodes[2]["data"] = {"columns": "C", "rowMode": "same", "conflict": policy,
                            "skipEmpty": False, "style": "keep"}
        nodes[3]["data"] = {"filename": "c_%s.xlsx" % policy}
        return run(spec(nodes, conns), tmp_path, resolver=lambda x: str(conflicted))

    skipped = run_with("skip")
    assert skipped["ok"]
    assert any(c["action"] == "skip" for c in skipped["conflicts"])
    assert load_workbook(tmp_path / "c_skip.xlsx").active["C2"].value == 10

    overwritten = run_with("overwrite")
    assert overwritten["ok"]
    assert load_workbook(tmp_path / "c_overwrite.xlsx").active["C2"].value == 20

    errored = run_with("error")
    assert not errored["ok"]
    assert "中止" in errored["error"]["message"]


def test_write_style_asc(tmp_path):
    path = make_book(tmp_path / "style.xlsx", {"S": {(1, 1): 5}})
    nodes, conns = chain("file", "write", "save")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    nodes[1]["data"] = {"columns": "A", "rowMode": "same", "conflict": "overwrite", "style": "asc"}
    nodes[2]["data"] = {"filename": "styled.xlsx"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(path))
    assert result["ok"], result.get("error")
    cell = load_workbook(tmp_path / "styled.xlsx").active["A1"]
    assert cell.border.left.style == "thin"
    assert cell.alignment.horizontal == "center"
    assert cell.font.sz == 11


def test_write_formula_row_and_col(tmp_path):
    path = make_book(tmp_path / "formula.xlsx", {"S": {
        (1, 3): 1, (1, 4): 2, (2, 3): 3, (2, 4): 4,
    }})
    nodes = [
        {"id": "f", "type": "file", "data": {"fileId": "x", "sheetMode": "one", "sheet": "S",
            "rangeMode": "manual", "startCell": "C1", "endCell": "D2"}},
        {"id": "w", "type": "writeFormula", "data": {"kind": "rowSum", "columns": "C:D",
            "targetColumn": "E", "rowMode": "same", "style": "keep"}},
        {"id": "sf", "type": "writeFormula", "data": {"kind": "colSum", "columns": "C:E",
            "sumRow": "auto", "style": "keep"}},
        {"id": "s", "type": "save", "data": {"filename": "formula_out.xlsx"}},
    ]
    conns = [{"from": "f", "to": "w"}, {"from": "w", "to": "sf"}, {"from": "sf", "to": "s"}]
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(path))
    assert result["ok"], result.get("error")
    ws = load_workbook(tmp_path / "formula_out.xlsx").active
    assert ws["E1"].value == "=SUM(C1:D1)"
    assert ws["C3"].value == "=SUM(C1:C2)"


# ---------------------------------------------------------------------------
# 9. 导出 / 保存 / 试运行 / 取消
# ---------------------------------------------------------------------------

def test_export_table_with_title(simple, tmp_path):
    nodes, conns = chain("file", "aggregate", "exportTable")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto", "startCell": "A2"}
    nodes[1]["data"] = {"mode": "rows", "groupBy": "A", "valueColumns": "C", "agg": "sum"}
    nodes[2]["data"] = {"filename": "sum.xlsx", "sheetName": "汇总", "title": "工资表", "header": True, "totals": True}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple))
    assert result["ok"], result.get("error")
    ws = load_workbook(tmp_path / "sum.xlsx").active
    assert ws["A1"].value == "工资表"
    assert ws["A2"].value == "A"
    assert ws.cell(row=3, column=1).value in ("甲", "乙", "丙")


def test_dry_run_does_not_write_files(simple, tmp_path):
    nodes, conns = chain("file", "write", "save")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    nodes[1]["data"] = {"columns": "A", "rowMode": "same", "conflict": "skip"}
    nodes[2]["data"] = {"filename": "never.xlsx"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple), options={"dryRun": True})
    assert result["ok"] and result["dryRun"]
    assert not (tmp_path / "never.xlsx").exists()


def test_preview_node_stops_early(simple, tmp_path):
    nodes, conns = chain("file", "mapCells", "write", "save")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    nodes[1]["data"] = {"columns": "C", "op": "copy"}
    nodes[2]["data"] = {"columns": "A", "rowMode": "same"}
    nodes[3]["data"] = {"filename": "stop.xlsx"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple),
                 options={"previewNode": "n1"})
    assert result["ok"] and result["stopped"]
    assert "n2" not in result["nodes"]
    assert not (tmp_path / "stop.xlsx").exists()


def test_cancelled(simple, tmp_path):
    nodes, conns = chain("file", "save")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    nodes[1]["data"] = {"filename": "cancel.xlsx"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple),
                 cancelled=lambda: True)
    assert result["ok"]
    assert not (tmp_path / "cancel.xlsx").exists()


def test_progress_events(simple, tmp_path):
    events = []
    nodes, conns = chain("file", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    result = te.run_workflow(spec(nodes, conns), options={"outDir": str(tmp_path)},
                             resolver=lambda x: str(simple),
                             on_event=lambda name, payload: events.append((name, payload)))
    assert result["ok"]
    assert any(e[0] == "node_start" for e in events)
    assert any(e[0] == "node_done" for e in events)


# ---------------------------------------------------------------------------
# 10. 流程校验
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("mutate,expected", [
    (lambda s: s["nodes"].__setitem__(0, dict(s["nodes"][0], id="")), "id"),
    (lambda s: s["connections"].append({"from": "nope", "to": "n0"}), "不存在"),
    (lambda s: s["nodes"][0].update(type="unknown"), "未知节点类型"),
    (lambda s: s["nodes"].append(dict(s["nodes"][0])), "重复"),
])
def test_validation_errors(simple, tmp_path, mutate, expected):
    nodes, conns = chain("file", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    data = spec(nodes, conns)
    mutate(data)
    result = run(data, tmp_path, resolver=lambda x: str(simple))
    assert not result["ok"]
    assert expected in str(result.get("errors") or result.get("error"))


def test_validation_cycle(simple, tmp_path):
    nodes, conns = chain("file", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    conns.append({"from": "n1", "to": "n0"})
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: str(simple))
    assert not result["ok"]
    assert "循环" in result["errors"][0]["message"]


def test_validation_missing_upstream(simple, tmp_path):
    nodes, _ = chain("file", "preview")
    nodes[0]["data"] = {"fileId": "x", "sheetMode": "one", "sheet": "S", "rangeMode": "auto"}
    result = run(spec(nodes, []), tmp_path, resolver=lambda x: str(simple))
    assert not result["ok"]
    assert "上游" in str(result["errors"])


def test_missing_upload_file(tmp_path):
    nodes, conns = chain("file", "preview")
    nodes[0]["data"] = {"fileId": "missing", "sheetMode": "one", "rangeMode": "auto"}
    result = run(spec(nodes, conns), tmp_path, resolver=lambda x: os.path.join(str(tmp_path), "no.xlsx"))
    assert not result["ok"]
    assert "找不到输入文件" in result["error"]["message"]
