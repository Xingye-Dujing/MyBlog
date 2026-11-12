# -*- coding: utf-8 -*-
"""Build the OMM-ZEN desktop programs.

Windows: dist/OMM-<App>.exe, OMM-ZEN.exe, OMM-ZEN-Setup.exe
macOS:   dist/OMM-<App>.app, OMM-ZEN.app, OMM-ZEN-Setup.app

    python desktop/build_exes.py              # 11 apps + hub + framework + installer
    python desktop/build_exes.py hub framework installer
    python desktop/build_exes.py planner writer
    python desktop/build_exes.py --list
    python desktop/build_exes.py --clean

The target machine needs no Python. Windows needs WebView2; macOS uses the
system WebKit and needs no extra runtime.
"""
from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

from omm_launcher import APPS
from plugin_specs import DESKTOP_EXE_NAMES
import offline

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "desktop"
BUILD = ROOT / "build" / "desktop"
DIST = ROOT / "dist"

IS_MACOS = sys.platform == "darwin"
IS_WINDOWS = os.name == "nt"
DATA_SEP = ":" if IS_MACOS else ";"
APP_SUFFIX = ".app" if IS_MACOS else ".exe"

EXE_NAMES = {key: value for key, value in DESKTOP_EXE_NAMES.items() if key != "hub"}

HUB_TARGET = "hub"
HUB_NAME = "OMM-ZEN"
FRAMEWORK_TARGET = "framework"
FRAMEWORK_NAME = "OMM-ZEN"
INSTALLER_TARGET = "installer"
INSTALLER_NAME = "OMM-ZEN-Setup"
TARGETS = sorted(EXE_NAMES) + [HUB_TARGET, FRAMEWORK_TARGET, INSTALLER_TARGET]

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
    if app_id == HUB_TARGET:
        return build_hub()
    if app_id == FRAMEWORK_TARGET:
        return build_framework()
    if app_id == INSTALLER_TARGET:
        return build_installer()
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
        "--hidden-import", "omm_shared",
        "--hidden-import", "omm_share",
        "--hidden-import", "pystray",
        "--collect-submodules", "pystray",
        "--hidden-import", "keyboard",
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
    artifact = DIST / (name + APP_SUFFIX)
    before = _artifact_stamp(artifact)
    proc = subprocess.run(args, cwd=str(ROOT))
    if IS_MACOS:
        ok = artifact.is_dir()
        size = sum(p.stat().st_size for p in artifact.rglob("*") if p.is_file())
    else:
        ok = artifact.is_file()
        size = artifact.stat().st_size if ok else 0
    if not ok:
        print("  FAILED (PyInstaller exit %s)" % proc.returncode, file=sys.stderr)
        return False
    after = _artifact_stamp(artifact)
    if before is not None and after == before:
        # The artifact was not rewritten: a running instance of this program
        # usually locks the old exe, PyInstaller cannot replace it and the
        # stale binary would be published as if it were fresh.
        print(
            "  FAILED: %s was not rewritten (locked by a running instance?)" % artifact.name,
            file=sys.stderr,
        )
        return False
    print("  ok  %s  (%.1f MB)" % (artifact, size / 1024 / 1024), flush=True)
    return True


