# -*- coding: utf-8 -*-
"""Build one standalone desktop app per OMM-ZEN page.

Windows: dist/OMM-<App>.exe (PyInstaller + WebView2)
macOS:   dist/OMM-<App>.app (PyInstaller + WKWebView)

    python desktop/build_exes.py              # all 11 apps
    python desktop/build_exes.py planner writer
    python desktop/build_exes.py --list
    python desktop/build_exes.py --clean

The target machine needs no Python. Windows needs WebView2; macOS uses the
system WebKit and needs no extra runtime.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from omm_launcher import APPS
import offline

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "desktop"
BUILD = ROOT / "build" / "desktop"
DIST = ROOT / "dist"

IS_MACOS = sys.platform == "darwin"
IS_WINDOWS = os.name == "nt"
DATA_SEP = ":" if IS_MACOS else ";"
APP_SUFFIX = ".app" if IS_MACOS else ".exe"

EXE_NAMES = {
    "annotate": "OMM-Annotate",
    "corpus": "OMM-Corpus",
    "data": "OMM-Data",
    "english": "OMM-English",
    "latex": "OMM-LaTeX",
    "mdforge": "OMM-MdForge",
    "message": "OMM-Message",
    "planner": "OMM-Planner",
    "redact": "OMM-Redact",
    "visualization": "OMM-Visualization",
    "writer": "OMM-Writer",
}

COMMON_ASSETS = ["APL385.ttf", "icon.ico", "icon-writer.ico"]


def _square_image(source: Path):
    from PIL import Image, ImageOps

    img = Image.open(source).convert("RGBA")
    side = max(img.size)
    return ImageOps.pad(img, (side, side), color=(0, 0, 0, 0))


def make_ico(source: Path, target: Path) -> Path:
    """The repo icons are PNGs renamed to .ico; build a real multi-size icon."""
    img = _square_image(source)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    target.parent.mkdir(parents=True, exist_ok=True)
    img.save(target, format="ICO", sizes=[(s, s) for s in sizes])
    return target


def make_icns(source: Path, target: Path) -> Path:
    """Build a .icns with the system iconutil (macOS build host)."""
    img = _square_image(source)
    iconset = target.with_suffix(".iconset")
    shutil.rmtree(iconset, ignore_errors=True)
    iconset.mkdir(parents=True)
    specs = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for size, filename in specs:
        img.resize((size, size)).save(iconset / filename)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(target)],
            check=True,
            capture_output=True,
        )
    except Exception:
        # Fallback for hosts without iconutil (Pillow's ICNS writer).
        img.save(target, format="ICNS")
    finally:
        shutil.rmtree(iconset, ignore_errors=True)
    return target


def build(app_id: str) -> bool:
    html, _port, backend = APPS[app_id]
    name = EXE_NAMES[app_id]
    entry = BUILD / "entries" / ("omm_start_%s.py" % app_id)
    work = BUILD / "work" / app_id
    icon_src = ROOT / ("icon-writer.ico" if app_id == "writer" else "icon.ico")
    custom_icon = DESKTOP / "icons-src" / ("%s.png" % app_id)
    if custom_icon.is_file():
        icon_src = custom_icon
    if IS_MACOS:
        icon = make_icns(icon_src, BUILD / "icons" / ("%s.icns" % app_id))
    else:
        icon = make_ico(icon_src, BUILD / "icons" / ("%s.ico" % app_id))

    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text(
        "import os, sys, traceback\n"
        "from omm_launcher import run\n"
        "try:\n"
        "    run(%r)\n"
        "except Exception:\n"
        "    base = (os.path.expanduser('~/Library/Application Support')\n"
        "            if sys.platform == 'darwin'\n"
        "            else (os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')))\n"
        "    folder = os.path.join(base, 'OMM-ZEN', %r)\n"
        "    os.makedirs(folder, exist_ok=True)\n"
        "    with open(os.path.join(folder, 'crash.log'), 'w', encoding='utf-8') as fh:\n"
        "        fh.write(traceback.format_exc())\n"
        "    raise\n" % (app_id, app_id),
        encoding="utf-8",
    )

    # Staging: source page already points at vendor/, bundle its subset.
    stage = offline.stage(
        app_id,
        html,
        BUILD / "stage" / app_id,
        common_assets=COMMON_ASSETS,
    )
    if backend == "mdforge":
        shutil.copytree(ROOT / "mdforge-examples", stage / "mdforge-examples", dirs_exist_ok=True)
    elif backend == "latex":
        shutil.copy2(ROOT / "latex-serve.py", stage / "latex-serve.py")

    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", name,
        "--icon", str(icon),
        "--paths", str(DESKTOP),
        "--distpath", str(DIST),
        "--workpath", str(work),
        "--specpath", str(work),
        "--add-data", "%s%s." % (stage, DATA_SEP),
        "--add-data", "%s%s%s" % (icon, DATA_SEP, icon.name),
    ]
    if backend == "mdforge":
        args += [
            "--hidden-import", "mdforge.server",
            "--collect-submodules", "mdforge",
            "--add-data", "%s%s%s" % (ROOT / "mdforge" / "templates", DATA_SEP, "mdforge/templates"),
            "--add-data", "%s%s%s" % (ROOT / "mdforge" / "docs", DATA_SEP, "mdforge/docs"),
        ]

    if IS_MACOS:
        args += [
            "--osx-bundle-identifier", "com.ommzen.%s" % app_id,
            "--hidden-import", "webview.platforms.cocoa",
            "--hidden-import", "objc",
            "--hidden-import", "Foundation",
            "--hidden-import", "AppKit",
            "--hidden-import", "WebKit",
            "--hidden-import", "PyObjCTools.AppHelper",
            "--collect-all", "webview",
        ]
    elif IS_WINDOWS:
        # WebView2 backend (pywebview -> pythonnet/clr); collect-all keeps the
        # runtime DLLs that PyInstaller's static analysis misses.
        args += [
            "--collect-all", "webview",
            "--collect-all", "clr_loader",
            "--collect-all", "pythonnet",
        ]
    else:
        args += ["--collect-all", "webview"]

    args.append(str(entry))

    print("\n=== %s -> %s%s ===" % (html, name, APP_SUFFIX), flush=True)
    proc = subprocess.run(args, cwd=str(ROOT))
    artifact = DIST / (name + APP_SUFFIX)
    if IS_MACOS:
        ok = artifact.is_dir()
        size = sum(p.stat().st_size for p in artifact.rglob("*") if p.is_file())
    else:
        ok = artifact.is_file()
        size = artifact.stat().st_size if ok else 0
    if not ok:
        print("  FAILED (PyInstaller exit %s)" % proc.returncode, file=sys.stderr)
        return False
    print("  ok  %s  (%.1f MB)" % (artifact, size / 1024 / 1024), flush=True)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Build OMM-ZEN desktop applications")
    parser.add_argument("apps", nargs="*", metavar="app",
                        help="app ids to build (default: all)")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--clean", action="store_true", help="remove dist/ and build/desktop first")
    args = parser.parse_args()
    if args.list:
        for app_id in sorted(APPS):
            print("%-14s %-24s -> %s%s" % (app_id, APPS[app_id][0], EXE_NAMES[app_id], APP_SUFFIX))
        return
    if args.clean:
        shutil.rmtree(DIST, ignore_errors=True)
        shutil.rmtree(BUILD, ignore_errors=True)
    targets = args.apps or sorted(APPS)
    unknown = [app_id for app_id in targets if app_id not in APPS]
    if unknown:
        sys.exit("unknown app(s): %s (use --list)" % ", ".join(unknown))
    failed = [app_id for app_id in targets if not build(app_id)]
    if failed:
        sys.exit("failed: %s" % ", ".join(failed))
    print("\nDone: %d application(s) in %s" % (len(targets), DIST))


if __name__ == "__main__":
    main()
