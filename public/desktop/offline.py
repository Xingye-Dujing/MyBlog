"""Stage desktop applications, the hub framework, and plugin directories."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from plugin_specs import BUILTIN_PLUGINS, PLUGIN_BY_ID, manifest

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
    "plugin-spec.md",
]

INSTALLER_ASSETS = ["installer.html", "installer.css", "installer.js", "omm-icons.js"]

PLUGIN_ASSETS = ["omm-embed.js", "omm-desktop.js", "icon.ico", "icon-writer.ico"]


def _copy_common(dest: Path) -> None:
    for asset in ("icon.ico", "icon-writer.ico", "icon-writer.png"):
        src = ROOT / asset
        if src.is_file():
            shutil.copy2(src, dest / src.name)
    for src in ROOT.glob("icon-*.png"):
        shutil.copy2(src, dest / src.name)


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
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    shutil.copy2(ROOT / html_name, dest / html_name)
    shutil.copy2(ROOT / "omm-embed.js", dest / "omm-embed.js")
    shutil.copy2(ROOT / "omm-desktop.js", dest / "omm-desktop.js")
    for asset in common_assets:
        shutil.copy2(ROOT / asset, dest / Path(asset).name)
    copy_vendor(dest, app_id)
    return dest


def stage_plugin(app_id: str, dest: Path) -> Path:
    """Create one plugin directory: manifest, entry page and its assets."""
    item = PLUGIN_BY_ID[app_id]
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    shutil.copy2(ROOT / item["entry"], dest / item["entry"])
    for asset in PLUGIN_ASSETS:
        src = ROOT / asset
        if src.is_file():
            shutil.copy2(src, dest / src.name)
    if item.get("apl_font"):
        shutil.copy2(ROOT / "APL385.ttf", dest / "APL385.ttf")
    if item.get("examples"):
        shutil.copytree(
            ROOT / "mdforge-examples", dest / "mdforge-examples", dirs_exist_ok=True
        )
    copy_vendor(dest, app_id)
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
    _copy_common(dest)
    for asset in common_assets:
        shutil.copy2(ROOT / asset, dest / Path(asset).name)
    (dest / "vendor").mkdir(parents=True, exist_ok=True)
    shutil.copytree(VENDOR / "fonts", dest / "vendor" / "fonts", dirs_exist_ok=True)
    shutil.copytree(ROOT / "plugin-template", dest / "plugin-template", dirs_exist_ok=True)
    shutil.copy2(ROOT / "latex-serve.py", dest / "latex-serve.py")


def stage_hub(dest: Path, common_assets=()) -> Path:
    """Full offline hub: shell + every built-in plugin under plugins/<id>."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    _stage_shell(dest, common_assets=common_assets)
    for item in BUILTIN_PLUGINS:
        stage_plugin(item["id"], dest / "plugins" / item["id"])
    return dest


def stage_framework(dest: Path, common_assets=()) -> Path:
    """Plugin-less hub framework used by the online installer."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    _stage_shell(dest, common_assets=common_assets)
    (dest / "plugins").mkdir()
    return dest


def stage_installer(dest: Path, common_assets=()) -> Path:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for asset in INSTALLER_ASSETS:
        shutil.copy2(ROOT / asset, dest / asset)
    shutil.copy2(ROOT / "plugin-spec.md", dest / "plugin-spec.md")
    _copy_common(dest)
    for asset in common_assets:
        shutil.copy2(ROOT / asset, dest / Path(asset).name)
    (dest / "vendor").mkdir(parents=True, exist_ok=True)
    shutil.copytree(VENDOR / "fonts", dest / "vendor" / "fonts", dirs_exist_ok=True)
    return dest
