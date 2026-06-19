import type * as vscode from "vscode";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import {
  openReadonly,
  defaultGlobalDbPath,
  SOURCES,
  tableForSource,
  buildComposerRepoMap,
  repoForKey,
  applyRows,
  appendUndoJournal,
  defaultUndoJournalPath,
  backupDatabase,
  emptyState,
  type DetectorState,
  type WriteRow,
  type Source,
} from "@cursorsync/cursor-store";
import { isUtf8 } from "node:buffer";
import {
  toKvRecord,
  fromKvRecord,
  blobRecord,
  writeRowOf,
  shouldSyncRow,
  shouldOffload,
  sha256Hex,
  type KvRecord,
  type SyncPolicy,
} from "@cursorsync/sync-engine";
import type { Transport } from "./transport.js";
import type { SyncScope } from "./config.js";

const WATERMARK_KEY = "cursorsync.watermark";
const BACKUP_DIR = join(homedir(), "cursorsync-backups");
const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // explicit full backups at most weekly
const BACKUP_KEEP = 2;
// Stream the up-sync in small batches so we never hold the whole DB in memory.
const UP_BATCH = 400;
// Cap the down-sync undo journal so safety never costs unbounded disk.
const UNDO_CAP_BYTES = 64 * 1024 * 1024;
// Download at most this many offloaded blobs into memory at once during down-sync.
const DOWN_BLOB_CHUNK = 32;

export interface UpResult {
  pushed: number;
  scanned: number;
}

/**
 * Orchestrates sync between Cursor's local state.vscdb and the Supabase hub.
 *
 * Up: detect changed rows (per-source rowid watermark) → tag with repo → push. In "repo" scope,
 * only the current repo's conversation rows are pushed.
 * Down: decode records → upsert into the live state.vscdb (atomic transaction; REPLACE semantics).
 * Cursor surfaces newly-written chats after a restart.
 */
export class SyncBridge {
  /** composerId→repo map cached and invalidated by the composerData max rowid (cheap to check). */
  private composerRepoCache?: { maxRowid: number; map: Map<string, string> };

  constructor(
    private ctx: vscode.ExtensionContext,
    private transport: Transport,
    private deviceId: string,
  ) {}

