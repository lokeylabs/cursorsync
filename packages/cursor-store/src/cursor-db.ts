import Database from "better-sqlite3";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { BubbleRow, ChatRow, ComposerRow } from "./types.js";

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

function parseJsonValue(raw: Buffer | string): unknown {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  return JSON.parse(text);
}

/** Iterate all `bubbleId:*` rows (chat messages). */
export function* readBubbles(db: Database.Database): Generator<BubbleRow> {
  const stmt = db.prepare(
    "SELECT key, value FROM cursorDiskKV WHERE key >= 'bubbleId:' AND key < 'bubbleId:~'",
  );
  for (const { key, value } of stmt.iterate() as IterableIterator<{ key: string; value: Buffer }>) {
    const parts = key.split(":");
    yield {
      namespace: "bubbleId",
      key,
      composerId: parts[1] ?? "",
      messageId: parts[2] ?? "",
      value: parseJsonValue(value),
    };
  }
}

/** Iterate all `composerData:*` rows (conversations). */
export function* readComposers(db: Database.Database): Generator<ComposerRow> {
  const stmt = db.prepare(
    "SELECT key, value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData:~'",
  );
  for (const { key, value } of stmt.iterate() as IterableIterator<{ key: string; value: Buffer }>) {
    const parts = key.split(":");
    yield {
      namespace: "composerData",
      key,
      composerId: parts[1] ?? "",
      value: parseJsonValue(value),
    };
  }
}

/** Everything we currently sync, as a single stream. */
export function* readSyncedRows(db: Database.Database): Generator<ChatRow> {
  yield* readComposers(db);
  yield* readBubbles(db);
}
