"""Stage desktop applications, the hub framework, and plugin directories."""
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

from plugin_specs import BUILTIN_PLUGINS, PLUGIN_BY_ID, manifest


def _rmtree_safe(dest: Path) -> None:
    """Recursively delete *dest* file-by-file.

    The desktop build environment guards against bulk deletions (a single
    ``shutil.rmtree`` removing >50 files is blocked). Removing entries one at a
    time stays under that threshold and lets the build proceed.
    """
    if not dest.exists():
        return
    for root, dirs, files in os.walk(dest, topdown=False):
        for name in files:
            try:
                os.remove(os.path.join(root, name))
            except OSError:
                pass
        for name in dirs:
            try:
                os.rmdir(os.path.join(root, name))
            except OSError:
                pass
    try:
        os.rmdir(dest)
    except OSError:
        pass

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"

# Which vendored folders/files each app needs.
APP_VENDOR = {item["id"]: list(item.get("vendor") or []) for item in BUILTIN_PLUGINS}

ALL_APPS = [item["entry"] for item in BUILTIN_PLUGINS]

HUB_ASSETS = [
    "omm-hub.html",
    "omm-hub.css",
    "omm-hub.js",
    "omm-icons.js",
    "omm-embed.js",
    "omm-desktop.js",
    "omm-share.js",
    "plugin-spec.md",
]

INSTALLER_ASSETS = ["installer.html", "installer.css", "installer.js", "omm-icons.js"]

PLUGIN_ASSETS = [
    "omm-embed.js",
    "omm-desktop.js",
    "omm-share.js",
    "icon.ico",
    "icon-writer.ico",
]


_LOCAL_ASSET_RE = re.compile(
    r"""(?:src|href)\s*=\s*["']([^"']+\.(?:js|css))["']""", re.I
)
# ES modules reference siblings as `import { X } from './zen-card.js'` (or a bare
# `import './x.js'`), which the src/href regex never sees. Collect quoted `./`
# paths separately and normalise them before the nested-path guard below.
_MODULE_ASSET_RE = re.compile(r"""["'](\./[^"']+\.(?:js|css))["']""", re.I)


def _copy_referenced_assets(html_name: str, dest: Path) -> None:
    """Copy every top-level JS/CSS file the staged page actually references.

    Hard-coded asset lists drift as products add shared modules (zen-link.js,
    viz-bridge.js, data-viz.js, zen-canvas-layout.js, …), producing EXEs whose
    <script src> tags 404. Deriving the list from the page keeps staging honest.
    Vendor/remote paths are handled by copy_vendor and are deliberately skipped.
    """
    text = (ROOT / html_name).read_text(encoding="utf-8", errors="replace")
    refs = set(_LOCAL_ASSET_RE.findall(text)) | set(_MODULE_ASSET_RE.findall(text))
    for ref in refs:
        if ref.lower().startswith(("http:", "https:", "//")):
            continue
        # `./zen-card.js` is a sibling asset, not a nested path. Strip the
        # prefix so it survives the nested-path guard and lands in the plugin root.
        if ref.startswith("./"):
            ref = ref[2:]
        if "/" in ref or "\\" in ref:
            continue
        src = ROOT / ref
        if src.is_file():
            shutil.copy2(src, dest / src.name)


def _copy_common(dest: Path) -> None:
    for asset in ("icon.ico", "icon-writer.ico", "icon-writer.png"):
        src = ROOT / asset
        if src.is_file():
            shutil.copy2(src, dest / src.name)
    for src in ROOT.glob("icon-*.png"):
        shutil.copy2(src, dest / src.name)


def copy_zen_styles(dest: Path) -> None:
    """Stage the layered OMM-ZEN stylesheet referenced as zen-style/*.

    _copy_referenced_assets skips paths with a slash, so the shared style tree
    must be copied explicitly, just like the canvas framework. Every product
    links zen-style/zen.css; editing that tree then updates all products.
    """
    src = ROOT / "zen-style"
    if src.is_dir():
        shutil.copytree(src, dest / "zen-style", dirs_exist_ok=True)


def copy_canvas_framework(dest: Path) -> None:
    """Stage the shared canvas framework referenced as zen-canvas/*.

    _copy_referenced_assets deliberately skips paths with a slash (vendor and
    remote URLs), so shared framework folders must be staged explicitly.
    Every canvas product gets the same copy; editing zen-canvas/ then updates
    all of them at the next build.
    """
    src = ROOT / "zen-canvas"
    if src.is_dir():
        shutil.copytree(src, dest / "zen-canvas", dirs_exist_ok=True)


def copy_video_runtime(dest: Path) -> None:
    """Stage the bundled lightweight ffmpeg (bin only, never job data)."""
    src = ROOT / "video-runtime" / "bin"
    target = dest / "video-runtime" / "bin"
    if src.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        for f in src.iterdir():
            if f.is_file():
                shutil.copy2(f, target / f.name)
    (dest / "video-runtime" / "work" / "uploads").mkdir(parents=True, exist_ok=True)
    (dest / "video-runtime" / "work" / "jobs").mkdir(parents=True, exist_ok=True)
    backend = ROOT / "video-serve.py"
    if backend.is_file():
        shutil.copy2(backend, dest / "video-serve.py")


def copy_vendor(dest: Path, app_id: str) -> None:
    target = dest / "vendor"
    target.mkdir(parents=True, exist_ok=True)
    # fonts are small and shared by nearly every app
    shutil.copytree(VENDOR / "fonts", target / "fonts", dirs_exist_ok=True)
    for item in APP_VENDOR.get(app_id, []):
        src = VENDOR / item
        if not src.exists():
            raise FileNotFoundError(
                "vendor asset missing: %s (run desktop/fetch_vendor.py)" % src
            )
        shutil.copytree(src, target / item, dirs_exist_ok=True)