  /**
   * Create a full consistent snapshot of the live DB in ~/cursorsync-backups (the explicit
   * "Back up now" command). Skips if `force` is false and a backup younger than BACKUP_MAX_AGE_MS
   * exists. Keeps the newest BACKUP_KEEP and prunes older ones. Routine down-sync safety is the
   * undo journal, not this — a 27 GB copy is far too heavy for the write path.
   */
  async ensureBackup(force = false): Promise<string | undefined> {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const existing = readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".bak"))
      .map((f) => ({ f, t: statSync(join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const fresh = existing[0] !== undefined && Date.now() - existing[0].t < BACKUP_MAX_AGE_MS;
    if ((!force && fresh) || !existsSync(defaultGlobalDbPath())) return undefined;

    const dest = join(
      BACKUP_DIR,
      `state.vscdb.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`,
    );
    await backupDatabase(dest);
    for (const old of existing.slice(BACKUP_KEEP - 1)) {
      try {
        unlinkSync(join(BACKUP_DIR, old.f));
      } catch {
        /* best-effort prune */
      }
    }
    return dest;
  }

  private getWatermark(): DetectorState {
    return this.ctx.globalState.get<DetectorState>(WATERMARK_KEY) ?? emptyState();
  }
  private async setWatermark(s: DetectorState): Promise<void> {
    await this.ctx.globalState.update(WATERMARK_KEY, s);
  }

  /**
   * composerId→repo map, rebuilt only when conversations changed. composerData rows REPLACE on edit
   * (bumping rowid), so MAX(rowid) over that namespace is a cheap, correct cache key — avoids
   * rescanning ~160 MB of composers on every background sync tick.
   */
  private getComposerRepoMap(db: ReturnType<typeof openReadonly>): Map<string, string> {
    const row = db
      .prepare(
        "SELECT MAX(rowid) AS m FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData:~'",
      )
      .get() as { m: number | null };
    const maxRowid = row.m ?? 0;
    if (this.composerRepoCache?.maxRowid === maxRowid) return this.composerRepoCache.map;
    const map = buildComposerRepoMap(db);
    this.composerRepoCache = { maxRowid, map };
    return map;
  }

  /**
   * Encode one local row for up-sync. Large or binary values are uploaded to object storage
   * (content-addressed, deduped) and represented by a pointer record; everything else inlines.
   * One blob is held in memory at a time.
   */
  private async encodeForUp(
    source: Source,
    key: string,
    raw: Buffer | string | null,
    ownerId: string,
    repo: string | null,
  ): Promise<KvRecord> {
    const bytes = raw === null ? null : typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    if (bytes !== null && shouldOffload(key, bytes.length)) {
      const sha = sha256Hex(bytes);
      await this.transport.uploadBlob(ownerId, sha, bytes);
      return blobRecord({ source, key }, ownerId, this.deviceId, repo, sha, !isUtf8(bytes));
    }
    return toKvRecord({ source, key, rowid: 0, value: raw }, ownerId, this.deviceId, repo);
  }

  /**
   * Push changed local rows to the cloud, STREAMING in small batches so memory stays bounded even
   * for a 27 GB database. The per-source rowid watermark is persisted after each pushed batch, so a
   * large first sync is resumable and later syncs only push new rows. `maxRows` caps a single run
   * (e.g. background auto-sync) so it never runs away.
   */
  async upSync(
    ownerId: string,
    scope: SyncScope,
    currentRepo: string | null,
    policy: SyncPolicy,
    maxRows = Infinity,
  ): Promise<UpResult> {
    const db = openReadonly();
    try {
      const composerRepo =
        scope === "repo" ? this.getComposerRepoMap(db) : new Map<string, string>();
      let state = this.getWatermark();
      let pushed = 0;
      let scanned = 0;

      for (const source of SOURCES) {
        const table = tableForSource(source);
        const stmt = db.prepare(
          `SELECT rowid AS rowid, key, value FROM "${table}" WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
        );
        let since = state.rowids[source] ?? 0;
        for (;;) {
          if (scanned >= maxRows) return { pushed, scanned };
          const rows = stmt.all(since, UP_BATCH) as Array<{
            rowid: number;
            key: string;
            value: Buffer | string | null;
          }>;
          if (rows.length === 0) break;

          const records: KvRecord[] = [];
          for (const r of rows) {
            since = r.rowid;
            scanned++;
            if (!shouldSyncRow(source, r.key, policy)) continue; // namespace include/exclude
            const repo = repoForKey(r.key, composerRepo);
            if (scope === "repo" && repo !== currentRepo) continue; // isolate to this repo
            records.push(await this.encodeForUp(source, r.key, r.value ?? null, ownerId, repo));
          }
          if (records.length) pushed += await this.transport.push(records);

          // Persist progress per batch — resumable, and frees the batch from memory.
          state = { rowids: { ...state.rowids, [source]: since } };
          await this.setWatermark(state);
          if (rows.length < UP_BATCH) break;
        }
      }
      return { pushed, scanned };
    } finally {
      db.close();
    }
  }

  /** Reset the watermark so the next upSync re-scans and pushes everything. */
  async resetWatermark(): Promise<void> {
    await this.setWatermark(emptyState());
  }

  /** Write WriteRows into the live Cursor DB atomically, journaling any over-writes for undo. */
  private writeRows(rows: WriteRow[]): number {
    if (rows.length === 0) return 0;
    const { written, undo } = applyRows(defaultGlobalDbPath(), rows, {
      allowLiveGlobalDb: true,
      captureUndo: true,
    });
    appendUndoJournal(defaultUndoJournalPath(), undo, UNDO_CAP_BYTES);
    return written;
  }

  /**
   * Apply records to the live Cursor DB. Inline records write in one transaction; offloaded records
   * (blob_sha set) download their bytes in bounded chunks so memory stays flat regardless of blob
   * size. Safety is the lightweight undo journal — never a full-DB copy.
   */
  async applyRecords(
    records: Array<
      Pick<KvRecord, "source" | "ckey" | "is_binary" | "value" | "blob_sha" | "owner_id">
    >,
  ): Promise<number> {
    let written = this.writeRows(records.filter((r) => r.blob_sha === null).map(fromKvRecord));

    const offloaded = records.filter((r) => r.blob_sha !== null);
    for (let i = 0; i < offloaded.length; i += DOWN_BLOB_CHUNK) {
      const chunk = offloaded.slice(i, i + DOWN_BLOB_CHUNK);
      const rows: WriteRow[] = [];
      for (const rec of chunk) {
        if (rec.blob_sha === null) continue; // narrowed; defensive
        const bytes = await this.transport.downloadBlob(rec.owner_id, rec.blob_sha);
        rows.push(writeRowOf(rec, bytes));
      }
      written += this.writeRows(rows);
    }
    return written;
  }

  /** Pull the user's rows (optionally one repo) and apply them locally, STREAMING page by page. */
  async pullAndApply(scope: SyncScope, currentRepo: string | null): Promise<number> {
    let total = 0;
    for await (const page of this.transport.pullPages(scope === "repo" ? currentRepo : undefined)) {
      total += await this.applyRecords(page);
    }
    return total;
  }
}
