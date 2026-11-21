# ZenCanvas — OMM-ZEN 通用画布框架

> 设计母本：`public/omm-writer.html`。它是目前 OMM-ZEN 里最完善的画布系统，
> 本框架以它为准抽取，而不是另起炉灶。所有后续画布产品（视频工作流、未来的
> 数据编排、自动化编排等）都接这一套：**核心改一次，所有产品同时生效**。

## 1. 目录与职责

```
zen-canvas/
├── zen-canvas.js    # 画布核心：节点 / 连线 / 视口 / 选择 / 历史 / 序列化 / 事件
├── layout-engine.js # 6 策略自动布局引擎（唯一实现，纯函数）
└── README.md        # 本文件
```

画布样式已并入共享样式层 `zen-style/features/canvas-framework.css`，由
`zen-style/zen.css` 统一加载；画布产品只需要引用 zen.css，不再单独引入 CSS。

`zen-canvas/layout-engine.js` 是 6 策略自动布局的**唯一实现**，writer 与
zenflow 已经验证过；框架只调用，不复制。布局算法改动同样会同步到所有产品。

## 2. 从 writer 抽取了什么

| 能力 | writer 原始实现 | 框架对应 |
|---|---|---|
| DOM 层次 | `#workspace > #canvas-inner > #svg-layer + .node` | `.zc-workspace > .zc-canvas-inner > .zc-svg-layer + .node` |
| 节点结构 | `.node > .node-header + .node-port×4 + .node-content + .node-resize` | 完全一致，端口由节点类型声明 |
| 端口坐标 | `ConnectionManager.getPortPosition` | `ZenCanvas.geometry.getPortPosition`（逐行抽取） |
| 贝塞尔连线 | `_getCurvePath` 4 种端口组合 | `ZenCanvas.geometry.getCurvePath` |
| 折线兜底 | `_getElbowPath`（lane / around / L / path + 圆角） | `ZenCanvas.geometry.getElbowPath` |
| 连线渲染 | rAF 防抖 + 逐条 try/catch 隔离 + 14px 删除热区 | `renderConnections` 同策略 |
| 拖拽 | `newLeft = ox + dx / scale` | 同公式，支持整组已选节点一起拖 |
| 视口 | `translate3d(panX,panY,0) scale(scale)` | 同变换，`screenToWorld/worldToScreen/zoomAt/fitView` |
| 滚轮判定 | 滚动流区分触控板平移 / 物理滚轮缩放 | 同判定逻辑（含 180ms burst、wheelDeltaY 归一化） |
| 框选 | 固定定位橡皮筋 + 世界坐标命中 | 同实现 |
| 序列化 | `{nodes:[{type,x,y,w,h,title,id,...}], connections:[{from,to,fromPort,toPort,route}]}` | `toJSON/fromJSON` 兼容该结构 |
| 自动布局 | `computeCanvasLayout` → 写回 items + ports | `autoLayout()` 同流程 |

**刻意没有抽走的 writer 私有业务**：文档列表、图片资产管理、MathJax、涂鸦、
云同步、i18n、确认弹窗。它们通过依赖注入点接进来，而不是写死在核心里。

## 3. 关键设计

1. **实例级状态**：`create()` 返回独立实例，每个实例有自己的 workspace / svg /
   state / 事件总线；同页可挂多张画布，不再有 writer 那种全局 `DOM/AppState` 冲突。
2. **节点类型注册表**：产品只声明"这个节点长什么样、有哪些端口、怎么渲染"，
   画布核心不认识任何业务节点。`registerNodeType(key, def)`。
3. **外部接入接口**
   - `nodeTypes` / `registerNodeType()` —— 业务节点
   - `plugins` / `use()` —— 横切能力（对齐、小地图、执行引擎等）
   - `onChange / onSelectionChange / onNodeCommand / onConnect / onDisconnect`
   - `storage: {load, save}` —— 持久化完全由产品决定（localStorage / 后端）
   - `onContextMenu(e, ctx) -> items[]` —— 右键菜单由产品提供
   - `layout` —— 可替换布局引擎
