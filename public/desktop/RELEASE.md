# OMM-ZEN 桌面版发布流程

本文记录 v1.0.2 起固定的发布流程：从改版本号、构建、生成 `catalog.json`，
到 GitHub / Gitee 上传 Release，最后由旧版本自更新到新版本。

> 配套文档：桌面端总说明见 `README.md`；Gitee 附件配额的坑见本文
> 「Gitee 附件配额」一节与 `README.md` 的同名章节。

---

## 0. 名词与资产位置

| 名称 | 位置 | 说明 |
| --- | --- | --- |
| 源码 | `D:\blog\web\public` | 所有 `omm-*.html`、`desktop/` 都在这里 |
| 构建产物 | `public/dist` | EXE、框架 zip、插件 zip、`catalog.json`（不入库） |
| 远端 · GitHub | `Xingye-Dujing/MyBlog` | Windows + macOS 全量 Release |
| 远端 · Gitee | `Xingye-Dujing/my-blog` | 只放 Windows 全量 Release（配额限制） |
| 目录文件 | `catalog.json` | 版本号 + 每个 app 的下载地址 / 大小 / SHA-256 |
| 用户数据 | `%LOCALAPPDATA%\OMM-ZEN`（macOS：`~/Library/Application Support/OMM-ZEN`） | `shared.json`、快照、页面缩放、浏览器数据，升级不会动它 |

Release 标签一旦发布就视为不可变：同一个版本号不要覆盖重发（原因见
「同一个版本号为什么不能覆盖」）。

---

## 1. 改版本号（三处）

```text
public/desktop/plugin_specs.py        VERSION = "1.0.2"
public/desktop/plugin_manager.py      CATALOG_URL = .../releases/download/v1.0.2/catalog.json
.github/workflows/macos-build.yml     default: v1.0.2  /  RELEASE_TAG
```

`VERSION` 同时决定：

- 桌面程序自更新时「本地版本」是多少；
- `build_plugins.py` 生成的插件包版本与 `catalog.json` 里的 `version`。

---

## 2. 构建 Windows 全部程序

```powershell
cd D:\blog\web\public
.venv\Scripts\python.exe desktop\build_exes.py framework annotate corpus data english latex mdforge message planner redact visualization writer hub installer
```

产出（`dist/`）：

- 13 个 EXE：11 个产品 + `OMM-ZEN.exe`（完整版工作台）+ `OMM-ZEN-Setup.exe`（安装器）
- `OMM-ZEN-Framework-win64.zip`（框架版工作台，给在线安装器用）
- `dist/framework/OMM-ZEN.exe`

顺序有讲究：先 `framework`，再全部产品，最后 `hub` / `installer`，这样
`catalog.json` 里写入的校验值一定对应最终 EXE。

---

## 3. 生成插件包与 `catalog.json`

```powershell
.venv\Scripts\python.exe desktop\build_plugins.py --tag v1.0.2
```

产出 `dist/plugins/plugin-<id>-1.0.2.zip`（11 个）、`dist/catalog.json`、
`dist/plugin-template.zip`、`dist/plugin-spec.md`。

`catalog.json` 里三类地址是混合的（`build_plugins.py` 自动处理）：

| 条目 | 地址 | 原因 |
| --- | --- | --- |
| `apps.*.url`（Windows EXE） | Gitee | 国内下载更快 |
| `plugins[*].url` | Gitee | 插件安装走 Gitee |
| `frameworks.win64.url` | Gitee | 框架版工作台自更新 |
| `base_url` / `frameworks.macos-*.url` | GitHub | macOS 资源放不进 Gitee 配额 |

### 3.1 发布前自检

```powershell
.venv\Scripts\python.exe -c "import hashlib,json,pathlib;d=pathlib.Path('dist');c=json.loads((d/'catalog.json').read_text(encoding='utf-8'));print('version',c['version'],'apps',len(c['apps']),'plugins',len(c['plugins']));print('bad',[a for a,i in c['apps'].items() if hashlib.sha256((d/i['bundle']).read_bytes()).hexdigest()!=i['sha256']] or 'none');print('fw ok',hashlib.sha256((d/'OMM-ZEN-Framework-win64.zip').read_bytes()).hexdigest()==c['frameworks']['win64']['sha256'])"
```

必须全部为 `none` / `True`，否则不要发布。

---

## 4. 提交、打标签、推送

```powershell
git add -A
git commit -m "feat: <本次改动概要>"
git tag v1.0.2
git push MyBlog production ; git push Gitee production
git push MyBlog v1.0.2   ; git push Gitee v1.0.2
```

`MyBlog` = GitHub，`Gitee` = Gitee。标签指向打了标签的那个提交。

---

## 5. 创建 Release 并上传资源

### 5.1 GitHub（全量）

