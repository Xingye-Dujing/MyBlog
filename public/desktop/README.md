# OMM-ZEN 桌面版构建说明

把 `public/` 下的 11 个产品打包成独立桌面程序，并提供三种集成形态：

- **OMM-ZEN.exe / .app**：完整离线版，内置全部 11 个插件。
- **OMM-ZEN-Framework**：只含工作台框架，产品以插件形式按需安装。
- **OMM-ZEN-Setup.exe / .app**：在线安装器，勾选要安装的产品，下载框架和对应插件包。

每个程序：

- 在本机回环地址上起一个仅本机可访问的 HTTP 服务，再用系统 WebView 打开窗口
  （Windows 用 WebView2，macOS 用系统 WebKit/WKWebView）；
- 每个插件使用固定或持久化的独立端口，`localStorage` / IndexedDB / 登录态按
  origin 隔离；
- 关闭窗口后后台服务随进程退出。

所有程序都不再显示各产品的品牌启动页，打开后直接进入工作界面。

`dist/` 下生成 13 个 Windows 程序，另有框架 zip：

| EXE | 对应页面 | 端口 | 大小 | 离线资源 |
| --- | --- | --- | --- | --- |
| **OMM-ZEN.exe** | **omm-hub.html + 内置全部插件** | **8300** | **60.4 MB** | **各插件自带** |
| **OMM-ZEN-Setup.exe** | 在线安装器 | — | 17.7 MB | 无，联网下载 |
| OMM-Annotate.exe | omm-annotate.html | 8311 | 21.1 MB | pdf.js |
| OMM-Corpus.exe | omm-corpus.html | 8312 | 19.3 MB | Supabase SDK |
| OMM-Data.exe | omm-data.html | 8313 | 19.3 MB | Supabase SDK |
| OMM-English.exe | omm-english.html | 8314 | 19.4 MB | Supabase SDK |
| OMM-LaTeX.exe | omm-latex.html | 8123 | 21.1 MB | pdf.js |
| OMM-MdForge.exe | omm-mdforge.html | 8316 | 19.3 MB | 字体 + `mdforge` |
| OMM-Message.exe | omm-message.html | 8317 | 19.2 MB | Supabase SDK |
| OMM-Planner.exe | omm-planner.html | 8318 | 19.3 MB | html2canvas |
| OMM-Redact.exe | omm-redact.html | 8319 | 30.4 MB | pdf.js、MuPDF、pdf-lib、JSZip、PptxViewJS、mammoth、Chart.js、jsPDF |
| OMM-Visualization.exe | omm-visualization.html | 8320 | 20.4 MB | Chart.js、ApexCharts、ECharts、SheetJS、html2canvas、jsPDF |
| OMM-Writer.exe | omm-writer.html | 8321 | 20.3 MB | html2canvas、jsPDF、MathJax、Supabase SDK |

单个程序复制到对应系统的电脑即可运行，目标机器不需要 Python、Node 或网络。

## 插件架构

工作台本身不包含产品逻辑，只读取插件：

```text
插件目录/
├── plugin.json     # id、名称、入口页面、运行时、排序
├── index.html      # entry
├── vendor/...      # 离线依赖
└── assets/...
```

