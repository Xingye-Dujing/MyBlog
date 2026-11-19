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


def main() -> int:
    failures = 0
    failures += run("Backend hardening (Python unittest)",
                    [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"])
    failures += run("Unified product guard (quotes / links / imports / bridge / specs / debug)",
                    [sys.executable, "tests/product_guard.py", "--check"])
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
    ]
    failures += run("ZenCard / SRS / Flow / Review / Backup / products (Node)",
                    ["node", "--test"] + ["tests/" + t for t in zen_tests])
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
