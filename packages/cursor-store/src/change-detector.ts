import type Database from "better-sqlite3";
import { SOURCES, tableForSource, type KvRow, type Source } from "./types.js";

/**
 * Delta detection across ALL of Cursor's state via a per-source SQLite rowid watermark.
 *
 * Cursor's tables are declared `key TEXT UNIQUE ON CONFLICT REPLACE`, so an update REPLACEs the
 * row — deleting it and re-inserting with a NEW, higher rowid. Verified empirically: max(rowid)
 * exceeds count by thousands in both tables. Therefore a rowid watermark catches inserts AND
 * edits across every namespace (bubbleId, composerData, agentKv, checkpointId, UI state, …) in
 * O(changed rows). (Deletes don't bump a watermark; a periodic full-key reconcile handles those.)
 */
export interface DetectorState {
  /** Highest rowid already exported, per source. */
  rowids: Partial<Record<Source, number>>;
}

export function emptyState(): DetectorState {
  return { rowids: {} };
}

export interface DetectResult {
  changed: KvRow[];
  next: DetectorState;
}

/** Returns rows changed since `state` across all sources, plus the new state to persist. */
export function detectChanges(db: Database.Database, state: DetectorState): DetectResult {
  const changed: KvRow[] = [];
  const rowids: Partial<Record<Source, number>> = { ...state.rowids };

  for (const source of SOURCES) {
    const table = tableForSource(source);
    const since = state.rowids[source] ?? 0;
    const stmt = db.prepare(
      `SELECT rowid AS rowid, key, value FROM "${table}" WHERE rowid > ? ORDER BY rowid ASC`,
    );
    let max = since;
    for (const r of stmt.iterate(since) as IterableIterator<{
      rowid: number;
      key: string;
      value: Buffer | string | null;
    }>) {
      changed.push({ source, key: r.key, rowid: r.rowid, value: r.value ?? null });
      if (r.rowid > max) max = r.rowid;
    }
    rowids[source] = max;
  }

  return { changed, next: { rowids } };
}
