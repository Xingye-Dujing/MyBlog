# OMM-ZEN 设计系统

这是 OMM-ZEN 产品开发的唯一入口。目标：新增产品时不需要重新设计样式、协议与流程，
只需要按本文约定接线，就能得到与其余产品完全一致的品牌语言与工作台体验。

## 契约

1. 样式只有一个入口：`zen-style/zen.css`。产品页只额外引入自己的
   `zen-style/products/<id>.css`，不得内联 `<style>` 或自建第二套令牌。
2. 配色、字体、圆角、间距、层级全部来自共享令牌；产品 CSS 不定义新的色值。
3. 跨产品通信只走 `OMMShare` / `OMMDesktop` / ZenCard 与共享频道，不直接读写别的产品数据。
4. 所有产品使用同一组桥接脚本与 origin 校验；不得使用通配符 `postMessage`。
5. 新增产品必须在 `desktop/plugin_specs.py` 注册，并补齐规范与 AI 知识镜像。

## 文档索引

- [设计令牌](design-tokens.md)：颜色、字体、间距、圆角、层级的唯一取值表。
- [组件库](components.md)：共享 class 词汇表与用法。
- [共享模块](shared-modules.md)：可直接复用的 JS 模块与桥接脚本。
- [新产品开发指南](product-guide.md)：从零到可发布的完整步骤。
- [技能体系](skills.md)：AI 产品技能与开发者技能的使用与扩展。

## 目录约定

```text
public/
├── omm-<id>.html              产品入口页（id 即产品注册 id）
├── zen-style/
│   ├── zen.css                唯一入口，声明层顺序
│   ├── tokens.css             令牌真源
│   ├── base.css               基础重置
│   ├── primitives.css         通用组件
│   ├── features/              按能力划分的共享样式
│   └── products/<id>.css      产品专有样式
├── zen-*.js                   可复用产品逻辑模块
├── omm-*.js                   工作台桥接与壳脚本
├── json-specs/                JSON 格式规范真源
└── desktop/                   桌面端启动器、离线打包与发布
```
