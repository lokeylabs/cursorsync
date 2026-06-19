-- cursorsync Supabase schema — generic, syncs EVERYTHING Cursor stores.
--
-- Cursor keeps all state as key/value rows in two SQLite tables (`cursorDiskKV` and `ItemTable`)
-- of its global `state.vscdb`. Rather than curate namespaces, cursorsync syncs every row: bubbleId
-- (messages), composerData (conversations), agentKv (agent traces, binary), checkpointId, ofsContent,
-- inline diffs, and UI state all flow through. Values that aren't valid UTF-8 are base64-encoded
-- (is_binary = true).
--
-- One row per (owner, source, key). `id` is deterministic so any device upserts the same row.

create table if not exists cursor_kv (
  id         text primary key,            -- `${owner_id}:${source}:${key}`
  owner_id   uuid not null default auth.uid(),
  source     text not null,               -- 'global:cursorDiskKV' | 'global:ItemTable'
  ckey       text not null,               -- the raw Cursor key
  is_binary  boolean not null default false,
  value      text,                        -- inline value (text/base64); null when offloaded to storage
  blob_sha   text,                        -- sha256 pointer into the `cursor-blobs` bucket; null when inline
  repo       text,                        -- stable repo id (git remote) for conversation rows; null otherwise
  device_id  text,
  updated_at timestamptz not null default now()
);

create index if not exists cursor_kv_owner_idx        on cursor_kv (owner_id);
create index if not exists cursor_kv_owner_source_idx on cursor_kv (owner_id, source);
create index if not exists cursor_kv_owner_repo_idx   on cursor_kv (owner_id, repo);

-- Row Level Security: each authenticated user only sees their own rows.
alter table cursor_kv enable row level security;

drop policy if exists "own rows" on cursor_kv;
create policy "own rows" on cursor_kv
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Large/binary values are content-addressed in the private `cursor-blobs` Storage bucket at
-- path `{owner_id}/{sha256}`. Each user may read/write only their own folder.
drop policy if exists "own blobs read" on storage.objects;
drop policy if exists "own blobs insert" on storage.objects;
create policy "own blobs read" on storage.objects for select to authenticated
  using (bucket_id = 'cursor-blobs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own blobs insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'cursor-blobs' and (storage.foldername(name))[1] = auth.uid()::text);
