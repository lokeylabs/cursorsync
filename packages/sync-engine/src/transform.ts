import { isUtf8 } from "node:buffer";
import type { KvRow, Source } from "@cursorsync/cursor-store";

/**
 * A row shaped for the `cursor_kv` Supabase table / PowerSync local SQLite.
 * `id` is deterministic so any device upserts the same row (conflict-free union merge).
 */
export interface KvRecord {
  id: string;
  owner_id: string;
  source: Source;
  ckey: string;
  is_binary: boolean;
  value: string | null;
  device_id: string;
}

/** Build the deterministic row id for a (user, source, key). */
export function rowId(ownerId: string, source: Source, key: string): string {
  return `${ownerId}:${source}:${key}`;
}

/**
 * Encode a raw Cursor row for sync. Values that are valid UTF-8 (JSON, strings) are stored as
 * text; anything else (agentKv protobuf/gzip blobs, etc.) is base64-encoded with is_binary=true.
 */
export function toKvRecord(row: KvRow, ownerId: string, deviceId: string): KvRecord {
  let isBinary = false;
  let value: string | null = null;
  if (typeof row.value === "string") {
    value = row.value; // TEXT-affinity value: already UTF-8 text
  } else if (row.value !== null) {
    if (isUtf8(row.value)) {
      value = row.value.toString("utf8");
    } else {
      isBinary = true;
      value = row.value.toString("base64");
    }
  }
  return {
    id: rowId(ownerId, row.source, row.key),
    owner_id: ownerId,
    source: row.source,
    ckey: row.key,
    is_binary: isBinary,
    value,
    device_id: deviceId,
  };
}

/** Decode a synced record back into raw bytes for writing into Cursor's DB. */
export function fromKvRecord(rec: Pick<KvRecord, "source" | "ckey" | "is_binary" | "value">): {
  source: Source;
  key: string;
  value: Buffer;
} {
  const value =
    rec.value === null
      ? Buffer.alloc(0)
      : Buffer.from(rec.value, rec.is_binary ? "base64" : "utf8");
  return { source: rec.source, key: rec.ckey, value };
}
