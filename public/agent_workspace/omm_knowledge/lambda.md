# Lambda 演算计算器（λ）产品规范

> 用途：让 AI（或任何程序）了解 OMM-ZEN“Lambda 演算计算器”（`public/index.html` +
> `public/lambda-app.py`，插件 id `lambda`，端口 8330，runtime `lambda`，Flask 后端）。
>
> 本文是 `omm_data.PRODUCTS['lambda']` 与 `json-specs/lambda.md` 的检索友好镜像；
> `omm_validators` 会校验 AI 生成的会话 / 分享 JSON。

---

## 0. 一句话规则

这个 App 能用“AI 生成的 omm-lambda-session / omm-lambda-share JSON”导入的，只有这两种格式（见 json-specs/lambda.md）。AI 不直接驱动后端：只能让用户把生成的会话/分享发到界面上。

---

## 1. AI 桥（页面侧）

`public/index.html` 暴露 `window.ZenLambdaAI`：

| 方法 | 返回 |
|---|---|
| `snapshot()` | 只读快照：`{version, app:"lambda", sessionCount, sessions:[{id, name, lang, lines}]}`（来自 GET /api/snapshots） |
| `snapshotMarkdown()` | 给模型看的紧凑摘要（会话列表 + 行数 + 语言） |

- 页面监听工作台广播的 `omm:zen-card-request`，回传 `kind: "omm.lambda.session"` 卡片（通过 `postMessage`，只接受 loopback parent origin）。
- “发送 AI 工作区”按钮把会话快照通过共享频道 `documents` 发送（`format: "omm.lambda.session"`）；共享空间不可用时导出 `lambda-sessions.json`。

---

## 2. 产品表面

| 能力 | 说明 |
|---|---|
| 纯 λ 演算 | α 等价、无捕获替换；归约轨迹；四种策略（应用序/正规序/按名调用/按值调用） |
| 归约分析 | 正规形与 whnf、redex 矩阵、α/β/η 等价判断与证明、策略/步数/统计/计时/基准 |
| 简单类型 | Hindley–Milner 推断：let 多态、`(expr : T)` 标注，`:type` 给出 Curry–Howard 命题推导 |
| 教材库 | 预定义环境（ZERO–Y、PAIR/FST/SND 等）；`lib/prelude.lam`、`lib/scott.lam`（含 Church↔Scott 互转） |
| 计算器 API | POST /api/eval、/api/race、/api/eval/stream；GET /api/snapshots 列会话；GET /api/gallery 策展示例 |
| 会话 | 会话编辑器本地持久化，回放可恢复/重命名/删除 |

---

## 3. 后端约束

- 解释器二进制：`public/extension.exe`（按 `LAMBDA_INTERP_BIN` 解析）。缺失时 GET /api/health 返回 `available: false`，POST /api/eval 返回 500。
- 步数上限：`:steps` 默认 10000；非终止项被自动停止并给出提示。
- 写入受限：`:load`/`:save` 限 .lam 非隐藏路径；`:save` 默认关闭（`LAMBDA_ALLOW_SAVE`）。
- 会话存储：GET /api/snapshots → `{snapshots: [{id, name?, lines, lang, used}]}`（20 行上限、TTL 回收）。

---

## 4. 示例请求

- “帮我写一个 Church 图灵对（TRUE / FALSE）并给出 λ 项”
- “给邱奇数 3 乘以 2 的表达式并算出正规形”
- “分析这段 λ 项：归约轨迹、步数、统计”

---

## 5. 常见坑

- 解释器缺失：/api/health 的 available 为 false → /api/eval 500；先检查 extension.exe。
- 非终止项：不要生成无界项再等待；AI 不要把描述当成执行结果。
- AI 给出的归约/统计只作解释建议，最终评估结果应以用户实际运行为准。
