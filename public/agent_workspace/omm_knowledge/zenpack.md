# ZenPack 工作区包规范

ZenPack 是把 OMM-ZEN 整个工作区搬到另一台设备的可移植文件。它不是新的备份格式：
打包、校验、差异、合并与恢复全部由 `lib/zen-backup.js` 的 `ZenBackup` 处理，
`lib/zen-pack.js` 只是增加工作区键目录与文件读写入口的薄包装。

## 文件格式

沿用 `zen-backup` 清单：

```json
{
  "format": "zen-backup",
  "v": 1,
  "createdAt": "ISO 8601",
  "name": "OMM-ZEN 工作区包",
  "products": [
    { "id": "zen.cards.v1", "name": "zen.cards.v1", "version": "1",
      "savedAt": "ISO 8601", "checksum": "fnv1a-36", "data": [] }
  ]
}
```

- `id` 就是 localStorage 的键名，恢复时按原键写回。
- `data` 能解析成 JSON 的存解析后的值，否则保留原始字符串。
- `checksum` 由 `ZenBackup.checksum(data)` 计算，导入时逐项校验。

## 工作区键目录

`ZenPack.WORKSPACE_KEYS` 覆盖四类数据：

- 卡片与剪藏：`zen.cards.v1`、`zen.inbox.v1`、`zen.clip.v1`
- 自动化规则：`zen.flow.rules.v1`、`zen.flow.strategy.v1`
- 笔记与设置：`zc-docs`、`zc-settings`、`zc-autosave`、`zwLayoutStrategy`、
  `zwDocListMode`、`zp-settings-v1`、`zr-settings`、`zenglish-supabase-config-v1`、`zen.theme`
- 工作台状态：`omm-search-v1`、`omm.hub.appearance.v1`、`omm.hub.pins.v1`、
  `omm.hub.workspaces.v1`、`omm.hub.recent.v1`、`omm.hub.usage.v1`、`omm.bridge.ping.v1`

## 通用函数（供产品直接调用）

```js
import { ZenPack } from './zen-pack.js'

ZenPack.scanWorkspace(localStorage)      // [{ id, name, data }]，交给清单
ZenPack.makePack(localStorage, { name }) // 生成 zen-backup 清单
ZenPack.readPack(text)                   // 解析并校验，失败抛错
ZenPack.planPack(current, incoming)      // { diff, merged }，委托 ZenBackup
ZenPack.restoreEntries(manifest)         // [{ key, value }]
ZenPack.applyPack(manifest, storage)     // 写回并返回写入键数
```

## 产品入口

`omm-zenbackup.html` 的“ZenPack 工作区包”面板直接调用上述函数：
收集整个工作区 → 导出文件；导入后展示差异 → 确认后恢复。
原有 ZenBackup 清单、手动添加、合并与恢复流程保持不变。

## 给 AI 的提示词模板

```text
生成一个 OMM-ZEN 工作区包 JSON，严格输出文件本身：
- 顶层 format 必须为 "zen-backup"，v 必须为数字 1
- products 为数组，每项含 id / name / version / savedAt / checksum / data
- id 使用上面列出的 localStorage 键名
- checksum 用 ZenBackup.checksum(data) 的 FNV-1a 36 进制结果
- 所有字符串使用 UTF-8，禁止注释与尾逗号
```
