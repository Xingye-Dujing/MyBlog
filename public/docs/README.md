# OMM-ZEN 设计系统

这是 OMM-ZEN 产品开发的唯一入口。目标：新增产品时不需要重新设计样式、协议与流程，
只需要按本文约定接线，就能得到与其余产品完全一致的品牌语言与工作台体验。

## 契约

1. 样式只有一个入口：`zen/zen.css`。产品页只额外引入自己的
   `zen/products/<id>.css`，不得内联 `<style>` 或自建第二套令牌。
2. 配色、字体、圆角、间距、层级全部来自共享令牌；产品 CSS 不定义新的色值。
2a. 交互浮层（确认框、候选区、日期/时间）统一使用 `zen/components/` 共享组件；禁止浏览器原生弹窗。
2b. **底线**：`zen/` 是通用可复用资产，禁止为某个产品写入特殊分支或补丁；产品独有行为只能留在产品自身文件里。
2c. `zen/` 各目录按职责划分且互不重叠：`foundation/` 只放视觉基座，`components/` 只放交互组件，
   `canvas/` 只放画布能力，`features/` 只放可选视觉包，`products/` 只放产品适配样式。
2d. **零残留、零兼容、零冗余**（硬性要求，提交前必须满足）：逻辑或样式迁入共享层后，产品私有实现
   （旧浮层壳、监听器、辅助函数、死绑定、无用 id/模板、备份文件、过期文档）必须**全部删除**，不留注释掉的
   代码；不留旧 API 别名、兼容包装或废弃命名，所有调用点统一到唯一规范 API，然后移除别名；当前无任何引用的
   文件、函数、CSS 规则、令牌、文档一律删除（删除前全局 grep 确认）；同一视觉或交互关注点只允许一份实现，
   发现两处做同一件事就合并并删除副本。生成物出现漂移时改源再重新生成，绝不手改生成物掩盖问题。
2e. 画布的右键菜单、右键拖动与视口适应只有共享引擎一份实现；产品只配置（如 `contextMenu:false`、
   `pan:false`），不得再开第二个菜单、监听 `mousedown` 做右键平移或私算居中偏移。
   `ZenUI.menu` 与 `ZenUI.contextMenu` 在共享浮层层互斥，任何时刻只允许一个菜单存在。
3. 跨产品通信只走 `OMMShare` / `OMMDesktop` / ZenCard 与共享频道，不直接读写别的产品数据。
4. 所有产品使用同一组桥接脚本与 origin 校验；不得使用通配符 `postMessage`。
5. 新增产品必须在 `desktop/plugin_specs.py` 注册，并补齐规范与 AI 知识镜像。

## 文档索引

- [设计令牌](design-tokens.md)：颜色、字体、间距、圆角、层级的唯一取值表。
- [组件库](components.md)：共享 class 词汇表与用法。
- [共享模块](shared-modules.md)：可直接复用的 JS 模块与桥接脚本。
- [OMM-ZEN UI 组件库](../zen/components/README.md)：浮层、候选区、对话框、日期/时间选择器的统一实现。
- [新产品开发指南](product-guide.md)：从零到可发布的完整步骤。
- [技能体系](skills.md)：AI 产品技能与开发者技能的使用与扩展。
- [AI 工作区](README-AI.md)：静书房 AI 插件的知识、技能、工具与产物契约。
- [MDFORGE](README-MDFORGE.md)：铸造台的排版与模板说明。

## 目录约定

```text
public/
├── omm-<id>.html              产品入口页（id 即产品注册 id）
├── zen/                       OMM-ZEN 品牌视觉与交互库（唯一入口 zen/zen.css）
│   ├── zen.css                核心样式入口
│   ├── foundation/            视觉基座：tokens / base / primitives
│   ├── components/            交互组件：浮层、Toast、对话框、候选区、菜单、快捷键
│   ├── canvas/                画布能力与布局引擎（可选）
│   ├── features/              可选视觉能力包（grid/doc/learning/cloud/tool）
│   └── products/<id>.css      产品专有样式
├── zen-*.js                   可复用产品逻辑模块
├── omm-*.js                   工作台桥接与壳脚本
├── json-specs/                JSON 格式规范真源
├── tools/new_product.py       新产品脚手架
└── desktop/                   桌面端启动器、离线打包与发布
```
