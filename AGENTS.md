# AGENTS.md

## Repo shape

- `production` is the deployed build variant of a personal blog repo that also carries a much larger static product suite. The root `README.md` covers only the blog and lists the differences from `main`.
- Root `src/` + root `index.html`: Vue 3 + Vite blog SPA. Content is fetched from `public/data/chats.json` and `public/data/comments.json` with `no-cache` (no LocalStorage for content).
- `public/`: OMM-ZEN product suite. Standalone HTML pages with sibling ES modules; there is no frontend build step for these pages. It also holds the Python desktop launcher (`public/desktop/`), AI workspace backend (`public/agent_workspace/`), and JSON format specs (`public/json-specs/`).
- `public/index.html` is currently the Lambda product/plugin page, not the blog. The blog entry is the root `index.html`. `npm run build` emits the blog as `dist/index.html`; test Lambda through the plugin/desktop path.
- `third_party/zenviz-core/` is a git submodule shared with another product (`profiles/omm` is the OMM profile). Init it with `git submodule update --init` before chart work.
- `public/dist/` is desktop release output (gitignored); root `dist/` is the web build.
- Web deploy is Vercel (`vercel.json` rewrites all paths to `/`). Desktop release flow is in `public/desktop/RELEASE.md`.

## Commands

Run from the repo root unless noted.

- `npm install`, `npm run dev`, `npm run build`, `npm run preview`.
- `npm run lint` and `npm run format` touch `src/` only. `public/` is deliberately outside ESLint/Prettier.
- Full regression: `python tests/run_all.py` (Python unittest, product guard, AI workspace pytest, Node suites, Playwright E2E, lint, build). Venv-dependent steps are skipped if `public/.venv` is missing.
- Required after any `public/` edit: `python tests/product_guard.py --check`. Without `--check` it first auto-fixes quote violations. Use `--list` or `--only LINK,IMPORT,REGISTRY` for focused runs.
- Focused tests:
  - `node --test tests/test_zencard.mjs`
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
- AI product knowledge lives in `public/agent_workspace/omm_data.py`; skills derive from `PRODUCTS`, so update that rather than hand-editing derived skill lists.
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
- There is no CI test workflow; only `.github/workflows/macos-build.yml` exists. Run the regression suite locally before committing.