def build_hub() -> bool:
    """Build the integrated OMM-ZEN workspace (all 11 pages in one program)."""
    name = HUB_NAME
    entry = BUILD / "entries" / "omm_start_hub.py"
    work = BUILD / "work" / HUB_TARGET
    icon_src = DESKTOP / "icons-src" / "hub.png"
    if not icon_src.is_file():
        icon_src = ROOT / "icon.ico"
    if IS_MACOS:
        icon = make_icns(icon_src, BUILD / "icons" / "hub.icns")
    else:
        icon = make_ico(icon_src, BUILD / "icons" / "hub.ico")

    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text(
        "import os, sys, traceback\n"
        "from omm_launcher import run_hub\n"
        "try:\n"
        "    run_hub()\n"
        "except Exception:\n"
        "    base = (os.path.expanduser('~/Library/Application Support')\n"
        "            if sys.platform == 'darwin'\n"
        "            else (os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')))\n"
        "    folder = os.path.join(base, 'OMM-ZEN', 'hub')\n"
        "    os.makedirs(folder, exist_ok=True)\n"
        "    with open(os.path.join(folder, 'crash.log'), 'w', encoding='utf-8') as fh:\n"
        "        fh.write(traceback.format_exc())\n"
        "    raise\n",
        encoding="utf-8",
    )

    stage = offline.stage_hub(
        BUILD / "stage" / HUB_TARGET,
        common_assets=COMMON_ASSETS,
    )

    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", name,
        "--icon", str(icon),
        "--paths", str(DESKTOP),
        "--hidden-import", "omm_shared",
        "--hidden-import", "omm_share",
        "--distpath", str(DIST),
        "--workpath", str(work),
        "--specpath", str(work),
        "--add-data", "%s%s." % (stage, DATA_SEP),
        "--add-data", "%s%s%s" % (icon, DATA_SEP, icon.name),
        "--hidden-import", "hub_server",
        "--hidden-import", "plugin_manager",
        "--hidden-import", "plugin_specs",
        # optional tray/hotkey extras; missing on the build machine = warning only
        "--hidden-import", "pystray",
        "--collect-submodules", "pystray",
        "--hidden-import", "keyboard",
        "--hidden-import", "werkzeug.serving",
        "--hidden-import", "mdforge.server",
        "--collect-submodules", "mdforge",
        "--add-data", "%s%s%s" % (ROOT / "mdforge" / "templates", DATA_SEP, "mdforge/templates"),
        "--add-data", "%s%s%s" % (ROOT / "mdforge" / "docs", DATA_SEP, "mdforge/docs"),
    ]

    if IS_MACOS:
        args += [
            "--osx-bundle-identifier", "com.ommzen.hub",
            "--hidden-import", "webview.platforms.cocoa",
            "--hidden-import", "objc",
            "--hidden-import", "Foundation",
            "--hidden-import", "AppKit",
            "--hidden-import", "WebKit",
            "--hidden-import", "PyObjCTools.AppHelper",
            "--collect-all", "webview",
        ]
    elif IS_WINDOWS:
        args += [
            "--collect-all", "webview",
            "--collect-all", "clr_loader",
            "--collect-all", "pythonnet",
        ]
    else:
        args += ["--collect-all", "webview"]

    args.append(str(entry))

    print("\n=== 11 apps -> %s%s ===" % (name, APP_SUFFIX), flush=True)
    artifact = DIST / (name + APP_SUFFIX)
    before = _artifact_stamp(artifact)
    proc = subprocess.run(args, cwd=str(ROOT))
    ok, size = _artifact_ok(artifact)
    if not ok:
        print("  FAILED (PyInstaller exit %s)" % proc.returncode, file=sys.stderr)
        return False
    after = _artifact_stamp(artifact)
    if before is not None and after == before:
        print(
            "  FAILED: %s was not rewritten (locked by a running instance?)" % artifact.name,
            file=sys.stderr,
        )
        return False
    print("  ok  %s  (%.1f MB)" % (artifact, size / 1024 / 1024), flush=True)
    return True


def _webview_args(target: str) -> list[str]:
    if IS_MACOS:
        return [
            "--osx-bundle-identifier", "com.ommzen.%s" % target,
            "--hidden-import", "webview.platforms.cocoa",
            "--hidden-import", "objc",
            "--hidden-import", "Foundation",
            "--hidden-import", "AppKit",
            "--hidden-import", "WebKit",
            "--hidden-import", "PyObjCTools.AppHelper",
            "--collect-all", "webview",
        ]
    if IS_WINDOWS:
        return [
            "--collect-all", "webview",
            "--collect-all", "clr_loader",
            "--collect-all", "pythonnet",
        ]
    return ["--collect-all", "webview"]


def _artifact_ok(path: Path) -> tuple[bool, int]:
    if IS_MACOS:
        if not path.is_dir():
            return False, 0
        return True, sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
    if not path.is_file():
        return False, 0
    return True, path.stat().st_size


def _artifact_stamp(path: Path):
    """A fingerprint used to detect that a build did not rewrite the artifact."""
    if not path.exists():
        return None
    if path.is_dir():
        return ("dir", path.stat().st_mtime_ns)
    return ("file", path.stat().st_mtime_ns, path.stat().st_size)


