"""Run the full offline regression suite for the project hardening work.

    python tests/run_all.py

Requires Python 3.10+ and Node 18+ (for the postMessage protocol tests).
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(label: str, command: list[str]) -> int:
    print("\n" + "=" * 68)
    print(label)
    print("=" * 68)
    result = subprocess.run(command, cwd=ROOT)
    if result.returncode:
        print("%s FAILED (exit %d)" % (label, result.returncode), file=sys.stderr)
    return result.returncode


def npm_command() -> str:
    return "npm.cmd" if sys.platform == "win32" else "npm"


def venv_python() -> Path | None:
    """Playwright lives in the repo-local virtualenv, not the system Python."""
    rel = "Scripts/python.exe" if sys.platform == "win32" else "bin/python"
    candidate = ROOT / "public" / ".venv" / rel
    return candidate if candidate.exists() else None


def main() -> int:
    failures = 0
    vp = venv_python()
    failures += run("Backend hardening (Python unittest)",
                    [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"])
    failures += run("Unified product guard (quotes / links / imports / bridge / specs / spec_sync / debug / resources / xss / a11y / registry / runtime / version)",
                    [sys.executable, "tests/product_guard.py", "--check"])
    if vp:
        failures += run("AI workspace (pytest, includes framework quote gate)",
                        [str(vp), "-m", "pytest", "public/tests", "-q"])
    else:
        print("\nAI workspace pytest SKIPPED (repo virtualenv not found)")
    failures += run("postMessage protocol (Node)",
                    ["node", "tests/test_message_security.mjs"])
    zen_tests = [
        "test_zencard.mjs",
        "test_srs.mjs",
        "test_flow.mjs",
        "test_review.mjs",
        "test_backup.mjs",
        "test_products.mjs",
        "test_knowledge_graph.mjs",
        "test_chart.mjs",
        "test_writer_deep.mjs",
        "test_search_library.mjs",
        "test_search_page.mjs",
        "test_data_viz.mjs",
        "test_dataviz_flow.mjs",
        "test_data_flow.mjs",
        "test_canvas_layout.mjs",
        "test_cmdk.mjs",
        "test_cmdk_upgrade.mjs",
        "test_json_specs.mjs",
        "test_golden_formats.mjs",
        "test_today_panel.mjs",
        "test_zenpack.mjs",
        "test_ai_live_context.mjs",
        "test_review_pull.mjs",
        "test_writer_review_link.mjs",
        "test_markdown_sanitizer.mjs",
        "test_annotate_reliability.mjs",
        "test_hardening_regressions.mjs",
        "test_frontend_bugfixes.mjs",
        "test_frontend_bugfixes2.mjs",
        "test_frontend_bugfixes3.mjs",
        "test_security_fixes.mjs",
    ]
    failures += run("ZenCard / SRS / Flow / Review / Backup / products (Node)",
                    ["node", "--test"] + ["tests/" + t for t in zen_tests])
    if vp:
        failures += run("E2E browser chain (Playwright)",
                        [str(vp), "-m", "unittest", "discover", "-s", "tests/e2e", "-v"])
    else:
        print("\nE2E browser chain SKIPPED (repo virtualenv with Playwright not found)")
    failures += run("Build & lint (Vite + ESLint)",
                    [npm_command(), "run", "lint"])
    failures += run("Production build", [npm_command(), "run", "build"])
    if failures:
        print("\n%d test step(s) failed." % failures, file=sys.stderr)
        return 1
    print("\nAll test steps passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
