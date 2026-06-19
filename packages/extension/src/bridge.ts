import type * as vscode from "vscode";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import {
  openReadonly,
  defaultGlobalDbPath,
  detectChanges,
  buildComposerRepoMap,
  repoForKey,
  applyRows,
  backupDatabase,
  emptyState,
  type DetectorState,
  type WriteRow,
} from "@cursorsync/cursor-store";
import { toKvRecord, fromKvRecord, type KvRecord } from "@cursorsync/sync-engine";
import type { Transport } from "./transport.js";
import type { SyncScope } from "./config.js";

const WATERMARK_KEY = "cursorsync.watermark";
const BACKUP_DIR = join(homedir(), "cursorsync-backups");
const BACKUP_MAX_AGE_MS = 12 * 60 * 60 * 1000; // back up at most every 12h
const BACKUP_KEEP = 3;

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
  private backedUpThisSession = false;

  constructor(
    private ctx: vscode.ExtensionContext,
    private transport: Transport,
    private deviceId: string,
  ) {}

  /**
   * Guarantee a recent backup before any write to the live DB. Creates a consistent snapshot in
   * ~/cursorsync-backups (at most once per 12h), keeps the newest few, prunes the rest.
   * Returns the backup path if one was created. "Never lose a chat" is enforced here.
   */
  async ensureBackup(force = false): Promise<string | undefined> {
    if (this.backedUpThisSession && !force) return undefined;
    mkdirSync(BACKUP_DIR, { recursive: true });
    const existing = readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".bak"))
      .map((f) => ({ f, t: statSync(join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const fresh = existing[0] && Date.now() - existing[0].t < BACKUP_MAX_AGE_MS;
    let created: string | undefined;
    if (force || !fresh) {
      const dest = join(
        BACKUP_DIR,
        `state.vscdb.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`,
      );
      if (existsSync(defaultGlobalDbPath())) {
        await backupDatabase(dest);
        created = dest;
      }
      for (const old of existing.slice(BACKUP_KEEP - 1)) {
        try {
          unlinkSync(join(BACKUP_DIR, old.f));
        } catch {
          /* ignore */
        }
      }
    }
    this.backedUpThisSession = true;
    return created;
  }

  private getWatermark(): DetectorState {
    return this.ctx.globalState.get<DetectorState>(WATERMARK_KEY) ?? emptyState();
  }
  private async setWatermark(s: DetectorState): Promise<void> {
    await this.ctx.globalState.update(WATERMARK_KEY, s);
  }

  /** Push changed local rows to the cloud. */
  async upSync(ownerId: string, scope: SyncScope, currentRepo: string | null): Promise<UpResult> {
    const db = openReadonly();
    try {
      const { changed, next } = detectChanges(db, this.getWatermark());
      const composerRepo = scope === "repo" ? buildComposerRepoMap(db) : new Map<string, string>();

      const records: KvRecord[] = [];
      for (const row of changed) {
        const repo = repoForKey(row.key, composerRepo);
        if (scope === "repo" && repo !== currentRepo) continue; // isolate to this repo
        records.push(toKvRecord(row, ownerId, this.deviceId, repo));
      }

      const pushed = await this.transport.push(records);
      await this.setWatermark(next); // only advance after a successful push
      return { pushed, scanned: changed.length };
    } finally {
      db.close();
    }
  }

  /** Reset the watermark so the next upSync re-scans and pushes everything. */
  async resetWatermark(): Promise<void> {
    await this.setWatermark(emptyState());
  }

  /** Write decoded records into the live Cursor DB (one atomic transaction). Backs up first. */
  async applyRecords(
    records: Array<Pick<KvRecord, "source" | "ckey" | "is_binary" | "value">>,
  ): Promise<number> {
    await this.ensureBackup(); // never write the live DB without a recent safety backup
    const rows: WriteRow[] = records.map(fromKvRecord);
    const { written } = applyRows(defaultGlobalDbPath(), rows, {
      backup: false, // per-write 27GB copies are ruinous; ensureBackup() covers safety
      allowLiveGlobalDb: true,
    });
    return written;
  }

  /** Pull all of the user's rows (optionally one repo) and apply them locally. */
  async pullAndApply(scope: SyncScope, currentRepo: string | null): Promise<number> {
    const records = await this.transport.pullAll(scope === "repo" ? currentRepo : undefined);
    if (records.length === 0) return 0;
    return this.applyRecords(records);
  }
}
