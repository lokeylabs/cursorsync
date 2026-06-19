/**
 * Validates change detection + transform against the real Cursor DB, cheaply.
 * Simulates a watermark just below the current max rowid, then shows detectChanges()
 * returns only the recent delta (not all 800k rows).
 *
 *   npx tsx src/demo-delta.ts
 */
import { openReadonly, defaultGlobalDbPath } from "./cursor-db.js";
import { detectChanges, type DetectorState } from "./change-detector.js";
import { toKvRecord } from "./transform.js";

const db = openReadonly(process.argv[2] ?? defaultGlobalDbPath());

const { maxRowid } = db
  .prepare("SELECT MAX(rowid) AS maxRowid FROM cursorDiskKV")
  .get() as { maxRowid: number };

// Pretend we've synced everything except roughly the last 200 rowids.
const state: DetectorState = { maxRowid: Math.max(0, maxRowid - 200), composerHashes: {} };
console.log(`DB max rowid = ${maxRowid}; simulating watermark at ${state.maxRowid}\n`);

const t0 = Date.now();
const { changed, next } = detectChanges(db, state);
const ms = Date.now() - t0;

const records = changed.map(toKvRecord).filter(Boolean);
const byNs = records.reduce<Record<string, number>>((a, r) => {
  a[r!.namespace] = (a[r!.namespace] ?? 0) + 1;
  return a;
}, {});

console.log(`detectChanges() found ${changed.length} changed rows in ${ms} ms`);
console.log(`transformed -> ${records.length} records by namespace:`, byNs);
console.log(`new watermark: maxRowid=${next.maxRowid}, composerHashes tracked=${Object.keys(next.composerHashes).length}`);
console.log(`\nsample keys:`);
for (const c of changed.slice(0, 5)) console.log("  " + c.key);
db.close();
