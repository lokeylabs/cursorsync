import * as vscode from "vscode";
import type { SyncPolicy } from "@cursorsync/sync-engine";

export type SyncScope = "all" | "repo";

export interface ExtensionConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  autoSync: boolean;
  syncScope: SyncScope;
  policy: SyncPolicy;
}

/** Read cursorsync settings (defaults defined in package.json `contributes.configuration`). */
export function getConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration("cursorsync");
  return {
    supabaseUrl: c.get<string>("supabaseUrl", ""),
    supabaseAnonKey: c.get<string>("supabaseAnonKey", ""),
    autoSync: c.get<boolean>("autoSync", true),
    syncScope: c.get<SyncScope>("syncScope", "all"),
    policy: {
      agentArtifacts: c.get<boolean>("syncAgentArtifacts", false),
      fileSnapshots: c.get<boolean>("syncFileSnapshots", false),
      uiState: c.get<boolean>("syncUiState", false),
    },
  };
}

/** Persist a setting change (used by the panel's scope/auto-sync toggles). */
export async function updateConfig<K extends keyof ExtensionConfig>(
  key: K,
  value: ExtensionConfig[K],
): Promise<void> {
  await vscode.workspace
    .getConfiguration("cursorsync")
    .update(key, value, vscode.ConfigurationTarget.Global);
}
