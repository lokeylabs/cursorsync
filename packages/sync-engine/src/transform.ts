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
  /** Inline value (text or base64). Null when the bytes are offloaded — see `blob_sha`. */
  value: string | null;
  /** sha256 of the value when it lives in object storage instead of inline; null otherwise. */
  blob_sha: string | null;
  /** Stable repo id (git remote) this row belongs to, or null for non-conversation rows. */
  repo: string | null;
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
export function toKvRecord(
  row: KvRow,
  ownerId: string,
  deviceId: string,
  repo: string | null = null,
): KvRecord {
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
    blob_sha: null,
    repo,
    device_id: deviceId,
  };
}

/** Build a record whose bytes live in object storage (value offloaded, pointer = `sha`). */
export function blobRecord(
  meta: { source: Source; key: string },
  ownerId: string,
  deviceId: string,
  repo: string | null,
  sha: string,
  isBinary: boolean,
): KvRecord {
  return {
    id: rowId(ownerId, meta.source, meta.key),
    owner_id: ownerId,
    source: meta.source,
    ckey: meta.key,
    is_binary: isBinary,
    value: null,
    blob_sha: sha,
    repo,
    device_id: deviceId,
  };
}

/**
 * Decode an INLINE record back into raw bytes for writing into Cursor's DB. Records whose bytes are
 * offloaded (`blob_sha` set) must have their bytes fetched separately and written via `writeRowOf`.
 */
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

/** Construct a write row from a record plus already-fetched blob bytes. */
export function writeRowOf(
  rec: Pick<KvRecord, "source" | "ckey">,
  bytes: Buffer,
): { source: Source; key: string; value: Buffer } {
  return { source: rec.source, key: rec.ckey, value: bytes };
}
