# 产品插件开发指南

> 本文是**开发指南**，面向要新增或改造产品的人：做法、API、示例、测试。
> 字段速查、打包与安装限制见 [`../plugin-spec.md`](../plugin-spec.md)；
> 构建、发布、签名见 [`README.md`](README.md)。

这份文档写给以后要加入 OMM-ZEN 的产品开发者：怎样做一个插件、怎样保存文件、
怎样和别的产品通信，以及哪些地方不能碰。规范本身很短，照着做即可；遇到不常见
的需求，先看「架构」一节再决定是扩展现有频道还是新增频道。

---

## 1. 心智模型

```
┌─────────────┐   自己的回环端口   ┌──────────────────────────┐
│  产品 A     │ ───────────────▶  │ /__omm/share/*           │
│  (iframe)   │                   │   products/…  共享目录    │
└─────────────┘                   │   share/index.json       │
       ▲                          │   inbox/<产品>/…         │
       │ postMessage              └────────────▲─────────────┘
       │                                       │ 自己的回环端口
┌──────┴──────┐                                │
│  工作台 hub │  只负责：打开产品、聚焦、提示   │
└─────────────┘                       ┌────────┴────────┐
                                      │  产品 B          │
                                      │  (iframe)        │
                                      └──────────────────┘
```

三条原则：

1. **产品拥有自己的状态。** 只有产品自己的文档能读写它的 `localStorage` /
   IndexedDB。工作台从不直接读取 iframe 的内容；它只转发请求。
2. **数据走磁盘，不走窗口。** 文件、记录、消息都落在共享目录里，所以产品即使
   没有同时打开，也能在下次启动时收到。窗口之间只用 `postMessage` 做“提醒”。
3. **能力由清单声明，权限由用户决定。** `plugin.json` 只说“我愿意在哪个频道
   发布/接收”，真正的允许矩阵在「存档 → 跨产品共享 → 连接规则」里，用户随时
   可以取消。

---

## 2. 一个插件的最小结构

```text
my-product/
├── plugin.json
├── omm-my-product.html
├── omm-embed.js        # 桌面外壳共用（由构建复制）
├── omm-desktop.js      # 保存 / 快照 / 存档面板（由构建复制）
├── omm-share.js        # 跨产品共享（由构建复制）
└── vendor/…            # 只放这个产品用到的离线资源
```

`plugin.json`：

```json
{
  "schema": 1,
  "id": "my-product",
  "name": "我的产品",
  "version": "1.0.0",
  "description": "一句话说明",
  "glyph": "我",
  "entry": "omm-my-product.html",
  "runtime": "static",
  "order": 900,
  "author": "Your Name",
  "share": {
    "channels": [
      { "id": "data.tables", "role": "both" },
      { "id": "documents", "role": "consume" }
    ]
  }
}
```

页面 `<head>` 里按顺序引入三个共享脚本（**顺序不能反**）：

```html
<script src="omm-embed.js"></script>
<script src="omm-desktop.js"></script>
<script src="omm-share.js"></script>
```

`omm-embed.js` 负责去掉启动画面、转发快捷键；`omm-desktop.js` 负责保存、快照
和「存档」面板；`omm-share.js` 负责跨产品通信。网页版没有桌面 API 时，三个
脚本都会自动休眠，页面行为保持不变。

---

## 3. 保存文件：不要自己造下载

产品的「保存 / 导出」按钮应该走桌面桥：

```js
// 文本
await OMMDesktop.saveText('result.md', markdown, 'text/markdown')

// 二进制（PDF、DOCX、图片……）
await OMMDesktop.saveBlob('report.pdf', pdfBlob, {
  mode: 'versioned',       // 可选：覆盖当前产品设置
  label: '保存报告',
})
```

它完成了四件事：

1. 写入用户设置的保存目录（不再触发浏览器下载弹窗）；
2. 按「每次加时间后缀 / 覆盖同名文件」处理版本；
3. 按设置记录一份应用状态快照；
4. 按设置把文件自动放进共享空间（`auto_share` 默认关闭，可在保存设置里开启）。

如果产品有自己的“下载”逻辑（`<a download>`、`URL.createObjectURL`），桌面桥
也会自动接管，不需要改代码。只有一种情况需要手动调用：产品生成文件后想换一个
文件名或标签，此时用上面的 API 最清楚。

