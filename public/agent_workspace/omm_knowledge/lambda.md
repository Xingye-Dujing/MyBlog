# Lambda 演算计算器工作区格式规范

> 用途：让 AI（或任何程序）**直接生成可被 Lambda 演算计算器导入的 JSON**。
> 产品：`public/index.html`（插件 id `lambda`，端口 8330，runtime `lambda`）。
>
> 本文与 `agent_workspace/omm_knowledge/lambda.md` 互补：后者面向 AI 检索，本文是格式合约（字段/默认值/约束），由 `json-specs/format-registry.json` 的 lambda 条目声明，并由 `agent_workspace.omm_validators` 校验。

---

## 0. 产品表面（AI 的生成目标）

界面侧可消费的两种 JSON：

1. **会话快照**（`omm-lambda-session`）—— 用户会话/回放历史的结构化描述，AI 生成时让用户确认后由用户在界面应用。
2. **分享链接**（`omm-lambda-share`）—— “分享”按钮生成的静态公开渲染页 id。AI 一般不生成，除非用户明确要求分享。

常见 AI 任务通常是生成 λ 项/统计/评估结论让用户在界面里运行，而不是产出文件。

---

## 1. 会话快照格式（`omm-lambda-session`）

```json
{
  "format": "omm-lambda-session",
  "version": 1,
  "sid": "l-sess-0001",
  "name": "示例会话",
  "lang": "both",
  "code": ["?num = 3", "PLUS ONE TWO"]
}
```

| 字段 | 必需 | 校验 / 缺省行为 |
|---|---|---|
| `format` | 是 | 必须等于 `"omm-lambda-session"`（硬校验） |
| `version` | 是 | 必须是数字 `1`（硬校验） |
| `sid` | 是 | 非空字符串（深度校验）；一般取已保存会话的真实 id（GET /api/snapshots） |
| `code` | 是 | 非空数组，元素均为字符串（深度校验）；回放历史，按时间顺序排列，≤ 20 行 |
| `name` | 否 | 字符串（≤ 80 字符）；缺省用 sid 前 8 位 |
| `lang` | 否 | `"zh" / "en" / "both"`；缺省 `"both"` |

给 AI 的提示词模板：

```text
你要生成一个 Lambda 演算计算器（public/index.html）的会话快照 JSON 文件（UTF-8）。

硬性要求：
1. 顶层必须是 { "format": "omm-lambda-session", "version": 1, "sid": "...", "code": [...] }。
2. sid 必须是现有已保存会话的 id（GET /api/snapshots 可查），不要自造；code 是该会话的回放历史，每行一个 λ 表达式或 :-命令。
3. name ≤ 80 字符；lang ∈ zh/en/both。
4. 只输出 JSON 本身，不要 markdown 代码块围栏、不要注释、不要尾随逗号。
```

---

## 2. 分享格式（`omm-lambda-share`）

```json
{
  "format": "omm-lambda-share",
  "version": 1,
  "id": "ab12cd34ef"
}
```

| 字段 | 必需 | 校验 |
|---|---|---|
| `format` | 是 | 必须等于 `"omm-lambda-share"`（硬校验） |
| `version` | 是 | 必须是数字 `1`（硬校验） |
| `id` | 是 | 非空字符串（深度校验）；一般取界面 POST /api/share 返回的 10 位 hex |

警告：分享页是公开静态渲染，AI 一般不生成，除非用户明确要求。

---

## 3. 常见误区

- 不要把一句口头描述当成 `omm-lambda-session` 落库；只在用户确认后生成。
- `code` 元素按回放顺序排列，用户继续操作会追加，不要丢已有行。
- `sid` 必须是界面生成的（POST /api/session 返回或 GET /api/snapshots 中的 id），不要编造。
