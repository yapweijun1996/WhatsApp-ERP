# MacBook Air source migration

This is a sanitized working-tree snapshot of the WhatsApp ERP implementation, imported on 2026-09-30. The original VM repository, history, services, and live data remain on the VM.

## Source coverage

- Source HEAD: `a8ac9f1c0878537172a0c3dc5091a14f6f50c81a` on `main`.
- 349 original source, test, schema, configuration, skill, and documentation files are included. `MIGRATION_MANIFEST.json` records every original file's SHA-256 and size.
- Preserved uncommitted changes: `schema.sql`, `src/app.ts`, `src/database.ts`, `docs/DEMO_DATASETS.md`, and `tests/petshop-dataset.test.ts`.
- The safe tracked and untracked file set was checked against the VM and each file hash matched after transfer and validation.
- Transfer archive SHA-256: `7b1e555e441a8fc90ed43fb70af16c58a38972b83a8cd68b34ca1b07ee129727`.
- Excluded: Git history, all `.env*` files (including `.env.example`), Linux dependencies, build output, test artifacts, databases/customer data, uploads, runtime logs, and WhatsApp authentication/session material. Fictional source-code demo fixtures remain part of the implementation.
- The destination branch starts from the existing `.gitattributes`-only GitHub `main` commit `89ae4794bdffa94c805e2209f0af9386a179bee5`; no VM Git history was imported.

## Validation

Validated on macOS ARM64 with Node `24.20.0`, matching the source VM. The official Node distribution SHA-256 was checked. Dependencies were installed from the unchanged npm lockfile, and `better-sqlite3` was rebuilt locally for Node 24. No Linux `node_modules` were copied.

```bash
npm ci
npm run typecheck
npm run build
node --test --test-concurrency=1 --import tsx tests/*.test.ts
npm run e2e
```

- Typecheck: passed.
- Build: passed.
- Explicit TypeScript test run: 1,016 passed, 0 failed, 0 skipped.
- Playwright Chromium: 2 passed. The configured test server uses an in-memory database and test-only staff credentials.
- Gitleaks `8.30.1`: no secrets found in the VM snapshot or local publication source.
- Staged Gitleaks scan: no secrets found. Executable code/configuration and migration evidence passed the whitespace check; original review Markdown retains its existing two-space line breaks.
- The Mac's preinstalled Node 23 ran `npm test` with zero discovered tests, so that result was not accepted as evidence. The explicit command above verifies the TypeScript suite under Node 24 without changing the original package script.

`npm audit` reports two existing vulnerable dependency packages: `brace-expansion` (high) and `fast-uri` (moderate). Both have fixes available. The lockfile is preserved in this migration; dependency upgrades remain a separate change.

## Local use

Use Node 24.20.0 and the verification commands above. Environment templates and all runtime credentials were deliberately excluded; construct local configuration from the documented variable names and keep it outside Git. Do not reuse production WhatsApp sessions or customer databases for validation.

This migration does not deploy the app, cut over services, send customer messages, or merge the implementation.
