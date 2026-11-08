# -*- coding: utf-8 -*-
"""Build one standalone .exe per OMM-ZEN app (Windows, PyInstaller + WebView2).

    .venv/Scripts/python.exe desktop/build_exes.py              # all 11 apps
    .venv/Scripts/python.exe desktop/build_exes.py planner writer
    .venv/Scripts/python.exe desktop/build_exes.py --list

Output: dist/OMM-<App>.exe (each ~18-25 MB, no Python needed on the target PC).
"""
from __future__ import annotations

import argparse
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


def make_ico(source: Path, target: Path) -> Path:
    """The repo icons are PNGs renamed to .ico; build a real multi-size square icon."""
    from PIL import Image, ImageOps

    img = Image.open(source).convert("RGBA")
    side = max(img.size)
    img = ImageOps.pad(img, (side, side), color=(0, 0, 0, 0))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    target.parent.mkdir(parents=True, exist_ok=True)
    img.save(target, format="ICO", sizes=[(s, s) for s in sizes])
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
    icon = make_ico(icon_src, BUILD / "icons" / ("%s.ico" % app_id))

    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text(
        "import os, traceback\n"
        "from omm_launcher import run\n"
        "try:\n"
        "    run(%r)\n"
        "except Exception:\n"
        "    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')\n"
        "    folder = os.path.join(base, 'OMM-ZEN', %r)\n"
        "    os.makedirs(folder, exist_ok=True)\n"
        "    with open(os.path.join(folder, 'crash.log'), 'w', encoding='utf-8') as fh:\n"
        "        fh.write(traceback.format_exc())\n"
        "    raise\n" % (app_id, app_id),
        encoding="utf-8",
    )

    # Offline staging: rewritten HTML + local-first mirror table + vendored libs.
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
        "--add-data", "%s;." % stage,
        "--add-data", "%s;app.ico" % icon,
    ]
    if backend == "mdforge":
        args += [
            "--hidden-import", "mdforge.server",
            "--collect-submodules", "mdforge",
            "--add-data", "%s;mdforge/templates" % (ROOT / "mdforge" / "templates"),
            "--add-data", "%s;mdforge/docs" % (ROOT / "mdforge" / "docs"),
        ]
    elif backend == "latex":
        pass

    # WebView2 backend (pywebview -> pythonnet/clr); collect-all keeps the
    # runtime DLLs that PyInstaller's static analysis misses.
    args += ["--collect-all", "webview", "--collect-all", "clr_loader",
             "--collect-all", "pythonnet"]
    args.append(str(entry))

    print("\n=== %s -> %s.exe ===" % (html, name), flush=True)
    proc = subprocess.run(args, cwd=str(ROOT))
    exe = DIST / ("%s.exe" % name)
    ok = exe.is_file()
    if not ok:
        print("  FAILED (PyInstaller exit %s)" % proc.returncode, file=sys.stderr)
        return False
    print("  ok  %s  (%.1f MB)" % (exe, exe.stat().st_size / 1024 / 1024), flush=True)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Build OMM-ZEN desktop executables")
    parser.add_argument("apps", nargs="*", metavar="app",
                        help="app ids to build (default: all)")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--clean", action="store_true", help="remove dist/ and build/desktop first")
    args = parser.parse_args()
    if args.list:
        for app_id in sorted(APPS):
            print("%-14s %-24s -> %s.exe" % (app_id, APPS[app_id][0], EXE_NAMES[app_id]))
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
    print("\nDone: %d executable(s) in %s" % (len(targets), DIST))


if __name__ == "__main__":
    main()
