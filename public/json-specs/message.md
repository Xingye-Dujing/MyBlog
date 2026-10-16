# ZenMessage 数据 JSON 规范（重要：本应用**没有**文件导入）

> 用途：说清楚 `omm-message.html`（ZenMessage）**到底把什么以 JSON 形式读/写**，
> 让 AI 或程序理解真实数据模型，并知道**哪些 JSON 是自己能生成的、哪些不能**。
>
> 本文每个字段名、默认值、容错行为都是从 `omm-message.html` 的
> `cfg()` / `savePrefs()` / `loadUi()` / `loadCache()` / `persistCache()` /
> `normalizeMessage()` / `enc()` / `dec()` / `messageFromPayload()` /
> `send()` / `fetchHistory()` / `subscribe()` / `setFavorite()` / `sqlText()`
> 里逐行核对出来的，不是推测。
>
> 结论先行：**消息正文不存在本地文件里，也不支持“导入文件”。**
> 消息存在 Supabase Postgres，且落库前的 `payload` 是**用用户密码加密的信封**，
> 本地只有“配置 / 界面偏好 / 最近消息缓存 / 收藏 id”这几种明文 JSON。

---

## 0. 一句话规则

**这个 App 不接受任何“导入 JSON 文件”的操作。** 全文里没有 `FileReader`、
没有 `<input type="file">`、没有 `导入 / 恢复 / 上传 / readAsText / createObjectURL / download`
之类读写数据文件的代码。唯一带 `import` 字样的是加密用的
`crypto.subtle.importKey`（第 2959 行），与文件导入无关；唯一的“复制 SQL”导出的是**建表 SQL**、
不是数据。

所以你（AI）**无法生成一个“丢进去就出现聊天历史”的文件**。本文剩下的部分是：
把应用**真实读/写的那几份明文 JSON**（localStorage 里的 cfg / ui / cache / cache-favorites）
和**消息在内存/数据库里的结构**（规范化消息对象、加密前的消息内容、加密信封、Supabase 行）
讲明白，供**理解与参考**。真要“灌数据”，只有两条现实路径，且都不是文件导入：

1. **往 localStorage 注入 JSON**（配置 / 界面 / 消息缓存 / 收藏 id）—— 见 §2–§5、§7。
2. **往 Supabase 表插行**（`payload` 列必须是加密信封）—— 见 §6、§8，
   **且这一步 AI 做不到**，因为密钥来自用户浏览器本地密码，见 §6 的警告。

---

## 0.5 给 AI 的提示词模板（诚实版）

把下面这段连同本文发给 AI，让它产出“对应用有意义的结构”。**不要**让它假装产出一个能“导入”的消息文件——
那个东西不存在。

```text
你在为 ZenMessage（omm-message.html）产出 JSON。请先读配套文档《message.md》。

硬事实：
1. 该 App 没有任何“文件导入”功能。消息存在 Supabase Postgres，落库 payload 是用用户本地
   密码 AES-GCM 加密后的信封，AI 拿不到密码、也无法伪造合法消息行。
2. 因此只允许产出以下“应用真的会读的明文 JSON”，并逐条标注它是“参考/手动注入 localStorage”，
   不是“导入文件”：
   - 配置对象 cfg（zmsg-supabase-config-v1）：{ url, key, email, remember, autoSync, warnAck }
     （password 仅当 remember=true 才出现，属敏感，默认不要写）。
   - 界面偏好 ui（zmsg-ui-v1）：{ theme, bg, fscale, radius, pinned }。
   - 消息缓存数组 cache（zmsg-message-cache-v1）：每项是规范化消息对象，只保留
     id/deviceId/deviceName/ts/text/quoteId/quoteText/quoteDeviceName/quoteDeleted/editedAt。
   - 收藏 id 数组 cache-favorites（zmsg-message-cache-v1-favorites）：字符串 uuid 数组。
3. 若要展示“一条消息的逻辑内容”，用加密前的明文 payload：
   { "__zmsg": 1, "text": "...", "quoteId": null, "quoteText": "", "quoteDeviceName": "", "editedAt": 0 }，
   并注明它是内存/明文结构，落库时会被加密、不能直接当文件导入。
4. id 一律是 UUID 字符串；ts / editedAt 是毫秒整数（editedAt=0 表示未编辑）。
5. 只输出合法 JSON（UTF-8、无注释、无尾逗号），并在末尾附一句“这是参考结构、非文件导入”。
```

---

## 1. 数据到底存在哪（真实数据模型）