def build_framework() -> bool:
    """Build the plugin-less hub shell used by the online installer."""
    name = FRAMEWORK_NAME
    dist = DIST / "framework"
    entry = BUILD / "entries" / "omm_start_framework.py"
    work = BUILD / "work" / FRAMEWORK_TARGET
    icon_src = DESKTOP / "icons-src" / "hub.png"
    if not icon_src.is_file():
        icon_src = ROOT / "icon.ico"
    icon = (
        make_icns(icon_src, BUILD / "icons" / "framework.icns")
        if IS_MACOS
        else make_ico(icon_src, BUILD / "icons" / "framework.ico")
    )
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text(
        "import os, sys, traceback\n"
        "from omm_launcher import run_hub\n"
        "try:\n"
        "    run_hub()\n"
        "except Exception:\n"
        "    base = (os.path.expanduser('~/Library/Application Support')\n"
        "            if sys.platform == 'darwin'\n"
        "            else (os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')))\n"
        "    folder = os.path.join(base, 'OMM-ZEN', 'hub')\n"
        "    os.makedirs(folder, exist_ok=True)\n"
        "    with open(os.path.join(folder, 'crash.log'), 'w', encoding='utf-8') as fh:\n"
        "        fh.write(traceback.format_exc())\n"
        "    raise\n",
        encoding="utf-8",
    )
    stage = offline.stage_framework(
        BUILD / "stage" / FRAMEWORK_TARGET,
        common_assets=COMMON_ASSETS,
    )
    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", name,
        "--icon", str(icon),
        "--paths", str(DESKTOP),
        "--distpath", str(dist),
        "--workpath", str(work),
        "--specpath", str(work),
        "--add-data", "%s%s." % (stage, DATA_SEP),
        "--add-data", "%s%s%s" % (icon, DATA_SEP, icon.name),
        "--hidden-import", "hub_server",
        "--hidden-import", "plugin_manager",
        "--hidden-import", "plugin_specs",
        # optional tray/hotkey extras; missing on the build machine = warning only
        "--hidden-import", "pystray",
        "--collect-submodules", "pystray",
        "--hidden-import", "keyboard",
        "--hidden-import", "werkzeug.serving",
        "--hidden-import", "mdforge.server",
        "--collect-submodules", "mdforge",
        "--add-data", "%s%s%s" % (ROOT / "mdforge" / "templates", DATA_SEP, "mdforge/templates"),
        "--add-data", "%s%s%s" % (ROOT / "mdforge" / "docs", DATA_SEP, "mdforge/docs"),
    ]
    args += _webview_args(FRAMEWORK_TARGET)
    args.append(str(entry))
    print("\n=== framework -> %s%s ===" % (name, APP_SUFFIX), flush=True)
    artifact = dist / (name + APP_SUFFIX)
    before = _artifact_stamp(artifact)
    proc = subprocess.run(args, cwd=str(ROOT))
    ok, size = _artifact_ok(artifact)
    if not ok:
        print("  FAILED (PyInstaller exit %s)" % proc.returncode, file=sys.stderr)
        return False
    after = _artifact_stamp(artifact)
    if before is not None and after == before:
        print(
            "  FAILED: %s was not rewritten (locked by a running instance?)" % artifact.name,
            file=sys.stderr,
        )
        return False
    if IS_MACOS:
        arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"
        archive = DIST / ("OMM-ZEN-Framework-macOS-%s.zip" % arch)
        if archive.exists():
            archive.unlink()
        subprocess.run(
            [
                "ditto", "-c", "-k", "--sequesterRsrc", "--keepParent",
                str(artifact), str(archive),
            ],
            check=True,
        )
        print("  zip %s" % archive, flush=True)
    else:
        archive = DIST / "OMM-ZEN-Framework-win64.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(artifact, artifact.name)
        print("  zip %s" % archive, flush=True)
    print("  ok  %s  (%.1f MB)" % (artifact, size / 1024 / 1024), flush=True)
    return True


