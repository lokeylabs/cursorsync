import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";

/**
 * Repo-scoping: which conversation belongs to which repository.
 *
 * Every `composerData` value embeds `workspaceIdentifier.uri.fsPath` — the local folder the
 * conversation belongs to. We resolve that folder to a STABLE repo id (its git remote URL,
 * normalized) so the same repo's chats line up across machines even when local paths differ.
 * Conversations with no resolvable repo (no folder / no git remote) get a path-based fallback id.
 */

function asJson(value: Buffer | string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    return JSON.parse(typeof value === "string" ? value : value.toString("utf8"));
  } catch {
    return null;
  }
}

export interface ComposerMeta {
  /** workspaceIdentifier.uri.fsPath — the direct folder link, when Cursor recorded it. */
  fsPath: string | null;
  /** Fallback: the most-recently-interacted repo from trackedGitRepos. */
  trackedRepoPath: string | null;
  /** Number of messages; 0 means an empty "new chat" stub. */
  messageCount: number;
  /** Epoch ms of last activity (lastUpdatedAt, else createdAt); null if unknown. */
  updatedAt: number | null;
}

function lastInteraction(repo: { branches?: Array<{ lastInteractionAt?: number }> }): number {
  return (repo.branches ?? []).reduce((m, b) => Math.max(m, b.lastInteractionAt ?? 0), 0);
}

/** Extract the folder links + message count from a composerData value (parses once). */
export function composerMeta(composerValue: Buffer | string | null): ComposerMeta {
  const obj = asJson(composerValue);
  const fsPath =
    (obj?.["workspaceIdentifier"] as { uri?: { fsPath?: string } } | undefined)?.uri?.fsPath ??
    null;
  const messageCount = (obj?.["fullConversationHeadersOnly"] as unknown[] | undefined)?.length ?? 0;
  const tracked = obj?.["trackedGitRepos"] as
    | Array<{ repoPath?: string; branches?: Array<{ lastInteractionAt?: number }> }>
    | undefined;
  let trackedRepoPath: string | null = null;
  if (Array.isArray(tracked) && tracked.length > 0) {
    const best = [...tracked].sort((a, b) => lastInteraction(b) - lastInteraction(a))[0];
    trackedRepoPath = best?.repoPath ?? null;
  }
  const updated = obj?.["lastUpdatedAt"];
  const created = obj?.["createdAt"];
  const updatedAt =
    typeof updated === "number" ? updated : typeof created === "number" ? created : null;
  return { fsPath, trackedRepoPath, messageCount, updatedAt };
}

/** The best folder for a conversation: its recorded workspace, else its tracked git repo. */
export function folderForComposer(meta: ComposerMeta): string | null {
  return meta.fsPath ?? meta.trackedRepoPath;
}

export interface ComposerDetail {
  name: string;
  createdAt: number | null;
  messageCount: number;
  /** Resolved folder (workspace or tracked repo), or null. */
  folder: string | null;
  /** Best-effort folders referenced in the conversation's context (for locating "no repo" chats). */
  contextHints: string[];
}

// Paths under these are noise for "where did this chat happen" hints.
const HINT_NOISE = /\/(Downloads|\.cursor|\.Trash|Library|node_modules)(\/|$)/i;

/** Richer per-conversation info for the details pop-out (cold path — not used during sync). */
export function composerDetail(value: Buffer | string | null): ComposerDetail {
  const obj = asJson(value);
  const meta = composerMeta(value);
  const name = ((obj?.["name"] as string) || "").trim() || "(untitled)";
  const createdAt = typeof obj?.["createdAt"] === "number" ? (obj["createdAt"] as number) : null;
  const ctx = JSON.stringify(obj?.["context"] ?? {});
  const dirs = new Set<string>();
  for (const p of ctx.match(/\/Users\/[^"\\]+/g) ?? []) {
    const dir = p.replace(/\/[^/]*$/, ""); // dirname
    if (dir && !HINT_NOISE.test(dir)) dirs.add(dir);
  }
  return {
    name,
    createdAt,
    messageCount: meta.messageCount,
    folder: folderForComposer(meta),
    contextHints: [...dirs].slice(0, 5),
  };
}

/**
 * Normalize a git remote URL into a stable, host/owner/name identity:
 *   git@github.com:Owner/Repo.git  ->  github.com/owner/repo
 *   https://github.com/Owner/Repo  ->  github.com/owner/repo
 */
export function normalizeRemote(url: string): string {
  let s = url.trim().replace(/\.git$/i, "");
  s = s.replace(/^git@([^:]+):/i, "$1/"); // scp-style ssh
  s = s.replace(/^[a-z]+:\/\//i, ""); // strip scheme
  s = s.replace(/^[^@/]+@/, ""); // strip user@
  return s.toLowerCase();
}

const remoteCache = new Map<string, string | null>();

/** Resolve a folder path to a stable repo id (normalized git remote, else `path:<folder>`). */
export function repoIdForPath(folderPath: string): string {
  if (!remoteCache.has(folderPath)) {
    let remote: string | null = null;
    try {
      remote = execFileSync("git", ["-C", folderPath, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim();
    } catch {
      remote = null;
    }
    remoteCache.set(folderPath, remote ? normalizeRemote(remote) : null);
  }
  const remote = remoteCache.get(folderPath) ?? null;
  return remote ?? `path:${folderPath}`;
}

/**
 * Scan every composerData row once and build two composerId-keyed maps: repo id (for per-repo
 * sync) and last-activity epoch ms (for the rolling time window).
 */
export function buildComposerInfo(db: Database.Database): {
  repo: Map<string, string>;
  time: Map<string, number>;
} {
  const repo = new Map<string, string>();
  const time = new Map<string, number>();
  const stmt = db.prepare(
    "SELECT key, value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData:~' AND value IS NOT NULL",
  );
  for (const r of stmt.iterate() as IterableIterator<{ key: string; value: Buffer | string }>) {
    const composerId = r.key.split(":")[1];
    if (!composerId) continue;
    const meta = composerMeta(r.value);
    const folder = folderForComposer(meta);
    if (folder) repo.set(composerId, repoIdForPath(folder));
    if (meta.updatedAt !== null) time.set(composerId, meta.updatedAt);
  }
  return { repo, time };
}

/** The repo id for a raw Cursor key, using a composerId->repo map. null for non-conversation rows. */
export function repoForKey(key: string, composerRepo: Map<string, string>): string | null {
  if (key.startsWith("bubbleId:") || key.startsWith("composerData:")) {
    return composerRepo.get(key.split(":")[1] ?? "") ?? null;
  }
  return null; // agentKv blobs, checkpoints, UI state — not conversation-scoped
}
