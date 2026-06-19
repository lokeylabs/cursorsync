# Contributing to cursorsync

Thanks for your interest! cursorsync is an early-stage, local-first sync tool for Cursor chat
history. Contributions of all sizes are welcome.

## Prerequisites

- **Node** ≥ 20 (see [`.nvmrc`](.nvmrc) — `nvm use`)
- **pnpm** ≥ 9 (`corepack enable && corepack prepare pnpm@latest --activate`)

## Getting started

```bash
git clone https://github.com/hughesyadaddy/cursorsync.git
cd cursorsync
pnpm install
pnpm build          # builds all packages topologically
pnpm test           # vitest
pnpm lint           # eslint
pnpm typecheck      # tsc --noEmit across the workspace
```

To run the read-only probe against your own Cursor DB:

```bash
pnpm build
pnpm probe          # prints chat namespace footprint
```

## Repository layout

```
packages/
  cursor-store/   Pure adapter for Cursor's state.vscdb (read/write + delta detection). No app deps.
  sync-engine/    Transform, config, and PowerSync/Supabase transport (orchestration).
  extension/      The Cursor / VS Code extension that hosts the bridge.
examples/         Runnable probes/demos against a local Cursor DB.
supabase/         Postgres schema + PowerSync sync rules.
docs/             Architecture and design notes.
```

**Separation of concerns:** `cursor-store` is the only package that talks to SQLite and must stay
free of app/transport dependencies. Anything network- or config-related belongs in `sync-engine`.

## Pull requests

1. Branch from `main`.
2. Keep changes focused; add/adjust tests for behavior changes.
3. Ensure `pnpm build && pnpm lint && pnpm typecheck && pnpm test` pass.
4. Use clear commit messages (Conventional Commits encouraged).

## Safety rules for code that touches Cursor's DB

- Reads must be read-only (`mode=ro`, never `immutable=1` on a live DB).
- Writes must be backup-first and must never corrupt a user's chat history.
- Never commit a real `.env`, a `.vscdb`, or any extracted chat content.

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
