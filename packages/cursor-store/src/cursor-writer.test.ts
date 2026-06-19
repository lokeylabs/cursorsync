import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRows } from "./cursor-writer.js";

// Mirrors Cursor's real schema exactly: `key TEXT UNIQUE ON CONFLICT REPLACE`.
const DDL = "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cursorsync-test-"));
  dbPath = join(dir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec(DDL);
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    "composerData:c1",
    Buffer.from(JSON.stringify({ title: "old" }), "utf8"),
  );
  db.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function read(key: string): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(key) as
    | { value: Buffer }
    | undefined;
  db.close();
  return row ? row.value.toString("utf8") : "";
}

describe("applyRows", () => {
  it("inserts new rows and replaces existing keys in place", () => {
    const res = applyRows(dbPath, [
      { key: "composerData:c1", value: JSON.stringify({ title: "new" }) },
      { key: "bubbleId:c1:m1", value: JSON.stringify({ text: "hi" }) },
    ]);

    expect(res.written).toBe(2);
    expect(JSON.parse(read("composerData:c1"))).toEqual({ title: "new" }); // replaced
    expect(JSON.parse(read("bubbleId:c1:m1"))).toEqual({ text: "hi" }); // inserted

    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT count(*) AS n FROM cursorDiskKV").get() as { n: number };
    db.close();
    expect(count.n).toBe(2); // replace did not duplicate
  });

  it("does not back up by default; opts in on request", () => {
    expect(applyRows(dbPath, [{ key: "bubbleId:c1:m3", value: "{}" }]).backupPath).toBeUndefined();
    const res = applyRows(dbPath, [{ key: "bubbleId:c1:m4", value: "{}" }], { backup: true });
    expect(res.backupPath).toBeDefined();
    expect(existsSync(res.backupPath!)).toBe(true);
  });

  it("captures undo only for state-changing writes", () => {
    const res = applyRows(
      dbPath,
      [
        { key: "composerData:c1", value: JSON.stringify({ title: "new" }) }, // overwrites -> undo prior
        { key: "bubbleId:fresh", value: "{}" }, // new key -> undo (restore = absent)
        { key: "composerData:c1", value: JSON.stringify({ title: "new" }) }, // identical now -> no undo
      ],
      { captureUndo: true },
    );
    const byKey = new Map(res.undo.map((u) => [u.key, u]));
    expect(byKey.size).toBe(2);
    const overwritten = byKey.get("composerData:c1")!;
    expect(JSON.parse(Buffer.from(overwritten.valueB64!, "base64").toString())).toEqual({
      title: "old",
    });
    expect(byKey.get("bubbleId:fresh")!.valueB64).toBeNull(); // was absent
  });

  it("refuses the live global DB unless explicitly allowed", () => {
    const live = join(
      process.env.HOME ?? "",
      "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    );
    expect(() => applyRows(live, [{ key: "x", value: "{}" }])).toThrow(/Refusing to write/);
  });
});
