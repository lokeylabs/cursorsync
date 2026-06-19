import { createHash } from "node:crypto";

/**
 * Large or binary values are offloaded to object storage (content-addressed) instead of stored
 * inline in Postgres, so syncing 100% of Cursor's data — including the ~12 GB of agentKv blobs —
 * never bloats the database. The pointer (sha256) lives in the row; the bytes live in the bucket.
 */
export const BLOB_THRESHOLD_BYTES = 64 * 1024;

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Whether a value should be offloaded to the blob bucket rather than inlined in Postgres. */
export function shouldOffload(key: string, byteLength: number): boolean {
  return key.startsWith("agentKv:") || byteLength > BLOB_THRESHOLD_BYTES;
}
