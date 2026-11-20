"""Backend input-validation and status-flag regression tests.

    python -m unittest discover -s tests -p 'test_backend_bugfixes.py' -v

Covers: unhashable ids never crash validators, Flask parameter parsing,
runtime/workspace truncation flags, and plugin api field type errors.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for path in (str(ROOT / "public"),):
    if path not in sys.path:
        sys.path.insert(0, path)

from agent_workspace import omm_validators, python_runtime, workspace  # noqa: E402
from agent_workspace.errors import AIError  # noqa: E402
from agent_workspace.plugins import PluginHost  # noqa: E402


class _Prefs:
    def __init__(self):
        self.data = {}

    def get_pref(self, account, key, default=""):
        return self.data.get((account, key), default)

    def set_pref(self, account, key, value):
        self.data[(account, key)] = value


class MalformedIdTests(unittest.TestCase):
    """Untrusted JSON ids as objects/arrays must yield a report, not TypeError."""

    def test_annotate_object_id_does_not_crash(self):
        report = omm_validators.validate(
            "annotate",
            {"app": "zenmark", "version": 1, "project": {"codes": [{"id": {"x": 1}}]}},
        )
        self.assertFalse(report["ok"])
        self.assertTrue(report["errors"])

    def test_corpus_list_id_does_not_crash(self):
        report = omm_validators.validate(
            "corpus",
            {
                "entries": [{"en": "x", "categoryId": "c", "id": ["x"]}],
                "categories": [{"id": "c"}],
            },
        )
        self.assertFalse(report["ok"])

    def test_planner_object_id_does_not_crash(self):
        report = omm_validators.validate(
            "planner",
            {
                "app": "zenplan", "version": 2, "planners": [{"id": {"x": 1}}],
                "eventsBy": {}, "recursBy": {},
            },
        )
        self.assertFalse(report["ok"])

    def test_writer_object_endpoint_does_not_crash(self):
        report = omm_validators.validate(
            "writer",
            {
                "format": "zenwriter-canvas", "v": 2,
                "nodes": [{"id": "node-1", "x": 1, "y": 1}],
                "connections": [{"from": {"x": 1}, "to": "node-1"}],
            },
        )
        self.assertFalse(report["ok"])
        self.assertTrue(any("端点" in item for item in report["errors"]))

    def test_valid_numeric_ids_still_work(self):
        report = omm_validators.validate(
            "corpus",
            {
                "version": 1,
                "entries": [{"en": "x", "categoryId": 1, "id": 2}],
                "categories": [{"id": 1}],
            },
        )
        self.assertNotIn("entries[0].categoryId 不在 categories 中", report["errors"])


class RuntimeFlagTests(unittest.TestCase):
    def test_truncated_reflects_dropped_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "out.jsonl"
            path.write_text(
                "\n".join('{"i": %d}' % i for i in range(5)), encoding="utf-8"
            )
            rows, truncated = python_runtime._read_output(path, 3)
            self.assertEqual(len(rows), 3)
            self.assertTrue(truncated, "dropped rows must set truncated")
            rows, truncated = python_runtime._read_output(path, 10)
            self.assertEqual(len(rows), 5)
            self.assertFalse(truncated)


class WorkspaceFlagTests(unittest.TestCase):
    def _ws(self, folder):
        prefs = _Prefs()
        return workspace.Workspace(prefs, "tester", root=folder)

    def test_created_flag(self):
        with tempfile.TemporaryDirectory() as folder:
            ws = self._ws(folder)
            first = ws.write("new.txt", "x")
            self.assertTrue(first["created"])
            second = ws.write("new.txt", "y")
            self.assertFalse(second["created"])

    def test_truncated_flag(self):
        with tempfile.TemporaryDirectory() as folder:
            ws = self._ws(folder)
            script = Path(folder) / "gen.py"
            script.write_text("print('a' * 200)", encoding="utf-8")
            result = ws.run("python gen.py", max_bytes=32, allow=("python",))
            self.assertTrue(result["truncated"])
            self.assertLessEqual(len(result["stdout"]), 32)


class PluginApiTests(unittest.TestCase):
    def test_non_numeric_api_is_validation_error_not_value_error(self):
        host = PluginHost.__new__(PluginHost)
        host.store = _Prefs()
        host.host = type(
            "Env", (),
            {"environment": lambda self: type("E", (), {"cloud": False, "local": True})()},
        )()
        with self.assertRaises(AIError) as ctx:
            host.validate({"id": "plug", "api": "abc", "kind": "skill-pack"})
        self.assertEqual(ctx.exception.key, "plugin.apiMismatch")


if __name__ == "__main__":
    unittest.main()
