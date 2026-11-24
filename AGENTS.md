# AGENTS.md

## Repo shape

- `production` is the deployed branch. Root `README.md` documents only the Vue blog, not the product suite.
- Root `src/` + root `index.html` are the Vue 3/Vite blog. Chat/comment content is fetched from `public/data/*.json` with `cache: 'no-cache'`; localStorage is only for UI preferences.
- `public/` is the standalone OMM-ZEN product suite. Its HTML/JS/CSS have no frontend build step. Python backends live in `public/server/`, desktop packaging in `public/desktop/`, AI backend in `public/agent_workspace/`.
- `public/index.html` is the Lambda product page, not the blog. Test Lambda through the plugin/desktop path.
- Root `dist/` is the Vite blog build. `public/dist/` and `public/build/` are gitignored desktop/plugin outputs.
- Vercel rewrites every path to `/` (`vercel.json`).

## OMM-ZEN contract

- Before product work, read `public/docs/README.md` and `public/docs/product-guide.md`; use `design-tokens.md`, `components.md`, and `shared-modules.md` as references.
- **Zero residue, zero compatibility, zero redundancy.** After moving logic/styles, delete the old implementation, aliases, wrappers, dead bindings, unused ids/templates, and stale docs. Grep all source before deleting. Never leave commented-out code.
- Styles enter only through `zen/zen.css`. Shared layers are `foundation/`, `components/`, `features/`; product-only CSS goes in `zen/products/<id>.css` inside `@layer zen.product`. No inline `<style>`, new hardcoded colours, or per-product z-index. Radius stays `0`; accent stays neutral.
- Reuse `ZenUI` components; do not add native dialogs or private overlay shells. Shared JS lives in `public/lib/` or `public/zen/`; products configure it rather than copy it.
- Untrusted HTML must pass through `lib/zen-html.js` (`ZenHTML.sanitize`); do not add product-private sanitisers. Escape every imported id used in an HTML attribute.
- Bridge load order is `omm-embed.js` → `omm-desktop.js` → `omm-share.js`. Keep these and `viz-bridge.js` at the `public/` root; the zenviz-core template references `viz-bridge.js` by bare name.
- Cross-product data goes through `OMMShare` / `OMMDesktop` / ZenCard. Never wildcard `postMessage`; validate both `event.origin` and `event.source`, and reply to an explicit origin.
- New product: `python public/tools/new_product.py <id> <名称> <字标> <描述> --port <端口> --channels <频道>`. It generates files and prints the registry entry but does not register the product.
- `public/desktop/plugin_specs.py` `BUILTIN_PLUGINS` is the product registry. Conventional entries are `public/omm-<id>.html`. Also wire `DESKTOP_EXE_NAMES`, runtime/offline staging, tests, and JSON/AI specs when applicable. Imported plugins are forced to `static`.
- AI product knowledge comes from `PRODUCTS` in `public/agent_workspace/omm_data.py`; skills derive from it. Do not hand-edit generated skill lists.
- `public/server/*` code must work both in the source tree (assets one directory up) and staged plugins (assets beside the backend).

## Commands

Run from the repo root. Requires Node `^20.19.0 || >=22.12.0` and Python 3.10+.

- Blog: `npm install`, `npm run dev`, `npm run build`, `npm run preview`.
- `npm run lint` and `npm run format` only touch `src/`; `public/` is excluded. There is no `npm test`.
- Required after any `public/` edit: `python tests/product_guard.py --check`. Without `--check`, the guard first repairs quote violations. Focused: `python tests/product_guard.py --only LINK,IMPORT,REGISTRY`.
- Style audit: `python public/desktop/check_styles.py`.
- Full regression: `python tests/run_all.py` (Python, guard, pytest, Node, Playwright, lint, build). pytest/E2E are skipped when `public/.venv` is absent.
- A new `tests/test_*.mjs` is silently omitted from the full suite unless added to the hardcoded `zen_tests` list in `tests/run_all.py`.
- Focused checks:
  - `node --test tests/test_design_system.mjs tests/test_zen_shared_ui.mjs`
  - `python -m unittest discover -s tests -p 'test_build_consistency.py' -v`
  - `public/.venv/Scripts/python.exe -m pytest public/tests/test_table_api.py::test_origin_and_host_guards -q`
  - `public/.venv/Scripts/python.exe -m unittest discover -s tests/e2e -v -k test_hub_cmdk_finds_product_owned_data`
- First-time E2E setup: `public/.venv/Scripts/python.exe -m playwright install chromium-headless-shell`.
- Playwright must use the shared UI: click `.zenui-select-trigger` then `.zenui-option` for `data-zen-select`, and `.zenui-ok` for `ZenUI.dialog.confirm`. Native selects are hidden and confirms are not browser dialogs.

## Generated files and versions

- Never hand-edit generated artifacts. Edit the source, regenerate, then run the sync guard.
- `public/json-specs/format-registry.json` generates `omm_formats_generated.py` and both `formats.generated.md` copies: `python public/tools/gen_formats.py`.
- `public/json-specs/*.md` must be byte-identical to `public/agent_workspace/omm_knowledge/*.md`; every spec must be indexed in `public/json-specs/README.md`.
- Chart page source is `third_party/zenviz-core/profiles/omm`; regenerate with `python third_party/zenviz-core/build.py --product omm --root .`. Run `git submodule update --init` before chart work.
- A new shared module must be added to `SHARED_MODULES` in `tests/product_guard.py`; `offline.py copy_shared_lib` stages `public/lib/` wholesale.
- Bump the product `version` when its page changes, or suite `VERSION` when a `SHARED_MODULES` file changes. Also update default tags in `.github/workflows/macos-build.yml` and `public/desktop/release/*`.
- After a version bump, run `python public/desktop/build_plugins.py` before `product_guard.py --check`; `public/dist/catalog.json` is gitignored and stale on a fresh clone.
- `tests/version_baseline.json` is release state. Do not run `--record-baseline` outside a release. Follow `public/desktop/RELEASE.md` for the immutable-tag release flow.

## Gotchas

- Never use CJK corner brackets U+300C/U+300D/U+300E/U+300F/U+FE41-U+FE44/U+301D-U+301F. Use Chinese curly quotes; `python tests/no_jp_quotes.py` repairs violations.
- `public/agent_workspace/` is vendored upstream; only `omm_*.py` adapters and `omm_knowledge/` are ours. Do not reformat upstream files.
- Put `public/` on `sys.path` and import `agent_workspace.omm_data`; never add `public/agent_workspace` itself, because its `types.py` shadows the standard library.
- On Windows, do not bulk-rewrite Chinese source with PowerShell `Set-Content -Encoding UTF8`; it can add a BOM or corrupt text. Use the editor or UTF-8 without BOM.
- Vite copies all of `public/` before stripping `.venv`, `desktop`, `build`, `mdforge`, `data_back`, etc. from root `dist/`; builds are heavy.
- `offline.copy_zen_styles(dest, app_id)` stages shared styles plus only that product's CSS. Do not restore a wholesale `zen/products` copy: unrelated product assets (for example Lambda's APL font) would become false bundle requirements.
- `public/tests/test_table_api.py::test_cancel` and `::test_origin_and_host_guards` intermittently raise `ConnectionAbortedError` (WinError 10053) in the full suite but pass alone. Do not treat one occurrence as a regression.
- There is no CI test workflow; only `.github/workflows/macos-build.yml` exists. Run regression locally before committing.
- On Windows the `.venv/Scripts/python.exe` launcher can spawn a base-Python child. Stopping only the launcher leaves Hub/product servers alive; stop the matching process tree before restarting runtime tests.
