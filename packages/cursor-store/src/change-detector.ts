import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Efficient delta detection over Cursor's `cursorDiskKV` table.
 *
 * The table has no modified-time column and ~1.5M rows, so a full rescan per cycle is too costly.
 * We exploit the observed access pattern:
 *
 *   - bubbleId:* rows are append-only and immutable once written. New messages always get a
 *     higher SQLite rowid, so an insert watermark (max rowid seen) finds them in O(new rows).
 *   - composerData:* rows mutate in place as a conversation grows, but there are only a couple
 *     thousand of them. We keep a key->valueHash manifest and rescan just that namespace to catch
 *     in-place updates. Cheap.
 *
 * Persist `DetectorState` between cycles (e.g. in the PowerSync DB or extension globalState).
 */
export interface DetectorState {
  /** Highest cursorDiskKV rowid we have already exported. */
  maxRowid: number;
  /** composerData key -> sha256(value) for in-place update detection. */
  composerHashes: Record<string, string>;
}

export function emptyState(): DetectorState {
  return { maxRowid: 0, composerHashes: {} };
}

export interface ChangedRow {
  key: string;
  rowid: number;
  value: Buffer;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Returns rows changed since `state`, and the updated state to persist.
 * Read-only against the DB.
 */
export function detectChanges(
  db: Database.Database,
  state: DetectorState,
): { changed: ChangedRow[]; next: DetectorState } {
  const changed: ChangedRow[] = [];

  // 1) New append-only inserts (bubbleId + brand-new composerData) via rowid watermark.
  const inserts = db
    .prepare(
      `SELECT rowid AS rowid, key, value FROM cursorDiskKV
       WHERE rowid > ?
         AND value IS NOT NULL
         AND ( (key >= 'bubbleId:' AND key < 'bubbleId:~')
            OR (key >= 'composerData:' AND key < 'composerData:~') )
       ORDER BY rowid ASC`,
    )
    .all(state.maxRowid) as Array<{ rowid: number; key: string; value: Buffer }>;

  let maxRowid = state.maxRowid;
  const composerHashes = { ...state.composerHashes };

  for (const r of inserts) {
    changed.push({ key: r.key, rowid: r.rowid, value: r.value });
    if (r.rowid > maxRowid) maxRowid = r.rowid;
    if (r.key.startsWith("composerData:")) composerHashes[r.key] = sha256(r.value);
  }

  // 2) In-place updates to existing composerData rows (small namespace, full rescan + hash diff).
  const composers = db
    .prepare(
      `SELECT rowid AS rowid, key, value FROM cursorDiskKV
       WHERE key >= 'composerData:' AND key < 'composerData:~' AND value IS NOT NULL`,
    )
    .all() as Array<{ rowid: number; key: string; value: Buffer }>;

  const seen = new Set(changed.map((c) => c.key));
  for (const r of composers) {
    if (seen.has(r.key)) continue; // already emitted as an insert this cycle
    const h = sha256(r.value);
    if (composerHashes[r.key] !== h) {
      changed.push({ key: r.key, rowid: r.rowid, value: r.value });
      composerHashes[r.key] = h;
    }
  }

  return { changed, next: { maxRowid, composerHashes } };
}
