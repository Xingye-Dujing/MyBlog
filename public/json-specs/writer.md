# ZenWriter 画布文件 JSON 规范 (.zc)

> 用途：让 AI（或任何程序）**直接生成画布文件**，用户在 ZenWriter 里
> 「导入文件」→ 选中该 `.zc` 文件即可看到画布。
>
> 本文所有字段名、默认值、容错行为都是从 `omm-writer.html` 的
> `buildCanvasData()`（写出）、`DocManager.importObject()` / `createDoc()`
> （读入）、`NodeManager._createNodeInner()` / `_buildContent()`（建节点）
> 里逐行核对出来的，不是推测。
>
> 兼容性：`v: 2`。当前代码不校验 `v`，但请保留它，未来版本会用到。

---

## 0. 一句话规则

**导入函数只看两样东西：`obj.nodes` 是不是数组，以及每个节点上的 `type` 和 `id`。**
其余字段全部可选，缺省行为见下。

导入永远是**新建一张画布**并切换过去，**绝不覆盖**已有画布。
画布名取 `name`，重名会自动加后缀去重。

---

## 0.5 给 AI 的提示词模板

把下面这段连同本文一起发给 AI，让它直接产出可导入的 `.zc`：

```text
你要生成一个 ZenWriter 画布文件（.zc，JSON 格式）。

严格遵守配套文档《zencanvas-JSON-spec.md》里的字段、缺省值和容错规则。硬性要求：

1. 顶层输出 { "format": "zenwriter-canvas", "v": 2, "name": "...", "nodes": [...], "connections": [...] }。
2. 每个节点必须有 "id"(唯一, 格式 node-数字) 和 "type"(text/todo/group/markdown/math/image 之一)。
3. 版面围绕世界原点排布：x 在 [-1500,1500]、y 在 [-1000,1000]，且 x、y 绝不能等于 0。
4. "w"/"h" 必须带 px 单位；不给就省略，让引擎自动。
5. 每条连线的 from/to 必须是真实存在的节点 id，且两者不同；端口取 top/bottom/left/right。
6. text/todo/group 的 "content" 是 HTML 片段，文本里的 & < > 必须转义成 &amp; &lt; &gt;。
7. markdown 只用：1-3 级标题、- 或 * 列表、1. 有序列表、> 引用、``` 代码块、
   以及行内 **粗** *斜* `码` [文字](链接)。不要用表格、图片、任务列表、4 级以上标题。
