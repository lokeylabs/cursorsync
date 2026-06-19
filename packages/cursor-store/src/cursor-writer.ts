import Database from "better-sqlite3";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultGlobalDbPath } from "./cursor-db.js";
import { tableForSource, type Source } from "./types.js";

/** A row to write back into one of Cursor's tables. */
export interface WriteRow {
  /** Which table to write. Defaults to global:cursorDiskKV when omitted. */
  source?: Source;
  key: string;
  /** Raw value bytes. Strings are encoded as UTF-8 (JSON namespaces are stored as text). */
  value: Buffer | string;
}

export interface ApplyOptions {
  /** Copy the DB before writing. Default true. */
  backup?: boolean;
  /**
   * Allow writing to the user's LIVE global Cursor DB. Default false.
   * cursorsync refuses this by default: Cursor caches chat state in memory and writing the live DB
   * while Cursor is running is unsafe. Always test against a copy first.
   */
  allowLiveGlobalDb?: boolean;
}

export interface ApplyResult {
  written: number;
  backupPath?: string;
}

function isDefaultGlobalDb(dbPath: string): boolean {
  return resolve(dbPath) === resolve(defaultGlobalDbPath());
}

/** Copy `dbPath` to a timestamped sibling backup and return the backup path. */
export function backupDb(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.cursorsync-backup-${stamp}`;
  copyFileSync(dbPath, backupPath);
  return backupPath;
}

/**
 * Upsert rows into a Cursor `state.vscdb`'s `cursorDiskKV` table.
 *
 * The table is declared `key TEXT UNIQUE ON CONFLICT REPLACE`, so a plain INSERT replaces an
 * existing key — the same conflict-free union-merge semantics cursorsync relies on. All writes run
 * in a single transaction; the DB is backed up first by default.
 *
 * Refuses the live global DB unless `allowLiveGlobalDb` is set (see ApplyOptions).
 */
export function applyRows(
  dbPath: string,
  rows: Iterable<WriteRow>,
  opts: ApplyOptions = {},
): ApplyResult {
  const { backup = true, allowLiveGlobalDb = false } = opts;

  if (isDefaultGlobalDb(dbPath) && !allowLiveGlobalDb) {
    throw new Error(
      "Refusing to write to the live Cursor global DB. Test against a copy, or pass " +
        "{ allowLiveGlobalDb: true } once Cursor is closed.",
    );
  }

  const backupPath = backup ? backupDb(dbPath) : undefined;

  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    // One prepared INSERT per table; ON CONFLICT REPLACE is baked into the schema.
    const stmts: Partial<Record<string, Database.Statement>> = {};
    const stmtFor = (source: Source) => {
      const table = tableForSource(source);
      return (stmts[table] ??= db.prepare(`INSERT INTO "${table}" (key, value) VALUES (?, ?)`));
    };
    const tx = db.transaction((items: WriteRow[]) => {
      let n = 0;
      for (const r of items) {
        const value = typeof r.value === "string" ? Buffer.from(r.value, "utf8") : r.value;
        stmtFor(r.source ?? "global:cursorDiskKV").run(r.key, value);
        n++;
      }
      return n;
    });
    const written = tx([...rows]);
    return { written, backupPath };
  } finally {
    db.close();
  }
}