- 内置插件放在程序目录的 `plugins/<id>/`；用户插件放在
  `%LOCALAPPDATA%\OMM-ZEN\plugins\<id>\`（macOS 为
  `~/Library/Application Support/OMM-ZEN/plugins/<id>/`）。
- 同一 id 的用户插件覆盖内置插件；卸载用户版本后内置版本重新出现。
- 插件使用独立的本地端口，`static` 插件由静态服务器提供；官方
  `mdforge` / `latex` 插件使用框架内置的 Python 后端。
- 用户导入的插件必须是 `static` 运行时，不能执行本机后端代码。
- 完整规范见 `public/plugin-spec.md`，最小示例见 `public/plugin-template/`。

## 在线安装器

`OMM-ZEN-Setup.exe` / `OMM-ZEN-Setup.app` 从 GitHub Release 的
`catalog.json` 读取插件目录：

1. 选择安装位置（默认用户目录，无需管理员权限）。
2. 勾选要安装的产品；未勾选的产品不会下载。
3. 下载平台框架 `OMM-ZEN-Framework-*.zip` 和对应插件包；直连失败时自动尝试
   `ghproxy.net` 加速镜像。
4. 插件写入用户插件目录，框架写入安装位置；安装完成后可直接启动。

安装器本身也有一致的 OMM-ZEN 外观：顶部齿轮可调圆角、强调色、动效和紧凑布局，
设置会保存到本地；圆角同样作用于产品卡片和安装按钮。

工作台内的「插件」面板还支持：

- 查看已安装插件及其来源（内置 / 用户安装）；
- 在线安装、更新、卸载插件；
- 导入本地 `plugin-template.zip` 或自己的插件 zip；
- 查看插件规范。

## OMM-ZEN 工作台

`OMM-ZEN.exe` / `OMM-ZEN.app` 是完整离线合集，单独的程序仍然保留。

- **顶部标签**：打开的应用形成标签，点击切换，`×` 或中键关闭。
- **分屏**：工具栏左右/上下分屏；把标签或 Dock 图标拖到窗格上/下/左/右边缘
  可半屏分割，拖到中间可替换窗格；分隔条可拖动，双击恢复均分。
- **布局预设**：单窗格、左右双栏、上下双栏、四宫格、专注当前窗格。
- **Dock**：底部常驻应用入口，运行中的应用有黄色标记；可隐藏。
- **状态恢复**：打开的应用、分屏树、分隔比例、Dock 状态和焦点会自动保存，
  下次启动恢复；首次启动显示应用选择网格。
- **快捷键**：`Ctrl+Tab` 切换、`Ctrl+W` 关闭、`Ctrl+1…9` 打开应用、
  `Ctrl+0` 应用面板、`Ctrl+\` / `Ctrl+Shift+\` 分屏、`Ctrl+Shift+M` 专注、
  `Ctrl+Shift+D` 显示/隐藏 Dock。
- 合集使用独立的 WebView 配置目录 `OMM-ZEN/hub`，与单独应用的数据互不影响；
  需要迁移旧数据时，使用各应用自带的导出/导入。
- **外观设置**：顶部齿轮可调圆角（0/4/8/12/16）、强调色（琥珀/橄榄/赭石/雾蓝）、
  界面动效、顶部菜单栏显示/隐藏，设置会持久化。圆角同时作用于 Dock 外框和
  图标框。
- **字体与图标**：英文使用 Literata，中文使用宋体（SimSun / Songti SC）；顶部
  标签、Dock、应用面板与安装器使用用户提供的 `icon.ico` / `icon-writer.png`
  产品图标。
- 工作台外壳使用暖墨色，不使用纯黑；各产品页面保留自己的主题与配色。

## 运行要求

1. **WebView2 运行时（仅 Windows）**：Windows 11 自带；Windows 10 通常随 Edge 已安装。
   缺失时安装 “Microsoft Edge WebView2 Runtime”（Evergreen）即可。macOS 使用系统 WebKit。
2. **TeX（仅 LaTeX / MdForge）**：真正编译 `.tex` 时需要。
   Windows 用 MiKTeX，macOS 用 MacTeX；路径不再写死，见下一节。
3. **仍然需要联网的功能**：AI 接口（DeepSeek / OpenAI 等）、翻译、Supabase 云同步、
   TeX 首次自动安装缺失宏包。这些是服务本身需要网络，界面和本地编辑/导出不受影响。

## 设置 TeX 路径（不再写死）

两个应用都可在前端设置，保存后立即生效，并写入共享配置：

```
Windows: %LOCALAPPDATA%\OMM-ZEN\miktex.json
macOS:   ~/Library/Application Support/OMM-ZEN/miktex.json
```

- **LaTeX 编译工作台**：菜单「编译 → 服务地址」→ 填写「MiKTeX 路径」→
  「保存 MiKTeX 路径」。Windows 填 `xelatex.exe` 所在的 `...\miktex\bin\x64`；
  macOS 填 `/Library/TeX/texbin`（MacTeX 的稳定入口）。留空会恢复自动探测。
- **Markdown 铸造台**：右上角「偏好 / 设置 → MiKTeX」→ 填路径 →「保存 MiKTeX 路径」。
- 顺序：用户设置 → `MIKTEX_BIN` 环境变量 → 常见安装目录 → `PATH` 里的 `xelatex`。
- 保存时会校验目录内是否存在 `xelatex` / `pdflatex` / `lualatex`，
  路径无效会直接报错，不会把错误配置写进去。

## 保存路径、历史快照与跨产品共享

桌面版每个产品都可以设置自己的保存目录（默认 `Documents/OMM-ZEN`）。设置
入口是窗口左下角的「存档」按钮，包含三个页签：

- **保存设置**：填写保存 / 快照目录，选择「每次保存加时间后缀（保留所有版本）」
  或「覆盖同名文件」，并可把设置应用到所有产品。产品的「保存 / 导出」按钮
  产生的文件会直接写入该目录，不再经过浏览器下载弹窗。
- **历史快照**：保存时自动记录应用状态（LocalStorage + IndexedDB），也可以
  点「立即创建快照」。列表按时间倒序，可一键恢复；快照与保存文件一样放在
  保存目录下的 `snapshots/<产品>/`。
- **共享数据**：所有产品保存文件时都会把路径登记到共享配置，其他产品在这里
  自动看到最新文件，并按文件类型交给自己的导入入口「载入」，不需要手动导出
  再导入。

共享配置文件：

```
Windows: %LOCALAPPDATA%\OMM-ZEN\shared.json
macOS:   ~/Library/Application Support/OMM-ZEN/shared.json
```

它记录每个产品的保存路径、保存方式以及已保存文件的路径，所有产品读写同一份
文件。配置、快照和浏览器数据都在用户数据目录中，升级只会替换程序本体，不会
覆盖这些内容；更新前还会额外备份一份 `shared.backup-*.json`。

页面缩放也记录在同一份配置的 `ui.zoom` 下：在任意产品里用 Ctrl + 滚轮缩放后，
下次启动会恢复该产品的缩放比例。

## 离线是怎么做的

- `vendor/` 存放所有第三方库和 Literata 字体（约 30 MB，含 PDF/MuPDF/图表等）。
- 源码 HTML 直接引用 `vendor/...`，不再包含 CDN 地址、镜像表或加载回退逻辑。
- 构建时 `desktop/offline.py` 按插件复制它真正用到的库；完整版把每个插件放在
  `plugins/<id>/`，在线安装器也只下载选中的插件包。
- 网站部署和 EXE 使用同一套资源，不再需要构建期改写。
- 已验证应用启动后对公网的请求数为 **0**；PDF.js、MuPDF、MathJax、
  ECharts、SheetJS 等均从包内加载。

## 重新构建

```powershell
# 全部重建（11 个单独应用 + 完整版 + 框架 + 安装器）
.venv\Scripts\python.exe desktop\build_exes.py --clean

