import { describe, it, expect } from "vitest";
import { shouldSyncRow, defaultSyncPolicy } from "./policy.js";

const kv = "global:cursorDiskKV" as const;
const it_ = "global:ItemTable" as const;

describe("shouldSyncRow", () => {
  it("always syncs conversations regardless of policy", () => {
    const p = defaultSyncPolicy();
    expect(shouldSyncRow(kv, "bubbleId:c:m", p)).toBe(true);
    expect(shouldSyncRow(kv, "composerData:c", p)).toBe(true);
  });

  it("excludes agent traces, snapshots, and UI state by default", () => {
    const p = defaultSyncPolicy();
    expect(shouldSyncRow(kv, "agentKv:blob:abc", p)).toBe(false);
    expect(shouldSyncRow(kv, "checkpointId:x", p)).toBe(false);
    expect(shouldSyncRow(kv, "ofsContent:x", p)).toBe(false);
    expect(shouldSyncRow(kv, "composer.content.abc", p)).toBe(false);
    expect(shouldSyncRow(it_, "workbench.ui", p)).toBe(false);
  });

  it("opts in per flag", () => {
    expect(
      shouldSyncRow(kv, "agentKv:blob:abc", { ...defaultSyncPolicy(), agentArtifacts: true }),
    ).toBe(true);
    expect(
      shouldSyncRow(kv, "checkpointId:x", { ...defaultSyncPolicy(), fileSnapshots: true }),
    ).toBe(true);
    expect(shouldSyncRow(it_, "workbench.ui", { ...defaultSyncPolicy(), uiState: true })).toBe(
      true,
    );
  });
});