ZenMessage 是**云端多端同步**的消息板，数据分三层，从“权威”到“临时”：

| 层 | 位置 | 内容 | 是否明文 JSON | AI 能生成吗 |
|---|---|---|---|---|
| **权威数据** | Supabase Postgres `zmessage_messages` / `zmessage_message_meta` | 每条消息一行（正文加密）；每条收藏一行 | 行是 JSON，但 `payload` 列是**加密信封字符串** | ❌ 落库正文需用户密码加密，AI 伪造不了 |
| **内存消息** | JS `messages` 数组 | 规范化消息对象（§4） | 是（运行期内存，非文件） | ✅ 逻辑结构可参考 |
| **本地缓存/偏好** | `localStorage`（`LS.*` 四个键 + 两个字符串键） | 配置 / 界面 / 最近 250 条消息缓存 / 收藏 id | **是，明文 JSON** | ✅ 可生成（手动注入，非导入） |

> 关键：本地缓存**只是显示用的快照**。清掉本地缓存不影响云端历史；反过来，
> 你手动注入本地缓存 JSON 也**不会**把消息同步到云端（没有加密 payload、不会触发 Realtime）。

---

## 2. localStorage 键总览

键名常量定义在 `LS`（第 2581 行）：

```jsonc
// 常量（源码，非可导入文件）
const LS = {
  cfg:    'zmsg-supabase-config-v1',      // 配置（明文对象）
  ui:     'zmsg-ui-v1',                    // 界面偏好（明文对象）
  cache:  'zmsg-message-cache-v1',         // 最近 250 条消息缓存（明文数组）
  device: 'zmsg-device-v1'                 // 设备（用后缀，见下，值是纯字符串不是 JSON）
}
const TABLE      = 'zmessage_messages'      // 消息表
const META_TABLE = 'zmessage_message_meta'  // 收藏/编辑元数据表
```

实际键与存储格式：

| 完整键名 | 存的内容 | 读/写函数 | 读缺省 |
|---|---|---|---|
| `zmsg-supabase-config-v1` | cfg 对象 JSON | `cfg()` 读 / `saveCfg()` 写 | `'{}'`，坏 JSON 吞异常返回 `{}` |
| `zmsg-ui-v1` | ui 对象 JSON | `loadUi()` 读 / `saveUi()` 写 | `'{}'`，`Object.assign` 合并到默认 |
| `zmsg-message-cache-v1` | 规范化消息对象**数组** JSON | `loadCache()` 读 / `persistCache()` 写 | `'[]'`，非数组则忽略 |
| `zmsg-message-cache-v1-favorites` | 收藏消息 id 的**字符串数组** JSON | `loadCache()` 读 / `persistCache()` 写 | `'[]'`，非数组则视为空 Set |
| `zmsg-device-v1-id` | 设备 UUID（**纯字符串**，非 JSON） | `lsGet`/`lsSet`，缺省 `crypto.randomUUID()` | `''` |
| `zmsg-device-v1-name` | 设备名（**纯字符串**，非 JSON） | `lsGet`/`lsSet` | `''` |
| `zmsg-ui-v1-lang` | 语言 `'zh'`/`'en'`（**纯字符串**） | 直接 `localStorage.getItem` | `'zh'` |

> 注意后三个键存的是**裸字符串**，不是被 `JSON.parse` 解析的对象，别给它们包引号或写花括号。

---

## 3. 配置对象 cfg（`zmsg-supabase-config-v1`）

`cfg()`（第 2635 行）读，`savePrefs()`→`saveCfg()`（第 2662–2690 行）写。
字段由 `savePrefs` 决定，`prefs()`（第 2665 行）取用：

