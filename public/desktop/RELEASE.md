# OMM-ZEN 桌面版发布流程

从改版本号、构建、生成 `catalog.json`，到 GitHub / Gitee 上传 Release、同步旧版本指针、
验收自更新。本文按实际操作顺序写，末尾专门列出踩过的坑。

> 配套文档：桌面端总说明见 `README.md`。
> 所有发布相关脚本在 `public/desktop/release/`。

---

## 0. 名词与资产位置

| 名称 | 位置 | 说明 |
| --- | --- | --- |
| 源码 | `D:\blog\web\public` | 所有 `omm-*.html`、`desktop/` 都在这里 |
| 构建产物 | `public/dist` | EXE、框架 zip、插件 zip、`catalog.json`（不入库） |
| 构建缓存 | `public/build` | 每次构建重建，可随时删，删掉只是下次慢一点 |
| 远端 · GitHub | `Xingye-Dujing/MyBlog` | Windows + macOS 全量 Release |
| 远端 · Gitee | `Xingye-Dujing/my-blog` | 只放 Windows 全量（配额限制） |
| 目录文件 | `catalog.json` | 版本号 + 每个条目的下载地址 / 大小 / SHA-256 |
| 用户数据 | `%LOCALAPPDATA%\OMM-ZEN`（macOS：`~/Library/Application Support/OMM-ZEN`） | `shared.json`、快照、页面缩放、浏览器数据；升级不动它 |
| 用户插件目录 | 默认 `%LOCALAPPDATA%\OMM-ZEN\plugins\<id>`，可在集成器里改 | 用户手动装/导入的插件，覆盖同名内置插件；改目录会自动迁移 |
| 本地设置 | `%LOCALAPPDATA%\OMM-ZEN\settings.json` | 目前只有 `plugin_root`（插件安装目录）；删掉即回到默认目录 |

Release 标签一旦发布就视为不可变：同一个版本号不要覆盖重发（见 §8）。

---

## 1. 发版前：改版本号 + 清理本地旧副本

### 1.1 改版本号（只有两处）

```text
public/desktop/plugin_specs.py        VERSION = "1.0.6"
.github/workflows/macos-build.yml     default: v1.0.6  /  RELEASE_TAG
```

`VERSION` 同时决定：

- 桌面程序自更新时「本地版本」是多少；
- `build_plugins.py` 生成的插件包版本与 `catalog.json` 里的 `version`。

> **不要用 PowerShell 批量替换源码。**
> `Set-Content -Encoding UTF8` 会写入 BOM 并可能把中文写坏（本次就写坏过
> `plugin_specs.py`，只能 `git checkout` 重来）。用编辑器改，或用 Python 以
> `encoding="utf-8", newline=""` 读写。

### 1.2 目录地址不要写死版本号

`plugin_manager.py` 里的 `CATALOG_URL` **不随版本变**，它一直指向 `latest`：

```text
https://gitee.com/Xingye-Dujing/my-blog/releases/download/latest/catalog.json
```

Gitee 与 GitHub 的 `latest` 都解析到当前最新 Release，所以：

- 今天的程序永远能找到明天的新版本，不用改代码；
- 直接下载链接也一直有效（`.../releases/download/latest/OMM-ZEN.exe`）。

`catalog.json` 里每个条目的 `url` 仍然写死本次版本（校验值要对应具体文件），
另外附带 `latest_url` 字段，指向永远拿到最新版的地址。

> 例外：**已经发出去的旧程序**读的是它自己那个版本目录里的 `catalog.json`。
> 每次发版后要把最新 `catalog.json` 覆盖到**所有**旧版本的 Release 上（见 §5.4）。

### 1.3 清理本机旧版本副本

发版前先删旧副本，避免「本地看着是旧界面 / 磁盘越攒越大」。可释放的空间很大：

```powershell
# 1) 用户插件目录里的旧副本（内置插件会随安装包更新，这些副本是纯冗余）
$p = "$env:LOCALAPPDATA\OMM-ZEN\plugins"
Get-ChildItem $p -Directory | Remove-Item -Recurse -Force
# 保留 ports.json；其它散落文件一并删掉

# 2) dist 里旧版本的插件包（只留本次版本）
Get-ChildItem D:\blog\web\public\dist\plugins -Filter *.zip |
  Where-Object { $_.Name -notmatch '-1\.0\.6\.zip$' } | Remove-Item -Force

# 3) 构建缓存（可选，删掉可省 ~600 MB，下次构建全量重编）
# Remove-Item -Recurse -Force D:\blog\web\public\build
```

