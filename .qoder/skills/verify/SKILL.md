---
name: verify
description: Run a production build to catch errors before committing. Use when you want to confirm code compiles and bundles correctly.
---

Run the production build and report the result.

## Steps

1. Run `npm run build` in the project root.
2. If it succeeds, report success with the build output size summary.
3. If it fails, show the full error output and identify the file/line causing the issue.
4. Do not attempt to fix errors automatically — report them and let the user decide.
