import type * as vscode from "vscode";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import {
  openReadonly,
  defaultGlobalDbPath,
  SOURCES,
  tableForSource,
  buildComposerInfo,
  repoForKey,
  composerMeta,
  composerDetail,
  folderForComposer,
  repoIdForPath,
  PushCache,
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
  repoEnabled,
  isConversationKey,
  NO_REPO_KEY,
  type KvRecord,
  type SyncPolicy,
} from "@cursorsync/sync-engine";
import type { Transport } from "./transport.js";

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

/** One conversation in the repo-details pop-out. */
export interface ConvRow {
  name: string;
  created: number | null;
  msgs: number;
  /** The project folder this conversation came from, if any. */
  folder: string | null;
  /** Whether that folder still exists on disk (false = it lives only in Cursor's global DB now). */
  folderExists: boolean;
  /** Location hints (for "no repo" chats); empty for chats that have a folder. */
  hints: string[];
}

/** Everything the details pop-out shows for one repo. */
export interface RepoDetails {
  /** The global Cursor DB that physically stores every conversation. */
  dbPath: string;
  folders: string[];
  conversations: ConvRow[];
  truncated: boolean;
}

const DETAILS_CONV_CAP = 400;

/**
 * Orchestrates sync between Cursor's local state.vscdb and the Supabase hub.
 *
 * Up: detect changed rows (per-source rowid watermark) → tag with repo → push. In "repo" scope,
 * only the current repo's conversation rows are pushed.
 * Down: decode records → upsert into the live state.vscdb (atomic transaction; REPLACE semantics).
 * Cursor surfaces newly-written chats after a restart.
 */
export class SyncBridge {
  /** composerId→{repo,time} maps cached and invalidated by the composerData max rowid. */
  private composerInfoCache?: {
    maxRowid: number;
    info: { repo: Map<string, string>; time: Map<string, number> };
  };
  /** id→content-hash of what we've already uploaded, so unchanged rows aren't re-pushed. */
  private pushCacheInstance?: PushCache;

  constructor(
    private ctx: vscode.ExtensionContext,
    private transport: Transport,
    private deviceId: string,
  ) {}

  private pushCache(): PushCache {
    if (!this.pushCacheInstance) {
      const dir = this.ctx.globalStorageUri.fsPath;
      mkdirSync(dir, { recursive: true });
      this.pushCacheInstance = new PushCache(join(dir, "push-cache.db"));
    }
    return this.pushCacheInstance;
  }

