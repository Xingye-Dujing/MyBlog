# -*- coding: utf-8 -*-
"""Build plugin bundles, a development plugin root, and the online catalog.

    python desktop/build_plugins.py
    python desktop/build_plugins.py --tag v1.0.2

Outputs:
    build/plugin-dirs/<id>/                 # for running the hub from source
    dist/plugins/plugin-<id>-<version>.zip  # release assets
    dist/catalog.json                       # release asset (catalog.json)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

from plugin_specs import BUILTIN_PLUGINS, DESKTOP_EXE_NAMES, VERSION
import offline

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build" / "plugin-dirs"
DIST = ROOT / "dist"
OUT = DIST / "plugins"
REPO = "Xingye-Dujing/my-blog"

FRAMEWORKS = {
    "win64": "OMM-ZEN-Framework-win64.zip",
    "macos-arm64": "OMM-ZEN-Framework-macOS-arm64.zip",
    "macos-x86_64": "OMM-ZEN-Framework-macOS-x86_64.zip",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def zip_dir(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(source).as_posix())


def main() -> None:
    parser = argparse.ArgumentParser(description="Build OMM-ZEN plugin bundles")
    parser.add_argument("--tag", default="v" + VERSION, help="release tag for download URLs")
    parser.add_argument("--base", default="", help="override release download base URL")
    args = parser.parse_args()

    if BUILD.exists():
        shutil.rmtree(BUILD)
    BUILD.mkdir(parents=True)
    OUT.mkdir(parents=True, exist_ok=True)

    base = args.base or "https://gitee.com/%s/releases/download/%s" % (REPO, args.tag)
    catalog = {
        "schema": 1,
        "version": VERSION,
        "tag": args.tag,
        "base_url": base,
        "plugins": [],
        "frameworks": {},
        "apps": {},
    }

    print("Building %d plugin bundles" % len(BUILTIN_PLUGINS))
    for item in BUILTIN_PLUGINS:
        plugin_dir = offline.stage_plugin(item["id"], BUILD / item["id"])
        bundle_name = "plugin-%s-%s.zip" % (item["id"], item["version"] if "version" in item else VERSION)
        target = OUT / bundle_name
        zip_dir(plugin_dir, target)
        manifest = json.loads((plugin_dir / "plugin.json").read_text(encoding="utf-8"))
        catalog["plugins"].append(
            {
                "id": manifest["id"],
                "name": manifest["name"],
                "version": manifest["version"],
                "description": manifest["description"],
                "glyph": manifest["glyph"],
                "runtime": manifest["runtime"],
                "order": manifest["order"],
                "bundle": bundle_name,
                "sha256": sha256(target),
                "size": target.stat().st_size,
            }
        )
        print(
            "  %-14s %-30s %6.1f MB"
            % (manifest["id"], manifest["name"], target.stat().st_size / 1024 / 1024)
        )

    for platform, asset in FRAMEWORKS.items():
        entry = {"url": base + "/" + asset, "bundle": asset}
        local = DIST / asset
        if local.is_file():
            entry["sha256"] = sha256(local)
            entry["size"] = local.stat().st_size
        catalog["frameworks"][platform] = entry

    for app_id, name in DESKTOP_EXE_NAMES.items():
        local = DIST / (name + ".exe")
        if not local.is_file():
            continue
        bundle = name + ".exe"
        catalog["apps"][app_id] = {
            "version": VERSION,
            "url": base + "/" + bundle,
            "bundle": bundle,
            "sha256": sha256(local),
            "size": local.stat().st_size,
        }

    catalog_path = DIST / "catalog.json"
    catalog_path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    template_zip = DIST / "plugin-template.zip"
    zip_dir(ROOT / "plugin-template", template_zip)
    shutil.copy2(ROOT / "plugin-spec.md", DIST / "plugin-spec.md")
    print("\nCatalog: %s" % catalog_path)
    print("Template: %s" % template_zip)
    print("Spec: %s" % (DIST / "plugin-spec.md"))
    print("Plugin root for source runs: %s" % BUILD)
    print("Next: upload dist/plugins/*.zip, dist/catalog.json and dist/plugin-template.zip")


if __name__ == "__main__":
    main()
