"""Desktop capability, identity and Hub credential regressions."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
for path in (str(ROOT / "public" / "desktop"), str(ROOT / "public")):
    if path not in sys.path:
        sys.path.insert(0, path)

import app_updater  # noqa: E402
import hub_server  # noqa: E402
import omm_share  # noqa: E402
import omm_shared  # noqa: E402


def payload(response):
    return json.loads(response[2].decode("utf-8"))


class DesktopCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(
            os.environ,
            {"OMM_DESKTOP": "1", "OMM_SHARED_DIR": self.tmp.name},
            clear=False,
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_imported_static_plugin_cannot_mount_sensitive_fs_routes(self):
        granted = omm_shared.IMPORTED_FS_CAPABILITIES
        routes = [
            "/__omm/fs/ai-config",
            "/__omm/fs/archive",
            "/__omm/fs/snapshots",
            "/__omm/fs/snapshot?path=x",
            "/__omm/fs/file?path=x",
            "/__omm/fs/shared",
            "/__omm/fs/config",
        ]
        for route in routes:
            with self.subTest(route=route):
                status, _, body = omm_shared.handle_get(
                    route.split("?", 1)[0],
                    {"path": ["x"]} if "path=" in route else {},
                    "imported-evil",
                    capabilities=granted,
                )
                self.assertEqual(status, 403)
                self.assertFalse(payload((status, "", body))["ok"])
        status, _, body = omm_shared.handle_post(
            "/__omm/fs/snapshot", {}, b'{"state":{},"app":"hub"}',
            "imported-evil", capabilities=granted,
        )
        self.assertEqual(status, 403)

    def test_registry_decides_capabilities_not_page_or_manifest(self):
        hub = object.__new__(hub_server.HubServer)
        hub._trusted_plugins = set()
        imported = {"id": "data", "source": "user"}
        bundled = {"id": "data", "source": "bundled"}
        self.assertEqual(hub._plugin_capabilities(imported), omm_shared.IMPORTED_FS_CAPABILITIES)
        self.assertIn("archive", hub._plugin_capabilities(bundled))
        hub._trusted_plugins.add("data")
        self.assertIn("archive", hub._plugin_capabilities(imported))

    def test_non_hub_query_and_payload_cannot_change_app(self):
        status, _, body = omm_shared.handle_get(
            "/__omm/fs/status", {"app": ["hub"]}, "data"
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload((status, "", body))["app"], "data")
        status, _, body = omm_shared.handle_post(
            "/__omm/fs/snapshot",
            {"app": ["hub"]},
            json.dumps({"app": "corpus", "state": {"value": 1}, "label": "test"}).encode(),
            "data",
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload((status, "", body))["app"], "data")

    def test_only_trusted_hub_can_scope_fs_to_another_product(self):
        status, _, body = omm_shared.handle_post(
            "/__omm/fs/snapshot",
            {},
            json.dumps({"app": "corpus", "state": {"value": 2}, "label": "hub"}).encode(),
            "hub",
            capabilities=omm_shared.capabilities_for_app("hub", trusted_hub=True),
            trusted_hub=True,
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload((status, "", body))["app"], "corpus")

    def test_ai_config_never_returns_key_and_missing_post_key_preserves_it(self):
        def seed(cfg):
            cfg["ai"]["apiKey"] = "server-secret"

        omm_shared.mutate_config(seed)
        status, _, body = omm_shared.handle_get(
            "/__omm/fs/ai-config", {}, "data",
            capabilities=omm_shared.capabilities_for_app("data"),
        )
        data = payload((status, "", body))
        self.assertTrue(data["hasStoredKey"])
        self.assertNotIn("apiKey", data["ai"])
        self.assertNotIn("server-secret", body.decode())

        status, _, body = omm_shared.handle_get(
            "/__omm/fs/config", {}, "data",
            capabilities=omm_shared.capabilities_for_app("data"),
        )
        self.assertNotIn("server-secret", body.decode())
        status, _, body = omm_shared.handle_post(
            "/__omm/fs/config", {}, b'{"mode":"versioned"}', "data",
            capabilities=omm_shared.capabilities_for_app("data"),
        )
        self.assertNotIn("server-secret", body.decode())

        status, _, body = omm_shared.handle_post(
            "/__omm/fs/ai-config", {},
            json.dumps({"ai": {"provider": "openai", "apiBase": "https://example.test/v1"}}).encode(),
            "hub",
            capabilities=omm_shared.capabilities_for_app("hub", trusted_hub=True),
            trusted_hub=True,
        )
        data = payload((status, "", body))
        self.assertTrue(data["hasStoredKey"])
        self.assertNotIn("apiKey", data["ai"])
        self.assertNotIn("server-secret", body.decode())
        self.assertEqual(omm_shared.load_config()["ai"]["apiKey"], "server-secret")

        status, _, body = omm_shared.handle_post(
            "/__omm/fs/ai-config", {}, b'{"ai":{"apiKey":""}}',
            "hub",
            capabilities=omm_shared.capabilities_for_app("hub", trusted_hub=True),
            trusted_hub=True,
        )
        self.assertFalse(payload((status, "", body))["hasStoredKey"])
        self.assertEqual(omm_shared.load_config()["ai"]["apiKey"], "")

    def test_shell_handler_does_not_inherit_process_hub_identity(self):
        handler = app_updater.ShellHandler.__new__(app_updater.ShellHandler)
        handler._default_app = "data"
        handler._fs_capabilities = None
        handler._trusted_hub = False
        with mock.patch.dict(os.environ, {"OMM_APP_ID": "hub"}):
            self.assertEqual(handler._default_app_id(), "data")
            self.assertIn("archive", handler._desktop_capabilities())
            self.assertNotIn("ai-config:write", handler._desktop_capabilities())


class ShareIdentityAndChannelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(
            os.environ,
            {"OMM_DESKTOP": "1", "OMM_SHARED_DIR": self.tmp.name},
            clear=False,
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def post(self, path, body, default_app="data", query=None, trusted_hub=False):
        return omm_share.handle_post(
            path,
            query or {},
            json.dumps(body).encode("utf-8"),
            default_app,
            trusted_hub=trusted_hub,
        )

    def test_policy_is_for_trusted_hub_only(self):
        status, _, body = self.post(
            "/__omm/share/policy",
            {"channel": "data.tables", "app": "corpus", "publish": True},
            query={"app": ["hub"]},
        )
        self.assertEqual(status, 403)
        status, _, _ = self.post(
            "/__omm/share/policy",
            {"channel": "data.tables", "app": "corpus", "publish": True},
            default_app="hub",
            trusted_hub=True,
        )
        self.assertEqual(status, 200)

    def test_data_cannot_publish_as_corpus(self):
        status, _, body = self.post(
            "/__omm/share/publish",
            {"app": "corpus", "record": {"secret": "x"}, "type": "application/json"},
        )
        self.assertEqual(status, 200)
        item = payload((status, "", body))["item"]
        self.assertEqual(item["source_app"], "data")
        self.assertEqual(item["channel"], "data.tables")

    def test_send_ignores_caller_channel_and_uses_unique_common_channel(self):
        status, _, body = self.post(
            "/__omm/share/send",
            {
                "app": "corpus",
                "to": "visualization",
                "channel": "documents",
                "format": "zenviz-data",
                "payload": {"format": "zenviz-data"},
            },
        )
        self.assertEqual(status, 200)
        message = payload((status, "", body))["message"]
        self.assertEqual(message["from"], "data")
        self.assertEqual(message["channel"], "data.tables")

    def test_no_common_channel_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "没有共同"):
            omm_share.send("data", {"to": "corpus", "payload": {"x": 1}})

    def test_ambiguous_pair_requires_format_or_artifact(self):
        policy = omm_share.default_policy()
        with self.assertRaisesRegex(ValueError, "多个共同频道"):
            omm_share.resolve_send_channel(policy, "hub", "annotate")
        self.assertEqual(
            omm_share.resolve_send_channel(policy, "hub", "annotate", "omm.bridge"),
            "notes.english",
        )

    def test_delete_and_inbox_are_bound_to_default_app(self):
        status, _, body = self.post(
            "/__omm/share/publish",
            {"record": {"x": 1}, "type": "application/json"},
            default_app="corpus",
        )
        item = payload((status, "", body))["item"]
        status, _, _ = self.post(
            "/__omm/share/delete", {"app": "corpus", "id": item["id"]}
        )
        self.assertEqual(status, 400)
        status, _, body = omm_share.handle_get(
            "/__omm/share/inbox", {"app": ["corpus"]}, "data"
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload((status, "", body))["app"], "data")
        self.assertEqual(payload((status, "", body))["messages"], [])


class HubCredentialTests(unittest.TestCase):
    def handler(self, method, path, headers):
        handler = hub_server.HubHandler.__new__(hub_server.HubHandler)
        handler.command = method
        handler.path = path
        handler.headers = {
            "Host": "127.0.0.1:8300",
            "Origin": "http://127.0.0.1:8300",
            "Sec-Fetch-Site": "same-origin",
            **headers,
        }
        handler.hub = types.SimpleNamespace(
            capability_token="test-capability-token",
            cloud_upload=mock.Mock(return_value={"ok": True}),
            full_backup=mock.Mock(return_value={"ok": True, "zip": "eA==", "stats": {}}),
        )
        handler.replies = []
        handler._reply = lambda status, body: handler.replies.append((status, body))
        handler.handle_desktop_post = lambda: False
        handler.handle_update_post = lambda: False
        handler.handle_update_get = lambda: False
        return handler

    def test_cloud_upload_without_credential_never_packages_or_uploads(self):
        handler = self.handler("POST", "/api/cloud/upload", {"Content-Type": "application/json"})
        handler._json_body = mock.Mock(side_effect=AssertionError("body must not be read"))
        handler.do_POST()
        self.assertEqual(handler.replies[0][0], 403)
        handler.hub.cloud_upload.assert_not_called()
        handler.hub.full_backup.assert_not_called()

    def test_cross_origin_text_plain_no_cors_is_rejected(self):
        handler = self.handler(
            "POST",
            "/api/cloud/upload",
            {
                "Content-Type": "text/plain;charset=UTF-8",
                "Origin": "http://127.0.0.1:9999",
                hub_server.HUB_CREDENTIAL_HEADER: "test-capability-token",
            },
        )
        handler._json_body = mock.Mock(side_effect=AssertionError("body must not be read"))
        handler.do_POST()
        self.assertEqual(handler.replies[0][0], 403)
        handler.hub.cloud_upload.assert_not_called()

    def test_same_origin_text_plain_is_not_a_json_capability_request(self):
        handler = self.handler(
            "POST",
            "/api/restore",
            {
                "Content-Type": "text/plain",
                hub_server.HUB_CREDENTIAL_HEADER: "test-capability-token",
            },
        )
        handler._json_body = mock.Mock(side_effect=AssertionError("body must not be read"))
        handler.do_POST()
        self.assertEqual(handler.replies[0][0], 403)

    def test_full_backup_requires_credential_before_packaging(self):
        handler = self.handler("GET", "/api/full-backup", {})
        handler.do_GET()
        self.assertEqual(handler.replies[0][0], 403)
        handler.hub.full_backup.assert_not_called()

        authorized = self.handler(
            "GET", "/api/full-backup", {hub_server.HUB_CREDENTIAL_HEADER: "test-capability-token"}
        )
        authorized.do_GET()
        self.assertEqual(authorized.replies[0][0], 200)
        authorized.hub.full_backup.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
