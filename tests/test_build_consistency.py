"""离线打包与发布默认值一致性回归测试。

    python -m unittest discover -s tests -p 'test_build_consistency.py' -v
"""
from __future__ import annotations

import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "public" / "desktop"
for path in (str(DESKTOP), str(ROOT / "public")):
    if path not in sys.path:
        sys.path.insert(0, path)

import offline  # noqa: E402
from plugin_specs import BUILTIN_PLUGINS, VERSION  # noqa: E402

SCRIPT_RE = re.compile(r'<script[^>]+src=["\']([^"\']+\.js)["\']', re.I)


class StagedAssetsTests(unittest.TestCase):
    def test_every_local_script_reference_is_staged(self):
        problems = []
        for item in BUILTIN_PLUGINS:
            with tempfile.TemporaryDirectory() as folder:
                dest = offline.stage_plugin(item["id"], Path(folder))
                page = (dest / item["entry"]).read_text(encoding="utf-8", errors="replace")
                for ref in set(SCRIPT_RE.findall(page)):
                    if "/" in ref or "\\" in ref:  # vendor paths copied separately
                        continue
                    if not (dest / ref).is_file():
                        problems.append("%s: %s" % (item["id"], ref))
        self.assertEqual(problems, [], "staged pages reference missing scripts")


class ReleaseDefaultTests(unittest.TestCase):
    def test_release_defaults_track_suite_version(self):
        expected = "v" + VERSION
        scripts = [
            DESKTOP / "release" / name for name in (
                "create_gitee_release.ps1", "delete_gitee_assets.ps1",
                "publish_pointer.ps1", "upload_gitee_assets.ps1",
            )
        ]
        scripts.append(DESKTOP / "release" / "verify_release.py")
        for script in scripts:
            text = script.read_text(encoding="utf-8-sig")
            tags = re.findall(r"v(\d+(?:\.\d+){2})", text)
            self.assertTrue(tags, "%s has no default tag" % script.name)
            self.assertEqual(tags[0], VERSION.lstrip("v"), "%s default tag drifted" % script.name)
        workflow = (ROOT / ".github" / "workflows" / "macos-build.yml").read_text(encoding="utf-8")
        self.assertIn(expected, workflow)


if __name__ == "__main__":
    unittest.main()
