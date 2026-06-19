/**
 * Read-only footprint probe. Prints row counts and byte sizes per namespace.
 * Reproduces the manual measurement used to design the sync schema.
 *
 *   pnpm --filter @cursorsync/examples probe [path-to-state.vscdb]
 */
import { openReadonly, defaultGlobalDbPath } from "@cursorsync/cursor-store";

const dbPath = process.argv[2] ?? defaultGlobalDbPath();
const db = openReadonly(dbPath);

const prefixes = ["bubbleId", "composerData", "agentKv", "checkpointId", "ofsContent"];
console.log(`Probing ${dbPath}\n`);
for (const p of prefixes) {
  const row = db
    .prepare(
      `SELECT count(*) AS rows, COALESCE(sum(length(value)),0) AS bytes
       FROM cursorDiskKV WHERE key >= ? AND key < ?`,
    )
    .get(`${p}:`, `${p}:~`) as { rows: number; bytes: number };
  const mb = (row.bytes / 1048576).toFixed(1);
  console.log(`${p.padEnd(14)} rows=${String(row.rows).padEnd(8)} ${mb} MB`);
}
db.close();
