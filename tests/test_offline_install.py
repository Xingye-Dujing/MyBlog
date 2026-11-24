"""Offline asset staging and transactional framework installation tests."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "public" / "desktop"
for path in (str(DESKTOP), str(ROOT / "public")):
    if path not in sys.path:
        sys.path.insert(0, path)

import installer_server  # noqa: E402
import plugin_manager  # noqa: E402
from plugin_manager import PluginError  # noqa: E402


def _framework_zip(path: Path, files: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)


class LocalCatalogTests(unittest.TestCase):
    def test_windows_drive_path_is_read_as_a_local_catalog(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "catalog.json"
            payload = {"plugins": [], "frameworks": {}}
            path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(plugin_manager.fetch_catalog(str(path)), payload)
            self.assertEqual(plugin_manager.fetch_json(str(path)), payload)
            self.assertEqual(plugin_manager.download_bytes(str(path)), path.read_bytes())


class FrameworkInstallTests(unittest.TestCase):
    def test_windows_upgrade_keeps_previous_exe_until_replacement_succeeds(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            install_dir = root / "Programs" / "OMM-ZEN"
            install_dir.mkdir(parents=True)
            target = install_dir / "OMM-ZEN.exe"
            target.write_bytes(b"old framework")
            archive = root / "framework.zip"
            _framework_zip(archive, {"OMM-ZEN.exe": b"new framework"})

            with mock.patch.object(installer_server.sys, "platform", "win32"):
                result = installer_server._extract_framework(archive, install_dir)

            self.assertEqual(result, target)
            self.assertEqual(target.read_bytes(), b"new framework")
            self.assertEqual((install_dir / ".OMM-ZEN.previous.exe").read_bytes(), b"old framework")
            self.assertEqual(list(install_dir.parent.glob(".omm-framework-*")), [])

    def test_invalid_windows_package_does_not_touch_previous_exe(self):
        cases = (
            ({"readme.txt": b"no executable"}, "没有 OMM-ZEN.exe"),
            ({"../OMM-ZEN.exe": b"escape"}, "路径无效"),
            ({"OMM-ZEN.exe": b""}, "为空"),
        )
        for files, message in cases:
            with self.subTest(files=list(files)), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                install_dir = root / "OMM-ZEN"
                install_dir.mkdir()
                target = install_dir / "OMM-ZEN.exe"
                target.write_bytes(b"old framework")
                archive = root / "framework.zip"
                _framework_zip(archive, files)
                with mock.patch.object(installer_server.sys, "platform", "win32"):
                    with self.assertRaisesRegex(PluginError, message):
                        installer_server._extract_framework(archive, install_dir)
                self.assertEqual(target.read_bytes(), b"old framework")
                self.assertFalse((install_dir / ".OMM-ZEN.previous.exe").exists())

    def test_failed_windows_atomic_replace_leaves_current_exe_intact(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            install_dir = root / "OMM-ZEN"
            install_dir.mkdir()
            target = install_dir / "OMM-ZEN.exe"
            target.write_bytes(b"old framework")
            archive = root / "framework.zip"
            _framework_zip(archive, {"OMM-ZEN.exe": b"new framework"})
            real_replace = os.replace

            def fail_new(source, destination):
                if Path(source).name == "OMM-ZEN.exe" and Path(destination) == target:
                    raise OSError("new executable is locked")
                return real_replace(source, destination)

            with mock.patch.object(installer_server.sys, "platform", "win32"), mock.patch.object(
                installer_server.os, "replace", side_effect=fail_new
            ):
                with self.assertRaisesRegex(OSError, "locked"):
                    installer_server._extract_framework(archive, install_dir)

            self.assertEqual(target.read_bytes(), b"old framework")
            self.assertEqual((install_dir / ".OMM-ZEN.previous.exe").read_bytes(), b"old framework")
            self.assertEqual(list(install_dir.parent.glob(".omm-framework-*")), [])

    @staticmethod
    def _fake_ditto(command, **kwargs):
        if command[:3] != ["ditto", "-x", "-k"]:
            raise AssertionError("unexpected ditto command: %r" % (command,))
        executable = Path(command[4]) / "OMM-ZEN.app" / "Contents" / "MacOS" / "OMM-ZEN"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"new app")
        return subprocess.CompletedProcess(command, 0)

    def test_macos_upgrade_keeps_previous_app_bundle(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            install_dir = root / "Applications" / "OMM-ZEN"
            old_executable = install_dir / "OMM-ZEN.app" / "Contents" / "MacOS" / "OMM-ZEN"
            old_executable.parent.mkdir(parents=True)
            old_executable.write_bytes(b"old app")
            archive = root / "framework.zip"
            _framework_zip(archive, {"OMM-ZEN.app/Contents/MacOS/OMM-ZEN": b"new app"})

            with mock.patch.object(installer_server.sys, "platform", "darwin"), mock.patch.object(
                installer_server.subprocess, "run", side_effect=self._fake_ditto
            ):
                result = installer_server._extract_framework(archive, install_dir)

            target = install_dir / "OMM-ZEN.app"
            backup = install_dir / ".OMM-ZEN.previous-app"
            self.assertEqual(result, target)
            self.assertEqual((target / "Contents" / "MacOS" / "OMM-ZEN").read_bytes(), b"new app")
            self.assertEqual((backup / "Contents" / "MacOS" / "OMM-ZEN").read_bytes(), b"old app")
            self.assertEqual(list(install_dir.parent.glob(".omm-framework-*")), [])

    def test_failed_macos_replacement_restores_previous_app_bundle(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            install_dir = root / "Applications" / "OMM-ZEN"
            old_executable = install_dir / "OMM-ZEN.app" / "Contents" / "MacOS" / "OMM-ZEN"
            old_executable.parent.mkdir(parents=True)
            old_executable.write_bytes(b"old app")
            archive = root / "framework.zip"
            _framework_zip(archive, {"OMM-ZEN.app/Contents/MacOS/OMM-ZEN": b"new app"})
            target = install_dir / "OMM-ZEN.app"
            real_replace = os.replace

            def fail_new(source, destination):
                if Path(source).name == "OMM-ZEN.app" and Path(destination) == target:
                    raise OSError("new app cannot be moved")
                return real_replace(source, destination)

            with mock.patch.object(installer_server.sys, "platform", "darwin"), mock.patch.object(
                installer_server.subprocess, "run", side_effect=self._fake_ditto
            ), mock.patch.object(installer_server.os, "replace", side_effect=fail_new):
                with self.assertRaisesRegex(OSError, "cannot be moved"):
                    installer_server._extract_framework(archive, install_dir)

            self.assertEqual((target / "Contents" / "MacOS" / "OMM-ZEN").read_bytes(), b"old app")
            self.assertFalse((install_dir / ".OMM-ZEN.previous-app").exists())
            self.assertEqual(list(install_dir.parent.glob(".omm-framework-*")), [])

    def test_invalid_macos_bundle_does_not_touch_previous_app(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            install_dir = root / "Applications" / "OMM-ZEN"
            old_executable = install_dir / "OMM-ZEN.app" / "Contents" / "MacOS" / "OMM-ZEN"
            old_executable.parent.mkdir(parents=True)
            old_executable.write_bytes(b"old app")
            archive = root / "framework.zip"
            _framework_zip(archive, {"OMM-ZEN.app/Contents/Info.plist": b"invalid"})

            def fake_ditto(command, **kwargs):
                bundle = Path(command[4]) / "OMM-ZEN.app"
                (bundle / "Contents").mkdir(parents=True)
                (bundle / "Contents" / "Info.plist").write_bytes(b"invalid")
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.object(installer_server.sys, "platform", "darwin"), mock.patch.object(
                installer_server.subprocess, "run", side_effect=fake_ditto
            ):
                with self.assertRaisesRegex(PluginError, "缺少可执行文件"):
                    installer_server._extract_framework(archive, install_dir)

            self.assertEqual((install_dir / "OMM-ZEN.app" / "Contents" / "MacOS" / "OMM-ZEN").read_bytes(), b"old app")
            self.assertFalse((install_dir / ".OMM-ZEN.previous-app").exists())


if __name__ == "__main__":
    unittest.main()
