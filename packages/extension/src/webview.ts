import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { buildPanelHtml } from "./panel-html.js";
import type { AuthUser } from "./auth.js";

/** One row in the panel's "Synced repos" list. */
export interface RepoEntry {
  /** Repo id (git remote), or "" for the no-repo bucket. */
  repo: string;
  label: string;
  count: number;
  enabled: boolean;
  /** The repo open in this window (highlighted). */
  isCurrent: boolean;
  /** How many distinct local folder copies this repo lives in (0 if only synced from elsewhere). */
  folderCount: number;
}

export interface PanelState {
  user: AuthUser | null;
  autoSync: boolean;
  autoSyncNew: boolean;
  repos: RepoEntry[];
  repo: string | null;
  status: "idle" | "syncing" | "error";
  /** Which operation is in flight (drives the per-button spinner); null when idle. */
  busy: "push" | "pull" | null;
  statusText: string;
  stats: { pushed: number; pulled: number; lastSync: string | null };
  log: string[];
}

export interface PanelActions {
  signIn(): void;
  signOut(): void;
  syncNow(): void;
  pullNow(): void;
  setRepoEnabled(repo: string, enabled: boolean): void;
  setAutoSyncNew(enabled: boolean): void;
  setAutoSync(value: boolean): void;
  openDetails(repo: string): void;
}

/** The cursorsync sidebar panel. */
export class PanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private last?: PanelState;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly version: string,
    private readonly actions: PanelActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: { type: string; value?: unknown; repo?: string }) => {
      switch (msg.type) {
        case "ready":
          if (this.last) this.postState(this.last);
          break;
        case "signIn":
          return this.actions.signIn();
        case "signOut":
          return this.actions.signOut();
        case "syncNow":
          return this.actions.syncNow();
        case "pullNow":
          return this.actions.pullNow();
        case "setRepoEnabled":
          return this.actions.setRepoEnabled(msg.repo ?? "", msg.value as boolean);
        case "setAutoSyncNew":
          return this.actions.setAutoSyncNew(msg.value as boolean);
        case "setAutoSync":
          return this.actions.setAutoSync(msg.value as boolean);
        case "openDetails":
          return this.actions.openDetails(msg.repo ?? "");
      }
    });
  }

  postState(state: PanelState): void {
    this.last = state;
    this.view?.webview.postMessage({ type: "state", state });
  }

  private html(webview: vscode.Webview): string {
    const asset = (file: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file)).toString();
    return buildPanelHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      styleUri: asset("panel.css"),
      scriptUri: asset("panel.js"),
      logoUri: asset("logo.svg"),
      version: this.version,
    });
  }
}