- `%LOCALAPPDATA%\OMM-ZEN\updates` 是自更新下载的临时 exe，正常会自动清空，可手动清。
- `<app>` 数据目录（`hub`、`planner` 等）是 WebView2 的用户数据，**不是**版本副本，别删。
- `shared.backup-*.json` 是更新前的配置备份，很小，可留。
- `settings.json` 里的 `plugin_root` 是插件目录；删掉它即回到默认目录（不会删插件文件）。

### 1.4 插件安装目录可以改（自动迁移）

集成器 →「插件管理」→「已安装」顶部显示当前安装目录，点「修改」可直接改名，
确认后**已安装的插件会自动迁移过去**，不需要重装：

```text
C:\Users\<用户>\AppData\Local\OMM-ZEN\plugins      ← 默认
D:\OMM-ZEN\plugins                                 ← 可以改到别的盘
```

实现要点（改这块代码时注意）：

- 路径存 `settings.json` 的 `plugin_root`，`default_plugin_root()` 启动时读它。
- 先复制、**全部成功后才删除源目录**，中途失败不会留下搬了一半的安装。
- 迁移前会**停掉所有插件本地服务器**（Windows 会锁文件），迁移后按需重启；
  已打开的产品会自动重新挂载。
- 新目录不能是旧目录本身或它的子目录；必须是绝对路径。
- 配置的盘符不存在时，`default_plugin_root()` 回退到默认目录，不会起不来。

清理后确认集成器仍能用内置插件：

```powershell
(Invoke-WebRequest http://127.0.0.1:8300/api/plugins -UseBasicParsing).Content
# plugins[*].source 应全是 "bundled"，version 为本次版本
```

---

## 2. 构建 Windows 全部程序

```powershell
cd D:\blog\web\public
.venv\Scripts\python.exe desktop\build_exes.py framework annotate corpus data english latex mdforge message planner redact visualization writer hub installer
```

产出（`dist/`）：

- **13 个 EXE**：11 个产品 + `OMM-ZEN.exe`（完整版工作台）+ `OMM-ZEN-Setup.exe`（安装器）
- `OMM-ZEN-Framework-win64.zip`（框架版工作台，给在线安装器用）+ `dist/framework/OMM-ZEN.exe`

顺序有讲究：先 `framework`，再全部产品，最后 `hub` / `installer`。

### 2.1 构建必须知道的几件事

- **全量约 8 分钟**，日志几万行。用重定向而不是管道截断：

  ```powershell
  .venv\Scripts\python.exe desktop\build_exes.py *> $env:TEMP\build.log
  # 完成后看结果
  Select-String $env:TEMP\build.log -Pattern "^  ok |FAILED"
  ```

  > 坑：`... | Select-Object -First 3` 会提前关闭管道，**直接杀掉**构建/服务器进程。

- **只重建工作台**（改了 `hub_server.py`、`plugin_manager.py`、`omm-hub.*` 等）：

  ```powershell
  .venv\Scripts\python.exe desktop\build_exes.py hub
  ```

- **重建任何 EXE 之后都必须重新跑 §3**，否则 `catalog.json` 里的 SHA-256 对不上新文件。
- 构建器自带「产物未重写」保护（`_artifact_stamp`），不会拿旧 exe 冒充新版本。

---

## 3. 生成插件包与 `catalog.json`

```powershell
.venv\Scripts\python.exe desktop\build_plugins.py --tag v1.0.6
```

产出 `dist/plugins/plugin-<id>-1.0.6.zip`（11 个）、`dist/catalog.json`、
`dist/plugin-template.zip`、`dist/plugin-spec.md`，以及源码运行用的
`build/plugin-dirs/`（集成器在这里找内置插件）。

`catalog.json` 里三类地址是混合的（`build_plugins.py` 自动处理）：

| 条目 | 地址 | 原因 |
| --- | --- | --- |
| `apps.*.url`（Windows EXE） | Gitee | 国内下载更快 |
| `plugins[*].url` | Gitee | 插件安装走 Gitee |
| `frameworks.win64.url` | Gitee | 框架版工作台自更新 |
| `base_url` / `frameworks.macos-*.url` | GitHub | macOS 资源放不进 Gitee 配额 |

### 3.1 发布前自检（必须全绿）

