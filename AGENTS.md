# AGENTS.md

## Read this first (OMM-ZEN product work)

- `public/docs/` is the design-system contract: `README.md` (hard rules), `design-tokens.md`,
  `components.md`, `shared-modules.md`, `product-guide.md`, `skills.md`. Read `README.md` and
  `product-guide.md` before adding or changing any product.
- New product: `python public/tools/new_product.py <id> <名称> <字标> <描述> --port <端口> --channels <频道>`
  (from repo root). It generates the entry page, `zen-style/products/<id>.css` and a test skeleton,
  refuses to overwrite, and prints the `BUILTIN_PLUGINS` entry to paste. It does not edit the registry.
- Styles: one entry `zen-style/zen.css`; shared layers `tokens.css`, `base.css`, `primitives.css`,
  `features/*.css`; product-only rules in `zen-style/products/<id>.css` wrapped in `@layer zen.product { … }`.
  No inline `<style>`, no new hardcoded colours, no per-product z-index. Radius is fixed 0 and the
  accent is neutral — the hub/installer theme-colour, radius and light/dark settings were deliberately
  removed; do not reintroduce them.
- Shared JS lives in `public/lib/` (`zen-*.js`, `data-viz.js`, `search-library.js`) and exposes one
  global per module (`ZenCrypto`, `ZenCard`, …). Bridge scripts (`omm-embed.js`, `omm-desktop.js`,
  `omm-share.js`) and `viz-bridge.js` stay at the root: the zenviz-core submodule template references
  `viz-bridge.js` by bare name. `lib/zen-crypto.js` holds the Base64/PBKDF2 helpers used by the six
  cloud-sync products; do not re-inline them. A new shared module must be listed in
  `tests/product_guard.py` `SHARED_MODULES` and staged by `offline.py copy_shared_lib`, which ties
  it to the suite version.

## Repo shape

- `production` is the deployed build variant of a personal blog repo that also carries a much larger static product suite. The root `README.md` covers only the blog and lists the differences from `main`.
- Root `src/` + root `index.html`: Vue 3 + Vite blog SPA. Content is fetched from `public/data/chats.json` and `public/data/comments.json` with `no-cache` (no LocalStorage for content).
- `public/`: OMM-ZEN product suite. Standalone HTML pages with ES modules from `public/lib/`; there is no frontend build step for these pages. Shared JS is in `lib/`, Python product backends in `server/`; the Python desktop launcher is `public/desktop/`, AI workspace backend `public/agent_workspace/`, JSON format specs `public/json-specs/`.
- `public/server/*` backends are staged to the plugin root under their original filenames by `offline.py`; source-tree code finds assets one directory up, staged code finds them beside itself. Keep both paths working when moving a backend.
- `public/index.html` is currently the Lambda product/plugin page, not the blog. The blog entry is the root `index.html`. `npm run build` emits the blog as `dist/index.html`; test Lambda through the plugin/desktop path.
- `third_party/zenviz-core/` is a git submodule shared with another product (`profiles/omm` is the OMM profile). Init it with `git submodule update --init` before chart work.
- `public/dist/` is desktop release output (gitignored); root `dist/` is the web build.
- Web deploy is Vercel (`vercel.json` rewrites all paths to `/`). Desktop release flow is in `public/desktop/RELEASE.md`.

## Commands

Run from the repo root unless noted.

- `npm install`, `npm run dev`, `npm run build`, `npm run preview`.
- `npm run lint` and `npm run format` touch `src/` only. `public/` is deliberately outside ESLint/Prettier.
- Full regression: `python tests/run_all.py` (Python unittest, product guard, AI workspace pytest, Node suites, Playwright E2E, lint, build). Venv-dependent steps are skipped if `public/.venv` is missing.
- `tests/run_all.py` has a hardcoded `zen_tests` list of Node files — a new `tests/test_*.mjs` is **silently skipped** unless added there. `python tests/product_guard.py --check` does not catch this.
- Required after any `public/` edit: `python tests/product_guard.py --check`. Without `--check` it first auto-fixes quote violations. Use `--list` or `--only LINK,IMPORT,REGISTRY` for focused runs.
- Focused tests:
  - `node --test tests/test_zencard.mjs`
  - `node --test tests/test_design_system.mjs tests/test_zen_crypto.mjs`
  - `python -m unittest discover -s tests -p 'test_build_consistency.py' -v`
  - `public/.venv/Scripts/python.exe -m pytest public/tests -q`
  - `public/.venv/Scripts/python.exe -m unittest discover -s tests/e2e -v`
- First-time E2E setup: `public/.venv/Scripts/python.exe -m playwright install chromium-headless-shell`.
- There is no `npm test` script.

