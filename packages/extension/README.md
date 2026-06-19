# cursorsync

Sync your Cursor AI chat history across all your devices.

Cursor keeps every conversation in a local SQLite database with no built-in cross-device sync.
cursorsync bridges that database to a private, row-level-secured Supabase backend, so your chats
follow you from machine to machine — sign in once with GitHub and your history is there.

## Features

- **Sign in with GitHub** — one click, OAuth via Supabase. Your data is row-level-security scoped
  to your account; nobody else can read it.
- **Full-fidelity sync** — conversations, messages, and agent tool-result traces. Large/binary data
  (agent traces) is stored content-addressed in object storage, so 100% sync stays lightweight and
  never bloats the database. (Regenerable file snapshots and per-machine UI state are excluded.)
- **Scope toggle** — sync **all chats**, or **isolate to the current repo** (matched by git remote,
  so the same repo lines up across machines).
- **Two-way** — push your local chats to the cloud and pull chats made on other devices.
- **Auto-sync** — new chats push automatically and remote changes arrive live in the background.
- **Safe by design** — cursorsync snapshots your local database to `~/cursorsync-backups` before it
  ever writes to it, and all writes are atomic. Your local chats can't be lost.

## Getting started

1. Install the extension (from a `.vsix`: **Extensions → ⋯ → Install from VSIX…**, or the Marketplace
   once published).
2. Open the **cursorsync** panel from the activity bar.
3. Click **Sign in with GitHub** and approve in your browser.
4. Click **Sync all chats now** to push your history. On another device, sign in and the same chats
   appear (restart Cursor once to display freshly-pulled conversations).

## The panel

| Control                          | What it does                                                                |
| -------------------------------- | --------------------------------------------------------------------------- |
| **Sign in with GitHub**          | Authenticate; your session is stored securely in VS Code SecretStorage.     |
| **Scope: All chats / This repo** | Sync everything, or only conversations belonging to the current repository. |
| **Sync all chats now**           | Push local changes to the cloud.                                            |
| **Pull from cloud**              | Fetch chats from your other devices into this one.                          |
| **Auto-sync**                    | Toggle background push + live pull.                                         |

Commands (Command Palette): `cursorsync: Sign in with GitHub`, `Sync all chats now`, `Pull chats
from cloud`, `Back up local chats now`, `Sign out`.

## Settings

- `cursorsync.syncScope` — `all` or `repo` (also toggleable in the panel).
- `cursorsync.autoSync` — background push/pull on/off.
- `cursorsync.supabaseUrl` / `cursorsync.supabaseAnonKey` — backend (defaults to the cursorsync
  project; the anon key is public and RLS-protected). Point these at your own Supabase project to
  self-host.

## How it works

Each row of Cursor's `state.vscdb` is synced (binary values base64-encoded) to a Supabase table,
upserted by a deterministic key for conflict-free union merge. A new chat is just new rows; two
machines writing different conversations never collide. See
[the architecture docs](https://github.com/lokeylabs/cursorsync/blob/main/docs/ARCHITECTURE.md).

## Privacy & safety

- Your chats sync to **your** backend, scoped to **your** account by row-level security.
- The extension reads your live DB read-only and writes back atomically, backup-first.
- No secrets are bundled beyond the public anon key.

MIT licensed · [github.com/lokeylabs/cursorsync](https://github.com/lokeylabs/cursorsync)
