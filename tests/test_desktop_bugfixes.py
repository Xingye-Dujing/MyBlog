"""Desktop-layer bug fixes: geometry persistence, server reuse, restore body cap.

    python -m unittest tests.test_desktop_bugfixes -v
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for path in (str(ROOT / "public" / "desktop"), str(ROOT / "public")):
    if path not in sys.path:
        sys.path.insert(0, path)

import omm_shared  # noqa: E402
import omm_launcher  # noqa: E402
from app_updater import ShellHandler  # noqa: E402
from plugin_manager import PluginError, PluginRegistry  # noqa: E402


class WindowGeometryTests(unittest.TestCase):
    def test_normalize_preserves_window_geometry(self):
        raw = {
            "ui": {
                "window": {
                    "planner": {"x": 10, "y": 20, "width": 1200, "height": 800, "maximized": True},
                    "writer": {"x": -5, "width": 640},
                }
            }
        }
        ui = omm_shared._normalize_config(raw)["ui"]
        self.assertEqual(ui["window"]["planner"]["width"], 1200)
        self.assertTrue(ui["window"]["planner"]["maximized"])
        self.assertEqual(ui["window"]["writer"]["width"], 640)

    def test_normalize_drops_malformed_window_entries(self):
        raw = {"ui": {"window": {"planner": "bad", "writer": {"width": "abc", "height": 480}}}}
        ui = omm_shared._normalize_config(raw)["ui"]
        self.assertNotIn("planner", ui["window"])
        self.assertEqual(ui["window"]["writer"]["height"], 480)
        self.assertNotIn("width", ui["window"]["writer"])

    def test_empty_config_has_window_bucket(self):
        self.assertEqual(omm_shared._empty_config()["ui"]["window"], {})


class ServerReuseTests(unittest.TestCase):
    def test_hub_server_passes_source_root_when_checking_existing_servers(self):
        src = (ROOT / "public" / "desktop" / "hub_server.py").read_text(encoding="utf-8-sig")
        self.assertIn("existing_server_ok(wanted, entry, self.root)", src)
        self.assertIn("existing_server_ok(port, HUB_HTML, root)", src)


class ShareIdentityTests(unittest.TestCase):
    def test_handler_default_app_is_per_handler_not_global_env(self):
        handler = ShellHandler.__new__(ShellHandler)
        handler._default_app = "data"
        self.assertEqual(handler._default_app_id(), "data")
        handler._default_app = ""
        handler._default_app_id()  # falls back to the env, never raises

    def test_plugin_servers_pass_their_own_id(self):
        src = (ROOT / "public" / "desktop" / "hub_server.py").read_text(encoding="utf-8-sig")
        self.assertIn("default_app=plugin_id", src)


class RollbackPathTests(unittest.TestCase):
    def test_rollback_rejects_traversal_id(self):
        registry = PluginRegistry.__new__(PluginRegistry)
        registry.user_root = Path(tempfile.gettempdir())
        with self.assertRaises(PluginError):
            registry.rollback("../evil")


class RestoreBodyTests(unittest.TestCase):
    def test_restore_body_limit_allows_base64_expansion(self):
        src = (ROOT / "public" / "desktop" / "hub_server.py").read_text(encoding="utf-8-sig")
        self.assertIn("MAX_FULL_BACKUP_BYTES * 4 // 3", src)
        self.assertIn("len(data) > MAX_FULL_BACKUP_BYTES", src)


if __name__ == "__main__":
    unittest.main()
