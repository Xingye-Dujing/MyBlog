# 静书房 v1.0.33（视频 / 表格 / Lambda · 设计系统与目录重整）

本版本为全量发布，版本号在所有组件统一为 **1.0.33**。自 v1.0.26 以来共 22 次提交，新增三个产品、建立统一设计系统，并完成目录重组与共享模块抽取。

## 新产品与新能力

- **视频工作台**（新插件 `video`，独立 EXE `OMM-Video`）：节点式工作流程、视频分析与处理，内置 ffmpeg。
- **表格自动化**（新插件 `table`）：Excel 节点工作流程，支持逐格 / 逐列计算、写回与汇总。
- **Lambda 演算计算器**（新插件 `lambda`）：Flask + extension 的 λ 演算解释器与计算器，已接入 AI 工作区全套内容。
- 视频 / Lambda / 表格三个产品均补齐了 AI 工作区技能与最佳实践中内容。

## 设计系统与前端

- 建立 OMM-ZEN 设计系统：语义化 token、分层 `zen/styles`，新增开发者技能 `omm.zen.dev`。
- 通用画布框架 `zen/canvas` 落地，布局引擎归入共享层，删除无用桥接与已并层的旧样式。
- 深色主题改用柔和黑；补齐应用图标与无障碍标签，移除自定义 tooltip。
- 移除集成器外观设置（主题色 / 圆角 / 明暗开关），样式规则收敛到单一真源。

## 工程与结构

- Python 后端归入 `public/server/`，共享 JS 归入 `public/lib/`，文档归入 `public/docs/`。
- 云同步加密工具抽取为共享模块 `lib/zen-crypto.js`，供六个云同步产品复用。
- 新增新产品脚手架 `public/tools/new_product.py`，并更新产品守卫、版本基线与 AGENTS.md。
- CLI 启动默认启用桌面文件桥。

## 更新方式

- 完整版 `OMM-ZEN.exe` / 框架版：通过 `catalog.json` 自更新到 1.0.33。
- 在线安装器 `OMM-ZEN-Setup.exe`：全新安装默认获取 1.0.33 组件。
- 独立产品 EXE 与插件包：从本 Release 下载覆盖，或在集成器“插件管理”内更新。

## 文件

- 18 个产品 EXE + `OMM-ZEN.exe`（完整版工作台）+ `OMM-ZEN-Setup.exe`（安装器）+ `OMM-ZEN-Framework-win64.zip`
- 21 个插件包 `plugin-*.zip`、`plugin-template.zip`、`plugin-spec.md`
- `catalog.json`（tag=v1.0.33，version=1.0.33）
- macOS 资源由 Actions 工作流补充上传
