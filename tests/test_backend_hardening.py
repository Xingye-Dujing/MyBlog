"""Regression tests for the backend security/robustness fixes.

Run from the repository root:

    python -m unittest discover -s tests -v

All tests are offline and use temporary directories; no user data is touched.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "public" / "desktop"
PUBLIC = ROOT / "public"
for path in (str(DESKTOP), str(PUBLIC)):
    if path not in sys.path:
        sys.path.insert(0, path)

import omm_shared  # noqa: E402


class RequestIsLocalTests(unittest.TestCase):
    """Desktop bridge must reject DNS rebinding and cross-site POSTs."""

    class Handler:
        def __init__(self, headers):
            self.headers = headers

    def test_loopback_no_origin_allowed(self):
        self.assertTrue(
            omm_shared.request_is_local(self.Handler({"Host": "127.0.0.1:8300"}))
        )

    def test_same_origin_loopback_allowed(self):
        self.assertTrue(
            omm_shared.request_is_local(
                self.Handler({"Host": "127.0.0.1:8300", "Origin": "http://127.0.0.1:8300"})
            )
        )

    def test_null_origin_rejected(self):
        self.assertFalse(
            omm_shared.request_is_local(
                self.Handler({"Host": "127.0.0.1:8300", "Origin": "null"})
            )
        )

    def test_foreign_host_rejected(self):
        self.assertFalse(
            omm_shared.request_is_local(
                self.Handler({"Host": "evil.example", "Origin": "http://evil.example"})
            )
        )

    def test_foreign_origin_rejected(self):
        self.assertFalse(
            omm_shared.request_is_local(
                self.Handler({"Host": "127.0.0.1:8300", "Origin": "https://xingye-blog.xyz"})
            )
        )

    def test_ipv6_loopback_host_allowed(self):
        self.assertTrue(
            omm_shared.request_is_local(self.Handler({"Host": "[::1]:8300"}))
        )


class RemoteUrlTests(unittest.TestCase):
    """WebDAV URL validation (SSRF guard)."""

    def test_public_urls_allowed(self):
        for url in ("https://dav.example.com/backup.zip", "http://8.8.8.8:5005/dav"):
            with self.subTest(url=url):
                self.assertTrue(omm_shared.remote_url_is_public(url))

    def test_loopback_and_private_rejected(self):
        for url in (
            "http://127.0.0.1:8301/admin",
            "http://localhost/x",
            "http://[::1]:8300/x",
            "http://10.0.0.5/x",
            "http://192.168.1.1/x",
            "http://169.254.169.254/latest/meta-data/",
        ):
            with self.subTest(url=url):
                self.assertFalse(omm_shared.remote_url_is_public(url))

    def test_metadata_and_local_names_rejected(self):
        for url in (
            "http://metadata.google.internal/computeMetadata/",
            "http://nas.local/dav",
        ):
            with self.subTest(url=url):
                self.assertFalse(omm_shared.remote_url_is_public(url))

    def test_bad_scheme_or_userinfo_rejected(self):
        self.assertFalse(omm_shared.remote_url_is_public("file:///etc/passwd"))
        self.assertFalse(omm_shared.remote_url_is_public("https://user:pw@dav.example.com/x"))
        self.assertFalse(omm_shared.remote_url_is_public(""))

    def test_explicit_private_opt_in(self):
        self.assertTrue(
            omm_shared.remote_url_is_public("http://192.168.1.10/dav", allow_private=True)
        )

    def test_encoded_ip_literals_are_rejected(self):
        # urllib / browsers resolve these to 127.0.0.1 even though they are not
        # dotted decimals. A literal-only guard used to let every one through.
        for url in (
            "http://2130706433/", "http://0177.0.0.1/", "http://0x7f000001/",
            "http://0x7f.0.0.1/", "http://168430090/",
        ):
            with self.subTest(url=url):
                self.assertFalse(omm_shared.remote_url_is_public(url))


class WebdavRedirectTests(unittest.TestCase):
    """Every redirect hop must be re-checked and must not leak Basic auth."""

    @staticmethod
    def _request():
        import urllib.request
        req = urllib.request.Request(
            "https://dav.example.com/backup", headers={"Authorization": "Basic abc"}
        )
        return req

    def _redirect(self, newurl, allow_private=False):
        return omm_shared.ValidatedRedirectHandler(allow_private).redirect_request(
            self._request(), None, 302, "Moved", {}, newurl
        )

    def test_same_origin_redirect_keeps_authorization(self):
        req = self._redirect("https://dav.example.com/other")
        self.assertEqual(req.headers.get("Authorization"), "Basic abc")

    def test_cross_origin_redirect_drops_authorization(self):
        req = self._redirect("https://cdn.example.com/other")
        self.assertNotIn("Authorization", req.headers)

    def test_redirect_to_loopback_is_blocked(self):
        for url in (
            "http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/",
            "http://2130706433/",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    self._redirect(url)

    def test_private_opt_in_allows_lan_redirect(self):
        req = self._redirect("http://192.168.1.10/dav", allow_private=True)
        self.assertNotIn("Authorization", req.headers)  # still cross-origin

    def test_hub_server_uses_validated_opener(self):
        hub = (ROOT / "public" / "desktop" / "hub_server.py").read_text(encoding="utf-8")
        self.assertIn("ValidatedRedirectHandler", hub)
        self.assertNotIn("urllib.request.urlopen(request", hub)


class ResourcePathTests(unittest.TestCase):
    """A registered resource file must not expose its whole parent directory."""

    def test_sibling_of_resource_is_not_readable(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            resource = base / "registered.txt"
            sibling = base / "secret.txt"
            resource.write_text("public content", encoding="utf-8")
            sibling.write_text("private content", encoding="utf-8")
            cfg = {
                "save": {"path": str(base / "unused-save")},
                "apps": {"writer": {"resources": {"a": {"path": str(resource)}}}},
            }
            with mock.patch.object(omm_shared, "load_config", return_value=cfg), \
                    mock.patch.object(omm_shared, "shared_root", return_value=base / "shared"):
                data, _mime = omm_shared.read_shared_file(str(resource))
                self.assertEqual(data, b"public content")
                with self.assertRaises(ValueError):
                    omm_shared.read_shared_file(str(sibling))


class MdForgeRootIsolationTests(unittest.TestCase):
    """Two mdforge app instances must serve their own static directories."""

    def test_each_app_uses_its_own_root(self):
        try:
            import mdforge.server as mdforge_server
        except ImportError as exc:  # pragma: no cover - depends on optional deps
            self.skipTest("mdforge dependencies unavailable: %s" % exc)
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            (Path(a) / "omm-mdforge.html").write_text("ROOT-A", encoding="utf-8")
            (Path(b) / "omm-mdforge.html").write_text("ROOT-B", encoding="utf-8")
            app_a = mdforge_server.create_app(Path(a))
            app_b = mdforge_server.create_app(Path(b))
            with app_a.test_client() as client_a, app_b.test_client() as client_b:
                resp_a = client_a.get("/")
                resp_b = client_b.get("/")
                body_a = resp_a.get_data(as_text=True)
                body_b = resp_b.get_data(as_text=True)
                resp_a.close()
                resp_b.close()
            self.assertIn("ROOT-A", body_a)
            self.assertIn("ROOT-B", body_b)
            self.assertNotIn("ROOT-B", body_a)
            self.assertNotIn("ROOT-A", body_b)
            # The process-wide global must stay untouched.
            self.assertEqual(
                app_a.config["PUBLIC_ROOT"] != app_b.config["PUBLIC_ROOT"], True
            )


class SigningErrorRedactionTests(unittest.TestCase):
    """signtool errors must never echo the PFX password."""

    def test_password_is_redacted(self):
        import sign_exes
        exc = subprocess.CalledProcessError(
            1,
            ["signtool", "sign", "/f", "cert.pfx", "/p", "topsecret", "app.exe"],
            stderr="sign failed",
        )
        text = sign_exes.redacted_process_error(exc)
        self.assertNotIn("topsecret", text)
        self.assertIn("***", text)
        self.assertIn("sign failed", text)


if __name__ == "__main__":
    unittest.main()
