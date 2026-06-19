import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { AuthUser } from "./auth.js";
import type { SyncScope } from "./config.js";

export interface PanelState {
  user: AuthUser | null;
  scope: SyncScope;
  autoSync: boolean;
  repo: string | null;
  status: "idle" | "syncing" | "error";
  statusText: string;
  stats: { pushed: number; pulled: number; lastSync: string | null };
  log: string[];
}

export interface PanelActions {
  signIn(): void;
  signOut(): void;
  syncNow(): void;
  pullNow(): void;
  setScope(scope: SyncScope): void;
  setAutoSync(value: boolean): void;
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
    view.webview.onDidReceiveMessage((msg: { type: string; value?: unknown }) => {
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
        case "setScope":
          return this.actions.setScope(msg.value as SyncScope);
        case "setAutoSync":
          return this.actions.setAutoSync(msg.value as boolean);
      }
    });
  }

  postState(state: PanelState): void {
    this.last = state;
    this.view?.webview.postMessage({ type: "state", state });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex");
    const asset = (file: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${asset("panel.css")}" />
</head>
<body>
  <header class="brand">
    <img class="logo" src="${asset("logo.svg")}" alt="" />
    <div class="brand-text"><h1>Cursor Sync</h1><span class="ver">v${this.version}</span></div>
  </header>
  <div id="view"></div>
  <script nonce="${nonce}" src="${asset("panel.js")}"></script>
</body>
</html>`;
  }
}
