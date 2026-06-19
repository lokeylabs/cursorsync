import * as vscode from "vscode";
import type { SyncPolicy } from "@cursorsync/sync-engine";

export interface ExtensionConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  autoSync: boolean;
  /** Rolling window: only sync conversations active within this many days (0 = no limit). */
  syncWindowDays: number;
  policy: SyncPolicy;
}

/** Read cursorsync settings (defaults defined in package.json `contributes.configuration`). */
export function getConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration("cursorsync");
  return {
    supabaseUrl: c.get<string>("supabaseUrl", ""),
    supabaseAnonKey: c.get<string>("supabaseAnonKey", ""),
    autoSync: c.get<boolean>("autoSync", true),
    syncWindowDays: c.get<number>("syncWindowDays", 90),
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
