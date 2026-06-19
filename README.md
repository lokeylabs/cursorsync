# cursorsync

Local-first, real-time sync of [Cursor](https://cursor.com) AI chat history across all your
machines — built on [PowerSync](https://powersync.com) + [Supabase](https://supabase.com).

Cursor stores every conversation in a local SQLite database (`state.vscdb`) and has **no
native cross-device sync**. cursorsync bridges each machine's local Cursor database to a shared
Supabase Postgres hub via PowerSync, so you can work locally and offline on every device and
have your chats converge automatically — with no central host to stay connected to and no data
loss under simultaneous use.

> Status: **early build**. Read-only extraction is implemented and validated. Write-back and the
> Cursor extension are in progress. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Why this is hard (and how we solve it)

Cursor's chat lives in one opaque SQLite blob with **no merge semantics**. Naively syncing the
file (Dropbox/Syncthing) corrupts it (last-writer-wins on a binary DB). Cursor exposes no API to
stream chat changes, so no extension can sync it "natively."

cursorsync sidesteps both problems:

- **Row-level union merge, not file merge.** Each chat message is a row with a globally-unique
  key (`bubbleId:{composerId}:{messageId}`). We sync _rows_, upserting by key. Distinct keys
  never collide → lossless union even when two machines write at once.
- **PowerSync owns the distributed-systems problem.** Offline, reconnect, conflict-free
  convergence, and "machines need not be online simultaneously" all come from PowerSync's bucket
  sync. We only write the thin adapter between Cursor's SQLite and PowerSync's SQLite.

```
Cursor state.vscdb  <->  [cursorsync bridge]  <->  PowerSync local SQLite
                                                        |
                                                  PowerSync service
                                                        |
                                                  Supabase Postgres  (hub of truth + backup)
```

## What we sync (measured on a real 27 GB Cursor DB)

| Namespace       | Rows | Size    | Synced     | Notes                                                                    |
| --------------- | ---- | ------- | ---------- | ------------------------------------------------------------------------ |
| `bubbleId`      | 802k | 10.8 GB | ✅         | individual chat messages, keyed by `{composerId}:{messageId}`            |
| `composerData`  | 2.3k | 162 MB  | ✅         | conversation objects (title, ordering, file mentions)                    |
| `agentKv:blob`  | 721k | 11.9 GB | ⏳ phase 2 | content-addressed agent tool-results & traces (JSON + binary, immutable) |
| `checkpointId`  | 7k   | 1.9 GB  | ❌         | file-tree snapshots — regenerable, excluded                              |
| `ofsContent`    | 6.5k | 114 MB  | ❌         | file content snapshots — excluded                                        |
| diff / UI state | —    | small   | ❌         | per-machine ephemeral state                                              |

The 27 GB on disk is mostly checkpoint/snapshot bloat. The actual conversations are ~11 GB.

## Repository layout

A pnpm workspace monorepo with strict separation of concerns:

```
packages/
  cursor-store/   Pure adapter for Cursor's state.vscdb — read/write + delta detection. No app deps.
  sync-engine/    Transform, config, and PowerSync/Supabase transport (orchestration).
  extension/      The Cursor / VS Code extension that hosts the bridge loop.
examples/         Runnable read-only probes/demos against a local Cursor DB.
supabase/         Postgres schema + PowerSync sync rules.
docs/             Architecture and design notes.
```

`cursor-store` is the only package allowed to touch SQLite and stays free of app/transport
dependencies; everything network- or config-related lives in `sync-engine`. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test
pnpm probe          # read-only footprint of your own Cursor DB
```

Requires Node ≥ 20 ([`.nvmrc`](.nvmrc)) and pnpm ≥ 9.

## Roadmap

- [x] Read-only schema probe + extractor (validated)
- [x] Up-sync delta detection (rowid watermark + composerData hash compare)
- [x] pnpm workspace, CI, lint/format, package separation
- [ ] Supabase schema + PowerSync sync rules applied to a live instance
- [ ] Bridge: up-sync (Cursor SQLite -> PowerSync)
- [ ] Bridge: down-sync (PowerSync -> Cursor SQLite) with safe writes + backups
- [ ] Per-machine path rewriting (file mentions use absolute paths)
- [ ] Cursor/VS Code extension packaging
- [ ] Phase 2: `agentKv` blob sync (base64/bytea, content-addressed)

## License

MIT — see [LICENSE](LICENSE).