```powershell
.venv\Scripts\python.exe -c "
import hashlib, json, pathlib
d = pathlib.Path('dist'); c = json.loads((d/'catalog.json').read_text(encoding='utf-8'))
print('version', c['version'], 'tag', c['tag'], 'apps', len(c['apps']), 'plugins', len(c['plugins']))
print('bad apps   ', [a for a,i in c['apps'].items() if hashlib.sha256((d/i['bundle']).read_bytes()).hexdigest() != i['sha256']] or 'none')
print('bad plugins', [p['id'] for p in c['plugins'] if hashlib.sha256((d/'plugins'/p['bundle']).read_bytes()).hexdigest() != p['sha256']] or 'none')
print('fw ok      ', hashlib.sha256((d/'OMM-ZEN-Framework-win64.zip').read_bytes()).hexdigest() == c['frameworks']['win64']['sha256'])
print('latest_url ', bool(c.get('latest_url')), bool(c.get('gitee_latest_url')))
"
```

必须是 `bad apps none` / `bad plugins none` / `fw ok True` / `latest_url True True`，
否则不要发布。

---

## 4. 提交、打标签、推送

```powershell
cd D:\blog\web
git add -A
git commit -m "feat: <本次改动概要>"
git tag v1.0.6
git push MyBlog production ; git push Gitee production
git push MyBlog v1.0.6   ; git push Gitee v1.0.6
```

`MyBlog` = GitHub，`Gitee` = Gitee。标签指向打了标签的那个提交。

打标签前确认本次所有修复都在里面（尤其临近发版才补的 bug）：

```powershell
git log --oneline -5
git merge-base --is-ancestor <修复提交> v1.0.6 ; if ($?) { "包含" }
```

---

## 5. 创建 Release 并上传资源

### 5.1 GitHub（全量，无配额）

```powershell
gh release create v1.0.6 -R Xingye-Dujing/MyBlog --title "OMM-ZEN v1.0.6" --notes-file <notes.md>

# 先传 catalog.json
gh release upload v1.0.6 dist\catalog.json -R Xingye-Dujing/MyBlog

# 再传其余 27 个（13 EXE + framework + template + spec + 11 插件包）
$files  = @(Get-ChildItem dist -Filter 'OMM-*.exe' | ForEach-Object FullName)
$files += @(Get-ChildItem dist -Filter 'OMM-ZEN-Framework-win64.zip' | ForEach-Object FullName)
$files += 'dist\plugin-template.zip','dist\plugin-spec.md'
$files += @(Get-ChildItem dist\plugins -Filter '*-1.0.6.zip' | ForEach-Object FullName)
"count=$($files.Count)"   # 必须是 27
gh release upload v1.0.6 @files -R Xingye-Dujing/MyBlog
```

Windows 资源应为 **28 个**（含 `catalog.json`）。macOS 由 §6 的工作流补上 28 个，最终 56。

### 5.2 Gitee（只 Windows）

**硬性顺序：`catalog.json` 必须先出现在 Release 上。** 旧版程序靠它发现新版本。

```powershell
# 1) 建 Release
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\release\create_gitee_release.ps1 -Tag v1.0.6 -Notes <notes.md>

# 2) 先传 catalog.json
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\release\upload_gitee_assets.ps1 -Tag v1.0.6 -Names "catalog.json"

# 3) 再传其余 27 个
$names  = @(Get-ChildItem dist -Filter 'OMM-*.exe' | ForEach-Object Name)
$names += 'OMM-ZEN-Framework-win64.zip','plugin-template.zip','plugin-spec.md'
$names += @(Get-ChildItem dist\plugins -Filter '*-1.0.6.zip' | ForEach-Object Name)
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\release\upload_gitee_assets.ps1 -Tag v1.0.6 -Names ($names -join ',')
```

上传 28 个；Gitee 页面会显示 **30** 个，多出来的是 Gitee 自动生成的源码包，正常。

> **Gitee API 现在需要鉴权。** 不带 `access_token` 的
> `https://gitee.com/api/v5/repos/...` 会返回 **403 Forbidden**（不是 404，也不是限流）。
> 仓库里的 `create_gitee_release.ps1` / `upload_gitee_assets.ps1` /
> `delete_gitee_assets.ps1` / `publish_pointer.ps1` 都已从 `git credential fill`
> 自动取 token；自己写一次性脚本时也要这么做：

