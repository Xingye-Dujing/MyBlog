# 回归测试

全部离线运行，不修改用户数据，也不启动后台服务。

## 运行

在仓库根目录执行：

```bash
python tests/run_all.py
```

或分别运行：

```bash
python -m unittest discover -s tests -v   # Python 后端安全/健壮性
node tests/test_message_security.mjs      # postMessage 协议与版本比较
node --test tests/test_zencard.mjs tests/test_srs.mjs tests/test_flow.mjs \
  tests/test_review.mjs tests/test_backup.mjs tests/test_products.mjs \
  tests/test_knowledge_graph.mjs tests/test_chart.mjs \
  tests/test_writer_deep.mjs  # 新增产品、通用格式、Hub 知识图谱与 Writer 深改
npm run lint                              # 前端静态检查
npm run build                             # 前端生产构建
```

## 覆盖内容

**`test_backend_hardening.py`**（14 项）

- 桌面桥 `request_is_local()`：Host / Origin 双重校验，拒绝 DNS rebinding、跨站 POST 与 `Origin: null`。
- WebDAV `remote_url_is_public()`：拒绝 loopback、内网、链路本地、云元数据地址与 URL 内嵌凭据；验证 `OMM_CLOUD_ALLOW_PRIVATE` 开关。
- 共享资源授权：注册文件只允许按精确路径读取，不再把整个父目录加入白名单。
- mdforge 多实例隔离：两个 `create_app(root)` 实例各自提供自己的静态文件，不串目录。
- 签名错误脱敏：`CalledProcessError` 中的 `/p <password>` 不会被打印。

**`test_message_security.mjs`**（20 项）

- 从真实源码抽取 `isNewerVersion` / `versionKey` 并在 VM 中执行，验证与后端 Python 元组比较语义一致（`1.2.0 > 1.2`）。
- `frameTargetOrigin()`：按 iframe 自身 URL 推导目标 origin，跨端口场景不被工作台 origin 覆盖；拒绝非 loopback 地址。
- 静态防护断言：4 个桥接脚本 + writer 内联脚本中不再出现 `postMessage(..., '*')`；所有 `message` 监听器都校验 `event.origin`；工作台把自身 origin 下发到 iframe URL，产品端读取该参数。

**`test_zencard.mjs` 等 9 个新增套件**（node:test，共 99 项）

- `zen-card.js` 通用知识卡片的归一化 / 严格校验 / 序列化 / 去重 / 指纹，以及与语料、批注、英语桥接包、写作画布、数据表、搜索、剪藏的双向转换。
- `zen-srs.js` SM-2 间隔重复：评级映射、间隔递增、遗忘重置、易度下限、到期队列、统计、持久化往返。
- `zen-flow.js` 工作流规则：条件匹配、六类动作、优先级多规则运行、副作用汇总、持久化。
- `zen-review.js` 复盘聚合：日期区间过滤、活跃度 / 标签统计、Markdown 报告生成。
- `zen-backup.js` 统一备份：清单校验和、差异比对、三种合并策略、按 id 去重。
- `test_products.mjs` 集成护栏：5 个新产品的标题 / 样式 / 桥接引入、模块脚本语法、DOM id 引用完整性、无开发残留；12 个既有产品仍引入 zen-link；origin 信任校验；每个页面的 id 引用都对得上真实元素。
- `test_knowledge_graph.mjs` Hub 知识图谱：工具栏入口与面板元素、命令注册、跨 iframe 卡片请求使用 frameTargetOrigin 而非通配符、产品端以明确 origin 回传、纯函数 `kgNormalize`/`dedupeGraphCards`/`kgEscape` 的归一化与转义。
- `test_chart.mjs` `zen-chart.js`：CSV 解析、数组/对象/CSV 归一化、柱状与折线 SVG、标题转义、data URL、空数据兜底。
- `test_writer_deep.mjs` Writer 深改：模块与面板引入、三个右键动作与分发分支、`ZenWriterDeep` 三个入口、引用块出处/批注、图表自包含 data URL、时间机器走工作台快照且二次确认、主脚本整体语法可解析。

## 前置条件

- Python 3.9+（需要 `flask`、`werkzeug`，项目 `public/requirements-mdforge.txt` 已包含）
- Node 18+
