import * as vscode from "vscode";

/**
 * cursorsync extension entrypoint (scaffold).
 *
 * Bridge loop (to implement):
 *   up-sync:   watch Cursor's state.vscdb -> read new bubbleId/composerData rows
 *              -> upsert into PowerSync local SQLite (PowerSync streams to Supabase)
 *   down-sync: subscribe to PowerSync changes -> write rows into state.vscdb (backup-first)
 *              -> when new conversations arrive, prompt: "restart Cursor to view"
 *
 * See docs/ARCHITECTURE.md.
 */
export function activate(context: vscode.ExtensionContext) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(sync) cursorsync";
  status.tooltip = "cursorsync: not yet configured";
  status.command = "cursorsync.status";
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorsync.status", () => {
      vscode.window.showInformationMessage("cursorsync: bridge not yet wired up (scaffold).");
    }),
    vscode.commands.registerCommand("cursorsync.syncNow", async () => {
      vscode.window.showInformationMessage("cursorsync: manual sync not yet implemented.");
    }),
    vscode.commands.registerCommand("cursorsync.signIn", async () => {
      vscode.window.showInformationMessage("cursorsync: Supabase auth not yet implemented.");
    }),
  );
}

export function deactivate() {}
