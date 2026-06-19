import Database from "better-sqlite3";
import { appendFileSync, copyFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** The prior value of a key that a write overwrote — enough to reverse the change. */
export interface UndoEntry {
  source: Source;
  key: string;
  /** Prior raw bytes, base64-encoded; null if the key did not previously exist. */
  valueB64: string | null;
}

export interface ApplyOptions {
  /** Full-DB copy before writing. Default false — prefer the lightweight undo journal. */
  backup?: boolean;
  /** Allow writing the user's LIVE global Cursor DB (see below). Default false. */
  allowLiveGlobalDb?: boolean;
  /** Capture prior values of overwritten-and-changed keys so the write is reversible. Default false. */
  captureUndo?: boolean;
}

export interface ApplyResult {
  written: number;
  backupPath?: string;
  undo: UndoEntry[];
}

function isDefaultGlobalDb(dbPath: string): boolean {
  return resolve(dbPath) === resolve(defaultGlobalDbPath());
}

function toBytes(value: Buffer | string): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function priorBytes(value: Buffer | string | null | undefined): Buffer | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

/** Copy `dbPath` to a timestamped sibling backup and return the backup path. */
export function backupDb(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.cursorsync-backup-${stamp}`;
  copyFileSync(dbPath, backupPath);
  return backupPath;
}

/**
 * Append undo entries to a size-capped, append-only journal so an over-write is recoverable without
 * ever copying the whole 27 GB database. Rotates to `<file>.1` once `capBytes` is exceeded.
 */
export function appendUndoJournal(filePath: string, entries: UndoEntry[], capBytes: number): void {
  if (entries.length === 0) return;
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    size = 0;
  }
  if (size > capBytes) renameSync(filePath, `${filePath}.1`); // keep exactly one rotation
  appendFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Default undo-journal location, alongside the user's full backups. */
export function defaultUndoJournalPath(): string {
  return join(process.env.HOME ?? ".", "cursorsync-backups", "undo.jsonl");
}

/**
 * Upsert rows into a Cursor `state.vscdb`. The tables are `key TEXT UNIQUE ON CONFLICT REPLACE`, so a
 * plain INSERT replaces an existing key — the conflict-free union merge cursorsync relies on. All
 * writes run in one transaction. With `captureUndo`, prior values of changed keys are returned so the
 * caller can journal them cheaply. Refuses the live global DB unless `allowLiveGlobalDb` is set.
 */
export function applyRows(
  dbPath: string,
  rows: Iterable<WriteRow>,
  opts: ApplyOptions = {},
): ApplyResult {
  const { backup = false, allowLiveGlobalDb = false, captureUndo = false } = opts;

  if (isDefaultGlobalDb(dbPath) && !allowLiveGlobalDb) {
    throw new Error(
      "Refusing to write to the live Cursor global DB. Pass { allowLiveGlobalDb: true } to opt in.",
    );
  }

  const backupPath = backup ? backupDb(dbPath) : undefined;
  const undo: UndoEntry[] = [];
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const inserts = new Map<string, Database.Statement>();
    const selects = new Map<string, Database.Statement>();
    const stmtFor = (
      table: string,
      cache: Map<string, Database.Statement>,
      sql: (t: string) => string,
    ): Database.Statement => {
      const existing = cache.get(table);
      if (existing) return existing;
      const created = db.prepare(sql(table));
      cache.set(table, created);
      return created;
    };

    const tx = db.transaction((items: WriteRow[]): number => {
      let n = 0;
      for (const r of items) {
        const source = r.source ?? "global:cursorDiskKV";
        const table = tableForSource(source);
        const value = toBytes(r.value);
        if (captureUndo) {
          const sel = stmtFor(table, selects, (t) => `SELECT value FROM "${t}" WHERE key = ?`);
          const prior = priorBytes(
            (sel.get(r.key) as { value?: Buffer | string | null } | undefined)?.value,
          );
          if (prior === null || !prior.equals(value)) {
            undo.push({
              source,
              key: r.key,
              valueB64: prior === null ? null : prior.toString("base64"),
            });
          }
        }
        const ins = stmtFor(table, inserts, (t) => `INSERT INTO "${t}" (key, value) VALUES (?, ?)`);
        ins.run(r.key, value);
        n++;
      }
      return n;
    });
    const written = tx([...rows]);
    return { written, backupPath, undo };
  } finally {
    db.close();
  }
}