8. math 的 "source" 只写 LaTeX 本体，不要带 $ 或 \(；JSON 里的反斜杠写成 \\。
9. 图片只用 "srcMode": "url" 加一个 https 地址。绝对不要用 "link" 模式、
   不要写 "assetId"、不要写 blob: 地址。
10. 只输出 JSON 本身，不要 markdown 代码块围栏，不要注释，不要尾逗号。

最后自查并在 JSON 后附一份简短的检查清单，说明：节点总数、连线总数、
有无未连线节点、有没有用到 link/blob 模式。
```

## 1. 文件外壳

```jsonc
{
  "format": "zenwriter-canvas",   // 建议写；导入时仅用于人读，不参与判断
  "v": 2,                          // 格式版本
  "name": "我的画布",               // 画布名，会显示在左侧画布列表
  "exportedAt": 1760000000000,      // 可选，时间戳毫秒
  "nodes": [ /* 见第 3 节 */ ],
  "connections": [ /* 见第 4 节 */ ],
  "doodles": [ /* 见第 5 节，可选 */ ]
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `format` | 建议 | 固定 `"zenwriter-canvas"` |
| `v` | 建议 | 固定 `2` |
| `name` | 否 | 缺省用文件名（去扩展名），再缺省用 `"Canvas"` |
| `nodes` | **是** | 必须是数组。**这是唯一的硬性要求** |
| `connections` | 否 | 缺省 `[]` |
| `doodles` | 否 | 缺省 `[]` |

### 导入分派逻辑（照抄代码行为）

```
if (obj.format === 'zenwriter-library' && obj.docs)  -> 当作整库导入
else if (Array.isArray(obj.nodes))                  -> 当作单张画布导入 ✅
else                                                -> 报「无效文件」
```

所以：**只要顶层有 `nodes` 数组就能导入**，其余随便。
（顺带说明：菜单里「导出 → JSON」那种 `{nodes:[{type,title,content}]}` 的
极简格式也能导入，但它没有坐标，所有节点会叠在 `(100,100)`，
只适合当纯文本备份，**不要用它来生成可视画布**。）

---

## 2. 坐标与视图

- 节点坐标 `x` / `y` 是**世界坐标（px）**，可以正可以负，没有边界限制。
- 导入后的初始视图：缩放固定 `1`，世界原点 `(0,0)` 放在**视口正中**。
  程序**不会**自动缩放到内容边界。
- 因此：**请把版面围绕原点排布**，推荐范围
  `x ∈ [-1500, 1500]`、`y ∈ [-1000, 1000]`，导入后一眼就能看全。
- ⚠️ **坑**：`x` 的读取代码是 `parseFloat(n.x) || 100`。
  当 `x` 恰好等于 `0` 时，`0` 是 falsy，会被替换成 `100`。
  **不要用 0 当坐标**；起点请用 `100` 或 `-1500` 这类非零值。

---

## 3. 节点对象

### 3.1 通用字段（所有类型都有）

```jsonc
{
  "id": "node-1",              // 字符串，全局唯一
  "type": "text",              // 必填，见下表
  "x": -600,                   // 数字，世界坐标
  "y": -300,
  "w": "320px",                // CSS 长度字符串，必须带单位
  "h": "200px",                // 可省略，省略则高度由内容撑开
  "title": "背景",              // 头部标题，纯文本
  "locked": false,             // 锁定（不能拖动/编辑）
  "minimized": false,          // 折叠成 32px 高的标题条
  "collapsed": false,          // 仅 group 有意义，见 3.3
  "fontSize": "15px",          // 正文字号
  "lh": "1.8",                 // 行高（仅 text/todo/group）
  "borderColor": "#c96a2e"     // 边框色
}
```

| 字段 | 类型 | 缺省行为 | 备注 |
|---|---|---|---|
| `id` | string | 自动生成 `node-<n>` | **强烈建议显式给**，格式 `node-数字` |
| `type` | string | **无缺省** | 不填会得到一个空壳节点 |
| `x` / `y` | number | `100` | `0` 会被当成缺省，见第 2 节 |
| `w` / `h` | string | 宽 `400px`、最小 `200x100`、高自适应 | **必须带 `px`**，写 `"320"` 会无效 |
| `title` | string | `TEXT_01` / `IMAGE_02` … | ⚠️ 会被原样插进 HTML，**不能含 `<` `>` `&`** |
| `locked` | bool | `false` | |
| `minimized` | bool | `false` | 会强制 `height:32px` 并隐藏正文与缩放柄 |
| `collapsed` | bool | `false` | 仅 `group`：隐藏所有与它相连的节点 |
| `fontSize` | string/number | `14px` | `"15px"` 和 `15` 都行（内部会补 `px`） |
| `lh` | string/number | `1.8` | 仅 text/todo/group。写 `"1.8"` 或 `"28px"` |
| `borderColor` | string | 无（用主题默认） | 只接受 `#rgb` 或 `#rrggbb`，其它一律忽略并清除 |

**关于 `id`**：加载器会 `parseInt(id.split('-')[1])` 来推进新节点计数器。
所以请用 `node-1` … `node-20` 这种**纯数字后缀**，且**绝不重复**。
用 `a`、`b` 这种非数字 id 不会报错，但之后新建的节点可能撞 id，
导致连线指向错乱。**未知的多余字段会被静默忽略**（可以加自己的元数据，
但重新保存时会被丢掉，不要依赖往返）。

### 3.2 类型表

| `type` | 名称 | 正文来自 | 额外字段 |
|---|---|---|---|
| `text` | 文本 | `content`（**HTML**） | `lh` |
| `todo` | 待办 | `content`（**HTML**） | `lh`；勾选态由内容推断 |
| `group` | 分组 | `content`（**HTML**） | `lh`、`collapsed` |
| `markdown` | Markdown | `source`（Markdown 文本） | — |
| `math` | 公式 | `source`（LaTeX，**不带** `$`） | — |
| `image` | 图片 | `srcMode` / `src` | 见 3.5 |

### 3.3 group 的语义（重要）

**分组没有 `children` 字段。** 成员的判定完全来自连线：
凡是和该 group 有连线的节点，就是它的子节点。

- 想让 B、C 成为 A 的成员 → 连 `A→B`、`A→C`
- 再给 A 写 `"collapsed": true` → 载入后 B、C 被隐藏（点 A 的 ▼ 展开）
- `collapsed` 的组**不能**把 `locked: true` 的子节点藏起来（锁定优先）

### 3.4 text / todo / group 的 `content`

**这是原始 HTML**，会被 `innerHTML` 直接注入。纯文本必须自己转义：

```jsonc
"content": "<p>第一段</p><p>第二段<strong>加粗</strong></p>"
```

转义规则：正文里的 `&` → `&amp;`，`<` → `&lt;`，`>` → `&gt;`。

- 换行用 `<p>` 分段，或 `<br>`
- `fontSize` / `lh` 建议**只写在节点字段上**，不要写行内 `style`
- **todo 勾选态**：内容里出现 `<s>文字</s>`、`<strike>文字</strike>`
  或带 `line-through` 的元素，载入时会自动打勾并给容器加 `todo-done` 类。
  用 `<s>` 最稳。
- group 的 `content` 是它自己的标题区说明文字，不要在里面画框

### 3.5 markdown 的 `source`

内置渲染器是**手写的小型 Markdown**，不是完整 marked。**支持**：

| 语法 | 例子 |
|---|---|
| 标题 1–3 级 | `## 小标题`（4 级以上不生效，当普通段落） |
| 无序列表 | `- 项` / `* 项` |
| 有序列表 | `1. 项` |
| 引用 | `> 引用` |
| 围栏代码块 | 三个反引号成对包住 |
| 行内加粗 | `**粗**` |
| 行内斜体 | `*斜*` |
| 行内代码 | 反引号包住 |
| 链接 | `[文字](https://…)` |

**不支持**：表格、图片 `![]()`、任务列表 `- [ ]`、嵌套列表、删除线、
水平线、HTML 块（会被转义成纯文本）。

公式（MathJax 3，SVG 输出）：行内 `$…$` 或 `\(…\)`，独立 `$$…$$` 或 `\[…\]`。
`source` 会被 HTML 转义后再交给 MathJax，所以 LaTeX 里的 `<` `&` 不用管。

### 3.6 math 的 `source`

纯 LaTeX，**不要自带 `$` 或 `\(`**（渲染时会自动包 `$$`）。
例：`"source": "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\pi}}{2}"`
（JSON 里反斜杠必须写成 `\\`。）

### 3.7 image 的字段

```jsonc
{
  "type": "image",
  "srcMode": "url",              // "url" | "embed"
  "src": "https://example.com/a.png",
  "fileName": "a.png",           // 可选，仅显示用
  "mime": "image/png",           // 可选，仅显示用
  "size": 204800,                // 可选，仅显示用（字节）
  "imgW": "480",                 // 显示宽度（px）
  "imgH": "",                    // 显示高度（px），一般留空
  "imgRatio": "1"                // "1"=跟随原图比例，"0"=自由拉伸
}
```

**三种来源模式**：

| `srcMode` | 含义 | AI 能否使用 |
|---|---|---|
| `url` | `src` 是 http(s) 远程地址 | ✅ **推荐** |
| `embed` | `src` 是完整 `data:` URL（自带图片字节） | ✅ 可用，但文件会膨胀约 33% |
| `link` | `src` 为空，靠 `assetId` 去浏览器 IndexedDB 取字节 | ❌ **禁止** |

- **`link` 模式必须避开**：它的 `assetId` 是**本机浏览器**生成的 blob id，
  换个浏览器/换台设备根本不存在，导入进来必然是裂图。
- **不要写 `blob:` 开头的 `src`**：加载器检测到会直接清空（会话级地址必然失效）。
- 不写 `srcMode` 时会自动推断：`data:` 开头 → `embed`，否则 → `url`。
  写错也会被纠正（`embed` 却不是 `data:` 开头 → 退回 `url`；反之亦然）。
- **`embed` 必须自己把图片转成 data URL**：读远程图 → base64 → `data:image/png;base64,…`。
  写一个非法的 data URL 会被当 `url` 处理并显示裂图。
- 显示尺寸：`imgW` 缺省 `180`；`imgRatio: "1"`（缺省）表示高度自动按原图比例算，
  此时 `imgH` 会被忽略；`imgRatio: "0"` 才真正按 `imgH` 拉伸。
- 尺寸字段是**显示**尺寸，不改变图片本身，也不影响节点 `w`/`h`。
- 内嵌图片**没有体积上限**（数据存在 IndexedDB，不再受 5MB 限制），
  但 base64 会让 `.zc` 文件明显变大，请酌情使用。

---

## 4. 连线 `connections`

```jsonc
"connections": [
  { "from": "node-1", "to": "node-2", "fromPort": "bottom", "toPort": "top" },
  { "from": "node-1", "to": "node-3", "fromPort": "right", "toPort": "left" }
]
```

| 字段 | 必需 | 取值 | 缺省 |
|---|---|---|---|
| `from` | **是** | 某个存在的节点 `id` | — |
| `to` | **是** | 某个存在的节点 `id`（不能等于 `from`） | — |
| `fromPort` | 否 | `top` / `bottom` / `left` / `right` | `bottom` |
| `toPort` | 否 | `top` / `bottom` / `left` / `right` | `top` |

- 每个节点四个方向都有端口，连任意组合都合法，**不会**报错。
- **载入时会被静默丢弃并弹提示**的情况（务必自查）：
  - `from` / `to` 指向不存在的 id
  - `from` 缺失或不是字符串
  - 自环（`from === to`）
- 丢弃只发生在载入那一刻，且只丢弃这些坏连线，其余节点照常显示。

---

## 5. 涂鸦 `doodles`（可选）

手写笔迹，与节点共用同一套 `panX/panY/scale`，所以会跟着画布一起缩放平移。

```jsonc
"doodles": [
  {
    "c": "#cc3333",                 // 颜色，#rgb 或 #rrggbb
    "w": 3,                         // 线宽（世界坐标 px），> 0
    "a": 0.32,                      // 不透明度 0–1
    "p": [[-600, -300, 0.5], [-560, -280, 0.7], [-520, -260, 1]]
  }
]
```

| 字段 | 说明 / 容错 |
|---|---|
| `c` | 必须匹配 `#` + 3~8 位十六进制，否则整笔退回默认红色 |
| `w` | 非有限数或 ≤ 0 → 按 `3` 处理 |
| `a` | 非有限数或 ≤ 0 → 按 `1`（不透明）处理 |
| `p` | 必填数组，每个点 `[x, y]` 或 `[x, y, pressure]`。**至少要有 1 个有效点**，否则整笔丢弃 |

- `x` / `y` 同样是**世界坐标**，必须和节点用同一个坐标系。
- `pressure` 可选（0–1），缺省或 ≤ 0 按 `1` 处理。
- 非数字坐标的点会被跳过；一笔里所有点都无效 → 整笔丢弃。
- 笔迹点建议做抽稀（相邻点间距 ≥ 0.6 世界 px），否则文件会膨胀。

---

## 6. 最小可用示例

下面第 6、7 节的代码块是**完整严格合法的 JSON**，可以直接复制保存成 `.zc` 导入。
其余 ```jsonc 代码块都带注释，只是字段说明，不能直接导入。

```json
{
  "format": "zenwriter-canvas",
  "v": 2,
  "name": "最小示例",
  "nodes": [
    { "id": "node-1", "type": "text", "x": -400, "y": -160, "w": "320px",
      "title": "起点", "content": "<p>随便写点什么。</p>" },
    { "id": "node-2", "type": "text", "x": 80, "y": -160, "w": "320px",
      "title": "终点", "content": "<p>第二个节点。</p>" }
  ],
  "connections": [
    { "from": "node-1", "to": "node-2", "fromPort": "right", "toPort": "left" }
  ]
}
```

## 7. 完整示例（涵盖全部类型）

```json
{
  "format": "zenwriter-canvas",
  "v": 2,
  "name": "功能演示",
  "exportedAt": 1760000000000,
  "nodes": [
    {
      "id": "node-1", "type": "group", "x": -900, "y": -520, "w": "760px",
      "title": "背景资料", "collapsed": true,
      "content": "<p>这一组里的节点会被折叠隐藏。</p>",
      "borderColor": "#8a8a8a"
    },
    {
      "id": "node-2", "type": "text", "x": -880, "y": -300, "w": "340px",
      "title": "摘要", "fontSize": "15px", "lh": "1.8",
      "content": "<p>正文是 <strong>HTML</strong>，&amp; 这类字符要转义。</p>"
    },
    {
      "id": "node-3", "type": "todo", "x": -880, "y": -100, "w": "340px",
      "title": "待办", "content": "<p><s>已完成的事</s></p><p>还没做的事</p>"
    },
    {
      "id": "node-4", "type": "markdown", "x": -440, "y": -300, "w": "420px",
      "title": "笔记", "fontSize": "14px",
      "source": "## 小标题\n\n- 第一项\n- 第二项\n\n> 一句引用\n\n行内公式 $E=mc^2$"
    },
    {
      "id": "node-5", "type": "math", "x": -440, "y": -60, "w": "420px",
      "title": "公式",
      "source": "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}"
    },
    {
      "id": "node-6", "type": "image", "x": 80, "y": -300, "w": "360px",
      "title": "配图",
      "srcMode": "url",
      "src": "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png",
      "imgW": "320", "imgRatio": "1"
    },
    {
      "id": "node-7", "type": "text", "x": 80, "y": -40, "w": "360px",
      "title": "锁定节点", "locked": true,
      "content": "<p>拖不动、也改不了。</p>"
    }
  ],
  "connections": [
    { "from": "node-1", "to": "node-2", "fromPort": "bottom", "toPort": "top" },
    { "from": "node-1", "to": "node-3", "fromPort": "bottom", "toPort": "top" },
    { "from": "node-2", "to": "node-4", "fromPort": "right", "toPort": "left" },
    { "from": "node-4", "to": "node-5", "fromPort": "bottom", "toPort": "top" },
    { "from": "node-5", "to": "node-6", "fromPort": "right", "toPort": "left" }
  ],
  "doodles": [
    { "c": "#cc3333", "w": 3, "a": 0.32,
      "p": [[-1000, -560, 0.6], [-940, -545, 0.8], [-880, -560, 1]] }
  ]
}
```

---

## 8. 给生成方的硬性检查清单

生成 `.zc` 后，逐条自查：

1. 顶层有 `"nodes"` 数组，`format` 为 `"zenwriter-canvas"`，`v` 为 `2`。
2. **每个节点都有 `type`**，且取自 6 个合法值。
3. 所有 `id` 唯一，格式 `node-1`、`node-2`…（纯数字后缀）。
4. 每条连线的 `from` / `to` 都**确实存在**于 `nodes` 中，且两者不同。
5. `x` / `y` 是数字、**非 0**，版面围绕原点（`x ∈ [-1500,1500]`、`y ∈ [-1000,1000]`）。
6. `w` / `h` 若写了，**必须带 `px` 单位**；不写就让引擎自动。
7. text / todo / group 的 `content` 是合法 HTML 片段，文本里的
   `&` `<` `>` 已转义；标题不含 `<` `>` `&`。
8. markdown 只用了第 3.5 节列出的语法；math 的 `source` 不带 `$`，
   反斜杠已按 JSON 规则写成 `\\`。
9. 图片只用 `url`（或正确的 `data:` URL）；**没有** `link` 模式、
   **没有** `assetId`、**没有** `blob:` 地址。
10. `doodles` 里每笔至少有一个 `[x, y]` 有效点。
11. 文件是 **UTF-8** 编码的合法 JSON（不要有注释、不要有尾逗号）。

只要 1–4 条满足，导入就一定成功并显示全部节点；
5–11 条决定「好不好看」。

---

## 9. 整库备份格式 `.zwlib`（进阶，一般用不到）

如果你要生成的是**多张画布打包**，用这个外壳：

```jsonc
{
  "format": "zenwriter-library",   // 触发整库导入
  "v": 2,
  "activeId": "doc-a",             // 导入后打开哪张
  "order": ["doc-a", "doc-b"],     // 左侧列表顺序
  "meta": {                        // 列表显示信息，可省略
    "doc-a": { "name": "第一张", "createdAt": 0, "updatedAt": 0, "nodes": 7 }
  },
  "docs": {
    "doc-a": {
      "name": "第一张",
      "createdAt": 0,
      "updatedAt": 0,
      "view": { "panX": 0, "panY": 0, "scale": 1 },   // 可省略 → 省略则用默认视图
      "nodes": [ /* 同上 */ ],
      "connections": [],
      "doodles": []
    },
    "doc-b": { "name": "第二张", "nodes": [] }
  },
  "settings": { }                  // 可选，界面设置
}
```

- `docs` 的键是画布 id，可以随便起（**不必**是 `doc-` 开头）。
- 每张画布**必须有 `nodes` 数组**，否则整张被跳过。
- `view` 省略时该画布打开后以缩放 1、原点居中显示（同 `.zc`）。
- 导入后画布名重名会自动去重，id 由程序重新分配，你的 id 只在文件内部有效。

---

## 10. 行为速查

| 情况 | 结果 |
|---|---|
| 顶层没有 `nodes` 数组 | 提示「无效文件」，什么都不变 |
| 某节点 `type` 缺失/非法 | 出现一个**空壳节点**（有边框、无正文），其余正常 |
| 某节点在构建时抛异常 | 该节点退化为空壳并写日志，**不影响同画布其它节点** |
| 连线指向不存在的节点 | 该连线被丢弃，弹提示告知丢弃了几条 |
| 已有同名画布 | 自动改名（加后缀） |
| 重复导入同一文件 | 生成**多张**画布，互不影响 |
| 画布非常大 | 无节点数 / 体积上限，IndexedDB 存储 |