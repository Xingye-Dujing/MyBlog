# ZenRedact 文件格式与持久化说明（`omm-redact.html`）

> 用途：说明 ZenRedact 接受的文档、导出产物、界面设置与遮罩工程的实际落点。
> 本产品**不接受 JSON 工程文件导入**，也没有“导出 JSON”入口。

## 0. 输入与输出

### 输入

- 文档：`.txt`、`.docx`、`.pdf`、`.pptx`。
- 图片：单独的图片/图片文件夹入口，支持多张图片，内部整理为 PDF。
- `.json` 不是文档输入，会被拒绝。

### 输出

- PDF（保留文字层）。
- 图片 ZIP。
- PPTX（逐页位图）。
- 不可逆脱敏 PDF。
- 不可逆脱敏 DOCX（逐页位图）。

没有机器可读的遮罩清单或工程 JSON 导出。

## 1. 界面设置：localStorage

键名：`zr-settings`。由 `saveSettings()` 写、`loadSettings()` 读，解析失败静默使用默认值。

```json
{
  "theme": "light",
  "bg": "bg-void",
  "tool": "rect",
  "pinned": true,
  "radius": 0,
  "sidebarCollapsed": false,
  "sidebarW": 270,
  "rightSidebarCollapsed": false,
  "rightSidebarW": 270,
  "redactStyle": { "color": "#000000", "radius": 0, "opacity": 100 },
  "sensitiveWords": ["张三", "身份证"],
  "imageNavEnabled": true,
  "pdfImageLargeFilter": true,
  "pdfImageLargeRatio": 0.9,
  "docxRenderMode": "native",
  "docxImportMode": "ask",
  "docxPdfEngine": ""
}
```

主要容错：

- `theme` 只有 `dark` 走深色，其余浅色。
- `bg` 使用 `bg-void` / `bg-grid` / `bg-dots` / `bg-diagonal`。
- `tool` 使用 `rect` / `select` / `move` / `eraser`。
- `redactStyle.opacity` 夹到 10–100；100 为永久脱敏，小于 100 为半透明高亮。
- `pdfImageLargeRatio` 夹到 0.5–0.95。
- `sensitiveWords` 必须是数组，导入时逐项转字符串、 trim、滤空。

这份 JSON 只能由用户手动写入 localStorage 后刷新，不是可导入文件。

## 2. 遮罩工程：IndexedDB

数据库：`zenredact-projects`（version 1）

对象仓库：`projects`

主键：文件指纹 `fingerprint`

### 2.1 文件指纹

`fileFingerprint(file)` 优先使用 Web Crypto SHA-256；输入包含：

- 文件名、字节数、MIME、lastModified；
- 文件头、中段、尾段各最多 64 KiB 的字节。

Web Crypto 或 File 分片不可用时退回 `ZenUtil.fingerprint(元数据)`。
指纹只用于遮罩工程键，不读取或修改磁盘上的原文件。

### 2.2 记录结构

```json
{
  "version": 1,
  "fingerprint": "sha256-hex",
  "fileName": "report.docx",
  "fileSize": 204800,
  "fileType": "docx",
  "redacts": [],
  "undoStack": [],
  "redoStack": [],
  "redactIdCounter": 12,
  "updatedAt": 1760000000000
}
```

单条遮罩：

```json
{
  "id": "r1",
  "pageIdx": 0,
  "nx1": 0.1,
  "ny1": 0.2,
  "nx2": 0.55,
  "ny2": 0.28,
  "type": "rect",
  "wordMatch": null,
  "applied": true,
  "timestamp": 1760000000000,
  "style": { "color": "#000000", "radius": 0, "opacity": 100 }
}
```

约束：

- `id` 为 `r` + 正整数，工程内唯一。
- `pageIdx` 为非负整数；坐标是相对该页内容盒的 0–1 比例。
- `nx1 < nx2`、`ny1 < ny2`。
- `style.color` 为 `#rrggbb`；`radius` 为 0–24；`opacity` 为 10–100。
- 撤销/重做栈保存 `JSON.stringify(redacts)`，各最多 `CONFIG.UNDO_LIMIT`（80）条。
- 遮罩变更后 250ms 防抖保存；切到后台或离开页面时立即冲刷。

## 3. 新文件两阶段加载

1. **准备阶段**：先冲刷旧工程遮罩；若保存失败则取消切换。计算新文件指纹并读取
   IndexedDB 中对应记录，此时不破坏旧工程。
2. **暂存阶段**：清空暂存遮罩/历史，解析新文档。解析中的 DOM、PDF、DOCX 资源都是新资源。
3. **提交阶段**：解析成功且加载令牌仍最新，才释放旧资源、应用新文件元数据并恢复匹配的遮罩。
4. **回滚阶段**：用户取消 DOCX 导入、解析失败或加载被更新任务取代时，释放新资源，
   恢复旧状态、旧 DOM、旧滚动位置和旧遮罩工程。

因此取消新文件不会丢掉旧工程；只有新文件成功提交后，旧资源才被释放。

## 4. DOCX HTML 安全

- Mammoth 生成的 HTML 在写入 `S.docxHtml` 前经过 `ZenHTML.sanitize()`。
- docx-preview 原生渲染后的 body 也经过 `ZenHTML.sanitizeNode()`。
- 文档预览策略清除事件属性、脚本、外链 href 和远程图片 src；只保留渲染器生成的
  `blob:` 图片或 `data:image/*;base64,...` 图片。
- docx-preview 生成的样式表会移除 `@import`、`url(...)`、`expression(...)`、
  `behavior` 和 `-moz-binding`，避免文档样式触发网络请求或执行代码。

## 5. 遮罩与导出

- `applied:false`：虚线预览，不进入最终导出。
- `applied:true` 且 `opacity:100`：永久脱敏，导出时移除原文。
- `applied:true` 且 `opacity < 100`：高亮，导出保留原文并叠加半透明色块。
- 清除全部遮罩会保留撤销栈，可 Ctrl/Cmd+Z 恢复。
- 改变原生 DOCX 分页方式或渲染引擎会使旧归一化坐标失效，产品会提示并清空该文件的遮罩。

## 6. 行为速查

| 情况 | 结果 |
|---|---|
| 拖入/选择 `.json` | 拒绝，仅支持 TXT/DOCX/PDF/PPTX |
| 重新打开同一文件 | 按指纹恢复遮罩、撤销/重做栈与 id 计数器 |
| 打开新文件时取消 | 保留旧工程、旧文档与旧遮罩 |
| 新文件解析失败 | 回滚旧工程，不释放旧资源 |
| 修改遮罩 | 防抖写入 IndexedDB |
| IndexedDB 不可用 | 当前内存遮罩仍可编辑，但会提示保存失败 |
| 清除全部遮罩 | 写入空工程， undo 仍可恢复 |
| 导出 JSON 工程 | 不支持 |
