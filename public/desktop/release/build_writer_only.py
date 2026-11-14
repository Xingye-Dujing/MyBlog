# -*- coding: utf-8 -*-
"""Build only the Writer plugin bundle and refresh a writer-only catalog.

This is for small follow-up releases where only omm-writer.html changed.
The global catalog version stays at the previous value so every other app
does not keep offering an update it cannot install; the Writer plugin carries
its own higher version and updates through the plugin manager.

The standalone OMM-Writer.exe must be built separately with
``plugin_specs.VERSION`` temporarily raised to ``WRITER_VERSION`` (the exe
bakes that value in at build time), then this script rebuilds the plugin and
rewrites the catalog entries for writer.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DESKTOP = ROOT / "desktop"
if str(DESKTOP) not in sys.path:
    sys.path.insert(0, str(DESKTOP))

import offline  # noqa: E402
from build_plugins import OUT, DIST, sha256, zip_dir  # noqa: E402
from plugin_specs import PLUGIN_BY_ID  # noqa: E402

TAG = "v1.0.12"
WRITER_VERSION = "1.0.12"


def main() -> None:
    item = PLUGIN_BY_ID["writer"]
    plugin_dir = offline.stage_plugin("writer", ROOT / "build" / "plugin-dirs" / "writer")
    manifest = json.loads((plugin_dir / "plugin.json").read_text(encoding="utf-8"))
    manifest["version"] = WRITER_VERSION
    (plugin_dir / "plugin.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    bundle = "plugin-writer-%s.zip" % WRITER_VERSION
    target = OUT / bundle
    zip_dir(plugin_dir, target)

    catalog_path = DIST / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    catalog["tag"] = TAG
    catalog["writer_only_release"] = True
    base = "https://gitee.com/Xingye-Dujing/my-blog/releases/download/%s" % TAG
    latest = "https://gitee.com/Xingye-Dujing/my-blog/releases/download/latest"

    for plugin in catalog.get("plugins", []):
        if plugin.get("id") != "writer":
            continue
        plugin.update(
            {
                "version": WRITER_VERSION,
                "bundle": bundle,
                "url": base + "/" + bundle,
                "sha256": sha256(target),
                "size": target.stat().st_size,
            }
        )
    exe = DIST / "OMM-Writer.exe"
    if not exe.is_file():
        raise SystemExit("missing %s" % exe)
    app = catalog.setdefault("apps", {}).setdefault("writer", {})
    app.update(
        {
            "version": WRITER_VERSION,
            "bundle": "OMM-Writer.exe",
            "url": base + "/OMM-Writer.exe",
            "latest_url": latest + "/OMM-Writer.exe",
            "sha256": sha256(exe),
            "size": exe.stat().st_size,
        }
    )
    catalog_path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("plugin : %s (%.1f MB)" % (target.name, target.stat().st_size / 1048576))
    print("exe    : %s (%.1f MB)" % (exe.name, exe.stat().st_size / 1048576))
    print("catalog: %s tag=%s version=%s" % (catalog_path, catalog.get("tag"), catalog.get("version")))


if __name__ == "__main__":
    main()
