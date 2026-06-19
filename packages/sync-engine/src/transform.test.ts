import { describe, it, expect } from "vitest";
import { toKvRecord } from "./transform.js";
import type { ChangedRow } from "@cursorsync/cursor-store";

function row(key: string, value: unknown): ChangedRow {
  return { key, rowid: 1, value: Buffer.from(JSON.stringify(value), "utf8") };
}

describe("toKvRecord", () => {
  it("parses a bubbleId message into composer + message ids", () => {
    const rec = toKvRecord(row("bubbleId:comp-1:msg-9", { text: "hi" }));
    expect(rec).toEqual({
      key: "bubbleId:comp-1:msg-9",
      namespace: "bubbleId",
      composer_id: "comp-1",
      message_id: "msg-9",
      value: { text: "hi" },
    });
  });

  it("parses a composerData conversation with a null message id", () => {
    const rec = toKvRecord(row("composerData:comp-1", { title: "Chat" }));
    expect(rec).toMatchObject({
      namespace: "composerData",
      composer_id: "comp-1",
      message_id: null,
    });
  });

  it("ignores namespaces outside the synced set", () => {
    expect(toKvRecord(row("checkpointId:abc", {}))).toBeNull();
    expect(toKvRecord(row("agentKv:blob:deadbeef", {}))).toBeNull();
  });
});
