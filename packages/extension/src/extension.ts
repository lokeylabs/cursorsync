import * as vscode from "vscode";
import { hostname } from "node:os";
import { repoIdForPath } from "@cursorsync/cursor-store";
import { AuthManager, type AuthUser } from "./auth.js";
import { Transport } from "./transport.js";
import { SyncBridge } from "./bridge.js";
import { PanelProvider, type PanelState } from "./webview.js";
import { getConfig, updateConfig, type SyncScope } from "./config.js";

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

  const currentRepo = (): string | null => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return folder ? repoIdForPath(folder) : null;
  };
  const addLog = (m: string) => {
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

  async function doUpSync() {
    if (!user) return void vscode.window.showInformationMessage("cursorsync: sign in first.");
    try {
      setStatus("syncing", "Pushing chats…");
      const cfg = getConfig();
      const r = await bridge.upSync(user.id, cfg.syncScope, currentRepo());
      stats.pushed += r.pushed;
      stats.lastSync = new Date().toLocaleString();
      addLog(`Pushed ${r.pushed} rows (${cfg.syncScope})`);
      setStatus("idle", `Pushed ${r.pushed}`);
    } catch (e) {
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

  function subscribeRealtime() {
    realtime?.unsubscribe();
    if (!user || !getConfig().autoSync) return;
    realtime = transport.subscribe(user.id, (rec) => {
      if (rec.device_id === deviceId) return; // ignore our own writes
      bridge
        .applyRecords([rec])
        .then(() => {
          stats.pulled += 1;
          addLog(`Live: ${rec.ckey.slice(0, 40)}`);
          refresh();
        })
        .catch((e) => addLog(`Apply error: ${(e as Error).message}`));
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
      const wasSignedIn = !!user;
      user = u;
      addLog(u ? `Signed in as ${u.userName ?? u.id}` : "Signed out");
      subscribeRealtime();
      refresh();
      if (u && !wasSignedIn && getConfig().autoSync) void doUpSync();
    }),
  );

  // Periodic up-sync of local changes.
  const timer = setInterval(() => {
    if (user && getConfig().autoSync && status !== "syncing") void doUpSync();
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