```python
import subprocess
cred = subprocess.run(["git", "credential", "fill"],
                      input="protocol=https\nhost=gitee.com\n\n",
                      capture_output=True, text=True).stdout
token = [l.split("=",1)[1] for l in cred.splitlines() if l.startswith("password=")][0]
# 之后拼 ?access_token=<token>
```

### 5.3 Gitee 附件配额：发版前先算空间

Gitee 配额是**仓库级 1 GB，跨 Release 累计**。现状：

- 一套 Windows 全量 ≈ **370 MB**
- 所以最多同时放 **2 个版本**的 Windows 资源
- macOS 资源 ≈ 925 MB，**永远不要**传 Gitee

发新版前算一下（带 token）：

```python
# 保存为 check_quota.py，python check_quota.py 运行
import subprocess, json, urllib.request, time
REPO = "Xingye-Dujing/my-blog"
cred = subprocess.run(["git","credential","fill"], input="protocol=https\nhost=gitee.com\n\n",
                      capture_output=True, text=True).stdout
tok = [l.split("=",1)[1] for l in cred.splitlines() if l.startswith("password=")][0]
def head(u):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, method="HEAD",
            headers={"User-Agent":"OMM-ZEN"}), timeout=60)
        return int(r.headers.get("Content-Length") or 0)
    except Exception:
        return 0
total = 0
for tag in ("v1.0.4","v1.0.5","v1.0.6"):
    u = "https://gitee.com/api/v5/repos/%s/releases/tags/%s?access_token=%s" % (REPO, tag, tok)
    d = json.loads(urllib.request.urlopen(urllib.request.Request(u,
        headers={"User-Agent":"OMM-ZEN"}), timeout=90).read())
    s = sum(head(a["browser_download_url"]) for a in d.get("assets") or []
            if not a["name"].endswith(".tar.gz"))
    total += s
    print("%-8s %8.1f MB  assets=%d" % (tag, s/1048576, len(d.get("assets") or [])))
print("TOTAL %.1f MB / 1024 MB" % (total/1048576))
```

放不下就删**更早版本**的 Gitee 资源（只删 Gitee，GitHub 保留）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\release\delete_gitee_assets.ps1 -Tag v1.0.4 -Keep catalog.json
```

规则：

- **只删当前版本和上一个版本之外的**。删「上一个版本」的 Windows 资源会让那版用户无法自更新。
- `-Keep catalog.json` **不能省**：旧程序靠它发现新版本，删了那版就永久收不到更新提示。
- 删除的是大件（EXE / 框架 / 插件包 / spec / template），`catalog.json` 留下。

### 5.4 把最新 catalog 覆盖到所有旧版本（重要）

1.0.5 起的程序读 `latest` 别名，自动能发现新版。但**更早发出去的程序**读的是
它自己版本目录里的 `catalog.json`：

```text
https://gitee.com/.../releases/download/v1.0.3/catalog.json
```

那个文件停在 1.0.3，1.0.3 的用户就**永远不会**收到更新。所以每次发版后，
把最新 `catalog.json` 覆盖到**每一个仍存在的旧版本**上（两端都做）：

```powershell
# Gitee：脚本会同时更新 prev 和当前版本
foreach ($prev in @("v1.0.5","v1.0.4","v1.0.3")) {
  powershell -NoProfile -ExecutionPolicy Bypass -File desktop\release\publish_pointer.ps1 -Tag v1.0.6 -PrevTag $prev
}

