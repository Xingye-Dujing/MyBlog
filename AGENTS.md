# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Project overview

A personal blog built with **Vue 3 + Vite + JavaScript** (not TypeScript). Uses Pinia for state, Vue Router, markdown-it for rendering, highlight.js for code blocks, and KaTeX for math.

Chat-style layout with markdown articles, comments, a timeline view, and an about page.

## Branches

- **`main`** — primary development branch, supports `npm run dev` only. Uses LocalStorage for data.
- **`production`** — deployment-only fork for `npm run build`. Reads from static JSON files (`/data/chats.json`, `/data/comments.json`) instead of LocalStorage.

When deploying, always use the `production` branch.

## Commands

```bash
npm run dev      # start dev server
npm run build    # production build (use to verify changes compile correctly)
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

- `src/stores/chat.js` and `src/stores/comment.js` use LocalStorage on `main`; on `production` they fetch from static JSON files
- `src/composables/useMarkdown.js` centralizes markdown-it configuration and plugins
- Build chunks are manually split in `vite.config.js`: `highlight`, `katex`, `markdown`
- Additional views on `main`: `TimelineView.vue`, `AboutView.vue`
- Additional components on `main`: `MessageComments.vue`, `OutlineToggle.vue`

## Repo conventions

- **Primary development branch: `main`** — the `production` branch is deployment-only
- Commit messages use **conventional commits** (`feat:`, `fix:`, `chore:`, etc.)
- Two git remotes: `MyBlog` (GitHub) and `Gitee` — confirm with the user before pushing to either