4. **序列化与撤销**：`toJSON()` 是唯一数据契约；`undo/redo` 基于快照；
   `fromJSON()` 过滤孤儿连线，和 writer 的 `_saneConnections` 同策略。
5. **样式以 writer 为准**：默认色板就是 writer 的 `--bg/--text/--border`、
   `--accent-green`（选中/连线），`--radius` 默认 0，1px 线框、hover 才显头部、
   圆点端口全部继承。对其他产品线只做变量回退（`--line/--panel/--dim`），
   但任何产品不得覆盖成与 writer 不同的圆角或强调色。

## 4. 最小接入示例

```html
<link rel="stylesheet" href="../zen-style/zen.css">
<script src="zen-canvas/layout-engine.js"></script>
<script src="zen-canvas/zen-canvas.js"></script>
<div id="canvas-host" style="position:relative;width:100%;height:100%"></div>
<script>
  const canvas = ZenCanvas.create({
    mount: document.getElementById('canvas-host'),
    scope: 'demo',
    nodeTypes: {
      source: {
        label: '数据源', category: '输入', glyph: '入', ports: ['right'],
        defaults: { path: '' },
        render(data, host, api) { host.textContent = data.path || '未选择文件' }
      },
      output: {
        label: '导出', category: '输出', glyph: '出', ports: ['left'],
        defaults: { format: 'mp4' },
        render(data, host) { host.textContent = data.format }
      }
    },
    onChange(data) { localStorage.setItem('demo.canvas', JSON.stringify(data)) },
    notify: msg => console.log(msg)
  })
  canvas.addNode('source', { path: 'a.mp4' }, { x: 160, y: 160 })
  canvas.addNode('output', { format: 'mp4' }, { x: 560, y: 160 })
  canvas.fitView()
</script>
```

## 5. API 速查

| 方法 | 说明 |
|---|---|
| `addNode(type, data, pos, opts)` / `updateNode(id, patch)` / `removeNode(id)` | 节点 CRUD |
| `getNodes()` / `getNode(id)` / `getSelection()` / `select/selectAll/clearSelection` | 查询与选择 |
| `addConnection(from,to,fromPort,toPort)` / `removeConnection(id)` / `getConnections()` | 连线 |
| `setNodeStatus(id, text, state)` | 节点状态徽标（`running/done/error/idle`） |
| `renderConnections()` / `refreshNode(id)` | 强制重绘 |
| `screenToWorld / worldToScreen / zoomAt / zoomBy / panBy / fitView / focusNode / setView` | 视口 |
| `autoLayout(strategy)` | `smart / layered / force / spine / radial / timeline` |
| `copySelection / paste / duplicate / deleteSelection / undo / redo` | 编辑 |
| `toJSON / fromJSON / exportFile` | 持久化 |
| `on(event, fn)` / `off` | 事件：`change/selection/connect/disconnect/nodeCommand/viewport/portDragStart/portDragEnd` |
| `use(plugin)` / `registerNodeType(type, def)` / `destroy()` | 扩展与生命周期 |

## 6. 迁移已有产品

- **ZenFlow**：目前只用布局引擎画静态 SVG，可保留原样；要升级为可拖拽画布时，
  把 `flowGraph()` 的节点映射成 `registerNodeType`，调用 `canvas.fromJSON()` 即可。
- **Writer**：writer 的交互层与文档/图片/涂鸦深度缠绕，不建议一次性替换。
  迁移路径是"先接桥、后切芯"：先让 writer 在保存时同时写出框架兼容的
  `toJSON()` 结构；确认无误后把它的 Manager 逐个替换为框架方法。本框架
  刻意保留了 writer 的类名与坐标约定，就是为了让这一步可行。

## 7. 变更纪律

- 改画布交互 → 只改 `zen-canvas/zen-canvas.js`；改画布样式 → 改
  `zen-style/features/canvas-framework.css`。
- 改自动布局算法 → 只改 `zen-canvas/layout-engine.js`。
- 产品特有逻辑（节点字段、执行引擎、面板）→ 放在产品自己的 JS 里，不要写进框架。
