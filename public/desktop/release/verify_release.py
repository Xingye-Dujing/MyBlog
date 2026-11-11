# -*- coding: utf-8 -*-
"""Verify a published OMM-ZEN release.

    python desktop/release/verify_release.py --tag v1.0.2

Checks the local build against the catalog and, when the GitHub CLI is
available, compares the published asset list with the local dist folder.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DIST = ROOT / "dist"
REPO = "Xingye-Dujing/MyBlog"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="verify an OMM-ZEN release")
    parser.add_argument("--tag", default="v1.0.2")
    parser.add_argument("--catalog", default=str(DIST / "catalog.json"))
    args = parser.parse_args()

    catalog_path = Path(args.catalog)
    if not catalog_path.is_file():
        print("catalog.json missing: %s" % catalog_path)
        return 1
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))

    problems = []
    print("version : %s" % catalog.get("version"))
    print("tag     : %s" % catalog.get("tag"))

    for app, item in (catalog.get("apps") or {}).items():
        local = DIST / item["bundle"]
        if not local.is_file():
            problems.append("missing binary: %s" % local.name)
            continue
        if sha256(local) != item["sha256"]:
            problems.append("sha mismatch: %s" % local.name)
        if local.stat().st_size != item["size"]:
            problems.append("size mismatch: %s" % local.name)
    for item in catalog.get("plugins") or []:
        local = DIST / "plugins" / item["bundle"]
        if not local.is_file():
            problems.append("missing plugin: %s" % local.name)
        elif sha256(local) != item["sha256"]:
            problems.append("plugin sha mismatch: %s" % local.name)
    framework = DIST / "OMM-ZEN-Framework-win64.zip"
    entry = (catalog.get("frameworks") or {}).get("win64") or {}
    if framework.is_file() and entry.get("sha256"):
        if sha256(framework) != entry["sha256"]:
            problems.append("framework sha mismatch")

    print("apps    : %d" % len(catalog.get("apps") or {}))
    print("plugins : %d" % len(catalog.get("plugins") or {}))

    if shutil.which("gh"):
        try:
            raw = subprocess.run(
                ["gh", "release", "view", args.tag, "-R", REPO, "--json", "assets"],
                capture_output=True, text=True, check=True,
            ).stdout
            assets = json.loads(raw).get("assets") or []
            names = [item["name"] for item in assets]
            mac = [name for name in names if "macOS" in name]
            win = [name for name in names if "macOS" not in name]
            print("github  : %d assets (%d windows, %d macos)" % (len(names), len(win), len(mac)))
            for required in ("catalog.json", "OMM-ZEN.exe", "OMM-ZEN-Framework-win64.zip"):
                if required not in names:
                    problems.append("github release missing: %s" % required)
        except Exception as exc:  # noqa: BLE001
            print("github check skipped: %s" % exc)
    else:
        print("github  : gh CLI not found, skipped")

    if problems:
        print("\nFAILED:")
        for item in problems:
            print("  - %s" % item)
        return 1
    print("\nOK: catalog and release assets are consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
