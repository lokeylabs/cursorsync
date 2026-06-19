/**
 * Validates full-namespace change detection + transform against the real Cursor DB, cheaply.
 * Simulates a per-source watermark just below the current max rowid, then shows detectChanges()
 * returns only the recent delta across ALL of Cursor's state (not all ~1.6M rows).
 *
 *   pnpm --filter @cursorsync/examples demo:delta
 */
import {
  openReadonly,
  defaultGlobalDbPath,
  detectChanges,
  type DetectorState,
} from "@cursorsync/cursor-store";
import { toKvRecord } from "@cursorsync/sync-engine";

const OWNER = "00000000-0000-0000-0000-000000000001";
const db = openReadonly(process.argv[2] ?? defaultGlobalDbPath());

const kv = db.prepare("SELECT MAX(rowid) AS m FROM cursorDiskKV").get() as { m: number };
const it = db.prepare("SELECT MAX(rowid) AS m FROM ItemTable").get() as { m: number };

// Pretend we've synced everything except the last ~200 rows of each table.
const state: DetectorState = {
  rowids: {
    "global:cursorDiskKV": Math.max(0, kv.m - 200),
    "global:ItemTable": Math.max(0, it.m - 50),
  },
};
console.log(
  `watermarks: cursorDiskKV=${state.rowids["global:cursorDiskKV"]}, ItemTable=${state.rowids["global:ItemTable"]}\n`,
);

const t0 = Date.now();
const { changed, next } = detectChanges(db, state);
const ms = Date.now() - t0;

const records = changed.map((r) => toKvRecord(r, OWNER, "mac-pro"));
const bySource = records.reduce<Record<string, number>>((a, r) => {
  a[r.source] = (a[r.source] ?? 0) + 1;
  return a;
}, {});
const binary = records.filter((r) => r.is_binary).length;

console.log(`detectChanges() found ${changed.length} changed rows in ${ms} ms`);
console.log(`by source:`, bySource, `| binary(base64): ${binary}`);
console.log(`new watermarks:`, next.rowids);
console.log(`\nsample keys:`);
for (const c of changed.slice(0, 5)) console.log(`  [${c.source}] ${c.key}`);
db.close();