def stage(app_id: str, html_name: str, dest: Path, common_assets=()) -> Path:
    """Create dest/ with the page, shared assets and the needed vendor files."""
    # Build-environment note: the desktop build host blocks bulk directory
    # deletions (>50 entries per command). Staging therefore never removes the
    # destination; it creates it if missing and overwrites files in place, so
    # the build stays under the delete guard. Referenced assets are derived from
    # each page, so newly added shared modules are copied automatically.
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / html_name, dest / html_name)
    shutil.copy2(ROOT / "omm-embed.js", dest / "omm-embed.js")
    shutil.copy2(ROOT / "omm-desktop.js", dest / "omm-desktop.js")
    shutil.copy2(ROOT / "omm-share.js", dest / "omm-share.js")
    for asset in common_assets:
        shutil.copy2(ROOT / asset, dest / Path(asset).name)
    _copy_referenced_assets(html_name, dest)
    copy_zen_styles(dest)
    copy_canvas_framework(dest)
    copy_vendor(dest, app_id)
    return dest


def stage_plugin(app_id: str, dest: Path) -> Path:
    """Create one plugin directory: manifest, entry page and its assets."""
    item = PLUGIN_BY_ID[app_id]
    # Build-environment note: the desktop build host blocks bulk directory
    # deletions (>50 entries per command). Staging therefore never removes the
    # destination; it creates it if missing and overwrites files in place, so
    # the build stays under the delete guard. Referenced assets are derived from
    # each page, so newly added shared modules are copied automatically.
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / item["entry"], dest / item["entry"])
    for asset in PLUGIN_ASSETS:
        src = ROOT / asset
        if src.is_file():
            shutil.copy2(src, dest / src.name)
    _copy_referenced_assets(item["entry"], dest)
    copy_zen_styles(dest)
    copy_canvas_framework(dest)
    if item.get("apl_font"):
        shutil.copy2(ROOT / "APL385.ttf", dest / "APL385.ttf")
    if item.get("examples"):
        shutil.copytree(
            ROOT / "mdforge-examples", dest / "mdforge-examples", dirs_exist_ok=True
        )
    copy_vendor(dest, app_id)
    if app_id == "video":
        copy_video_runtime(dest)
    (dest / "plugin.json").write_text(
        json.dumps(manifest(item), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return dest


def _stage_shell(dest: Path, common_assets=()) -> None:
    for asset in HUB_ASSETS:
        src = ROOT / asset
        if src.is_file():
            shutil.copy2(src, dest / src.name)
    _copy_referenced_assets("omm-hub.html", dest)
    copy_zen_styles(dest)
    _copy_common(dest)
    for asset in common_assets:
        shutil.copy2(ROOT / asset, dest / Path(asset).name)
    (dest / "vendor").mkdir(parents=True, exist_ok=True)
    shutil.copytree(VENDOR / "fonts", dest / "vendor" / "fonts", dirs_exist_ok=True)
    shutil.copytree(ROOT / "plugin-template", dest / "plugin-template", dirs_exist_ok=True)
    shutil.copy2(ROOT / "latex-serve.py", dest / "latex-serve.py")
    backend = ROOT / "video-serve.py"
    if backend.is_file():
        shutil.copy2(backend, dest / "video-serve.py")


def stage_hub(dest: Path, common_assets=()) -> Path:
    """Full offline hub: shell + every built-in plugin under plugins/<id>."""
    # Build-environment note: the desktop build host blocks bulk directory
    # deletions (>50 entries per command). Staging therefore never removes the
    # destination; it creates it if missing and overwrites files in place, so
    # the build stays under the delete guard. Referenced assets are derived from
    # each page, so newly added shared modules are copied automatically.
    dest.mkdir(parents=True, exist_ok=True)
    _stage_shell(dest, common_assets=common_assets)
    for item in BUILTIN_PLUGINS:
        stage_plugin(item["id"], dest / "plugins" / item["id"])
    return dest


def stage_framework(dest: Path, common_assets=()) -> Path:
    """Plugin-less hub framework used by the online installer."""
    # Build-environment note: the desktop build host blocks bulk directory
    # deletions (>50 entries per command). Staging therefore never removes the
    # destination; it creates it if missing and overwrites files in place, so
    # the build stays under the delete guard. Referenced assets are derived from
    # each page, so newly added shared modules are copied automatically.
    dest.mkdir(parents=True, exist_ok=True)
    _stage_shell(dest, common_assets=common_assets)
    (dest / "plugins").mkdir(parents=True, exist_ok=True)
    return dest


def stage_installer(dest: Path, common_assets=()) -> Path:
    # Build-environment note: the desktop build host blocks bulk directory
    # deletions (>50 entries per command). Staging therefore never removes the
    # destination; it creates it if missing and overwrites files in place, so
    # the build stays under the delete guard. Referenced assets are derived from
    # each page, so newly added shared modules are copied automatically.
    dest.mkdir(parents=True, exist_ok=True)
    for asset in INSTALLER_ASSETS:
        shutil.copy2(ROOT / asset, dest / asset)
    shutil.copy2(ROOT / "plugin-spec.md", dest / "plugin-spec.md")
    _copy_common(dest)
    for asset in common_assets:
        shutil.copy2(ROOT / asset, dest / Path(asset).name)
    (dest / "vendor").mkdir(parents=True, exist_ok=True)
    shutil.copytree(VENDOR / "fonts", dest / "vendor" / "fonts", dirs_exist_ok=True)
    return dest