def build_installer() -> bool:
    """Build the online installer UI."""
    name = INSTALLER_NAME
    entry = BUILD / "entries" / "omm_start_installer.py"
    work = BUILD / "work" / INSTALLER_TARGET
    icon_src = DESKTOP / "icons-src" / "hub.png"
    if not icon_src.is_file():
        icon_src = ROOT / "icon.ico"
    icon = (
        make_icns(icon_src, BUILD / "icons" / "installer.icns")
        if IS_MACOS
        else make_ico(icon_src, BUILD / "icons" / "installer.ico")
    )
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text(
        "import os, sys, traceback\n"
        "from installer_server import run_installer\n"
        "try:\n"
        "    run_installer()\n"
        "except Exception:\n"
        "    base = (os.path.expanduser('~/Library/Application Support')\n"
        "            if sys.platform == 'darwin'\n"
        "            else (os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')))\n"
        "    folder = os.path.join(base, 'OMM-ZEN', 'installer')\n"
        "    os.makedirs(folder, exist_ok=True)\n"
        "    with open(os.path.join(folder, 'crash.log'), 'w', encoding='utf-8') as fh:\n"
        "        fh.write(traceback.format_exc())\n"
        "    raise\n",
        encoding="utf-8",
    )
    stage = offline.stage_installer(
        BUILD / "stage" / INSTALLER_TARGET,
        common_assets=COMMON_ASSETS,
    )
    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", name,
        "--icon", str(icon),
        "--paths", str(DESKTOP),
        "--hidden-import", "omm_shared",
        "--hidden-import", "omm_share",
        "--distpath", str(DIST),
        "--workpath", str(work),
        "--specpath", str(work),
        "--add-data", "%s%s." % (stage, DATA_SEP),
        "--add-data", "%s%s%s" % (icon, DATA_SEP, icon.name),
        "--hidden-import", "installer_server",
        "--hidden-import", "plugin_manager",
        "--hidden-import", "plugin_specs",
    ]
    args += _webview_args(INSTALLER_TARGET)
    args.append(str(entry))
    print("\n=== online installer -> %s%s ===" % (name, APP_SUFFIX), flush=True)
    artifact = DIST / (name + APP_SUFFIX)
    before = _artifact_stamp(artifact)
    proc = subprocess.run(args, cwd=str(ROOT))
    ok, size = _artifact_ok(artifact)
    if not ok:
        print("  FAILED (PyInstaller exit %s)" % proc.returncode, file=sys.stderr)
        return False
    after = _artifact_stamp(artifact)
    if before is not None and after == before:
        print(
            "  FAILED: %s was not rewritten (locked by a running instance?)" % artifact.name,
            file=sys.stderr,
        )
        return False
    print("  ok  %s  (%.1f MB)" % (artifact, size / 1024 / 1024), flush=True)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Build OMM-ZEN desktop applications")
    parser.add_argument("apps", nargs="*", metavar="app",
                        help="app ids to build (default: all, including hub/framework/installer)")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--clean", action="store_true", help="remove dist/ and build/desktop first")
    args = parser.parse_args()
    if args.list:
        for app_id in sorted(APPS):
            print("%-14s %-24s -> %s%s" % (app_id, APPS[app_id][0], EXE_NAMES[app_id], APP_SUFFIX))
        print("%-14s %-24s -> %s%s" % (HUB_TARGET, "omm-hub.html + 11 apps", HUB_NAME, APP_SUFFIX))
        print("%-14s %-24s -> %s%s" % (FRAMEWORK_TARGET, "plugin-less hub", FRAMEWORK_NAME, APP_SUFFIX))
        print("%-14s %-24s -> %s%s" % (INSTALLER_TARGET, "online installer", INSTALLER_NAME, APP_SUFFIX))
        return
    if args.clean:
        shutil.rmtree(DIST, ignore_errors=True)
        shutil.rmtree(BUILD, ignore_errors=True)
    targets = args.apps or TARGETS
    unknown = [app_id for app_id in targets if app_id not in TARGETS]
    if unknown:
        sys.exit("unknown app(s): %s (use --list)" % ", ".join(unknown))
    failed = [app_id for app_id in targets if not build(app_id)]
    if failed:
        sys.exit("failed: %s" % ", ".join(failed))
    print("\nDone: %d application(s) in %s" % (len(targets), DIST))


if __name__ == "__main__":
    main()