  /** Close the push cache DB; call on extension deactivate. */
  dispose(): void {
    this.pushCacheInstance?.close();
    this.pushCacheInstance = undefined;
  }

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
   * composerId→{repo,time} maps, rebuilt only when conversations changed. composerData rows REPLACE
   * on edit (bumping rowid), so MAX(rowid) over that namespace is a cheap, correct cache key —
   * avoids rescanning ~180 MB of composers on every sync tick.
   */
  private getComposerInfo(db: ReturnType<typeof openReadonly>): {
    repo: Map<string, string>;
    time: Map<string, number>;
  } {
    const row = db
      .prepare(
        "SELECT MAX(rowid) AS m FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData:~'",
      )
      .get() as { m: number | null };
    const maxRowid = row.m ?? 0;
    if (this.composerInfoCache?.maxRowid === maxRowid) return this.composerInfoCache.info;
    const info = buildComposerInfo(db);
    this.composerInfoCache = { maxRowid, info };
    return info;
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
   *
   * `prefs` is the per-repo allowlist: a conversation row only uploads if its repo is enabled.
   * Non-conversation namespaces (agent traces, snapshots, UI) are governed solely by `policy`.
   */
  async upSync(
    ownerId: string,
    prefs: Map<string, boolean>,
    policy: SyncPolicy,
    windowDays: number,
    maxRows = Infinity,
    onBatch?: () => void,
  ): Promise<UpResult> {
    const db = openReadonly();
    const cache = this.pushCache();
    const cutoff = windowDays > 0 ? Date.now() - windowDays * 86_400_000 : 0;
    try {
      const info = this.getComposerInfo(db);
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
          const marks: Array<{ id: string; hash: string }> = [];
          for (const r of rows) {
            since = r.rowid;
            scanned++;
            if (!shouldSyncRow(source, r.key, policy)) continue; // namespace include/exclude
            if (
              r.key.startsWith("composerData:") &&
              composerMeta(r.value ?? null).messageCount === 0
            )
              continue; // skip empty "new chat" stubs
            const repo = repoForKey(r.key, info.repo);
            if (isConversationKey(r.key)) {
              if (cutoff > 0) {
                const t = info.time.get(r.key.split(":")[1] ?? "");
                if (t !== undefined && t < cutoff) continue; // older than the rolling window
              }
              if (!repoEnabled(repo, prefs)) continue; // disabled repo
            }
            const id = `${ownerId}:${source}:${r.key}`;
            const bytes =
              r.value === null
                ? null
                : typeof r.value === "string"
                  ? Buffer.from(r.value, "utf8")
                  : r.value;
            const hash = bytes === null ? "∅" : sha256Hex(bytes);
            if (cache.unchanged(id, hash)) continue; // content already uploaded — skip re-push
            records.push(await this.encodeForUp(source, r.key, r.value ?? null, ownerId, repo));
            marks.push({ id, hash });
          }
          if (records.length) {
            pushed += await this.transport.push(records);
            cache.mark(marks); // only after a successful push
          }

          // Persist progress per batch — resumable, and frees the batch from memory.
          state = { rowids: { ...state.rowids, [source]: since } };
          await this.setWatermark(state);
          onBatch?.(); // heartbeat (e.g. refresh the cross-window sync lease)
          if (rows.length < UP_BATCH) break;
        }
      }
      return { pushed, scanned };
    } finally {
      db.close();
    }
  }

  /**
   * The repos this machine has chatted in, from one scan of local conversations: a conversation
   * count per repo (NO_REPO_KEY for those with no git repo) and a representative local folder path
   * per repo (for "reveal in Finder"). Remote resolution is cached per folder, so this is cheap.
   */
  localRepos(): { counts: Map<string, number>; folders: Map<string, Set<string>> } {
    const db = openReadonly();
    try {
      const counts = new Map<string, number>();
      const folders = new Map<string, Set<string>>();
      const stmt = db.prepare(
        "SELECT value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData:~' AND value IS NOT NULL",
      );
      for (const r of stmt.iterate() as IterableIterator<{ value: Buffer | string }>) {
        const meta = composerMeta(r.value);
        if (meta.messageCount === 0) continue; // skip empty "new chat" stubs
        const folder = folderForComposer(meta);
        const repo = folder ? repoIdForPath(folder) : NO_REPO_KEY;
        counts.set(repo, (counts.get(repo) ?? 0) + 1);
        if (folder) {
          let set = folders.get(repo);
          if (!set) {
            set = new Set();
            folders.set(repo, set);
          }
          set.add(folder);
        }
      }
      return { counts, folders };
    } finally {
      db.close();
    }
  }

  /**
   * Full detail for one repo (or the NO_REPO_KEY bucket): every local folder copy it lives in, and
   * its conversations (title, date, size, and — for folderless chats — location hints to track them
   * down). On-demand for the details pop-out; conversations are capped to stay bounded.
   */
  repoDetails(repoId: string): RepoDetails {
    const db = openReadonly();
    const existsCache = new Map<string, boolean>();
    const onDisk = (p: string): boolean => {
      let e = existsCache.get(p);
      if (e === undefined) {
        e = existsSync(p);
        existsCache.set(p, e);
      }
      return e;
    };
    try {
      const folders = new Set<string>();
      const conversations: ConvRow[] = [];
      const stmt = db.prepare(
        "SELECT value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData:~' AND value IS NOT NULL",
      );
      for (const r of stmt.iterate() as IterableIterator<{ value: Buffer | string }>) {
        const d = composerDetail(r.value);
        if (d.messageCount === 0) continue;
        const id = d.folder ? repoIdForPath(d.folder) : NO_REPO_KEY;
        if (id !== repoId) continue;
        if (d.folder) folders.add(d.folder);
        conversations.push({
          name: d.name,
          created: d.createdAt,
          msgs: d.messageCount,
          folder: d.folder,
          folderExists: d.folder ? onDisk(d.folder) : false,
          hints: d.folder ? [] : d.contextHints,
        });
      }
      conversations.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
      return {
        dbPath: defaultGlobalDbPath(),
        folders: [...folders],
        conversations: conversations.slice(0, DETAILS_CONV_CAP),
        truncated: conversations.length > DETAILS_CONV_CAP,
      };
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

  /**
   * Pull the user's rows and apply them locally, STREAMING page by page. Conversation rows for a
   * disabled repo are skipped so an excluded repo never lands on this machine, even if it was
   * synced before being excluded.
   */
  async pullAndApply(prefs: Map<string, boolean>): Promise<number> {
    let total = 0;
    for await (const page of this.transport.pullPages()) {
      const allowed = page.filter((r) => !isConversationKey(r.ckey) || repoEnabled(r.repo, prefs));
      total += await this.applyRecords(allowed);
    }
    return total;
  }
}
