# ZenMark 项目备份 JSON 规范（`zenmark-project.json`）

> 适用：`omm-annotate.html`（OMM Annotate / ZenMark）。
>
> 用途：AI 或程序生成可整体替换当前项目的备份。导入前会确认；只有严格校验和
> localStorage 提交都成功，内存工程才会被替换。

## 0. 文件外壳与导入判据

```json
{
  "app": "zenmark",
  "version": 1,
  "exportedAt": "2026-11-24 12:00",
  "project": {}
}
```

- `project` 是数据容器；也允许把 `project` 的字段直接放在顶层。
- `app`、`version`、`exportedAt` 仅为人读元数据，当前不参与校验；建议保留。
- 顶层 `omm:"bridge"` 会走互通包追加分支，**不是项目备份**。生成备份时不要写它。
- `project` 必须是对象，且下列九个数组字段全部存在，缺一个即拒绝：
  `docs`、`codes`、`anns`、`rels`、`memos`、`marks`、`notes`、`cellCodes`、`reliability`。
- 空数组合法。导入永远是整体替换，不是合并。

## 1. 通用规则

### 1.1 id

所有对象必须有 `id`，且满足对应前缀与小写字母数字规则：

| 数组 | 前缀 | 正则 |
|---|---|---|
| `docs` | `d` | `^d[a-z0-9]+$` |
| `codes` | `c` | `^c[a-z0-9]+$` |
| `anns` | `a` | `^a[a-z0-9]+$` |
| `rels` | `r` | `^r[a-z0-9]+$` |
| `memos` | `m` | `^m[a-z0-9]+$` |
| `marks` | `k` | `^k[a-z0-9]+$` |
| `notes` | `n` | `^n[a-z0-9]+$` |
| `cellCodes` | `tc` | `^tc[a-z0-9]+$` |
| `reliability` | `rl` | `^rl[a-z0-9]+$` |

id 在**整个项目中全局唯一**，不只在各数组内唯一。不要使用大写、连字符、空格、
引号、HTML 或 CSS 特殊字符。引用字段必须指向同文件内真实存在的 id。

### 1.2 文本与时间

- 文本字段必须是字符串；未知字段会被丢弃。
- `ts` 建议使用 `YYYY-MM-DD HH:mm`，当前只校验类型，不解析时间格式。
- 可选布尔字段只能是 `true` / `false`。
- `status` 只能为 `done` / `review`；缺省按已确认处理。

## 2. `project` 对象

```json
{
  "title": "研究项目",
  "desc": "项目说明",
  "docs": [],
  "codes": [],
  "anns": [],
  "rels": [],
  "memos": [],
  "marks": [],
  "notes": [],
  "cellCodes": [],
  "reliability": []
}
```

`title` 缺省或非字符串时使用“未命名研究项目”；`desc` 缺省或非字符串时使用空串。
九个数组缺一不可，元素必须是对象。

## 3. `docs[]` 材料

```json
{
  "id": "d1",
  "title": "访谈记录",
  "source": "深度访谈",
  "type": "访谈转录",
  "date": "2026-11-24",
  "note": "备注",
  "text": "第一段\n第二段",
  "kind": "text"
}
```

- `id`、`title` 必须是非空字符串；`text` 必须是字符串。
- `source`、`type`、`date`、`note` 可缺省，给了就必须是字符串。
- `kind` 缺省补 `text`，合法值为 `text`、`pdf`、`table`。
- `text` / `pdf` 的正文是纯文本；编码和批注使用 UTF-16 字符下标。
- `pdf` 的原始字节和版面只在本机 IndexedDB，不在 JSON 中。备份可保留 pdf 元数据，
  换设备后需重新导入原 PDF。
- `table` 必须另有 `columns`（非空字符串数组）和 `rowCount`（非负整数）；
  表格原文在本机 IndexedDB，换设备后需重新导入列名一致的 CSV。

## 4. `codes[]` 码表

```json
{
  "id": "c1",
  "no": "01",
  "name": "情感动员",
  "level": "open",
  "parent": "",
  "def": "定义",
  "incl": "纳入标准",
  "excl": "排除标准",
  "eg": "例证",
  "color": "#e0913b",
  "memo": "备注"
}
```

- `id`、`no`、`name` 必须是非空字符串。
- `level` 必须为 `open` / `axial` / `selective`。
- `parent` 必须是空串或同文件真实 code id；不能自引用，也不能形成循环。
- `def`、`incl`、`excl`、`eg`、`memo`、`color` 可缺省，给了必须是字符串。
- `color` 不在下列色板时，导入会按数组下标自动改色：
  `#4a86d4 #3aa6a0 #5aa45a #d7b13e #e0913b #cf5b54 #c76b9e #8f74c4 #5b6fc4 #9c7a52 #6b7a8f #8a8f98`。

## 5. `anns[]` 编码片段

```json
{
  "id": "a1",
  "doc": "d1",
  "start": 0,
  "end": 2,
  "quote": "第一",
  "code": "c1",
  "memo": "",
  "status": "done",
  "star": false,
  "ts": "2026-11-24 12:00"
}
```

- `doc` 必须指向真实材料，`code` 必须指向真实码号。
- `start` / `end` 必须是整数，满足 `0 <= start < end <= doc.text.length`。
- `quote` 必须**严格等于** `doc.text.slice(start, end)`，不一致即拒绝。
- `memo`、`ts` 可缺省；`status`、`star` 给了必须合法。