```powershell
gh release create v1.0.2 -R Xingye-Dujing/MyBlog --title "OMM-ZEN 桌面版 v1.0.2" --notes-file <notes.md> --target production
gh release upload v1.0.2 dist\OMM-*.exe dist\OMM-ZEN-Framework-win64.zip dist\catalog.json dist\plugin-template.zip dist\plugin-spec.md dist\plugins\plugin-*-1.0.2.zip -R Xingye-Dujing/MyBlog --clobber
```

### 5.2 Gitee（只 Windows）

仓库内脚本 `desktop/release/upload_gitee_assets.ps1` 负责上传 28 个 Windows 附件
（会自动删掉同名旧附件再传）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\release\upload_gitee_assets.ps1 -Tag v1.0.2
```

创建 Release：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\release\create_gitee_release.ps1 -Tag v1.0.2 -Notes <notes.md>
```

> **硬性顺序：`catalog.json` 必须先出现在 Release 上。** 旧版程序靠它发现新版本，
> 晚一步上传就会出现「检查不到更新」。

---

## 6. macOS 构建

macOS 必须在 macOS 上构建，仓库自带工作流：

```powershell
gh workflow run macos-build.yml -R Xingye-Dujing/MyBlog --ref production -f release_tag=v1.0.2
```

工作流在 `macos-15`（arm64）与 `macos-15-intel`（x86_64）上执行
`desktop/build_exes.py --clean`，把每个 `.app` 打成
`OMM-<App>-macOS-<arch>.dmg`，框架额外打成
`OMM-ZEN-Framework-macOS-<arch>.zip`，最后自动 `gh release upload` 到
GitHub Release。共 26 个 DMG + 2 个框架 zip。

macOS 只做「检测 + 打开下载链接」，不原地替换程序。

### Gitee 附件配额（重要，别再踩）

Gitee 的附件配额是**仓库级 1 GB，跨 Release 累计**，不是每个 Release 各 1 GB。

- Windows 全量 ≈ 490 MB；macOS 28 个资源 ≈ 925 MB；两者加起来放不下。
- 上传 macOS 到 Gitee 会返回 `验证失败：文件大小已超出仓库附件配额（1 GB）`。
- **不要**反复重试，也**不要**为了腾空间删掉当前版本的 Windows 资源。
- 现行策略：Gitee 只保证 Windows 全量完整，macOS 只在 GitHub。
- 早期版本用过「macOS → Gitee 同步脚本」，现已作废，不要再跑。

---

## 7. 旧版本如何自更新到新版本

```text
旧版启动（约 0.9 秒后）→ 请求 /__omm/update/check（此后每 4 小时再查一次）
    → 读 Release 上的 catalog.json，version 高于本地 VERSION 才提示
    → 右下角提示「发现新版本 1.0.2」，可选「稍后」或「立即更新」
    → 立即更新：按 catalog 的 url 下载 → 校验 SHA-256 与大小 → 不符即中止
    → 退出进程 → 脱离的 PowerShell 助手等待进程结束后替换 exe → 重启
```

要点：

- 完整版工作台更新下载 `OMM-ZEN.exe`；框架版工作台下载框架 zip 并取出其中的 exe。
- 替换完成后**用户机器不需要再构建**，拿到的就是已发布的构建产物。
- 更新只替换程序本体；`shared.json`、历史快照、页面缩放、LocalStorage /
  IndexedDB 都在用户数据目录里，重启后继续沿用。更新前还会额外备份一份
  `shared.backup-*.json`。
- 只有 **1.0.1 及以后**（含自更新代码的版本）才能自动更新；更早的版本需要手动覆盖安装。

### 同一个版本号为什么不能覆盖

旧版判断「有没有更新」只看版本号，已经更新到 1.0.2 的用户不会再收到提示；
而且 `catalog.json` 里记着 SHA-256，换了文件就对不上。要修 bug 就发 1.0.3。

---

## 8. 发布后检查清单

- [ ] GitHub Release 资产数 = 28（Windows）+ 28（macOS）= 56
- [ ] Gitee Release 资产数 = 28（Windows 全量，无 macOS）
- [ ] 两端 `catalog.json` 的 SHA-256 与本地一致
- [ ] `catalog.json` 的 `version` 等于本次版本号，`tag` 等于本次标签
- [ ] 用旧版程序启动，确认弹出更新提示；点「立即更新」能完成替换并重启
- [ ] 更新后重启，确认保存路径、页面缩放、历史快照仍在

---

## 9. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 旧版提示「检查不到更新」 | `catalog.json` 没上传，或 `version` 没改，或 catalog 还没推到 Release 所在仓库 |
| 更新后启动报 `Failed to load Python DLL` | 旧版更新助手没清理 `_MEIPASS2` 等环境变量；1.0.1 起已修复 |
| Gitee 上传报「超出仓库附件配额」 | 仓库累计 1 GB 已满；macOS 不要传 Gitee |
| 上传后校验值对不上 | 重新跑 `build_plugins.py --tag <新标签>` 并同步重传 catalog 与产物 |
| 端口被占用导致启动异常 | 桌面程序用固定端口 8311–8321、8300；先关掉旧实例 |
