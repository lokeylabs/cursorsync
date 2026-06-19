import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { buildDetailsHtml } from "./details-html.js";
import type { ConvRow } from "./bridge.js";

export interface DetailsPayload {
  label: string;
  repoId: string;
  isOther: boolean;
  folders: string[];
  conversations: ConvRow[];
  truncated: boolean;
}

/** A reusable editor-tab pop-out showing one repo's folder copies and conversations. */
export class RepoDetailsPanel {
  private panel?: vscode.WebviewPanel;
  private pending?: DetailsPayload;

  constructor(private readonly extensionUri: vscode.Uri) {}

  show(payload: DetailsPayload): void {
    this.pending = payload;
    if (this.panel) {
      this.panel.title = payload.label;
      this.panel.reveal(vscode.ViewColumn.Active);
      this.post();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "cursorsync.details",
      payload.label,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
        retainContextWhenHidden: true,
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg");
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((msg: { type: string; path?: string }) => {
      if (msg.type === "ready") this.post();
      else if (msg.type === "reveal" && msg.path) this.reveal(msg.path);
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel = panel;
  }

  private reveal(path: string): void {
    if (!existsSync(path)) {
      void vscode.window.showWarningMessage(`Cursor Sync: that folder no longer exists — ${path}`);
      return;
    }
    void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path));
  }

  private post(): void {
    if (this.panel && this.pending) {
      void this.panel.webview.postMessage({ type: "details", payload: this.pending });
    }
  }

  private html(webview: vscode.Webview): string {
    const asset = (f: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f)).toString();
    return buildDetailsHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      styleUri: asset("details.css"),
      scriptUri: asset("details.js"),
    });
  }
}