## 6. `rels[]` 片段关联

```json
{ "id": "r1", "a": "a1", "b": "a2", "type": "因果" }
```

- `a` / `b` 必须指向真实 ann id，且不能相同。
- `type` 必填，只能为：`因果`、`对立`、`递进`、`例证`、`条件`、`并列`。

## 7. `memos[]` 备忘录

```json
{ "id": "m1", "title": "备忘", "type": "理论备忘录", "body": "正文", "codes": ["c1"], "ts": "2026-11-24 12:00" }
```

- `id`、`title` 必须是非空字符串；`type`、`body`、`ts` 可缺省。
- `codes` 必须是数组，每个元素都必须是真实 code id。

## 8. `marks[]` 阅读批注

```json
{
  "id": "k1",
  "doc": "d1",
  "start": 0,
  "end": 2,
  "quote": "第一",
  "sty": "hl",
  "color": "#f6dd8a",
  "text": "旁注",
  "status": "done",
  "star": false,
  "ts": "2026-11-24 12:00"
}
```

- `doc` 必须指向真实材料；范围规则同 `anns`。
- `quote` 必须严格等于文本切片。
- `sty` 缺省为 `hl`，合法值：`note`、`hl`、`ul`、`st`、`code`。
- `color` 可缺省（默认 `#f6dd8a`）；给了必须是 `#rgb` 或 `#rrggbb`。
- `text`、`ts` 可缺省；`status`、`star` 给了必须合法。

## 9. `notes[]` 学习笔记

```json
{
  "id": "n1",
  "kind": "sentence",
  "en": "原文",
  "zh": "译文",
  "phon": "",
  "ex": "",
  "exZh": "",
  "note": "",
  "tags": ["观点"],
  "doc": "d1",
  "src": "访谈记录",
  "start": 0,
  "end": 2,
  "ts": "2026-11-24 12:00"
}
```

- `id`、`en` 必须是非空字符串。
- `kind` 必须为 `word` / `sentence` / `template` / `phrase`。
- `tags` 必须是字符串数组。
- `start` / `end` 必须是整数。有 `doc` 时，范围规则同 `anns`；无 `doc` 时必须均为 `-1`。
- `zh`、`phon`、`ex`、`exZh`、`note`、`src`、`ts` 可缺省。

## 10. `cellCodes[]` 表格行编码

```json
{ "id": "tc1", "table": "d2", "row": 0, "col": "情感", "code": "c1", "round": 1, "memo": "", "status": "done", "star": false, "ts": "2026-11-24 12:00" }
```

- `table` 必须指向 `kind:"table"` 的材料，`code` 必须指向真实码号。
- `row` 是 0 基非负整数，且小于 `doc.rowCount`。
- `col` 必须逐字属于 `doc.columns`。
- `round` 缺省为 `1`，给了必须是正整数。
- `memo`、`ts` 可缺省；`status`、`star` 给了必须合法。

## 11. `reliability[]` 编码者信度

```json
{
  "id": "rl1",
  "ts": "2026-11-24 12:00",
  "source": "text",
  "round": 1,
  "col": "",
  "stat": { "N": 2, "po": 0.5, "pe": 0.5, "kappa": 0 },
  "multi": 0,
  "jaccard": null,
  "unmatched": 0,
  "missing": 0,
  "disagreements": [{ "k": "a1", "a": "c1", "b": "c2" }]
}
```

- `source` 必须为 `text` / `table`；`round` 必须是正整数。
- `unmatched`、`missing`、`multi` 必须是非负整数。
- `jaccard` 可为 `null` 或 0–1 数值。
- `stat` 可为 `null` 或对象；对象中 `N` 为非负整数，`po` / `pe` 为 0–1，`kappa` 为 -1–1。
- `disagreements` 必须是数组；`a` / `b` 必须是真实 code id。
  `source:"text"` 时 `k` 必须是真实 ann id；`source:"table"` 时 `k` 必须是非负行号字符串，
  且 `col` 必须属于某份表格、行号不越界。
- `ts`、`col` 可缺省。

## 12. 最小可用示例

```json
{
  "app": "zenmark",
  "version": 1,
  "project": {
    "title": "最小示例",
    "desc": "",
    "docs": [{ "id": "d1", "title": "材料", "text": "abcdef", "kind": "text" }],
    "codes": [{ "id": "c1", "no": "01", "name": "主题", "level": "open", "parent": "" }],
    "anns": [{ "id": "a1", "doc": "d1", "start": 0, "end": 2, "quote": "ab", "code": "c1" }],
    "rels": [],
    "memos": [],
    "marks": [],
    "notes": [],
    "cellCodes": [],
    "reliability": []
  }
}
```

## 13. 原子提交与失败行为

1. 先完整校验并克隆候选项目；任何字段错误都不改动当前工程。
2. 用户确认后，先写 localStorage；写入失败时当前工程保持不变。
3. localStorage 成功后，内存工程才整体替换，随后重绘界面。
4. 删除材料、清空项目、PDF 转纯文本等破坏操作，只有元数据提交成功后才删除
   IndexedDB 中的原始文件；保存失败则回滚内存状态并保留文件。
5. CSV 导出统一调用 `ZenCSV.stringify(rows, ',', { formulaSafe: true })`，由共享编解码器
   对 `=`、`+`、`-`（非数字）、`@` 及前导 TAB/CR 等公式前缀加单引号，防止电子表格公式注入。
