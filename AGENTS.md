# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Project overview

A personal blog built with **Vue 3 + Vite + JavaScript** (not TypeScript). Uses Pinia for state, Vue Router, markdown-it for rendering, highlight.js for code blocks, and KaTeX for math.

Deployed as a static site to Vercel/Edgeone. No backend.

## Commands

```bash
npm run dev      # start dev server
npm run build    # production build (also validates — use to verify changes)
npm run preview  # preview production build locally
npm run lint     # run ESLint on src/
npm run format   # format src/ with Prettier
```

No test runner is configured.

## Code style

- 2-space indentation, single quotes, no semicolons
- Vue SFCs use `<script setup>` (Composition API), not Options API
- Path alias: `@/` maps to `./src/`
- Plain JavaScript — do not introduce TypeScript

## Architecture notes

- `src/stores/chat.js` and `src/stores/comment.js` load data from static JSON files (`/data/chats.json`, `/data/comments.json`) via `fetch()`, not localStorage
- `src/composables/useMarkdown.js` centralizes markdown-it configuration and plugins
- Build chunks are manually split in `vite.config.js`: `highlight`, `katex`, `markdown`

## Repo conventions

- **Primary development branch: `main`** — the `production` branch is a deployment-only fork
- Commit messages use **conventional commits** (`feat:`, `fix:`, `chore:`, etc.)
- Two git remotes: `MyBlog` (GitHub) and `Gitee` — confirm with the user before pushing to either
