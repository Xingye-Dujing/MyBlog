# video-runtime — 内置 ffmpeg 运行时

`bin/ffmpeg.exe` 是随视频工作台一起分发的轻量 ffmpeg，用户无需自行安装。

- 版本：`ffmpeg version 7.1-essentials_build-www.gyan.dev`
- 来源：`imageio-ffmpeg 0.6.0`（win_amd64 wheel）内的静态构建
- 构建配置：`--enable-gpl --enable-version3 --enable-static`，含 libx264、
  libx265、libvpx、libmp3lame、drawtext、silencedetect、blackdetect 等常用能力
- 原始大小：约 84 MB；插件 zip 压缩后约 30 MB（低于插件 220 MB 上限）
- 不含 ffprobe：媒体信息通过解析 `ffmpeg -i` 输出获得，进一步减小体积

## 查找顺序

`video-serve.py` 按以下顺序定位 ffmpeg：

1. `OMM_FFMPEG` 环境变量（hub 会指向插件目录里的内置版本）
2. `<插件目录>/video-runtime/bin/ffmpeg.exe`
3. `<public 根目录>/video-runtime/bin/ffmpeg.exe`
4. 系统 PATH 中的 `ffmpeg`

前端顶部徽标会显示“ffmpeg 内置 ✓”或“系统”。

## 替换方式

把新的 ffmpeg 放到 `bin/` 覆盖同名文件即可；后端在首次调用时缓存路径，
替换后重启视频产品生效。macOS / Linux 构建请放同名无扩展文件 `ffmpeg`。

## 许可证提示（发布前请确认）

该二进制由 gyan.dev 的 GPL 构建（启用 `--enable-gpl --enable-version3`），
属于 GPLv3 兼容许可；`imageio-ffmpeg` 的打包脚本本身是 BSD-2-Clause。
对外发布包含该二进制的插件/安装包时，应随附 GPLv3 许可证文本及源代码获取说明：

- GPLv3 全文：https://www.gnu.org/licenses/gpl-3.0.txt
- gyan.dev 构建与源码：https://www.gyan.dev/ffmpeg/builds/

`work/` 目录只放运行时上传文件与任务产物，打包时不分发其中的内容。
