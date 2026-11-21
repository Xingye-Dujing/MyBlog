# 静书房 v1.0.27（表格自动化 · 画布工作台复用 · 守卫一致性）

本版本为全量发布，版本号在所有组件统一为 **1.0.27**。

## 新产品与新能力

- **表格自动化**（新插件 `table`，端口 8331）：Excel 工作簿的可视化数据流自动化。复用 ZenCanvas 画布与工作台外壳，节点包括 Excel 文件与区域、逐格/逐列计算、计算列、筛选/排序/去重/连接、分组与交叉汇总、写回单元格、写公式、导出汇总表与保存。
- 内置两套模板：**加班补贴**（最后时间 → 时间区间分档 → 下方插入空行 → 行内合计）与 **工资计算**（逐列乘系数 → 列合计 → 按人/按表汇总）。
- 写回引擎先收集写计划，再按表自底向上插行，避免行号偏移；提供试运行、冲突清单跳过/覆盖策略、节点级预览与取消。
- 安全表达式（AST 白名单）支持 `[列]` 引用与 IF / ROUND / REGEX 等函数；后端只监听回环地址并校验 Host / Origin。
- AI 工作区完整接入：`omm.zen.table` 技能、`omm-table-workflow` 格式契约与校验器、`ZenTableAI` 快照与共享频道发送。

## 画布与样式

- video 的通用工作台外壳样式上移到 `zen-canvas/zen-canvas.css`，video 与 table 共用一份画布逻辑与样式，未新增第二套画布实现。
- 5 个小工具页的 `.panel / .field / .row / .btn` 改为专用 `.zt-*` 类名，样式集中到 `zen-style/15-feature-tool.css`；空的 `zen-style/90-override.css` 与其导入已删除。
- 删除所有未真正使用的空产品样式占位文件（hub / zenclip / zenreview / zenbackup）及对应 `<link>`；`check_styles.py` 改为禁止空占位文件，不再强制每个页面必须有产品 CSS。
- 保留并纳入一批 UI 修复：annotate / corpus / AI 工作区等产品的迁移后布局修正；Lambda 弹窗按钮补齐可访问名称。

## 工程质量

- 新增 pytest 自动化测试：表格引擎、HTTP API、桌面注册与打包、页面与 AI 桥接线；公开测试集 **292 项通过**，Node 页面专项 8 项通过。
- 统一守卫的 REGISTRY 现在以 `entry` 字段为入口页权威来源，允许 lambda 使用 `index.html` 这类非约定名；video 的格式源码指向 `zen-video.js`，lambda 分享格式真源指向规范文档。
- json-specs 的 lambda / video 文档已纳入总表索引并与 AI 知识副本同步；本地 `catalog.json` 由发布脚本正常生成。

## 更新方式

- 完整版 `OMM-ZEN.exe` / 框架版：通过 `catalog.json` 自更新到 1.0.27。
- 在线安装器 `OMM-ZEN-Setup.exe`：全新安装默认获取 1.0.27 组件。
- 表格自动化以插件形式运行，不单独生成 EXE。

## 文件

- 21 个插件包 `plugin-*.zip`、`plugin-template.zip`、`plugin-spec.md`
- `catalog.json`（tag=v1.0.27，version=1.0.27）
- macOS 资源由 Actions 工作流补充上传
