# OMM-ZEN 导入格式生成与代码校验

AI 不要自己写校验逻辑，也不要凭记忆编造导入文件结构。工作区提供三个工具：

1. `omm_format_list(product?)` — 列出产品支持的导入/导出格式 `kind`。省略 product 时列出全部 19 个入口（18 个产品 + 静书房）。
2. `omm_format_template(product, kind?)` — 返回可直接填充的空白模板（JSON / TeX / Markdown / CSV）。不指定 kind 时返回该产品全部模板。
3. `omm_format_validate(product, content, kind?)` — 用各产品真实解析规则校验生成内容，返回 `{ok, kind, errors[], warnings[]}`。错误形如 `路径: 原因`，修正后重新校验直到 `ok=true`。

## 强制工作流

- 先 `omm_format_list` 确认格式，再 `omm_format_template` 取骨架；
- 按骨架填充后调用 `omm_format_validate`；有 errors 就逐条修，warnings 尽量处理；
- 只有 `ok=true` 的内容才能作为产物交付；输出纯文本/JSON，不包代码围栏、不加注释或尾随逗号。

## 校验器覆盖的硬约束（与产品源码一致）

- **文本标注**：`project.codes[]` 必填；id 全局唯一；`anns[].quote === docs[].text.slice(start,end)`；引用指向真实 id；时间字符串格式。
- **语料库**：`entries[]` 与 `categories[]` 同时存在；`en` 非空；`categoryId` 指向真实分类。
- **数据工作台**：行对象数组 / 二维数组 / `{rows:[]}`；拒绝 `{tables:[]}` 整库结构；CSV 列数一致。
- **六级备考**：四类导入 A 词库 / B 涂鸦 / C 完整备份 / D 桥接；涂鸦坐标 x∈[0,1200]、y∈[0,800]、p∈[0.15,1] 且键小写；备份须同时有 `books` 与 `prog`。
- **LaTeX**：完整单文件；`\documentclass` 与 `document` 环境成对；禁止 `\input`/`\include`/`\write18`/`\usepackage`。
- **MDFORGE**：frontmatter 有 `title` 与 `template: academic`；正文不包围栏；H1–H4；表格 ≤6 列；`# 参考文献` 只出现一次且位于末尾；图片走 `images/...`；`latex-figure` 禁止外部文件命令。
- **日程安排**：`version` 为数字 2；`eventsBy/recursBy` 的键须在 `planners` 中声明；事件 id/title 非空；五种内置色；`time` 为 `""` 或 `HH:MM`。
- **可视化图表**：`kind:"zenviz-right-properties"`、`version:1`（数字）；引擎只限 echarts/chartjs/apexcharts/zen；属性 JSON 不含数据。
- **所思所想**：`v:2`；节点 id `node-<数字>`；坐标非 0 且在范围内；连线端点存在且不同；图片节点必须 `srcMode:"url"` + https/data URL。
- **间隔复习 / 网页剪藏**：`format:"zen-card"`、`v:1`；kind/source 用枚举；content 非空；id 唯一；ISO 时间；links 指向真实卡片。
- **自动化编排**：action 类型只限 addTag/setKind/send/publish/notify/highlight；send 要 to、publish 要 channel。
- **统一备份**：`format:"zen-backup"`、`v:1`；`products[].id` 即 localStorage 键；`checksum` 必须与 data 的 **FNV-1a base36（UTF-16 码元）** 一致——校验器已内建与 `zen-backup.js` 完全相同的算法，会自动重算并指出正确值。
- **消息同步 / 文档脱敏**：没有文件导入；校验器会明确报错，不要为它们生成导入文件。
- **静书房 AI 配置**：可生成配置骨架，但 `apiKey` 必须留空，密钥只能在设置界面填写。

前端“校验”标签页提供同一套能力：选产品与格式 → 载入模板 → 粘贴内容 → 校验，产物卡上也可能出现“校验格式”按钮。
