# 视频工作台（视）产品规范

> 用途：让 AI（或任何程序）了解 OMM-ZEN“视频工作台”（`omm-video.html`）的节点库、
> 运行约束与 AI 工作区集成方式。
>
> 本文是 `omm_data.PRODUCTS['video']` 与 `json-specs/video.md` 的检索友好镜像；
> `omm_validators` 会校验 AI 生成的工作流 JSON（format 必须为 `omm-video-workflow`）。

---

## 0. 一句话规则

这个 App 能用“AI 生成的工作流 JSON”导入的只有一种格式：`format: "omm-video-workflow"`。
节点语义由后端 `video-serve.py` 的 `build_args` 逐个翻译成 ffmpeg 参数。
画布本身（节点的 x/y 位置、布局）AI 不需要关心；AI 只生成 `nodes[].type`、`data` 与连线。

---

## 1. AI 工作区集成（页面侧）

`omm-video.js` 暴露 `window.ZenVideoAI`：

| 方法 | 返回 |
|---|---|
| `snapshot()` | 只读快照：`{version, app:"video", nodeCount, connectionCount, nodes:[{id,type,title,summary,data}], connections:[{from,to,fromPort,toPort}], output:[...]}` |
| `snapshotMarkdown()` | 给模型看的紧凑摘要（节点列表 + 连线链） |
| `workflowSpec()` | 当前画布的工作流 JSON（`omm-video-workflow` 格式） |

- 工作台响应工作台广播的 `omm:zen-card-request`，回传 `kind: "omm.video.workflow"` 的卡片（通过 `postMessage`，只接受 loopback parent origin）。
- “发送 AI 工作区”通过共享频道 `documents` 发送（`format: "omm.video.workflow"`）；共享空间不可用时导出 `video-workflow.json`。

---

## 2. 节点库（`json-specs/video.md` 同步清单）

| op | 节点名 | data 默认值 | 备注 |
|---|---|---|---|
| `input` | 视频输入 | `{fileId:"", filename:""}` | 必须先导入文件，否则运行被拦截 |
| `probe` | 媒体信息 | `{}` | 不改内容；可不连线运行；返回 duration / width×height / fps / 音频 |
| `scene` | 场景检测 | `{threshold:0.3}` | threshold 范围 0.05–1，越小越敏感 |
| `silence` | 静音检测 | `{noise:"-40dB", duration:0.5}` | 门限 / 最短时长 |
| `black` | 黑场检测 | `{duration:0.5}` | 最短黑场 |
| `thumbnail` | 批量缩略图 | `{interval:5, count:8}` | interval 每隔几秒（0.2–60）、count 最多张数（1–30） |
| `trim` | 片段裁剪 | `{start:0, duration:10}` | 0 表示一直到结尾 |
| `crop` | 画面裁切 | `{w:0, h:0, x:0, y:0}` | 0 = 保持原值 |
| `scale` | 尺寸缩放 | `{w:1280, h:720, fit:"contain"}` | `fit`：contain（补边）/ stretch |
| `rotate` | 旋转与翻转 | `{degrees:0, hflip:false, vflip:false}` | degrees 取 0/90/180/270 |
| `speed` | 播放速度 | `{factor:1}` | 0.25–4；音频同步调速 |
| `volume` | 音量调整 | `{factor:1}` | 0–4 |
| `mute` | 去除音轨 | `{}` | 全部音频 |
| `fade` | 淡入淡出 | `{type:"in", start:0, duration:1}` | type：in/out |
| `drawtext` | 叠加文字 | `{text:"OMM-ZEN", fontsize:28, color:"white", x:"(w-text_w)/2", y:"(h-text_h)/2"}` | 文本/颜色按 ffmpeg 写法 |
| `audio` | 提取音频 | `{format:"mp3"}` | mp3/m4a |
| `concat` | 视频拼接 | `{}` | 至少连接 2 个上游节点（多输入拼接） |
| `format` | 编码与格式 | `{format:"mp4", crf:23, preset:"medium"}` | 容器 mp4/mkv/webm/mov/gif |
| `export` | 导出文件 | `{filename:"output.mp4", format:"mp4"}` | 终点节点 |

---

## 3. 运行约束

- “视频输入”节点必须有 `fileId`；文件随任务上传到本地工作区，不支持直接本地路径。
- 画布为空（无节点）或没有 `input` 节点带文件时，运行会被拦截并提示。
- `probe` 不接输入即可运行；其他节点必须有上游输入。
- 分析节点（probe/scene/silence/black/thumbnail）透传原视频，不改内容；可并联在输入之后。
- 所有处理节点都有默认值，直接运行也可以；但给“视频输入”导入文件是运行链的实际要求。
- 后端未连接（无内置 ffmpeg）时媒体信息与执行结果不可用；健康栏“ffmpeg”徽标见状态。
- 运行进度与状态实时轮询（600ms 一次）；失败有红色错误文案与 `log`。

---

## 4. 示例工作流（开箱即用）

- **基础剪辑**：`input → trim → format → export`
- **媒体分析**：`input` 端口扇出到 `probe` / `scene` / `silence` / `black` / `thumbnail`
- **缩略图与 GIF**：`input → trim → thumbnail → format → export`

---

## 5. 给 AI 的提示词模板

把下面这段连同本文一起发给 AI，让它产出可导入的 `.json`：

```text
你要生成一个 OMM-ZEN 视频工作台（omm-video.html）的工作流 JSON 文件（UTF-8）。

硬性要求：
1. 顶层必须是 { "format": "omm-video-workflow", "version": 1, "nodes": [...], "connections": [...] }。
2. nodes[] 里每个 { "id": "唯一短串", "type": "<节点op>", "data": {...} }；data 用本文清单里的默认值，
   只改需要改的字段，不要另造字段；字段类型与默认值同型。
3. connections[] 里每个 { "from": <上游节点id>, "to": <下游节点id>, "fromPort": "right", "toPort": "left" }。
   非 input / probe 节点必须连到至少一个上游；分析节点透传，不必为它们再连线。
4. 没有文件可导入（AI 无法上传文件）：生成 `input` 节点但 `fileId` 留空，由用户在工作台里导入后手动运行。
5. 画布位置（x/y）由工作台自动排布，不要生成不存在的字段。
6. 只输出 JSON 本身，不要 markdown 代码块围栏、不要注释、不要尾逗号。

目标：把需求翻译成节点链（如“去重复镜头”→ scene 检测 + trim；“加字幕”→ drawtext；
“导出全屏gif”→ format(gif)+export）。默认链：input → (处理节点) → format → export。
```

---

## 6. 常见坑

- 没有导入文件：`input` 的 `fileId` 为空会被拦截，提示“请先给“视频输入”节点选择文件”。
- 非 `probe` 节点没有上游：报“没有上游输入”；记得先连一条线。
- `drawtext` 的 `text`/`x`/`y`/`color` 按 ffmpeg 表达式写（如 `x` 不要写成普通文字）。
- 批量缩略图最多 30 张；`interval` 小会产生很多图，需要用户复核。
- `concat` 必须从多个 `input` 分支接入，不能直接只连一条。
- 后端未连接时，媒体信息为空；不要编造时长/分辨率。
