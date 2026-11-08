# OMM-ZEN 桌面版构建说明

把 `public/` 下的每个 `omm-*.html` 打包成独立的桌面程序：Windows 为 `.exe`，
macOS 为 `.app`。每个程序：

- 内嵌页面、字体和所有前端依赖（`vendor/`），**不联网也能完整打开和操作界面**；
- 在本机回环地址上起一个仅本机可访问的 HTTP 服务，再用系统 WebView 打开窗口
  （Windows 用 WebView2，macOS 用系统 WebKit/WKWebView）；
- 每个应用使用固定端口，`localStorage` / IndexedDB / 登录态稳定保存在
  `%LOCALAPPDATA%\OMM-ZEN\<应用名>\`（Windows）或
  `~/Library/Application Support/OMM-ZEN/<应用名>/`（macOS）；
- 关闭窗口后后台服务随进程退出。

`dist/` 下已生成 11 个 Windows 程序：

| EXE | 对应页面 | 端口 | 大小 | 离线资源 |
| --- | --- | --- | --- | --- |
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

## 离线是怎么做的

- `vendor/` 存放所有第三方库和 Literata 字体（约 30 MB，含 PDF/MuPDF/图表等）。
- 源码 HTML 直接引用 `vendor/...`，不再包含 CDN 地址、镜像表或加载回退逻辑。
- 构建时 `desktop/offline.py` 只做一件事：按应用复制它真正用到的库，
  避免每个 EXE 都塞满 30 MB。
- 网站部署和 EXE 使用同一套资源，不再需要构建期改写。
- 已验证 11 个 EXE 启动后对公网的请求数为 **0**；PDF.js、MuPDF、
  MathJax、ECharts、SheetJS 等均从包内加载。

## 重新构建

```powershell
# 全部重建（输出到 dist/）
.venv\Scripts\python.exe desktop\build_exes.py --clean

# 只构建某几个
.venv\Scripts\python.exe desktop\build_exes.py planner writer

# 查看应用清单
.venv\Scripts\python.exe desktop\build_exes.py --list

# 直接从源码运行（调试用，改 HTML 后无需重新打包）
.venv\Scripts\python.exe desktop\omm_launcher.py --app planner --debug
```

构建依赖已装进 `.venv`：`pywebview`、`pythonnet`、`pyinstaller`。新环境：

```powershell
.venv\Scripts\python.exe -m pip install pywebview pyinstaller
```

## macOS 构建

macOS 程序必须在 macOS 上构建，不能在 Windows 上交叉编译。仓库自带
`.github/workflows/macos-build.yml`，用 GitHub Actions 的 macOS runner 生成
Intel（`macos-15-intel`）和 Apple Silicon（`macos-15`）两套 `.app`：

1. 推送 `macos-*` 标签，或在 Actions 页面手动运行 “Build macOS apps”。
2. 工作流会执行 `python desktop/build_exes.py --clean`，把每个 `.app` 打包成
   `OMM-<App>-macOS-<arch>.dmg`，上传到指定的 GitHub Release（默认 `v1.0.0`）。

本机 Mac 构建：

```bash
python3 -m pip install -r requirements-mdforge.txt pywebview pyinstaller
python3 desktop/build_exes.py --clean
# 产物：dist/OMM-<App>.app
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

新增一个应用：

1. 把 HTML 放进 `public/`，在 `desktop/omm_launcher.py` 的 `APPS` 加一行
   （文件名、固定端口、后端 `None` / `"mdforge"` / `"latex"`），
   `WINDOW_TITLES` 写窗口标题。
2. 在 `desktop/build_exes.py` 的 `EXE_NAMES` 加 EXE 名。
3. 在 `desktop/offline.py` 的 `APP_VENDOR` 写它需要的库目录；
   页面里直接用 `vendor/...` 路径引用。
4. 重新构建该应用。

## 图标

`public/icon.ico` 和 `public/icon-writer.ico` 实际是 PNG 改名，WebView2 不能直接用。
Windows 构建时用 Pillow 转成真正的多尺寸 `app.ico`；macOS 构建时用 `iconutil`
生成 `app.icns`。想给单个应用换图标，放 `desktop/icons-src/<app>.png`
（id 见上表），会自动优先使用。

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
- **h5-news.html 未打包**：它依赖 `h5news/`（约 16 MB 图片/视频），需要时可按同样方式加入。
- **TeX 宏包**：离线环境请在联网机器上预先装好所需 MiKTeX 宏包。