> 不要在桌面版里自己写 `showSaveFilePicker` 或 `msSaveBlob`。保存路径由存档
> 面板统一管理，否则文件会散落在浏览器的下载目录里，也不会进入快照和共享。

---

## 4. 发布与接收共享内容

### 4.1 发布文件

```js
const item = await OMMShare.publishFile({
  path: saved.path,          // saveBlob 返回的磁盘路径
  name: saved.filename,
  title: '本月数据',
  type: 'text/csv',
  replaceKey: 'monthly',     // 同一个 key 再发布会替换旧项目
})
// item.channel 是自动匹配到的频道，例如 data.tables
```

不传 `channel` 时按产品提示 + MIME 自动选择：

| 产品 | 优先频道 |
| --- | --- |
| data / visualization | `data.tables` |
| english / corpus / annotate | `notes.english` |
| writer / mdforge / latex / message | `documents` |

### 4.2 发布记录

记录适合“不是一个文件”的东西，例如一份笔记包、一个筛选条件、一段配置：

```js
await OMMShare.publishRecord(
  { omm: 'bridge', v: 1, items: [...] },
  {
    channel: 'notes.english',
    type: 'application/x-omm-bridge+json',
    format: 'omm.bridge',
    title: '英语笔记 · 第 3 单元',
  }
)
```

记录会出现在共享空间里，接收方可以像文件一样取用。

### 4.3 发送给某个产品

```js
await OMMShare.send({
  to: 'visualization',
  channel: 'data.tables',
  artifactId: item.id,       // 或 payload: {...}
  format: item.format,
  title: item.title,
})
```

`send` 只负责投递，不会切换窗口；如果希望“发送并打开”，用
`OMMShare.openArtifact(item, { app: 'visualization', name: '可视化图表' })`。
目标产品启动后（或已经打开时收到提醒）从收件箱取走消息。

### 4.4 接收

```js
OMMShare.onArtifact((artifact) => {
  // artifact.format  === 'omm.bridge' 时，payload 是标准笔记包
  // artifact.kind    === 'file' 时，文件已经被交给页面的文件输入框
  // artifact.from    是发送方 id
  if (artifact.format === 'omm.bridge') {
    importNotes(artifact.payload)
  }
})
```

文件类共享默认走 `OMMDesktop.loadBlob`：它会找页面里最合适的
`input[type="file"]`，按扩展名和 `accept` 打分，自动触发 `change` 事件。因此
**只要产品的导入入口是标准的文件输入框，就不需要写任何接收代码**。如果产品
用自定义拖拽区域，监听 `omm:artifact` 事件即可拿到元数据，再通过
`OMMShare` 暴露的文件 URL 读取（见 API 表）。

`onArtifact` 可以注册多个；每条消息只会投递一次，处理完自动确认。页面启动较慢
也没关系：消息在确认前一直留在收件箱里，脚本会在注册处理器后立即再拉一次。

### 4.5 兼容旧的 `OMMBridge`

Annotate / English / Corpus 已经有一套 `window.OMMBridge`。桌面版在
`omm-share.js` 里拦截它：

- `OMMBridge.watch(apply)` 仍然可用，内部改为监听共享空间；
- `OMMBridge.deliver(target, items, meta)` 仍然返回 `true`，内部改为发送到
  `notes.english` 频道并打开目标产品；
- 网页版（没有 `/__omm/fs/status`）会自动回退到原来的 localStorage +
  BroadcastChannel，不加桌面判断也能用。

新产品不必复制这套东西；直接用 `OMMShare` 即可。只有需要和这三个老页面互通
时，才使用 `omm.bridge` 包格式。

---

## 5. 频道与权限

### 5.1 内置频道

| id | 名称 | 类型 | 默认成员 |
| --- | --- | --- | --- |
| `data.tables` | 数据表 | `text/csv`、`text/tab-separated-values`、`application/json`、XLSX | data、visualization |
| `notes.english` | 英语笔记 | `application/x-omm-bridge+json`、`text/markdown`、`application/json` | english、corpus、annotate |
| `documents` | 文档 | Markdown、TeX、纯文本、PDF、DOCX、ZIP、PNG/JPEG/SVG | writer、mdforge、latex、message、redact、annotate、visualization、planner |

