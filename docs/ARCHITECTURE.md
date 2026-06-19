# Architecture

## The data, as it actually exists on disk

Cursor (macOS) stores global state at:

```
~/Library/Application Support/Cursor/User/globalStorage/state.vscdb        # 27 GB main
~/Library/Application Support/Cursor/User/globalStorage/state.vscdb-wal     # up to ~16 GB WAL
~/Library/Application Support/Cursor/User/workspaceStorage/{id}/state.vscdb # per-workspace sidebar index
```

Both files are SQLite with two tables: `ItemTable` (small key/value) and `cursorDiskKV`
(the bulk; 1.57M rows). `cursorDiskKV` is used as a **key-value store**, `key TEXT -> value BLOB`.

### Key namespaces (measured)

- `bubbleId:{composerId}:{messageId}` — one chat message. JSON. **Synced.**
- `composerData:{composerId}` — one conversation (title, message ordering, file mentions). JSON.
  **Synced.** Note: `richText` embeds **absolute file paths** and `~/.cursor/projects/.../agent-transcripts/*.jsonl`
  paths → must be rewritten per machine on down-sync.
- `agentKv:blob:{sha256}` — content-addressed agent artifacts (tool results, traces). Mixed
  JSON and **binary** (protobuf/gzip). Immutable / write-once. **Phase 2.**
- `checkpointId:*`, `ofsContent:*` — file/workspace snapshots. Regenerable. **Excluded.**
- `composer.content.*`, `inlineDiff*`, `*VirtualRowHeights`, `bcCachedDetails` — ephemeral UI /
  diff state. **Excluded.**

## Reading the DB safely while Cursor is running

- Open with `file:state.vscdb?mode=ro` (read-only, **not** `immutable=1` — that flag assumes a
  static file and yields "database disk image is malformed" on a live WAL DB).
- For consistent point-in-time extraction during heavy writes, take a SQLite **online backup**
  (`VACUUM INTO` / backup API) into a temp file, then read the copy.
- Never open the live DB read-write. All down-sync writes go through a backup-first path.

## Merge model

PowerSync syncs its own managed SQLite on each client; we bridge it to Cursor's `state.vscdb`.

- **Primary key = the Cursor key** (`bubbleId:{composerId}:{messageId}`, `composerData:{composerId}`,
  `agentKv:blob:{sha256}`). Upsert by key.
- Distinct keys never collide → union merge is conflict-free. The only true conflict is two
  machines continuing the _same_ conversation in the _same_ second; worst case is a duplicated
  message row, never a lost one. `updated_at` + `device_id` break ties for display ordering.
- `agentKv` blobs are content-addressed (key = hash of value) → identical content dedupes for
  free and never needs conflict resolution.

## Down-sync display caveat

Cursor loads the chat list into memory at startup. Rows written to `state.vscdb` while Cursor is
running appear after a **full restart** (not just "Reload Window"). The extension surfaces a
"new chats synced — restart to view" prompt. This is a Cursor limitation, not ours.

## Components

- `packages/core` — pure TS: read-only extractor, key parsing, safe-copy, write-back with backup.
- `packages/extension` — Cursor/VS Code extension that hosts the PowerSync client and runs the
  bridge loop (up-sync on local change, down-sync on PowerSync change).
- `supabase/` — Postgres schema + PowerSync sync rules.
