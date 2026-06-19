import { describe, it, expect } from "vitest";
import { normalizeRemote, workspacePathOf } from "./repo.js";

describe("normalizeRemote", () => {
  it("normalizes all remote forms of the same repo to one identity", () => {
    const want = "github.com/owner/repo";
    expect(normalizeRemote("git@github.com:Owner/Repo.git")).toBe(want);
    expect(normalizeRemote("https://github.com/Owner/Repo")).toBe(want);
    expect(normalizeRemote("https://github.com/Owner/Repo.git")).toBe(want);
    expect(normalizeRemote("ssh://git@github.com/Owner/Repo.git")).toBe(want);
    expect(normalizeRemote("https://user@github.com/Owner/Repo.git")).toBe(want);
  });

  it("distinguishes different repos", () => {
    expect(normalizeRemote("git@github.com:a/b.git")).not.toBe(
      normalizeRemote("git@github.com:a/c.git"),
    );
  });
});

describe("workspacePathOf", () => {
  it("extracts workspaceIdentifier.uri.fsPath from a composerData value", () => {
    const v = JSON.stringify({ workspaceIdentifier: { uri: { fsPath: "/Users/x/proj" } } });
    expect(workspacePathOf(v)).toBe("/Users/x/proj");
    expect(workspacePathOf(Buffer.from(v))).toBe("/Users/x/proj");
  });
  it("returns null when absent or unparseable", () => {
    expect(workspacePathOf(JSON.stringify({ other: 1 }))).toBeNull();
    expect(workspacePathOf("not json")).toBeNull();
    expect(workspacePathOf(null)).toBeNull();
  });
});
