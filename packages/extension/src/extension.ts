import * as vscode from "vscode";
import { hostname } from "node:os";
import { repoIdForPath } from "@cursorsync/cursor-store";
import { AuthManager, type AuthUser } from "./auth.js";
import { Transport } from "./transport.js";
import { SyncBridge } from "./bridge.js";
import { PanelProvider, type PanelState } from "./webview.js";
import { getConfig, updateConfig, type SyncScope } from "./config.js";
import type { KvRecord } from "@cursorsync/sync-engine";

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

  const refresh = () => {
    const cfg = getConfig();
    status$.text = user ? "$(sync) cursorsync" : "$(sync-ignored) cursorsync";
    status$.tooltip = user ? `cursorsync: ${statusText}` : "cursorsync: sign in";
    status$.show();
    panel.postState({
      user,
      scope: cfg.syncScope,
      autoSync: cfg.autoSync,
      repo: currentRepo(),
      status,
      statusText,
      stats,
      log,
    });
  };

  const setStatus = (s: PanelState["status"], text: string) => {
    status = s;
    statusText = text;
    refresh();
  };

  // Background ticks push at most this many rows so they never run away; the manual button is uncapped.
  const BG_CAP = 5000;
  async function doUpSync(opts?: { background?: boolean }) {
    if (!user) {
      if (!opts?.background) vscode.window.showInformationMessage("cursorsync: sign in first.");
      return;
    }
    if (status === "syncing") return; // never overlap syncs
    try {
      setStatus("syncing", "Pushing chats…");
      const cfg = getConfig();
      const repo = currentRepo();
      out.appendLine(
        `upSync start: scope=${cfg.syncScope} repo=${repo ?? "(none)"} bg=${!!opts?.background}`,
      );
      const r = await bridge.upSync(
        user.id,
        cfg.syncScope,
        repo,
        cfg.policy,
        opts?.background ? BG_CAP : Infinity,
      );
      stats.pushed += r.pushed;
      stats.lastSync = new Date().toLocaleString();
      out.appendLine(`upSync done: scanned=${r.scanned} pushed=${r.pushed}`);
      if (r.pushed > 0 || !opts?.background) addLog(`Pushed ${r.pushed} rows (${cfg.syncScope})`);
      if (cfg.syncScope === "repo" && r.pushed === 0 && !opts?.background) {
        addLog(`No chats matched this repo (${repo ?? "no repo open"}). Try scope "All chats".`);
      }
      setStatus(
        "idle",
        r.pushed
          ? `Pushed ${r.pushed}`
          : cfg.syncScope === "repo"
            ? "No chats for this repo"
            : "Up to date",
      );
    } catch (e) {
      out.appendLine(`upSync ERROR: ${(e as Error).stack ?? (e as Error).message}`);
      addLog(`Push error: ${(e as Error).message}`);
      setStatus("error", "Push failed");
    }
  }

  async function doPull() {
    if (!user) return void vscode.window.showInformationMessage("cursorsync: sign in first.");
    try {
      setStatus("syncing", "Pulling chats…");
      const cfg = getConfig();
      const n = await bridge.pullAndApply(cfg.syncScope, currentRepo());
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

  const panel = new PanelProvider(ctx.extensionUri, {
    signIn: () =>
      auth.signIn().catch((e) => vscode.window.showErrorMessage(`Sign-in: ${e.message}`)),
    signOut: () => auth.signOut(),
    syncNow: () => void doUpSync(),
    pullNow: () => void doPull(),
    setScope: (scope: SyncScope) => updateConfig("syncScope", scope).then(refresh),
    setAutoSync: (v: boolean) =>
      updateConfig("autoSync", v).then(() => (subscribeRealtime(), refresh())),
  });

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorsync.panel", panel),
    vscode.window.registerUriHandler({ handleUri: (uri) => void auth.handleUri(uri) }),
    vscode.commands.registerCommand("cursorsync.signIn", () => auth.signIn()),
    vscode.commands.registerCommand("cursorsync.signOut", () => auth.signOut()),
    vscode.commands.registerCommand("cursorsync.syncNow", () => doUpSync()),
    vscode.commands.registerCommand("cursorsync.pullNow", () => doPull()),
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
      refresh();
      // Don't auto-push the whole DB on sign-in. The user kicks off the first (large) sync with
      // "Sync all chats now"; the background timer then keeps it incremental.
    }),
  );

  // Periodic incremental up-sync (capped per tick).
  const timer = setInterval(() => {
    if (user && getConfig().autoSync && status !== "syncing") void doUpSync({ background: true });
  }, 30_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Restore any existing session.
  auth.currentUser().then((u) => {
    user = u;
    subscribeRealtime();
    refresh();
  });
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
