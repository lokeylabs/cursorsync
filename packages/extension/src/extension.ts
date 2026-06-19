import * as vscode from "vscode";
import { hostname } from "node:os";
import { writeFileSync, readFileSync, rmSync, mkdirSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { repoIdForPath, defaultGlobalDbPath } from "@cursorsync/cursor-store";
import { AuthManager, type AuthUser } from "./auth.js";
import { Transport } from "./transport.js";
import { SyncBridge } from "./bridge.js";
import { PanelProvider, type PanelState, type RepoEntry } from "./webview.js";
import { RepoDetailsPanel } from "./details-panel.js";
import { getConfig, updateConfig } from "./config.js";
import {
  repoEnabled,
  autoSyncNew,
  DEFAULT_PREF_KEY,
  NO_REPO_KEY,
  type KvRecord,
} from "@cursorsync/sync-engine";

export function activate(ctx: vscode.ExtensionContext) {
  const deviceId = getDeviceId(ctx);
  const auth = new AuthManager(ctx);
  const transport = new Transport(auth.client);
  const bridge = new SyncBridge(ctx, transport, deviceId);

  let user: AuthUser | null = null;
  let realtime: { unsubscribe(): void } | undefined;
  const stats = { pushed: 0, pulled: 0, lastSync: null as string | null };
  const log: string[] = [];
  let status: PanelState["status"] = "idle";
  let statusText = "Ready";
  // Which sync operation is in flight, so only its button spins (the other just disables).
  let busy: PanelState["busy"] = null;
  // Per-repo allowlist (synced via repo_prefs) + merged repo→chat-count for the panel list.
  let prefs = new Map<string, boolean>();
  let repoCounts = new Map<string, number>();
  // Distinct local folder copies per repo (for the row badge + details pop-out).
  let repoFolders = new Map<string, Set<string>>();
  const detailsPanel = new RepoDetailsPanel(ctx.extensionUri);

  // LogOutputChannel — visible via Output → "cursorsync" AND persisted to disk for diagnostics.
  const out = vscode.window.createOutputChannel("cursorsync", { log: true });
  ctx.subscriptions.push(out);
  out.appendLine(`cursorsync activated (device ${deviceId})`);

  const currentRepo = (): string | null => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return folder ? repoIdForPath(folder) : null;
  };
  const addLog = (m: string) => {
    out.appendLine(`[${new Date().toISOString()}] ${m}`);
    log.unshift(`${new Date().toLocaleTimeString()}  ${m}`);
    if (log.length > 30) log.pop();
  };

  const status$ = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status$.command = "cursorsync.focus";
  ctx.subscriptions.push(status$);

  const prettyRepo = (repo: string): string =>
    repo === NO_REPO_KEY ? "Other (no repo)" : repo.split("/").slice(-2).join("/") || repo;

  const buildRepoList = (): RepoEntry[] => {
    const cur = currentRepo();
    return [...repoCounts.entries()]
      .map(
        ([repo, count]): RepoEntry => ({
          repo,
          label: prettyRepo(repo),
          count,
          enabled: repoEnabled(repo === NO_REPO_KEY ? null : repo, prefs),
          isCurrent: repo !== NO_REPO_KEY && repo === cur,
          folderCount: repoFolders.get(repo)?.size ?? 0,
        }),
      )
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.count - a.count);
  };

  const refresh = () => {
    const cfg = getConfig();
    status$.text = user ? "$(sync) Cursor Sync" : "$(sync-ignored) Cursor Sync";
    status$.tooltip = user ? `Cursor Sync: ${statusText}` : "Cursor Sync: sign in";
    status$.show();
    panel.postState({
      user,
      autoSync: cfg.autoSync,
      autoSyncNew: autoSyncNew(prefs),
      windowDays: cfg.syncWindowDays,
      repos: user ? buildRepoList() : [],
      repo: currentRepo(),
      status,
      busy,
      statusText,
      stats,
      log,
    });
  };

  /** Load per-repo prefs + the merged repo list (local + synced) from the backend, then refresh. */
  async function loadRepoState(): Promise<void> {
    if (!user) {
      prefs = new Map();
      repoCounts = new Map();
      return refresh();
    }
    try {
      const [prefRows, backendCounts] = await Promise.all([
        transport.getRepoPrefs(),
        transport.repoCounts(),
      ]);
      prefs = new Map(prefRows.map((p) => [p.repo, p.enabled]));
      const local = bridge.localRepos();
      repoFolders = local.folders;
      const counts = new Map<string, number>();
      for (const [repo, n] of local.counts) counts.set(repo, n);
      for (const { repo, n } of backendCounts) {
        const key = repo ?? NO_REPO_KEY;
        counts.set(key, Math.max(counts.get(key) ?? 0, Number(n)));
      }
      repoCounts = counts;
    } catch (e) {
      out.appendLine(`loadRepoState error: ${(e as Error).message}`);
    }
    refresh();
  }

  const setStatus = (s: PanelState["status"], text: string) => {
    status = s;
    statusText = text;
    if (s !== "syncing") busy = null; // a finished/failed op is no longer the active spinner
    refresh();
  };

  // Cross-window single-flight: Cursor's chat DB is global, but every open window runs its own sync
  // timer. A lease file in the shared globalStorage dir lets only one window sync at a time, so
  // multiple windows (e.g. a repo and its working copy) don't hammer the backend in parallel.
  const lockPath = join(ctx.globalStorageUri.fsPath, "sync.lock");
  const LEASE_TTL_MS = 120_000; // a lease older than this means the holder window died
  const readLease = (): { pid: number; ts: number } | null => {
    try {
      return JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; ts: number };
    } catch {
      return null;
    }
  };
  const claimLease = (): boolean => {
    const l = readLease();
    if (l && (l.pid === process.pid || Date.now() - l.ts >= LEASE_TTL_MS)) {
      try {
        rmSync(lockPath);
      } catch {
        /* stale lease already gone */
      }
    }
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: "wx" });
      return true;
    } catch {
      return false; // another live window holds it
    }
  };
  const refreshLease = (): void => {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    } catch {
      /* best effort */
    }
  };
  const releaseLease = (): void => {
    if (readLease()?.pid === process.pid) {
      try {
        rmSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  };
  ctx.subscriptions.push({ dispose: releaseLease });

  // Background ticks push at most this many rows so they never run away; the manual button is uncapped.
  const BG_CAP = 5000;
  async function doUpSync(opts?: { background?: boolean }) {
    if (!user) {
      if (!opts?.background) vscode.window.showInformationMessage("Cursor Sync: sign in first.");
      return;
    }
    if (status === "syncing") return; // never overlap syncs within this window
    if (!claimLease()) {
      if (!opts?.background)
        addLog("Another Cursor window is syncing — it'll continue automatically.");
      return;
    }
    try {
      busy = "push";
      setStatus("syncing", "Pushing chats…");
      const cfg = getConfig();
      out.appendLine(`upSync start: prefs=${prefs.size} bg=${!!opts?.background}`);
      const r = await bridge.upSync(
        user.id,
        prefs,
        cfg.policy,
        cfg.syncWindowDays,
        opts?.background ? BG_CAP : Infinity,
        refreshLease,
      );
      stats.pushed += r.pushed;
      stats.lastSync = new Date().toLocaleString();
      out.appendLine(`upSync done: scanned=${r.scanned} pushed=${r.pushed}`);
      if (r.pushed > 0 || !opts?.background) addLog(`Pushed ${r.pushed} rows`);
      setStatus("idle", r.pushed ? `Pushed ${r.pushed}` : "Up to date");
      // Refresh the repo list after a manual sync — new repos may now be visible.
      if (!opts?.background) void loadRepoState();
    } catch (e) {
      out.appendLine(`upSync ERROR: ${(e as Error).stack ?? (e as Error).message}`);
      addLog(`Push error: ${(e as Error).message}`);
      setStatus("error", "Push failed");
    } finally {
      releaseLease();
    }
  }

  async function doPull() {
    if (!user) return void vscode.window.showInformationMessage("cursorsync: sign in first.");
    try {
      busy = "pull";
      setStatus("syncing", "Pulling chats…");
      const n = await bridge.pullAndApply(prefs);
      stats.pulled += n;
      stats.lastSync = new Date().toLocaleString();
      addLog(`Pulled ${n} rows`);
      setStatus("idle", `Pulled ${n} — restart Cursor to view`);
      if (n > 0) {
        vscode.window
          .showInformationMessage(
            `cursorsync pulled ${n} chat rows. Restart Cursor to see them.`,
            "Restart",
          )
          .then(
            (c) =>
              c === "Restart" && vscode.commands.executeCommand("workbench.action.reloadWindow"),
          );
      }
    } catch (e) {
      addLog(`Pull error: ${(e as Error).message}`);
      setStatus("error", "Pull failed");
    }
  }

  // Enabling a repo (or auto-sync-new) widens what should sync, so the rows it previously skipped
  // sit below the watermark — reset it and resync to pick them up. Disabling just stops future syncs.
  async function applyPrefChange(repo: string, enabled: boolean): Promise<void> {
    if (!user) return;
    prefs.set(repo, enabled);
    refresh();
    try {
      await transport.setRepoPref(user.id, repo, enabled);
      addLog(
        repo === DEFAULT_PREF_KEY
          ? `Auto-sync new repos ${enabled ? "on" : "off"}`
          : `${enabled ? "Enabled" : "Disabled"} sync for ${prettyRepo(repo)}`,
      );
      if (enabled) {
        await bridge.resetWatermark();
        void doUpSync();
      }
    } catch (e) {
      addLog(`Pref error: ${(e as Error).message}`);
    }
  }

  // Backfill: rewind the watermark and re-scan from zero so every enabled repo's history uploads.
  // Safe and dup-free — matching ids upsert — but a first run can be large.
  async function doResyncAll(): Promise<void> {
    if (!user) return void vscode.window.showInformationMessage("Cursor Sync: sign in first.");
    if (status === "syncing")
      return void vscode.window.showInformationMessage("Cursor Sync: a sync is already running.");
    const pick = await vscode.window.showWarningMessage(
      "Re-sync everything? This re-scans all enabled chats and backfills the cloud. Duplicates are impossible (matching chats just update in place), but the first pass can take a while.",
      { modal: true },
      "Re-sync",
    );
    if (pick !== "Re-sync") return;
    await bridge.resetWatermark();
    addLog("Re-syncing everything from scratch…");
    await doUpSync();
  }

  // Debounced down-sync: coalesce a burst of live records into one DB transaction.
  let downBuffer: KvRecord[] = [];
  let flushTimer: NodeJS.Timeout | undefined;
  async function flushDown() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (downBuffer.length === 0) return;
    const batch = downBuffer;
    downBuffer = [];
    try {
      const n = await bridge.applyRecords(batch);
      stats.pulled += n;
      addLog(`Live: applied ${n} rows`);
      refresh();
    } catch (e) {
      addLog(`Apply error: ${(e as Error).message}`);
    }
  }
  function queueDown(rec: KvRecord) {
    downBuffer.push(rec);
    if (downBuffer.length >= 200) return void flushDown();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flushDown(), 1500);
  }
  ctx.subscriptions.push({ dispose: () => flushTimer && clearTimeout(flushTimer) });

  function subscribeRealtime() {
    realtime?.unsubscribe();
    if (!user || !getConfig().autoSync) return;
    realtime = transport.subscribe(user.id, (rec) => {
      if (rec.device_id === deviceId) return; // ignore our own writes
      queueDown(rec);
    });
  }

  const version = String((ctx.extension.packageJSON as { version?: string }).version ?? "0.0.0");
  const panel = new PanelProvider(ctx.extensionUri, version, {
    signIn: () =>
      auth.signIn().catch((e) => vscode.window.showErrorMessage(`Sign-in: ${e.message}`)),
    signOut: () => auth.signOut(),
    syncNow: () => void doUpSync(),
    pullNow: () => void doPull(),
    setRepoEnabled: (repo: string, enabled: boolean) => void applyPrefChange(repo, enabled),
    setAutoSyncNew: (enabled: boolean) => void applyPrefChange(DEFAULT_PREF_KEY, enabled),
    setWindow: (days: number) =>
      void updateConfig("syncWindowDays", days).then(async () => {
        addLog(`Sync window: ${days === 0 ? "all history" : `${days} days`}`);
        refresh();
        await bridge.resetWatermark(); // re-scan so a wider window picks up older chats
        void doUpSync();
      }),
    openDetails: (repo: string) => {
      const details = bridge.repoDetails(repo);
      detailsPanel.show({
        label: prettyRepo(repo),
        repoId: repo,
        isOther: repo === NO_REPO_KEY,
        ...details,
      });
    },
    resyncAll: () => void doResyncAll(),
    setAutoSync: (v: boolean) =>
      updateConfig("autoSync", v).then(() => (subscribeRealtime(), refresh())),
  });

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorsync.panel", panel),
    vscode.window.registerUriHandler({
      handleUri: (uri) =>
        void auth.handleUri(uri).catch((e: unknown) => {
          out.appendLine(`auth callback error: ${(e as Error).message}`);
          void vscode.window.showErrorMessage(`cursorsync sign-in failed: ${(e as Error).message}`);
        }),
    }),
    vscode.commands.registerCommand("cursorsync.signIn", () => auth.signIn()),
    vscode.commands.registerCommand("cursorsync.signOut", () => auth.signOut()),
    vscode.commands.registerCommand("cursorsync.syncNow", () => doUpSync()),
    vscode.commands.registerCommand("cursorsync.pullNow", () => doPull()),
    vscode.commands.registerCommand("cursorsync.resyncAll", () => doResyncAll()),
    vscode.commands.registerCommand("cursorsync.backupNow", async () => {
      setStatus("syncing", "Backing up…");
      const p = await bridge.ensureBackup(true);
      addLog(p ? `Backed up local chats` : "Backup skipped (recent one exists)");
      setStatus("idle", "Backup complete");
      vscode.window.showInformationMessage(
        p
          ? `cursorsync backed up your chats to ${p}`
          : "cursorsync: a recent backup already exists.",
      );
    }),
    vscode.commands.registerCommand("cursorsync.focus", () =>
      vscode.commands.executeCommand("cursorsync.panel.focus"),
    ),
    auth.onChange((u) => {
      user = u;
      addLog(u ? `Signed in as ${u.userName ?? u.id}` : "Signed out");
      subscribeRealtime();
      void loadRepoState();
      if (u) triggerSync();
      // Don't auto-push the whole DB on sign-in. The user kicks off the first (large) sync with
      // "Sync all chats now"; the background timer then keeps it incremental.
    }),
  );

  // Event-driven sync: react to actual writes to Cursor's DB instead of polling. fs.watch on the DB
  // folder fires whenever Cursor saves a chat; we debounce a burst into one sync, with a max wait so
  // a long continuous session still syncs periodically. A slow safety timer catches missed events.
  const DEBOUNCE_MS = 1500;
  const MAX_WAIT_MS = 8000;
  const SAFETY_MS = 120_000;
  let debounceTimer: NodeJS.Timeout | undefined;
  let burstStart = 0;
  const triggerSync = (): void => {
    if (!user || !getConfig().autoSync || status === "syncing") return;
    const now = Date.now();
    if (burstStart === 0) burstStart = now;
    if (debounceTimer) clearTimeout(debounceTimer);
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - (now - burstStart)));
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      burstStart = 0;
      void doUpSync({ background: true });
    }, wait);
  };

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(dirname(defaultGlobalDbPath()), (_event, filename) => {
      if (filename === null || filename.startsWith("state.vscdb")) triggerSync();
    });
  } catch (e) {
    out.appendLine(`db watch failed (${(e as Error).message}); relying on the safety timer`);
  }
  const safety = setInterval(triggerSync, SAFETY_MS);
  ctx.subscriptions.push({
    dispose: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(safety);
      watcher?.close();
      bridge.dispose();
    },
  });

  // Restore any existing session.
  auth
    .currentUser()
    .then((u) => {
      user = u;
      subscribeRealtime();
      void loadRepoState();
      if (u) triggerSync();
    })
    .catch((e: unknown) => out.appendLine(`session restore error: ${(e as Error).message}`));
  refresh();
}

export function deactivate() {}

function getDeviceId(ctx: vscode.ExtensionContext): string {
  let id = ctx.globalState.get<string>("cursorsync.deviceId");
  if (!id) {
    id = `${hostname()}-${Math.random().toString(36).slice(2, 8)}`;
    void ctx.globalState.update("cursorsync.deviceId", id);
  }
  return id;
}