### 5.2 新增频道

在清单里声明即可，不存在的频道会自动创建：

```json
"share": {
  "channels": [
    {
      "id": "my.notes",
      "name": "我的笔记",
      "description": "这个产品之间共享的笔记",
      "types": ["application/x-my-note+json", "text/markdown"],
      "role": "both"
    }
  ]
}
```

工作台启动 / 安装 / 升级插件时会把能力合并进
`%LOCALAPPDATA%/OMM-ZEN/share/policy.json`：

- 新频道、新成员会自动加入；
- 用户手动关掉的「发布 / 接收」不会被升级悄悄打开；
- 频道的 `types` 只会追加，不会删除，避免旧项目突然不可见。

### 5.3 权限规则

- 发布：产品必须在频道的 `apps` 里且 `publish=true`；
- 接收：产品必须在频道的 `apps` 里且 `consume=true`；
- 工作台（`app=hub`）可以查看全部项目，用于「共享空间」管理；
- 每个产品只能看到自己可见的频道，看不到无关的规则矩阵；
- 文件下载会再次校验接收权限，不能靠猜 URL 越权。

默认拒绝：没声明 `share` 的产品不会出现在任何频道里，也不会收到任何消息。

---

## 6. 共享目录与迁移

### 6.1 位置

默认：

```
%LOCALAPPDATA%/OMM-ZEN/share/
├── index.json      # 共享项目索引
├── policy.json     # 频道与允许矩阵
├── files/          # 发布的文件副本
├── records/        # 发布的记录
└── inbox/<产品>/    # 待接收的消息（确认后删除）
```

保存目录默认 `Documents/OMM-ZEN`，快照在 `<保存目录>/snapshots/<产品>/`。
插件目录默认 `%LOCALAPPDATA%/OMM-ZEN/plugins/`。

### 6.2 修改路径会立即迁移

三个路径都可以改，改完立即执行迁移，而不是“下次生效”：

| 路径 | 入口 | 迁移范围 |
| --- | --- | --- |
| 保存目录 | 存档 → 保存设置 | 该产品（或所有产品）的文件 + `snapshots/<产品>`；独占目录会整目录迁移 |
| 共享目录 | 存档 → 保存设置 → 共享空间目录（全局） | 整个共享空间（索引、文件、记录、收件箱、规则） |
| 插件目录 | 顶部「插件」→ 安装目录 → 修改 | 已安装插件与 `ports.json` |

迁移规则：

- **合并而不是覆盖**：目标目录已有同名文件时，新来的文件会重命名为
  `name-2.ext`，不会丢数据；`shared.json` 里的资源路径同步改写。
- **独占目录整目录迁移**：如果旧目录只属于被迁移的产品，目录里的未登记文件
  也会一起搬走，然后递归删除旧目录（包括所有空子文件夹）。
- **共享目录只搬自己的**：如果旧目录被多个产品共用，只移动当前产品的登记文件
  和它的快照子目录，旧目录保留给其它产品继续使用。
- **安全目录只搬登记文件**：如果旧目录是 `Documents`、桌面、下载、用户主目录
  或盘符根目录，不做整体移动，只迁移 OMM 登记过的文件和快照，避免误伤用户
  自己的资料。
- **失败回滚**：迁移过程中任何一步失败，已经移动的文件会尽量移回原位，配置
  不写入，旧目录保持可用。
- **成功后删除**：迁移成功会删除旧目录及其空子目录；如果有文件被系统占用而
  删不掉，界面会明确提示“旧目录仍有文件未能删除”，不会假装成功。

> 修改路径前请关闭正在写文件的程序。迁移是同步操作，大目录可能需要几秒。
> 新目录不能位于旧目录内部。

---

## 7. 测试清单

新增产品后至少验证这些：

1. **网页版不受影响**：不启动桌面时，页面正常打开，原有的下载 / 互通按钮行为
   不变；`OMMShare.enabled === false`。
2. **桌面保存**：点保存，文件出现在设置目录；`.omm-snapshot.json` 出现在
   `snapshots/<id>/`；存档面板能看到「文档 + 快照」两条记录。
3. **自动共享**：保存一个 CSV，共享空间出现同名项目；`replace_key` 生效，
   重复保存不会堆一堆旧版本。
