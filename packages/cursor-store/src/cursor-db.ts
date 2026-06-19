import Database from "better-sqlite3";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

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
 * Consistent online backup of the live DB to `destPath` (safe while Cursor is running).
 * Uses SQLite's backup API, so the result is a clean, restorable single-file snapshot.
 */
export async function backupDatabase(
  destPath: string,
  srcPath = defaultGlobalDbPath(),
): Promise<void> {
  const db = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destPath);
  } finally {
    db.close();
  }
}
