import { describe, it, expect } from "vitest";
import { shouldOffload, sha256Hex, BLOB_THRESHOLD_BYTES } from "./blob.js";

describe("shouldOffload", () => {
  it("always offloads agentKv blobs regardless of size", () => {
    expect(shouldOffload("agentKv:blob:abc", 10)).toBe(true);
  });
  it("offloads any value over the threshold", () => {
    expect(shouldOffload("bubbleId:c:m", BLOB_THRESHOLD_BYTES + 1)).toBe(true);
  });
  it("keeps small conversation values inline", () => {
    expect(shouldOffload("bubbleId:c:m", 1024)).toBe(false);
    expect(shouldOffload("composerData:c", BLOB_THRESHOLD_BYTES)).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("is deterministic and content-addressed", () => {
    expect(sha256Hex(Buffer.from("hello"))).toBe(sha256Hex(Buffer.from("hello")));
    expect(sha256Hex(Buffer.from("a"))).not.toBe(sha256Hex(Buffer.from("b")));
    expect(sha256Hex(Buffer.from("hello"))).toMatch(/^[0-9a-f]{64}$/);
  });
});
