import { describe, it, expect } from "vitest";
import { toKvRecord, fromKvRecord, rowId } from "./transform.js";
import type { KvRow } from "@cursorsync/cursor-store";

const OWNER = "11111111-1111-1111-1111-111111111111";

function row(
  key: string,
  value: Buffer | null,
  source: KvRow["source"] = "global:cursorDiskKV",
): KvRow {
  return { source, key, rowid: 1, value };
}

describe("toKvRecord", () => {
  it("stores UTF-8 (JSON) values as text", () => {
    const rec = toKvRecord(row("composerData:c1", Buffer.from('{"t":"hi"}', "utf8")), OWNER, "mac");
    expect(rec).toMatchObject({
      id: rowId(OWNER, "global:cursorDiskKV", "composerData:c1"),
      source: "global:cursorDiskKV",
      ckey: "composerData:c1",
      is_binary: false,
      value: '{"t":"hi"}',
      device_id: "mac",
    });
  });

  it("base64-encodes non-UTF-8 (binary) values", () => {
    const bin = Buffer.from([0xff, 0x00, 0xfe, 0x01]);
    const rec = toKvRecord(row("agentKv:blob:abc", bin), OWNER, "mac");
    expect(rec.is_binary).toBe(true);
    expect(rec.value).toBe(bin.toString("base64"));
  });

  it("handles null (tombstone) values", () => {
    expect(toKvRecord(row("composerData:x", null), OWNER, "mac")).toMatchObject({
      is_binary: false,
      value: null,
    });
  });

  it("round-trips text and binary back to identical bytes", () => {
    for (const buf of [Buffer.from('{"a":1}', "utf8"), Buffer.from([0xde, 0xad, 0xbe, 0xef])]) {
      const rec = toKvRecord(row("k", buf), OWNER, "mac");
      expect(fromKvRecord(rec).value.equals(buf)).toBe(true);
    }
  });

  it("routes ItemTable rows to the ItemTable source", () => {
    const rec = toKvRecord(row("ui.state", Buffer.from("x"), "global:ItemTable"), OWNER, "mac");
    expect(rec.source).toBe("global:ItemTable");
    expect(fromKvRecord(rec).source).toBe("global:ItemTable");
  });
});