4. **接收文件**：在另一个产品点「在 X 中打开」，目标产品的导入框收到文件；
   收件箱清空。
5. **接收记录**：用 `OMMShare.send({payload})` 发一条，目标产品
   `onArtifact` 收到，`format` 正确。
6. **权限**：在「连接规则」里关掉接收，再发一次，应返回 400 / 界面提示；
   重新打开后恢复。
7. **迁移**：改保存目录、共享目录、插件目录各一次，确认旧目录消失（含空
   文件夹）、资源路径仍可打开、旧项目仍可发送。
8. **重启**：关闭工作台再打开，未确认的消息仍在；共享列表、规则、路径都保持。

---

## 8. 参考：客户端 API

### `window.OMMDesktop`

| 方法 | 说明 |
| --- | --- |
| `saveBlob(name, blob, opts)` | 保存二进制；返回 `{filename, path, size, mode}` |
| `saveText(name, text, mime, opts)` | 保存文本 |
| `captureState(label)` | 抓取当前页面的 LocalStorage / SessionStorage / IndexedDB |
| `restore(snapshot)` | 恢复并重载页面 |
| `loadBlob(name, mime, buffer)` | 把字节交给当前页面的文件输入框 |
| `loadResource({path,name,mime})` | 从保存目录读取并交给文件输入框 |
| `snapshot(label)` | 创建快照 |
| `openPanel()` | 打开存档面板 |

### `window.OMMShare`

| 方法 | 说明 |
| --- | --- |
| `publishFile(opts)` | 发布文件，返回项目 |
| `publishRecord(record, opts)` | 发布记录 |
| `send(opts)` | 发送消息（`to`、`channel`、`artifactId` 或 `payload`） |
| `onArtifact(fn)` | 注册接收器，返回取消函数 |
| `openArtifact(item, {app,name})` | 发送项目并打开目标产品 |
| `openApp(id)` | 请求工作台打开产品 |
| `pollInbox()` | 立即拉取收件箱（一般不需要手动调用） |
| `refresh()` | 刷新共享面板 |
| `enabled` / `space` | 是否可用 / 最近一次的空间快照 |
| `mountPanel(root, opts)` | 挂载共享面板（存档面板已内置） |

### HTTP（每个产品自己的回环端口）

```text
GET  /__omm/share/space?app=<id>
GET  /__omm/share/items?app=<id>&channel=<id>
GET  /__omm/share/item?id=<id>&app=<id>
GET  /__omm/share/file?id=<id>&app=<id>
GET  /__omm/share/inbox?app=<id>
POST /__omm/share/publish     { app, channel, type, title, source_path|data|record, ... }
POST /__omm/share/send        { app, to, channel, artifact_id|payload, format, title }
POST /__omm/share/ack         { app, ids: [...] }
POST /__omm/share/delete      { app, id }
POST /__omm/share/policy      { app, channel, app, publish?, consume? }
```

返回统一是 `{ok:true,...}` 或 `{ok:false,error:"…"}`。错误码 400 表示参数/权限，
413 表示超过 64 MB（文件）或 16 MB（消息），404 表示桌面 API 未启用。

---

## 9. 常见坑

- **在 iframe 里直接 `window.open('omm-other.html')`**：每个插件只服务自己的
  目录，会 404。用 `OMMShare.openApp('other')`；桌面桥也会拦截普通链接。
- **用 `BroadcastChannel` 跨产品**：不同端口是不同源，收不到。共享空间才是
  跨源的通道。
- **在 hub 页面里抓快照**：工作台没有产品状态，会抓到工作台自己的存储。快照
  必须由产品页面调用；`OMMShare` 会替你转发。
- **把大文件塞进 `payload`**：消息体上限 16 MB。大文件用 `publishFile`，它会
  复制到共享目录并按流式读取。
- **忘记在清单里声明频道**：能看到共享面板，但发布/接收会返回 400。先在
  `plugin.json` 的 `share.channels` 里声明。
- **修改路径后马上写文件**：迁移是同步的，接口返回后新路径已生效；如果界面
  仍显示旧路径，点一次「刷新」。

---

需要更细的清单字段说明，看 `plugin-spec.md`；需要构建、发布、签名的步骤，
看 `desktop/README.md`。
