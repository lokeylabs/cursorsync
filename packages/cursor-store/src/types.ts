/**
 * cursorsync syncs ALL of Cursor's state, not a curated subset. Cursor stores everything as
 * key/value rows in two SQLite tables of its global `state.vscdb`:
 *
 *   - `cursorDiskKV` — bubbleId (messages), composerData (conversations), agentKv (agent traces,
 *     often binary), checkpointId, ofsContent, inline diffs, etc.
 *   - `ItemTable`    — workbench/UI state and assorted settings.
 *
 * We treat both generically. A row's value is raw bytes; values that aren't valid UTF-8 are
 * flagged binary and base64-encoded downstream.
 */

/** Logical origin of a row: which DB + table it came from. */
export type Source = "global:cursorDiskKV" | "global:ItemTable";

export const SOURCES: Source[] = ["global:cursorDiskKV", "global:ItemTable"];

/** Map a source to the SQLite table name it reads/writes. */
export function tableForSource(source: Source): "cursorDiskKV" | "ItemTable" {
  return source === "global:ItemTable" ? "ItemTable" : "cursorDiskKV";
}

/**
 * A raw key/value row from one of Cursor's tables.
 *
 * better-sqlite3 returns TEXT-affinity values as JS strings and BLOB-affinity values as Buffers,
 * so `value` may be either (or null for tombstones). Downstream handles all three.
 */
export interface KvRow {
  source: Source;
  key: string;
  rowid: number;
  value: Buffer | string | null;
}
