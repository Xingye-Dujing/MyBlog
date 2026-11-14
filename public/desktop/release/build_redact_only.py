# -*- coding: utf-8 -*-
"""Build only the Redact plugin bundle and refresh a redact-only catalog.

Companion of ``build_writer_only.py`` for follow-up releases where only the
document redaction product changed.  The global catalog version stays at the
previous value so the other products are not offered an update they cannot
install; the Redact plugin carries its own version and updates through the
plugin manager.

The standalone ``OMM-Redact.exe`` must be built first with
``plugin_specs.VERSION`` temporarily raised to ``REDACT_VERSION`` (the version
is baked into the executable), then this script rebuilds the plugin bundle and
rewrites only the redact entries in ``dist/catalog.json``.
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

TAG = "v1.0.14"
REDACT_VERSION = "1.0.14"


def main() -> None:
    item = PLUGIN_BY_ID["redact"]
    plugin_dir = offline.stage_plugin("redact", ROOT / "build" / "plugin-dirs" / "redact")
    manifest = json.loads((plugin_dir / "plugin.json").read_text(encoding="utf-8"))
    manifest["version"] = REDACT_VERSION
    (plugin_dir / "plugin.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    bundle = "plugin-redact-%s.zip" % REDACT_VERSION
    target = OUT / bundle
    zip_dir(plugin_dir, target)

    catalog_path = DIST / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    catalog["tag"] = TAG
    catalog["redact_only_release"] = True
    base = "https://gitee.com/Xingye-Dujing/my-blog/releases/download/%s" % TAG
    latest = "https://gitee.com/Xingye-Dujing/my-blog/releases/download/latest"

    for plugin in catalog.get("plugins", []):
        if plugin.get("id") != "redact":
            continue
        plugin.update(
            {
                "version": REDACT_VERSION,
                "bundle": bundle,
                "url": base + "/" + bundle,
                "sha256": sha256(target),
                "size": target.stat().st_size,
                "description": item.get("description") or plugin.get("description"),
            }
        )
    exe = DIST / "OMM-Redact.exe"
    if not exe.is_file():
        raise SystemExit("missing %s" % exe)
    app = catalog.setdefault("apps", {}).setdefault("redact", {})
    app.update(
        {
            "version": REDACT_VERSION,
            "bundle": "OMM-Redact.exe",
            "url": base + "/OMM-Redact.exe",
            "latest_url": latest + "/OMM-Redact.exe",
            "sha256": sha256(exe),
            "size": exe.stat().st_size,
        }
    )
    catalog_path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("plugin : %s (%.1f MB)" % (target.name, target.stat().st_size / 1048576))
    print("exe    : %s (%.1f MB)" % (exe.name, exe.stat().st_size / 1048576))
    print(
        "catalog: %s tag=%s version=%s"
        % (catalog_path, catalog.get("tag"), catalog.get("version"))
    )


if __name__ == "__main__":
    main()
