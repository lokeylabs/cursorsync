import type { Source } from "@cursorsync/cursor-store";

/**
 * What to sync. Cursor's DB holds far more than conversations — agent traces, file/checkpoint
 * snapshots, and per-machine UI state. By default cursorsync syncs only the conversations
 * (messages + composers); the heavy or machine-specific namespaces are opt-in.
 *
 *  - agentArtifacts: `agentKv:*` — agent tool-result traces, often large binary blobs. (Future:
 *    these go to object storage rather than inline.)
 *  - fileSnapshots:  `checkpointId:*`, `ofsContent:*` — regenerable file/tree snapshots.
 *  - uiState:        `ItemTable` rows + `composer.content.*`, `inlineDiff*`, etc — per-machine state
 *    that is usually undesirable to mirror across devices.
 */
export interface SyncPolicy {
  agentArtifacts: boolean;
  fileSnapshots: boolean;
  uiState: boolean;
}

export function defaultSyncPolicy(): SyncPolicy {
  return { agentArtifacts: false, fileSnapshots: false, uiState: false };
}

const CORE = new Set(["bubbleId", "composerData"]);

/** Whether a given row should be synced under `policy`. */
export function shouldSyncRow(source: Source, key: string, policy: SyncPolicy): boolean {
  if (source === "global:ItemTable") return policy.uiState;
  const ns = key.split(":")[0] ?? "";
  if (CORE.has(ns)) return true; // conversations always sync
  if (ns === "agentKv") return policy.agentArtifacts;
  if (ns === "checkpointId" || ns === "ofsContent") return policy.fileSnapshots;
  return policy.uiState; // composer.content.*, inlineDiff*, and other ephemeral keys
}
