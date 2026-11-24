# 新产品开发指南

按下列步骤即可得到一个与现有产品完全一致的新产品。每一步都有对应的守卫或测试兜底。

## 1. 注册产品

在 `desktop/plugin_specs.py` 的 `BUILTIN_PLUGINS` 增加条目：`id`（英文小写）、
`name`、`glyph`、`description`、`entry`（固定 `omm-<id>.html`）、`port`、
`runtime`（纯静态用 `static`）、`order`、`share`。
用户导入的插件强制 `static`，只有内置产品可用本地后端。

## 2. 创建入口页

用脚手架一次性生成入口页、产品样式与测试骨架，然后按业务填充：

```bash
python tools/new_product.py <id> <名称> <字标> <描述> --port <端口> --channels <频道>
```

它会拒绝覆盖已有文件，并打印需要补进注册表的条目。也可以复制
`plugin-template/index.html` 的结构手写。`<head>` 必须包含：

```html
<script src="omm-embed.js"></script>
<script src="zen/foundation/util.js"></script>
<script src="zen/components/layer.js"></script>
<script src="zen/components/popover.js"></script>
<script src="zen/components/toast.js"></script>
<script src="zen/components/dialog.js"></script>
<script src="zen/components/select.js"></script>
<script src="zen/components/menu.js"></script>
<script src="zen/components/shortcuts.js"></script>
<script src="zen/components/index.js"></script>
<script src="omm-desktop.js"></script>
<script src="omm-share.js"></script>
<link rel="stylesheet" href="zen/zen.css">
<link rel="stylesheet" href="zen/products/<id>.css">
```

入口根元素声明 `data-omm-app="<产品 id>"`，桌面桥与共享总线以此识别产品；非 `omm-*.html`
入口也必须声明。按需引入 `vendor/fonts/literata-*.css` 与 `zen-*.js` 共享模块。不得内联 `<style>`。

## 3. 写产品样式

新建 `zen/products/<id>.css`，内容包在 `@layer zen.product { … }` 中。
只用 `zen-*` 令牌；公共组件直接复用 `primitives.css` / `features/*`，
产品专有 class 加产品前缀。

## 4. 接线与协议

- 跨产品发送用 `OMMShare.send({to, format, payload})`，只走声明的共享频道。
- 接收消息必须校验 `event.origin` 与 `event.source`，回复用明确 origin，禁止通配符。
- 需要桌面能力时通过 `OMMDesktop` 桥接，不直接访问文件系统。
- 有导入格式的产品：在 `json-specs/` 写规范， mirrored 到 `agent_workspace/omm_knowledge/`，
  并在 `format-registry.json` 登记后运行 `python tools/gen_formats.py`。

## 5. AI 知识

在 `agent_workspace/omm_data.py` 的 `PRODUCTS` 增加条目（用途、功能、数据落点、格式、
AI、最佳实践、坑、示例请求）。技能会自动衍生，不要手改 `omm_skills.py` 的技能列表；
重新生成 `PRODUCTS.md`：

```bash
python -c "from agent_workspace.omm_data import product_index_md; from pathlib import Path; Path('agent_workspace/omm_knowledge/PRODUCTS.md').write_text(product_index_md(), encoding='utf-8')"
```

## 6. 共享能力接线

- CSV/TSV 导入导出只调用 `ZenCSV.parse()` / `ZenCSV.stringify()`，不维护产品私有分隔符解析器。
- 卡片桥接加载 `lib/zen-link.js` 即可；发送目标由共享频道权限解析，只读采集页用
  `data-zen-link-ui="false"` 隐藏悬浮入口。
- 存档、共享面板、日期选择器与候选区只复用 `ZenUI`；视觉进入 `zen/`，产品不注入私有浮层样式。

## 7. 测试与发布

1. 在 `tests/` 增加产品专项测试（DOM id、脚本语法、桥接与 origin 校验）。
2. 运行守卫与样式审计：`python ../tests/product_guard.py --check`、
   `python desktop/check_styles.py`。
3. 升版本：套件或对应产品版本 +1，运行 `python desktop/build_plugins.py`
   与 `python ../tests/product_guard.py --record-baseline`。
4. 运行完整回归：`python ../tests/run_all.py`。

所有命令在 `public/` 目录执行。
