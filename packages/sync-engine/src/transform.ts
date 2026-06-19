import type { ChangedRow } from "@cursorsync/cursor-store";

/** A row shaped for the `cursor_kv` Supabase table / PowerSync local SQLite. */
export interface KvRecord {
  key: string;
  namespace: "bubbleId" | "composerData";
  composer_id: string;
  message_id: string | null;
  value: unknown; // parsed JSON
}

/**
 * Parse a Cursor key/value into a syncable record.
 * Keys: `bubbleId:{composerId}:{messageId}` | `composerData:{composerId}`.
 * Returns null for keys outside the synced namespaces.
 */
export function toKvRecord(row: ChangedRow): KvRecord | null {
  const parts = row.key.split(":");
  const ns = parts[0];
  if (ns === "bubbleId") {
    return {
      key: row.key,
      namespace: "bubbleId",
      composer_id: parts[1] ?? "",
      message_id: parts[2] ?? "",
      value: JSON.parse(row.value.toString("utf8")),
    };
  }
  if (ns === "composerData") {
    return {
      key: row.key,
      namespace: "composerData",
      composer_id: parts[1] ?? "",
      message_id: null,
      value: JSON.parse(row.value.toString("utf8")),
    };
  }
  return null;
}
