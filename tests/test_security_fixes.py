"""Security-hardening regression tests.

    python -m unittest discover -s tests -p 'test_security_fixes.py' -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for path in (str(ROOT / "public" / "desktop"), str(ROOT / "public")):
    if path not in sys.path:
        sys.path.insert(0, path)

import omm_share  # noqa: E402
import omm_launcher  # noqa: E402


class ShareIdentityTests(unittest.TestCase):
    def test_hub_identity_cannot_be_claimed_by_a_product(self):
        self.assertEqual(omm_share._client_app("data", {"app": ["hub"]}), "data")
        self.assertEqual(omm_share._client_app("data", {"app": ["corpus"]}), "corpus")
        self.assertEqual(omm_share._client_app("hub", {}), "hub")


class PortReuseTests(unittest.TestCase):
    def test_without_a_local_source_marker_a_port_is_not_trusted(self):
        # No root/marker available: must not accept an arbitrary HTTP 200.
        self.assertFalse(omm_launcher.existing_server_ok(1, "missing.html"))


class SourceHardeningTests(unittest.TestCase):
    def test_no_bmob_secret_in_public_page(self):
        source = (ROOT / "public" / "h5-news.html").read_text(encoding="utf-8-sig")
        self.assertNotIn("511ccc97dead7a76", source)
        self.assertNotIn("adhkjkladnlajlka", source)
        self.assertIn("OMM_VOTE_CONFIG", source)

    def test_request_bodies_are_length_checked_before_read(self):
        updater = (ROOT / "public" / "desktop" / "app_updater.py").read_text(encoding="utf-8-sig")
        latex = (ROOT / "public" / "latex-serve.py").read_text(encoding="utf-8-sig")
        self.assertIn("length > omm_shared.MAX_BODY", updater)
        self.assertIn("n > omm_shared.MAX_BODY", latex)

    def test_cloud_download_is_bounded(self):
        hub = (ROOT / "public" / "desktop" / "hub_server.py").read_text(encoding="utf-8-sig")
        self.assertIn("MAX_FULL_BACKUP_BYTES + 1", hub)

    def test_share_record_path_is_bounded(self):
        share = (ROOT / "public" / "desktop" / "omm_share.py").read_text(encoding="utf-8-sig")
        self.assertIn("_inside_any(path, [share_root()])", share)


if __name__ == "__main__":
    unittest.main()
