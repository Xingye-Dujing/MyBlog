# 视频工作台（omm-video.html）工作流 JSON 规范

> 用途：让 AI（或任何程序）**直接生成可被视频工作台导入的 JSON**。
> 视频工作台是 `omm-video.html`（OMM-ZEN 视频工作台，端口 8329，节点工作流 + 内置轻量 ffmpeg）。
>
> 本文与 `agent_workspace/omm_knowledge/video.md` 互补：后者面向 AI 检索，
> 本文是格式合约（字段/默认值/约束），由 `json-specs/format-registry.json` 的 video 条目声明为
> `format: "omm-video-workflow"`，并由 `agent_workspace.omm_validators` 校验。

---

## 0. 文件外壳

```json
{
  "format": "omm-video-workflow",
  "version": 1,
  "nodes": [
    { "id": "n1", "type": "input", "data": { "fileId": "", "filename": "" } }
  ],
  "connections": [
    { "from": "n1", "to": "n2", "fromPort": "right", "toPort": "left" }
  ]
}
```

| 字段 | 必需 | 校验 / 缺省行为 |
|---|---|---|
| `format` | 是 | 必须等于 `"omm-video-workflow"`（硬校验） |
| `version` | 是 | 必须是数字 `1`（硬校验） |
| `nodes` | 是 | 顶层数组；`omm-video.js` 导出时非空（画布为空没有意义）；每个节点合法（下表） |
| `connections` | 是 | 顶层数组；可空；每个连线合法（下表）；`from` / `to` 必须指向 `nodes` 里存在的 `id`（深度校验） |

**节点对象**（`nodes[]`）：`id` 全局唯一、非空（深度校验）；`type` 必需，是节点 op；`data` 必需，是对象，字段默认值见下表。

**连线对象**（`connections[]`）：`from` / `to` 必需且非空（深度校验），指向已存在的节点 id；
`fromPort` 默认 `"right"`、`toPort` 默认 `"left"`（与 zen/canvas 连线约定一致）。

---

## 1. 节点库（op → data 默认值）

| op | 名称 | data 默认 | 说明 |
|---|---|---|---|
| `input` | 视频输入 | `{fileId:"", filename:""}` | 必须有文件，否则运行被拦截 |
| `probe` | 媒体信息 | `{}` | 不改内容；可不连线运行 |
| `scene` | 场景检测 | `{threshold:0.3}` | `threshold` 0.05–1 |
| `silence` | 静音检测 | `{noise:"-40dB", duration:0.5}` | |
| `black` | 黑场检测 | `{duration:0.5}` | |
| `thumbnail` | 批量缩略图 | `{interval:5, count:8}` | `interval` 0.2–60，`count` 1–30 |
| `trim` | 片段裁剪 | `{start:0, duration:10}` | 0 表示至结尾 |
| `crop` | 画面裁切 | `{w:0, h:0, x:0, y:0}` | 0 = 保持原值 |
| `scale` | 尺寸缩放 | `{w:1280, h:720, fit:"contain"}` | `fit` ∈ contain / stretch |
| `rotate` | 旋转与翻转 | `{degrees:0, hflip:false, vflip:false}` | `degrees` ∈ 0/90/180/270 |
| `speed` | 播放速度 | `{factor:1}` | 0.25–4 |
| `volume` | 音量调整 | `{factor:1}` | 0–4 |
| `mute` | 去除音轨 | `{}` | |
| `fade` | 淡入淡出 | `{type:"in", start:0, duration:1}` | `type` ∈ in / out |
| `drawtext` | 叠加文字 | `{text:"OMM-ZEN", fontsize:28, color:"white", x:"(w-text_w)/2", y:"(h-text_h)/2"}` | 文本/颜色/坐标按 ffmpeg 写法 |
| `audio` | 提取音频 | `{format:"mp3"}` | mp3 / m4a |
| `concat` | 视频拼接 | `{}` | 至少连接 2 个上游节点 |
| `format` | 编码与格式 | `{format:"mp4", crf:23, preset:"medium"}` | `format` ∈ mp4/mkv/webm/mov/gif |
| `export` | 导出文件 | `{filename:"output.mp4", format:"mp4"}` | 产物在任务输出目录，可预览下载 |

---

## 2. 运行约束

- 画布为空（无节点）或没有带文件的 `input`：运行被拦截（`请先给“视频输入”节点选择文件`）。
- 非 `input` / `probe` 的节点必须有上游，否则报“没有上游输入”。
- 分析节点透传原视频，不改内容；`concat` 通过多个 `input` 分支拼接。
- 所有处理节点都有默认值，链 `input → (处理节点) → format → export` 可直接运行。
- 后端未连接（无内置 ffmpeg）：媒体信息与执行结果不可用；AI 不要编造时长/分辨率。

---

## 3. 最小示例（基础剪辑）

```json
{
  "format": "omm-video-workflow",
  "version": 1,
  "nodes": [
    { "id": "input-1", "type": "input", "data": { "fileId": "", "filename": "" } },
    { "id": "trim-1", "type": "trim", "data": { "start": 0, "duration": 10 } },
    { "id": "format-1", "type": "format", "data": { "format": "mp4", "crf": 23, "preset": "medium" } },
    { "id": "export-1", "type": "export", "data": { "filename": "output.mp4", "format": "mp4" } }
  ],
  "connections": [
    { "from": "input-1", "to": "trim-1", "fromPort": "right", "toPort": "left" },
    { "from": "trim-1", "to": "format-1", "fromPort": "right", "toPort": "left" },
    { "from": "format-1", "to": "export-1", "fromPort": "right", "toPort": "left" }
  ]
}
```

---

## 4. 给 AI 的提示词模板

```text
你要生成一个 OMM-ZEN 视频工作台（omm-video.html）的工作流 JSON 文件（UTF-8）。

硬性要求：
1. 顶层必须是 { "format": "omm-video-workflow", "version": 1, "nodes": [...], "connections": [...] }。
2. nodes[] 里每个 { "id": "唯一短串", "type": "<节点op>", "data": {...} }；data 只写本文给出的
   默认值中要改的字段，字段类型与默认值同型；不要另造字段。
3. connections[] 里每个 { "from": <上游id>, "to": <下游id>, "fromPort": "right", "toPort": "left" }。
   非 input/probe 节点必须连到至少一个上游；分析节点透传，不必为它们再连线。
4. `input` 的 fileId 留空（AI 无法上传文件），由用户在工作台里导入后手动运行。
5. 只输出 JSON 本身，不要 markdown 代码块围栏、不要注释、不要尾逗号。

目标：把需求翻译成节点链（如“去重复镜头”→ scene + trim；“加字幕”→ drawtext；
“导出全屏gif”→ format(gif)+export）。默认链：input → (处理节点) → format → export。
```
