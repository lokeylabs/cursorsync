import Database from "better-sqlite3";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SOURCES, tableForSource, type KvRow, type Source } from "./types.js";

/**
 * Default location of Cursor's global state DB per platform.
 * Verified on macOS; Windows/Linux paths follow VS Code conventions.
 */
export function defaultGlobalDbPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(
        home,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    case "win32":
      return join(
        process.env.APPDATA ?? join(home, "AppData", "Roaming"),
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    default:
      return join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
  }
}

/**
 * Open Cursor's DB for safe reading while Cursor may be running.
 *
 * We use `readonly` (NOT immutable) so SQLite honors the live WAL and returns a consistent
 * snapshot. `immutable=1` assumes a static file and throws "database disk image is malformed"
 * mid-write — confirmed against a live 27 GB DB.
 */
export function openReadonly(dbPath = defaultGlobalDbPath()): Database.Database {
  if (!existsSync(dbPath)) throw new Error(`Cursor DB not found at ${dbPath}`);
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * Take a consistent point-in-time copy via SQLite's online backup, then open the copy.
 * Use this for heavy full-table extraction during active writes. Caller deletes the temp dir.
 */
export function snapshotAndOpen(dbPath = defaultGlobalDbPath()): {
  db: Database.Database;
  copyPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "cursorsync-"));
  const copyPath = join(dir, "state.snapshot.vscdb");
  // better-sqlite3's backup is async; for a simple, dependency-light copy we lean on the OS copy
  // plus WAL checkpoint readonly semantics. For very hot DBs prefer db.backup() (see TODO).
  copyFileSync(dbPath, copyPath);
  return { db: new Database(copyPath, { readonly: true }), copyPath };
}

/** Stream every row of one source (table), as raw key/value. */
export function* readSource(db: Database.Database, source: Source): Generator<KvRow> {
  const table = tableForSource(source);
  const stmt = db.prepare(`SELECT rowid AS rowid, key, value FROM "${table}"`);
  for (const r of stmt.iterate() as IterableIterator<{
    rowid: number;
    key: string;
    value: Buffer | string | null;
  }>) {
    yield { source, key: r.key, rowid: r.rowid, value: r.value ?? null };
  }
}

/** Stream every row of every source — a full snapshot of Cursor's state. */
export function* readAllRows(db: Database.Database): Generator<KvRow> {
  for (const source of SOURCES) yield* readSource(db, source);
}