```jsonc
{
  "url": "https://xxxxxxxx.supabase.co", // Supabase 项目 URL（连接必需）
  "key": "eyJ...anon...",                // Supabase anon/public key（连接必需）
  "email": "user@example.com",           // 登录邮箱（记住用）
  "remember": false,                      // 是否本地记住密码
  "autoSync": false,                      // 打开即自动同步
  "warnAck": false,                       // 已确认云端风险弹窗
  "password": "用户明文密码"               // 仅当 remember=true 时才写入！否则字段被删除
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `url` / `key` | **是（连接前提）** | `connect()` 与 UI 门控都靠 `c.url && c.key`（第 3038、4040、2769 行） |
| `email` | 否 | 仅回填登录框 |
| `remember` | 否 | `savePrefs` 会 `!!` 归一为布尔 |
| `autoSync` | 否 | 同上 |
| `warnAck` | 否 | 同上 |
| `password` | **敏感** | 只有 `remember && password` 同时成立才落盘，否则 `delete c.password`（第 2688–2689 行）。**AI 生成示例时不要编造真实密码。** |

> `savePrefs` 每次都会**先删掉** cfg 里的 `remember/autoSync/warnAck/password` 再按新值写回，
> 所以这四个是“受管字段”；`url/key/email` 及其它未知字段则被 `Object.assign(cfg(), next)` 原样保留。

---

## 4. 规范化消息对象（内存 & `zmsg-message-cache-v1` 数组元素）

这是**消息在运行期的唯一真身**。`normalizeMessage()`（第 3067 行）强制只保留这 10 个键，
`addMessage()`（第 3471 行）把每条消息先规整再 push 进 `messages`，
`persistCache()`（第 2920 行）写的是 `messages.slice(-250)`；
`loadCache()`（第 2930 行）读回来再 `.map(normalizeMessage)` 走一遍（幂等）。

```jsonc
{
  "id": "0f1c2a9e-...-uuid",   // UUID 字符串（来自 DB row.id），缓存内按 id 去重
  "deviceId": "a-b-c-uuid",     // 发送设备 id（zmsg-device-v1-id）
  "deviceName": "PHONE",        // 发送设备名，缺省 ''
  "ts": 1760000000000,          // 毫秒整数；缺省/非数 → Date.now()（源码兜底）
  "text": "你好",                // 纯文本；非字符串 → ''
  "quoteId": null,              // 被引用消息 id（uuid 字符串）或 null
  "quoteText": "",              // 引用到的正文快照；非字符串 → ''
  "quoteDeviceName": "",        // 引用设备名，缺省 ''
  "quoteDeleted": false,        // 被引用消息已删除则为 true
  "editedAt": 0                 // 编辑时间毫秒；0 = 从未编辑
}
```

| 字段 | 类型 | 缺省/容错（源码事实） |
|---|---|---|
| `id` | string | 原样保留，**缓存去重的唯一键**；不要重复 |
| `deviceId` | string | `|| ''` |
| `deviceName` | string | `|| ''` |
| `ts` | number | `Number(m.ts) || Date.now()`（注意 0 会被换成“现在”） |
| `text` | string | `typeof === 'string' ? m.text : ''` |
| `quoteId` | string/null | `m.quoteId || null`（空串会成 null） |
| `quoteText` | string | `typeof === 'string' ? m.quoteText : ''` |
| `quoteDeviceName` | string | `|| ''` |
| `quoteDeleted` | boolean | `!!m.quoteDeleted` |
| `editedAt` | number | `Number(m.editedAt) || 0` |

**这里没有的字段**（务必不要臆造）：没有 `type`、没有 `html`、没有 `from`、没有 `attachments`、
没有消息上的 `favorite` 标记。消息**只有一种纯文本类型**，渲染走转义（`filteredMessages`/搜索只用
`text/deviceName/quoteText/quoteDeviceName`，第 3089 行）。**收藏是独立机制**，见 §7。

> `quoteDeleted` 的两处来源：`fetchHistory` 里“引用目标不在本批 250 条内”置 true（第 3518 行）；
> 收到 DELETE / 删除后把指向该 id 的引用标记为 deleted（第 3596、3724 行）。手动注入缓存时想表达
> “引用已删除”，直接写 `quoteDeleted: true` 即可。

---

## 5. 界面偏好 ui（`zmsg-ui-v1`）

默认值在第 2599 行；`loadUi()` 用 `Object.assign(ui, JSON.parse(...))` **浅合并**（第 2816 行），
`applyUi()` 消费这些键（第 2823–2831 行）。未知键会被原样存进对象但不生效。

```jsonc
{
  "theme": "light",    // 'light' | 'dark'
  "bg": "bg-void",     // 背景类名：会 document.body.classList.add(ui.bg)，取值须是预置 bg-* 类
  "fscale": 1,          // 字号缩放，范围约 0.85–1.4（按 +0.05/-0.05 步进；写 CSS 变量 --fscale）
  "radius": 6,          // 圆角像素，0–14（写 --radius = radius + 'px'）
  "pinned": true        // 顶栏菜单是否固定展开
}
```

| 字段 | 合法取值 | 说明 |
|---|---|---|
| `theme` | `'light'` / `'dark'` | 其它值按非 dark 处理 |
| `bg` | 页面里已有的 `bg-*` 类名 | `applyUi` 先正则清除 `bg-\S+` 再 `add(ui.bg)`；写不存在的类名＝无背景 |
| `fscale` | number | 直接写进 `--fscale`，一般 0.85–1.4 |
| `radius` | number | 写进 `--radius`（带 px），0–14 |
| `pinned` | boolean | 控制菜单/图钉的 `pinned` 类 |

---

## 6. 消息内容 payload 与加密信封（`payload` 列 = 真身，AI 造不出）

`send()`（第 3886 行）先构造**明文内容对象**，交给 `enc()` 加密；
`enc()`（第 2974–2993 行）产出**信封 JSON 字符串**，这个字符串就是数据库 `payload` 列里存的东西。
读回时 `dec()`（第 2994 行）解析信封、解密，再 `JSON.parse` 明文；
`messageFromPayload()`（第 3010 行）把明文合并进 §4 的规范化对象。

### 6.1 加密前的明文内容（`{ __zmsg:1, ...data }`）

`enc` 里 `data` = `send` 传入的对象；序列化时打成 `JSON.stringify({ __zmsg:1, ...data })`（第 2978 行）。
这就是消息正文的**逻辑 schema**（解密后内存里的形态）：

```jsonc
{
  "__zmsg": 1,                   // 版本/格式标记；dec 后若不是 1 会被当成纯文本历史消息
  "text": "你好",                 // 正文纯文本
  "quoteId": null,               // 引用消息 id 或 null
  "quoteText": "",               // 引用正文快照
  "quoteDeviceName": "",         // 引用设备名
  "editedAt": 0                  // 编辑时间毫秒；编辑保存时写 Date.now()（第 3774 行）
}
```

> 兼容路径：如果解密出的明文**不是** `{__zmsg:1}` 对象（例如早期纯文本），`dec` 返回原字符串，
> `messageFromPayload` 走“纯字符串消息”分支（第 3021 行），只填 `text`。

### 6.2 落库的信封（`payload` 列真正的值，是字符串）

`enc()` 返回 `JSON.stringify({ v, alg, kdf, iter, salt, iv, cipher })`（第 2984–2992 行）：

```jsonc
{
  "v": 1,                          // 信封版本；dec 里 o.v!==1 或 o.alg!=='AES-GCM' → 抛“无效消息”
  "alg": "AES-GCM",                // 固定
  "kdf": "PBKDF2-SHA256",          // 派生方式
  "iter": 310000,                  // PBKDF2 迭代次数
  "salt": "base64...",             // 16 字节随机 salt（base64）
  "iv": "base64...",               // 12 字节随机 IV（base64）
  "cipher": "base64..."            // §6.1 明文经 AES-GCM 加密后的密文（base64）
}
```

⚠️ **AI 不能生成合法的 `payload`**。因为：
- 密钥由 `keyFor(password, salt)` = PBKDF2(**用户的本地明文密码**, SHA-256, 310000 次) 派生（第 2958 行）；
- 密码只在用户浏览器里，**从不上传云端**（除非用户勾“记住密码”落到本地 cfg）；
- 没有密码就无法算出密钥、无法产出能被该用户设备解开的 `cipher`。
- 硬凑一个信封即使 `v/alg/iter/salt/iv` 都写对，`cipher` 也是假的，`dec` 会解密失败抛异常，
  该条消息在同步/渲染时被 catch 掉（第 3512、3553 行）。

**结论：往数据库插消息这一步，只有“用户本人带着密码在浏览器里操作”才能完成，不是 AI 生成文件能替代的。**

---

## 7. 收藏 favorites

收藏**不在消息对象里**（§4 明确没有 favorite 字段），而是两条独立记录：

### 7.1 本地收藏 id 数组（`zmsg-message-cache-v1-favorites`）

`persistCache()` 写 `Array.from(favoriteIds)`（第 2921 行）——就是**消息 uuid 字符串的数组**。
`loadCache()` 读回并 `new Set(...)`（第 2928 行）。`isFavorite(id)`（第 3081 行）据此判断。

```jsonc
// 例：这两条消息被收藏（元素必须是真实存在于 cache 里的消息 id 字符串）
["0f1c2a9e-1111-2222-3333-444455556666", "9a8b7c6d-...-uuid"]
```

### 7.2 云端收藏行（`zmessage_message_meta` 表）

`setFavorite()`（第 3184–3204 行）先 `update`，无行则 `insert` 这条元数据：

```jsonc
{
  "user_id": "auth-用户UUID",        // = session.user.id（RLS 按它隔离）
  "message_id": "被收藏消息的uuid",   // = zmessage_messages.id（外键，级联删除）
  "device_id": "a-b-c-uuid",         // 操作设备
  "device_name": "PHONE",            // 操作设备名（缺省 ''）
  "favorite": true,                  // true=收藏 false=取消
  "edited_at": 0,                    // 该表也预留编辑位；insert 时写 0
  "updated_at": "2026-01-01T00:00:00.000Z" // ISO 字符串（new Date().toISOString()）
}
```

> 收藏 id 数组里出现的 uuid，必须是 §4/§8 消息对象的 `id`（即 `zmessage_messages.id`），
> 否则 `isFavorite` 命中不到、界面上也不会有对应消息可标星。

---

## 8. Supabase 表结构与行 shape（来自 `sqlText()`，第 3051 行）

建表 SQL 由 App 自己生成给用户去 Supabase 执行（“复制 SQL”功能）。列定义如下：

### 8.1 `public.zmessage_messages`（TABLE）

| 列 | 类型 | 约束/默认 | 对应 `send()` insert 字段（第 3895–3901 行） |
|---|---|---|---|
| `id` | `uuid` | PK，`gen_random_uuid()` | 不写，服务端生成，回读得到 |
| `user_id` | `uuid` | NOT NULL，FK→`auth.users(id)` ON DELETE CASCADE | `session.user.id` |
| `device_id` | `text` | NOT NULL | `deviceId`（zmsg-device-v1-id） |
| `device_name` | `text` | NOT NULL，默认 `''` | `deviceName \|\| 'DEVICE'` |
| `payload` | `text` | NOT NULL | **§6.2 的加密信封字符串** |
| `client_created_at` | `bigint` | NOT NULL | `ts = Date.now()`（毫秒） |
| `created_at` | `timestamptz` | NOT NULL，默认 `now()` | 不写，服务端生成 |

`fetchHistory()` 读列（第 3492 行）：`id,device_id,device_name,payload,client_created_at,created_at`，
按 `client_created_at` 升序、`limit 250`、`.eq('user_id', session.user.id)`。
行 → 消息对象映射见第 3505–3510 行：`id→id`、`device_id→deviceId`、`device_name→deviceName`、
`client_created_at`（或 `created_at`）→`ts`，正文来自 `dec(payload)`。

### 8.2 `public.zmessage_message_meta`（META_TABLE）

| 列 | 类型 | 约束/默认 |
|---|---|---|
| `user_id` | `uuid` | NOT NULL，FK→`auth.users(id)` CASCADE |
| `message_id` | `uuid` | NOT NULL，FK→`zmessage_messages(id)` CASCADE |
| `device_id` | `text` | NOT NULL，默认 `''` |
| `device_name` | `text` | NOT NULL，默认 `''` |
| `favorite` | `boolean` | NOT NULL，默认 `false` |
| `edited_at` | `bigint` | NOT NULL，默认 `0` |
| `created_at` | `timestamptz` | NOT NULL，默认 `now()` |
| `updated_at` | `timestamptz` | NOT NULL，默认 `now()` |
| PK | | `(user_id, message_id)` |

两张表都 `enable row level security`、仅 `authenticated` 可增删改查、`anon` 全 revoke、
policy 一律 `auth.uid() = user_id`，且都加进了 `supabase_realtime` publication。

### 8.3 Realtime 通道（`subscribe()`，第 3533 行）

- 通道名：`'zmsg-user-' + session.user.id`
- 监听 `postgres_changes`：`schema:'public'`，`table: TABLE` / `META_TABLE`，
  `event:'INSERT'/'UPDATE'/'DELETE'`，`filter:'user_id=eq.' + session.user.id`。
- INSERT/UPDATE on TABLE → `messageFromPayload(await dec(row.payload), base)` → `addMessage`（第 3546、3570 行）。
  **所以新消息进 UI 也必须能解密 `payload`，明文 JSON 插进去是显示不出来的。**

---

## 9. 可直接产出的 JSON 示例（**均为参考 / 手动注入 localStorage，非文件导入**）

下面每一段都是**严格合法的 JSON**，对应“应用真的会 `JSON.parse` 的那几个键”。
“注入方式”是指：用户/程序把这段写进对应 localStorage 键（本 App 自身没有读文件的导入入口）。

### 9.1 配置 cfg（写进 `zmsg-supabase-config-v1`；**password 字段此处故意省略**）

```json
{
  "url": "https://demo-project.supabase.co",
  "key": "public-anon-key-placeholder",
  "email": "demo@example.com",
  "remember": false,
  "autoSync": false,
  "warnAck": true
}
```

### 9.2 界面偏好 ui（写进 `zmsg-ui-v1`）

```json
{
  "theme": "dark",
  "bg": "bg-void",
  "fscale": 1.1,
  "radius": 8,
  "pinned": true
}
```

### 9.3 消息缓存数组（写进 `zmsg-message-cache-v1`；元素即 §4 规范化对象）

```json
[
  {
    "id": "11111111-1111-4111-8111-111111111111",
    "deviceId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "deviceName": "PHONE",
    "ts": 1760000000000,
    "text": "第一句话",
    "quoteId": null,
    "quoteText": "",
    "quoteDeviceName": "",
    "quoteDeleted": false,
    "editedAt": 0
  },
  {
    "id": "22222222-2222-4222-8222-222222222222",
    "deviceId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "deviceName": "PHONE",
    "ts": 1760000005000,
    "text": "引用了上面那条",
    "quoteId": "11111111-1111-4111-8111-111111111111",
    "quoteText": "第一句话",
    "quoteDeviceName": "PHONE",
    "quoteDeleted": false,
    "editedAt": 0
  }
]
```

### 9.4 收藏 id 数组（写进 `zmsg-message-cache-v1-favorites`；元素须是 9.3 里的消息 id）

```json
["11111111-1111-4111-8111-111111111111"]
```

### 9.5 一条消息的“明文内容 payload”（§6.1；仅示意逻辑结构，**落库要加密、非导入**）

```json
{
  "__zmsg": 1,
  "text": "你好，世界",
  "quoteId": null,
  "quoteText": "",
  "quoteDeviceName": "",
  "editedAt": 0
}
```

---

## 10. 给生成方的硬性检查清单（reference-only）

1. **不要宣称“导入文件”**：本 App 无文件导入。产出的 JSON 要么注入 localStorage（§2–§5、§7、§9），
   要么仅用于理解数据模型（§4、§6、§8）。在回复里明确标注这一点。
2. 配置对象里**不要编造真实密码**；`url/key` 只是连接地址与 anon key 的占位/示例。
3. 消息对象**只写 §4 的 10 个键**，不要塞 `type`/`html`/`from`/`attachments`/`favorite`（都不存在）。
4. 所有 `id` / `deviceId` / `quoteId` 用 UUID 字符串；`ts` / `editedAt` 用毫秒整数（`0`=未编辑）。
   缓存内 `id` **不要重复**（`addMessage` 按 id 合并）。
5. 收藏数组里的每个 uuid，必须能在消息缓存/数据库里对上，否则标星无意义。
6. `bg` 用页面已存在的 `bg-*` 类名；`theme` 只用 `light`/`dark`；`fscale` 0.85–1.4；`radius` 0–14。
7. **绝不要试图伪造 `payload` 列的加密信封**（§6.2）——缺用户本地密码就解不开，插入也会被
   `dec` 抛错丢弃；这不是“生成文件”能绕过的。
8. 输出是 UTF-8 合法 JSON（无注释、无尾逗号）。本文 §3–§6 的 `jsonc` 块带注释仅供说明，不能直接用。

---

## 11. 行为速查（读代码所得）

| 情况 | 结果 |
|---|---|
| 声称要“导入消息文件” | 不可能，App 无文件导入功能（全文无 FileReader / `<input type=file>`） |
| 手动往 `zmsg-message-cache-v1` 注入合法数组 | 打开即经 `loadCache→normalizeMessage` 渲染显示；**不会**上传云端、不会触发 Realtime |
| 注入的消息缺字段 | `normalizeMessage` 补默认（`''`/`null`/`0`/`Date.now()`），多余字段被静默丢弃 |
| 消息缓存超长 | `persistCache` 只保留最后 250 条（`slice(-250)`） |
| 收藏 id 指向不存在的消息 | `isFavorite` 命中不到，界面无可标星对象 |
| 想往数据库插一条消息 | 必须 `enc()` 用**用户本地密码**生成信封后 insert；AI 无密码 → 造不出合法 `payload` |
| 收到无法解密的历史行 | `fetchHistory` 整批抛“解锁失败”（第 3513 行）；Realtime 单条 catch 后丢弃（第 3553 行） |
| cfg 的 `password` 字段 | 仅 `remember=true` 时落盘；否则 `savePrefs` 删除之（第 2688–2689 行） |
| “复制 SQL” | 导出的是 §8 建表 SQL 文本，不是数据、也不是可导入文件 |
