/**
 * Package the extension into a .vsix.
 *
 * pnpm workspaces + native modules don't play nicely with `vsce package` directly, so we stage a
 * clean tree:
 *   - the esbuild bundle (dist/extension.js) — already contains @cursorsync/* and supabase-js
 *   - a package.json with the bundled deps stripped (only better-sqlite3 remains, it's native)
 *   - node_modules/better-sqlite3 rebuilt for the editor's Electron ABI (done before this script)
 *   - media/, README, LICENSE
 * then run `vsce package` from the stage.
 *
 *   node esbuild.mjs && node scripts/package.mjs
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, ".vsix-stage");

if (!existsSync(join(stage, "node_modules", "better-sqlite3", "build", "Release"))) {
  console.error("better-sqlite3 not rebuilt in .vsix-stage. Run the rebuild step first.");
  process.exit(1);
}

// 1. Staged manifest: drop bundled deps, keep only the native one.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
pkg.dependencies = { "better-sqlite3": pkg.dependencies["better-sqlite3"] };
delete pkg.scripts["vscode:prepublish"]; // already bundled; don't re-run in stage
writeFileSync(join(stage, "package.json"), JSON.stringify(pkg, null, 2));

// 2. Copy build outputs and assets.
for (const dir of ["dist", "media"]) cpSync(join(root, dir), join(stage, dir), { recursive: true });
for (const f of ["README.md", "LICENSE", "CHANGELOG.md"]) {
  const src = join(root, "..", "..", f);
  if (existsSync(src)) cpSync(src, join(stage, f));
}
writeFileSync(
  join(stage, ".vscodeignore"),
  ["**/*.ts", "**/*.map", "esbuild.mjs", "scripts/**", ".vsix-stage/**"].join("\n") + "\n",
);
mkdirSync(join(stage, ".vscode"), { recursive: true });

// 3. Package.
execFileSync("npx", ["--yes", "@vscode/vsce", "package", "--allow-missing-repository", "--skip-license"], {
  cwd: stage,
  stdio: "inherit",
});
console.log("\nVSIX written to", join(stage, `${pkg.name}-${pkg.version}.vsix`));