## Generated files: edit the source, then regenerate

- `public/json-specs/format-registry.json` -> `public/agent_workspace/omm_formats_generated.py`, `public/json-specs/formats.generated.md`, `public/agent_workspace/omm_knowledge/formats.generated.md` via `python public/tools/gen_formats.py`. The `GEN_FORMATS` guard fails on drift.
- `third_party/zenviz-core/` -> `public/omm-visualization.html` via `python third_party/zenviz-core/build.py --product omm --root .`. Keep product-specific code in `profiles/omm`; `tests/test_zenviz_core_sync.mjs` compares byte-for-byte.
- `public/json-specs/*.md` -> `public/agent_workspace/omm_knowledge/*.md` must be byte-identical (`README.md` mirrors as `json-specs-README.md`). Every spec must also be linked from `public/json-specs/README.md` (`SPEC` / `SPEC_SYNC`).
- `public/dist/` and `public/build/` are generated and gitignored; never treat them as source.

## Product and version rules

- `public/desktop/plugin_specs.py` `BUILTIN_PLUGINS` is the single product registry. The launcher, guard, catalog, and offline staging derive from it. A new product also needs `DESKTOP_EXE_NAMES`, a runtime branch when non-static, `offline.py` staging, tests, and (when it has an import format) a JSON spec plus its AI knowledge mirror.
- `REGISTRY` maps product id `x` to the conventional page `public/omm-x.html`; a different entry filename fails the check unless the guard is updated.
- AI product knowledge lives in `public/agent_workspace/omm_data.py`; skills derive from `PRODUCTS`, so update that rather than hand-editing derived skill lists. Adding an extra (non-product) skill in `omm_skills.py` also breaks hard-coded skill counts in `public/tests/test_omm_ai.py` and `public/tests/test_ui_browser.py`, and the AI page's skill grid. `omm.zen.dev` is the developer skill that teaches the design system to the AI.
- `tests/version_baseline.json` is release state. Do not run `--record-baseline` outside a release. Bump the product's `version` in `plugin_specs` when its page changes, or the suite `VERSION` when a module in `SHARED_MODULES` changes. `python tests/product_guard.py --suggest-bump` lists candidates.
- When bumping suite `VERSION`, also update the default release tags in `.github/workflows/macos-build.yml` and `public/desktop/release/*`; `tests/test_build_consistency.py` enforces this.
- `public/dist/catalog.json` is gitignored. On a fresh clone, `VERSION` and `REGISTRY` cannot pass until a local release build exists; do not "fix" that by rewriting the version baseline.
- Imported/user plugins are forced to `static` and cannot run local backend code; only official built-in products may use a non-static runtime.

## Gotchas

- Never use CJK corner brackets U+300C / U+300D / U+300E / U+300F / U+FE41-U+FE44 / U+301D-U+301F anywhere in source, docs, or data. Use Chinese curly quotes. `python tests/no_jp_quotes.py` repairs in place.
- `public/agent_workspace/` is a vendored upstream framework; only `omm_*.py` adapters and `omm_knowledge/` are ours. Do not reformat upstream files (the quote gate excludes them to keep them byte-identical).
- Import rule: put `public/` on `sys.path` and import as `agent_workspace.omm_data`; never put `public/agent_workspace` itself on `sys.path` because its `types.py` shadows the standard library.
- Product pages are parsed by Node tests for syntax, DOM id references, bridge wiring, and `postMessage` origin checks. Keep them parseable; never use wildcard `postMessage` or skip `event.origin` / `event.source` validation.
- Vite copies all of `public/` first, then removes `DEV_ONLY_DIRS` (`.venv`, `desktop`, `build`, `mdforge`, `data_back`, ...) from `dist/`; builds are heavy and `public/dist` is not deployed.
- On Windows, avoid bulk-rewriting Chinese source with PowerShell `Set-Content -Encoding UTF8`; it can add a BOM or mangle text. Use the editor or UTF-8 without BOM.
- `public/tests/test_table_api.py::test_cancel` and `::test_origin_and_host_guards` intermittently raise `ConnectionAbortedError` (WinError 10053) under the full suite; both pass when run alone. Do not treat one occurrence as a regression.
- Version bumps need a release refresh before the guard goes green: `python public/desktop/build_plugins.py` regenerates `public/dist/catalog.json`, then `python tests/product_guard.py --record-baseline` refreshes `tests/version_baseline.json`. Until both run, `--check` reports VERSION drift.
- There is no CI test workflow; only `.github/workflows/macos-build.yml` exists. Run the regression suite locally before committing.
