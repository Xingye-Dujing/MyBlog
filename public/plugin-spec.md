# OMM-ZEN 插件规范

> **本文是“契约”**：字段、打包方式、安装限制。它也会显示在工作台的「插件 → 插件规范」里。
> 开发教程、保存/快照/共享 API、迁移规则和测试清单见
> [`desktop/PLUGIN-GUIDE.md`](desktop/PLUGIN-GUIDE.md)；构建与发布见
> [`desktop/README.md`](desktop/README.md)。

OMM-ZEN 是一个插件化工作台。每个产品都是独立插件，可以随完整版内置、由在线安装器
下载，也可以由用户按本规范导入。

## 目录结构

插件是一个 zip 包，根目录必须包含 `plugin.json`：

```text
my-plugin.zip
├── plugin.json
├── index.html
├── style.css
├── app.js
└── assets/
    └── ...
```

也可以把内容放在单一顶层文件夹里：

```text
my-plugin.zip
└── my-plugin/
    ├── plugin.json
    └── index.html
```

入口页面必须位于插件目录内。所有资源使用相对路径，不要引用 CDN；插件在离线状态下
也必须能完整打开。

## plugin.json

```json
{
  "schema": 1,
  "id": "my-product",
  "name": "我的产品",
  "version": "1.0.0",
  "description": "一句话说明这个产品做什么",
  "glyph": "我",
  "entry": "index.html",
  "runtime": "static",
  "order": 900,
  "author": "Your Name",
  "homepage": "https://example.com"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema` | 否 | 固定为 `1` |
| `id` | 是 | 小写字母开头，只能包含小写字母、数字和 `-`，最长 41 字符；全局唯一 |
| `name` | 是 | 显示在标签页、Dock 和应用面板中的名称 |
| `version` | 否 | 用于在线更新的版本号，默认 `1.0.0` |
| `description` | 否 | 应用面板中的说明 |
| `glyph` | 否 | 1–4 个字符的字标，显示在标签和 Dock 中 |
| `entry` | 否 | 入口 HTML 的相对路径，默认 `index.html` |
| `runtime` | 否 | 导入插件必须为 `static` |
| `order` | 否 | Dock / 应用面板中的排序，越小越靠前 |
| `author` | 否 | 作者 |
| `homepage` | 否 | 项目主页 |
| `share` | 否 | 跨产品共享能力，见下一节 |

## 运行时

- `static`：纯前端页面，由本地静态服务器提供。**用户导入的插件只能是这种类型。**
- `mdforge` / `latex`：官方内置插件使用，依赖 OMM-ZEN 框架内置的 Python 后端。
  自定义插件不能使用这两个运行时。

插件运行在独立的回环端口上，因此拥有自己的 `localStorage`、IndexedDB 和 Cookie
空间，不会和其他插件互相覆盖。

## 跨产品共享（share）

插件可以声明自己愿意在哪些「频道」里发布或接收内容。频道是一个带类型的共享空间，
例如表格数据、英语笔记、文档。声明只是**能力**；真正允许谁和谁通信，由用户在
「存档 → 跨产品共享 → 连接规则」里最终决定，并且随时可以取消。

```json
{
  "share": {
    "channels": [
      { "id": "data.tables", "role": "both" },
      { "id": "documents", "role": "consume" }
    ]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `channels[].id` | 频道 id。内置频道：`data.tables`、`notes.english`、`documents` |
| `channels[].role` | `publish`（只能发布）、`consume`（只能接收）、`both`（默认） |
| `channels[].name` | 可选。新频道的显示名；内置频道已有名称 |
| `channels[].description` | 可选。新频道的一句话说明 |
| `channels[].types` | 可选。新频道接受的 MIME 类型，如 `text/csv`、`text/markdown` |

工作台启动、安装或卸载插件时，会把清单里的能力合并进共享策略
（`%LOCALAPPDATA%/OMM-ZEN/share/policy.json`）。合并只增不减：用户关掉的频道不会
因为升级插件而被悄悄打开。

页面接入使用桌面版注入的 `window.OMMShare`：`publishFile` / `publishRecord` /
`send` / `onArtifact`。完整示例、频道选择和工作原理见开发指南的「共享 API」一节。

现有的「三端互通」按钮（Annotate / English / Corpus）不需要改代码：桌面版会拦截
它们原有的 `OMMBridge`，把 `localStorage` + `BroadcastChannel` 传输替换成共享空间的
收件箱，因此跨端口仍然是一键直达。任何指向 `omm-*.html` 的链接也会被接管，改为在
工作台中打开对应产品，而不是跳到 404。

共享文件默认保存在 `%LOCALAPPDATA%/OMM-ZEN/share/`（`files/`、`records/`、
`inbox/`），与 `shared.json`、`snapshots/` 同级；也可以在「存档 → 保存设置 →
共享空间目录」里改成任意专用文件夹，修改会立即迁移并删除旧目录。
`share/index.json` 只保存索引，删除共享项目不会删除产品自己的存档。

完整的新产品接入指南（保存、快照、共享、权限、迁移、测试清单）见
[`desktop/PLUGIN-GUIDE.md`](desktop/PLUGIN-GUIDE.md)。

## 打包和导入

1. 按上面的结构准备目录，确认 `plugin.json` 在根目录。
2. 将目录内容压成 zip（`plugin.json` 位于压缩包根目录）。
3. 打开 OMM-ZEN 工作台 → 顶部「插件」→「导入插件」→ 选择 zip。
4. 安装成功后，新插件立即出现在顶部应用面板和底部 Dock 中。

限制：单个插件包不超过 220 MB，解压后不超过 600 MB，文件数不超过 6000。
zip 中不允许绝对路径、`..`、符号链接；入口页面必须在插件目录内。

## 开发建议

- 插件页面会被嵌入 iframe，请使用响应式布局，适配较窄的窗格。
- 不要修改 `window.top`、不要尝试关闭外壳窗口；页面只操作自己的文档。
- 需要联网的功能（AI、云同步等）可以保留，但界面和本地功能应离线可用。
- 使用 `localStorage` 时加上自己的前缀，避免未来与其他数据冲突。
- 需要示例时参考 `plugin-template/`。

## 数据位置

```text
Windows: %LOCALAPPDATA%\OMM-ZEN\plugins\<id>\
macOS:   ~/Library/Application Support/OMM-ZEN/plugins/<id>/
```

完整离线版还会在程序内部携带内置插件；用户安装的同 id 插件会覆盖内置版本，
卸载后内置版本会重新出现。
