/** Namespaces in Cursor's `cursorDiskKV` table that cursorsync understands. */
export type Namespace = "bubbleId" | "composerData" | "agentKv";

/** Namespaces we sync today. `agentKv` is phase 2. */
export const SYNCED_NAMESPACES: Namespace[] = ["bubbleId", "composerData"];

/** Namespaces we deliberately never sync (regenerable / ephemeral / per-machine). */
export const EXCLUDED_PREFIXES = [
  "checkpointId",
  "ofsContent",
  "composer.content.",
  "inlineDiff",
  "composerVirtualRowHeights",
  "bcCachedDetails",
] as const;

/** A single chat message. Key: `bubbleId:{composerId}:{messageId}`. */
export interface BubbleRow {
  namespace: "bubbleId";
  key: string;
  composerId: string;
  messageId: string;
  value: unknown; // parsed JSON
}

/** A conversation. Key: `composerData:{composerId}`. */
export interface ComposerRow {
  namespace: "composerData";
  key: string;
  composerId: string;
  value: unknown; // parsed JSON (contains richText with absolute paths)
}

/** Content-addressed agent artifact. Key: `agentKv:blob:{sha256}`. Phase 2. */
export interface AgentBlobRow {
  namespace: "agentKv";
  key: string;
  sha256: string;
  isBinary: boolean;
  value: Buffer; // raw bytes (may be protobuf/gzip or JSON text)
}

export type ChatRow = BubbleRow | ComposerRow | AgentBlobRow;