# GitHub：逐个 --clobber
foreach ($prev in @("v1.0.5","v1.0.4","v1.0.3")) {
  gh release upload $prev dist\catalog.json -R Xingye-Dujing/MyBlog --clobber
}
```

覆盖的只是清单文件，旧版本自己的 EXE 和插件包不受影响。这会破坏那个 Release
「清单与自身产物自洽」，但这是让旧程序发现新版的唯一办法，属于已知取舍。

> 如果某个旧版本的 Gitee 资源已被配额清理删光（只剩 catalog.json），那版用户
> 仍能收到「发现新版本」提示，但下载会失败——这是配额下的必然结果，优先保证
> 当前两版完整。

---

## 6. macOS 构建

macOS 必须在 macOS 上构建，仓库自带工作流：

```powershell
gh workflow run macos-build.yml -R Xingye-Dujing/MyBlog --ref production -f release_tag=v1.0.6
```

在 `macos-15`（arm64）与 `macos-15-intel`（x86_64）上执行
`desktop/build_exes.py --clean`，把每个 `.app` 打成 `OMM-<App>-macOS-<arch>.dmg`，
框架额外打成 `OMM-ZEN-Framework-macOS-<arch>.zip`，最后自动上传到 GitHub Release。
共 26 个 DMG + 2 个框架 zip = 28 个。

工作流约 15 分钟。等它 `conclusion: success` 后再做 §7.1 的最终校验
（否则 GitHub 资产数还是 28 而不是 56）。

macOS 只做「检测 + 打开下载链接」，不原地替换程序。

---

## 7. 验收

### 7.1 远端校验（必做）

```powershell
cd D:\blog\web\public
.venv\Scripts\python.exe desktop\release\verify_release.py --tag v1.0.6
```

期望：`OK: catalog and release assets are consistent`，
`github : 56 assets (28 windows, 28 macos)`。

再逐字节校验每个资源（Windows 全量，两端），并确认 `latest` 别名与旧版本指针：

```python
# save as verify_assets.py
import hashlib, json, pathlib, urllib.request
DIST = pathlib.Path(r"D:\blog\web\public\dist")
CAT  = json.loads((DIST/"catalog.json").read_text(encoding="utf-8"))
GH = "https://github.com/Xingye-Dujing/MyBlog/releases/download/v1.0.6/"
GT = "https://gitee.com/Xingye-Dujing/my-blog/releases/download/v1.0.6/"
def fetch(u):
    req = urllib.request.Request(u, headers={"User-Agent":"OMM-ZEN","Cache-Control":"no-cache"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()
entries = [(a, i["bundle"], i["sha256"], i["size"], False) for a,i in CAT["apps"].items()]
entries += [(p["id"], p["bundle"], p["sha256"], p.get("size",0), True) for p in CAT["plugins"]]
fw = CAT["frameworks"]["win64"]
entries.append(("framework-win64", fw["bundle"], fw["sha256"], fw.get("size",0), False))
for label, base in (("github", GH), ("gitee", GT)):
    ok, bad = 0, []
    for name, bundle, sha, size, is_plugin in entries:
        try:
            data = fetch(base + bundle)
            if hashlib.sha256(data).hexdigest() == sha and len(data) == size:
                ok += 1
            else:
                bad.append(name)
        except Exception as e:
            bad.append((name, str(e)[:40]))
    print("%s: %d/%d ok" % (label, ok, len(entries)))
    for b in bad: print("   BAD", b)
local = (DIST/"catalog.json").read_bytes()
for label, u in (
    ("gitee latest",  "https://gitee.com/Xingye-Dujing/my-blog/releases/download/latest/catalog.json"),
    ("github latest", "https://github.com/Xingye-Dujing/MyBlog/releases/latest/download/catalog.json"),
):
    d = fetch(u); j = json.loads(d)
    print("%-14s version=%s identical=%s" % (label, j.get("version"), d == local))
```

必须 **48/48**（24 个条目 × 2 端），两个 `latest` 都是本次版本且与本地 catalog 字节相同。

### 7.2 真实二进制验收（不要只信浏览器）

源码跑起来正常不代表打包后的 EXE 正常。用发布的 exe 起远程调试：

```powershell
cd D:\blog\web\public
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9340"
Start-Process .\dist\OMM-ZEN.exe
# 等 30 秒后
Invoke-WebRequest http://127.0.0.1:9340/json/version -UseBasicParsing
```

用 puppeteer 连 `browserURL: http://127.0.0.1:9340`。

**三个必须注意的点：**

1. **一定要禁缓存。** WebView2 会缓存 `omm-desktop.js` / `omm-*.html`，不禁用会
   看到旧界面而误判「没生效」：

   ```js
   const cdp = await page.target().createCDPSession();
   await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
   await cdp.send('Network.clearBrowserCache');
   await hub.reload({ ignoreCache: true });
   ```

2. **iframe 不在 `browser.pages()` 里。** 产品跑在 iframe 中，puppeteer 看不到，
   要走 CDP：

   ```js
   const cdp = await hub.createCDPSession();
   const { frameTree } = await cdp.send('Page.getFrameTree');
   const child = frameTree.childFrames[0];
   const ctx = await cdp.send('Page.createIsolatedWorld',
     { frameId: child.frame.id, worldName: 'probe' });
   await cdp.send('Runtime.evaluate', { contextId: ctx.executionContextId, ... });
   ```

3. **插件来源要核对。** 如果本机 `%LOCALAPPDATA%\OMM-ZEN\plugins` 里还留着旧版本
   的用户副本，先按 §1.3 清掉，或确认 `/api/plugins` 返回的 `source` 是 `bundled`。

### 7.3 自更新实测（发布后必须走一遍）

```powershell
$d = "$env:TEMP\ommtest"; New-Item -ItemType Directory -Force $d | Out-Null
# 下载上一版（已发布）exe
Invoke-WebRequest "https://gitee.com/Xingye-Dujing/my-blog/releases/download/v1.0.5/OMM-ZEN.exe" -OutFile "$d\OMM-ZEN.exe"
Start-Process "$d\OMM-ZEN.exe"
Start-Sleep 32
(Invoke-WebRequest http://127.0.0.1:8300/__omm/update/check -UseBasicParsing).Content
# 期望 available=true，latest 等于新版本，sha256 与 dist 里新 exe 一致
(Invoke-WebRequest http://127.0.0.1:8300/__omm/update/apply -Method POST -ContentType application/json -Body '{}' -UseBasicParsing).Content
Start-Sleep 35
(Get-FileHash "$d\OMM-ZEN.exe" -Algorithm SHA256).Hash   # 应等于 dist 新 exe 的哈希
(Invoke-WebRequest http://127.0.0.1:8300/__omm/update/check -UseBasicParsing).Content
# 期望 current==latest、available=false
```

---

## 8. 自更新原理

```text
旧版启动（约 0.9 秒后）→ 请求 /__omm/update/check（此后每 4 小时再查一次）
    → 读 Release 上的 catalog.json，version 高于本地 VERSION 才提示
    → 右下角提示「发现新版本」，可选「稍后」或「立即更新」
    → 立即更新：按 catalog 的 url 下载 → 校验 SHA-256 与大小 → 不符即中止
    → 退出进程 → 脱离的 PowerShell 助手等待进程结束后替换 exe → 重启
```

要点：

- 完整版工作台下载 `OMM-ZEN.exe`；框架版工作台下载框架 zip 并取出其中的 exe。
- 替换完成后**用户机器不需要再构建**，拿到的就是已发布的构建产物。
- 更新只替换程序本体；`shared.json`、快照、页面缩放、LocalStorage / IndexedDB
  都在用户数据目录里，重启后继续沿用。更新前还会备份一份 `shared.backup-*.json`。
- 只有 **1.0.1 及以后**（含自更新代码的版本）才能自动更新，更早的需手动覆盖安装。

### 内置插件与用户副本的优先级

内置插件随安装包更新，但用户目录里同 id 的副本原本会**永远**盖住内置版本，
导致升级工作台后产品界面还停在旧版。现在 `PluginRegistry.reload()` 按版本号比较：

- 内置版本 **高于** 用户副本 → 用内置（升级后立即生效）
- 用户装了**更高版本** → 仍用用户的（尊重用户主动升级）

排查方法：

```powershell
(Invoke-WebRequest http://127.0.0.1:8300/api/plugins -UseBasicParsing).Content
# 看 plugins[*] 的 version 与 source
```

### 同一个版本号为什么不能覆盖

旧版判断「有没有更新」只看版本号：已经更新到 1.0.6 的用户不会再收到提示；
而且 `catalog.json` 里记着 SHA-256，换了文件就对不上。要修 bug 就发 1.0.7。

---

## 9. 发布后检查清单

- [ ] `dist/catalog.json` 自检全绿（§3.1）
- [ ] GitHub Release：Windows 28 个，macOS workflow 完成后共 56 个
- [ ] Gitee Release：上传 28 个（页面显示 30，含 Gitee 源码包）
- [ ] 两端 `catalog.json` 与本地字节一致
- [ ] `catalog.json` 的 `version` / `tag` 等于本次版本
- [ ] 远端逐字节校验 **48/48**（§7.1）
- [ ] 两个 `latest` 别名都返回本次版本
- [ ] 最新 `catalog.json` 已覆盖到**所有**旧版本 Release（两端，§5.4）
- [ ] `verify_release.py --tag <本次>` 输出 OK
- [ ] 用上一版程序实测：能发现更新 → 应用成功 → 哈希一致 → 再查为最新（§7.3）
- [ ] 更新后重启，保存路径 / 页面缩放 / 历史快照仍在
- [ ] Gitee 配额仍 ≤ 1024 MB，且当前两版完整
- [ ] 本机旧副本已清理（§1.3），临时进程与临时目录已删除

---

## 10. 踩过的坑

| 现象 | 原因 / 处理 |
| --- | --- |
| 旧版提示「检查不到更新」 | `catalog.json` 没上传 / `version` 没改 / 最新 catalog 没覆盖到旧版本自己的 Release（§5.4） |
| Gitee `api/v5/...` 返回 **403** | 现在必须带 `access_token`（从 `git credential fill` 取），见 §5.2 |
| Gitee 上传报「超出仓库附件配额」 | 仓库累计 1 GB 已满；先删更早版本的大件（§5.3），macOS 永不传 Gitee |
| 上传后校验值对不上 | 重建过 EXE 却没重跑 `build_plugins.py`；重跑并重传该 exe 与 catalog |
| 升级后产品界面还是旧版 | `%LOCALAPPDATA%\OMM-ZEN\plugins` 里有旧副本。已按版本号修好；仍异常就看 `/api/plugins` 的 `source` |
| 验证时看到旧界面 | WebView2 缓存。用 CDP `Network.setCacheDisabled` + `reload({ignoreCache:true})`（§7.2） |
| puppeteer 找不到产品页面 | 产品在 iframe 里，`pages()` 看不到；用 CDP `Page.getFrameTree` + 隔离世界（§7.2） |
| 构建/服务器进程莫名其妙退出 | `\| Select-Object -First N` 提前关管道。改用 `*>` 重定向到日志 |
| 中文源码被写坏 | 用 PowerShell `Set-Content -Encoding UTF8` 改过文件。用编辑器 / Python `encoding="utf-8"` |
| `Failed to load Python DLL` | 旧版更新助手没清理 `_MEIPASS2` 等环境变量；1.0.1 起已修复 |
| 启动异常 / 端口占用 | 固定端口 8300、8311–8321、8123。先关旧实例：`Get-Process OMM* \| Stop-Process -Force` |
| 构建缓存占几百 MB | `build/` 是缓存，可整目录删除，下次构建重建 |

---

## 11. 附：发布脚本与接口

### 11.1 `desktop/release/` 脚本

| 脚本 | 用途 |
| --- | --- |
| `create_gitee_release.ps1 -Tag -Notes` | 建 Gitee Release |
| `upload_gitee_assets.ps1 -Tag [-Names]` | 传 Gitee 附件（同名先删后传） |
| `delete_gitee_assets.ps1 -Tag [-Keep]` | 腾配额，`-Keep catalog.json` |
| `publish_pointer.ps1 -Tag -PrevTag` | 把最新 catalog 覆盖到 Gitee 旧版本 |
| `verify_release.py --tag` | 校验 catalog 与两端资产是否自洽 |

### 11.2 集成器接口（`/api/*`）

| 接口 | 用途 |
| --- | --- |
| `GET /api/plugins` | 插件列表（含 `source`：bundled / user）与 `plugin_dir` |
| `GET /api/settings` | `plugin_dir`、`default_plugin_dir` |
| `POST /api/settings/plugin-dir` `{path}` | 改插件目录并迁移，返回 `moved`（迁移项数） |
| `GET /api/catalog` | 在线目录（插件安装/更新用） |
| `POST /api/plugins/install` `{id}` | 在线安装/更新插件，装完立即重启该插件 |
| `POST /api/plugins/import` | 导入插件 zip（请求体即 zip 字节） |
| `POST /api/plugins/remove` `{id}` | 卸载用户安装的插件 |

### 11.3 存档接口（`/__omm/fs/*`）

`/__omm/fs/archive` 是唯一的「存档」接口，把两类记录合并成一条时间线：

| `kind` | 内容 | 动作 |
| --- | --- | --- |
| `file` | 产品保存过的文件（旧版「共享数据」） | 载入 / 复制路径 |
| `snapshot` | 应用状态快照 | 恢复 / 改名 / 删除 |

- 旧的 `/snapshots`、`/shared` 保留（兼容旧客户端），界面只用 `/archive`。
- 快照改名：`POST /__omm/fs/snapshot/rename` `{path, label}`，文件名按新名字重写。
- 集成器顶栏「存档」按钮打开该面板；集成器内（`omm_embed=1`）的产品不再显示
  左下角浮动「存档」按钮，只保留顶栏入口。
- 集成器里「在应用中打开」会把文件通过 `postMessage` 交给对应产品载入。
