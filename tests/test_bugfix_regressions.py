"""第二轮缺陷猎捕的后端回归测试。

    python -m unittest tests.test_bugfix_regressions -v

覆盖 SSRF 进制字面量、恢复路径边界、配置脱敏、格式自动识别与凭据字段识别。
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


class SsrfLiteralTests(unittest.TestCase):
    def test_octal_literal_is_classified_not_treated_as_dns(self):
        self.assertEqual(str(omm_shared._ip_literal("17700000001")), "127.0.0.1")
        self.assertEqual(str(omm_shared._ip_literal("017700000001")), "127.0.0.1")
        self.assertFalse(omm_shared.remote_url_is_public("http://17700000001/"))
        self.assertFalse(omm_shared.remote_url_is_public("http://017700000001/"))

    def test_unknown_numeric_host_is_rejected(self):
        # 无法明确解析的纯数字主机名不是合法 DNS 名，不能按“公网域名”放行。
        self.assertFalse(omm_shared.remote_url_is_public("http://99999999999999/"))
        self.assertTrue(omm_shared.remote_url_is_public("http://example.com/"))


class RestorePathTests(unittest.TestCase):
    def test_restore_rejects_paths_outside_existing_roots(self):
        allowed = [Path(tempfile.gettempdir())]
        outside = Path.home() / "omm-evil-outside"
        with self.assertRaises(ValueError):
            omm_shared.sanitize_restored_config({"save": {"path": str(outside)}}, allowed)
        inside = Path(tempfile.gettempdir()) / "omm-allowed"
        omm_shared.sanitize_restored_config({"save": {"path": str(inside)}}, allowed)

    def test_restore_rejects_drive_root(self):
        root = Path(Path.home().anchor)
        with self.assertRaises(ValueError):
            omm_shared.sanitize_restored_config({"save": {"path": str(root)}}, [root])


class ConfigRedactionTests(unittest.TestCase):
    def test_credentials_are_blanked_without_mutating_source(self):
        cfg = {"ai": {"apiKey": "sk-secret", "apiModel": "m"}, "cloud": {"password": "pw"}}
        out = omm_shared.redact_config_secrets(cfg)
        self.assertEqual(out["ai"]["apiKey"], "")
        self.assertEqual(out["cloud"]["password"], "")
        self.assertEqual(out["ai"]["apiModel"], "m")
        self.assertEqual(cfg["ai"]["apiKey"], "sk-secret")

    def test_settings_backup_endpoint_uses_redaction(self):
        src = (ROOT / "public" / "desktop" / "hub_server.py").read_text(encoding="utf-8")
        block = src[src.index("def backup(self)") : src.index("def restore(self,")]
        self.assertIn("redact_config_secrets", block)


class ValidatorAndToolTests(unittest.TestCase):
    def test_validate_autodetects_non_json_kind(self):
        from agent_workspace.omm_validators import validate

        result = validate("mdforge", "---\ntitle: X\ntemplate: academic\n---\n# Hi")
        self.assertEqual(result["kind"], "markdown")
        self.assertFalse(any("JSON 解析失败" in e for e in result["errors"]))

    def test_spec_search_tolerates_non_numeric_limit(self):
        from agent_workspace.omm_tools import _spec_search

        self.assertIsInstance(_spec_search({"query": "card", "limit": "abc"}, {}), dict)

    def test_secret_guard_covers_common_credential_names(self):
        from agent_workspace.errors import AIError
        from agent_workspace.omm_host import _assert_no_secret

        for key in ("accessToken", "privateKey", "client_secret", "supabase"):
            with self.subTest(key=key), self.assertRaises(AIError):
                _assert_no_secret({key: "abcd1234efgh"})


if __name__ == "__main__":
    unittest.main()