# 只构建框架 / 安装器 / 完整版
.venv\Scripts\python.exe desktop\build_exes.py framework
.venv\Scripts\python.exe desktop\build_exes.py installer
.venv\Scripts\python.exe desktop\build_exes.py hub

# 生成在线插件包和 catalog.json（先构建 framework，才能写入其校验值）
.venv\Scripts\python.exe desktop\build_plugins.py --tag v1.0.2

# 直接从源码运行工作台（使用生成的插件目录）
.venv\Scripts\python.exe desktop\omm_launcher.py --app hub --debug --plugins build\plugin-dirs

# 直接运行安装器（使用本地或线上目录）
.venv\Scripts\python.exe desktop\omm_launcher.py --app installer --catalog dist\catalog.json
```

构建依赖已装进 `.venv`：`pywebview`、`pythonnet`、`pyinstaller`。新环境：

```powershell
.venv\Scripts\python.exe -m pip install pywebview pyinstaller
```

构建顺序：先 `framework`，再 `build_plugins.py`（生成带框架校验值的目录），
最后 `hub` / `installer`。发布时上传 `dist/catalog.json`、`dist/plugins/*.zip`、
`dist/plugin-template.zip`、`dist/OMM-ZEN-Framework-win64.zip`。

## 自更新

`catalog.json` 除插件外还包含顶层 `version` 和 `apps`：每个桌面程序的版本、
下载文件名、大小和 SHA-256。应用启动后请求 `/__omm/update/check`，发现更高
版本时在右下角提示。Windows 点击「立即更新」会下载并校验更新包，再由一个
脱离当前进程的 PowerShell 助手等待退出、替换 `exe` 并重启；完整版工作台
下载 `OMM-ZEN.exe`，框架版工作台下载框架 zip 并取出其中的 exe。macOS 只提示
并打开对应架构的 DMG 下载链接。

更新只替换程序文件本身：`shared.json`、保存路径、历史快照、LocalStorage /
IndexedDB 都在用户数据目录中，更新前还会备份配置文件，重启后继续读取原配置。

发布新版本时：

1. 修改 `desktop/plugin_specs.py` 的 `VERSION`。
2. 修改 `desktop/plugin_manager.py` 的 `CATALOG_URL` 和安装器/工作流里的默认标签。
3. 先构建 `framework` 和全部 exe，再运行 `build_plugins.py --tag vX.Y.Z`，
   让 `apps` 的校验值与最终 exe 一致。
4. 按新标签创建 Release，上传全部 exe、zip、catalog 和模板。


macOS 的 DMG 体积较大，GitHub Release 提供完整下载；Gitee Release 保留 Windows
程序、插件和 `catalog.json`，macOS 的下载链接也写在 `catalog.json` 中指向 GitHub。

## macOS 构建

macOS 程序必须在 macOS 上构建，不能在 Windows 上交叉编译。仓库自带
`.github/workflows/macos-build.yml`，用 GitHub Actions 的 macOS runner 生成
Intel（`macos-15-intel`）和 Apple Silicon（`macos-15`）两套 `.app`：

1. 在 Actions 页面手动运行 “Build macOS apps”，传入目标 Release 标签。
2. 工作流会执行 `python desktop/build_exes.py --clean`，构建 11 个单独应用、
   完整版、框架和安装器。
3. 每个 `.app` 打包成 `OMM-<App>-macOS-<arch>.dmg`；框架额外打成
   `OMM-ZEN-Framework-macOS-<arch>.zip`；安装器为
   `OMM-ZEN-Setup-macOS-<arch>.dmg`。
4. DMG 和框架 zip 都会上传到 Release。

本机 Mac 构建：

```bash
python3 -m pip install -r requirements-mdforge.txt pywebview pyinstaller
python3 desktop/build_exes.py --clean
python3 desktop/build_plugins.py --tag v1.0.2
# 产物：dist/OMM-<App>.app、dist/OMM-ZEN.app、dist/OMM-ZEN-Setup.app
#       dist/OMM-ZEN-Framework-macOS-<arch>.zip
```

未签名/未公证的 `.app` 首次打开会被 Gatekeeper 拦截。从 DMG 拖入 Applications 后，
可右键「打开」，或执行：

```bash
xattr -dr com.apple.quarantine /Applications/OMM-Planner.app
```

需要正式分发时，再给 `.app` 做 `codesign` + `notarytool` 公证。

## 更新/补充离线资源

```powershell
.venv\Scripts\python.exe desktop\fetch_vendor.py
```

脚本按 `desktop/fetch_vendor.py` 里的版本表下载到 `vendor/`，已存在的文件会跳过。
换库版本时改 `FILES` / `TREES`，同时更新页面里对应的 `vendor/...` 路径。

新增一个内置插件：

1. 把 HTML 放进 `public/`，在 `desktop/plugin_specs.py` 的 `BUILTIN_PLUGINS`
   增加一项（id、名称、字标、入口页面、固定端口、runtime、依赖的 vendor 子目录）。
2. 在 `desktop/omm_launcher.py` 的 `APPS` 与 `WINDOW_TITLES` 增加独立运行入口。
3. 页面 `<head>` 引入 `<script src="omm-embed.js"></script>`。
4. 重新构建：`build_exes.py framework` → `build_plugins.py --tag v1.0.2` →
   `build_exes.py hub installer`。在线安装器与工作台插件面板会自动看到它。

用户导入自己的产品不需要改代码：按 `public/plugin-spec.md` 准备目录和
`plugin.json`，压成 zip，在工作台「插件 → 导入插件」中安装即可。

## 图标

`public/icon.ico` 和 `public/icon-writer.ico` 实际是 PNG 改名，WebView2 不能直接用。
Windows 构建时用 Pillow 转成真正的多尺寸 `app.ico`；macOS 构建时用 `iconutil`
生成 `app.icns`。想给单个应用换图标，放 `desktop/icons-src/<app>.png`
（id 见上表），会自动优先使用；合集图标使用 `desktop/icons-src/hub.png`，
不存在时回退到 `icon.ico`。

工作台和安装器中的产品图标：所思所想使用 `icon-writer.ico` 专属图标，其他产品使用
`public/omm-icons.js` 里的彩色 SVG 线稿；所有图标都不加外边框。Dock 的
「所有应用」入口也是彩色 SVG 宫格图标。

## 签名 EXE（可选）

`desktop/sign_exes.py` 支持 PFX 或证书存储指纹，优先使用 Windows SDK 的
`signtool.exe`，否则回退到 PowerShell：

```powershell
.venv\Scripts\python.exe desktop\sign_exes.py --pfx cert.pfx --password *** --all
.venv\Scripts\python.exe desktop\sign_exes.py --thumbprint <指纹> --all
```

签名要在构建之后做，**每次重新构建都要重签**。证书选择：

| 方案 | 费用 | SmartScreen | 适用 |
| --- | --- | --- | --- |
| 自签名证书 | 免费 | 仍提示未知发布者 | 仅本机/内网测试 |
| OV 代码签名证书 | 约 $100–300/年 | 需积累信誉后逐步放行 | 一般分发 |
| EV 代码签名证书 | 约 $300–600/年 + 硬件令牌 | 通常立即受信任 | 面向公众分发 |
| Azure Trusted Signing | 约 $10/月 | 微软托管、CA 信任链 | 有 3 年经营记录的组织 |

## 已知取舍

- **固定端口**：端口被其它程序占用时会退回随机端口，该次运行的
  `localStorage` 会落在另一个 origin，看起来像“数据没了”。关掉占用端口的程序再启动即可。
- **首次启动约 1–3 秒**：onefile 包需要先解压到临时目录。
- **在线安装器需要网络**：安装器本身和首次下载插件需要联网；安装完成后工作台和插件可离线使用。
- **自定义插件只支持 static**：导入的插件不能执行本机 Python 后端；官方 mdforge / latex 插件除外。
- **h5-news.html 未打包**：它依赖 `h5news/`（约 16 MB 图片/视频），需要时可按同样方式加入。
- **TeX 宏包**：离线环境请在联网机器上预先装好所需 MiKTeX 宏包。
