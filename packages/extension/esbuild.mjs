import esbuild from "esbuild";

/**
 * Bundle the extension into a single CJS file for packaging.
 * Bundles the workspace packages (@cursorsync/*) and @supabase/supabase-js, but EXTERNALIZES:
 *   - `vscode`        — provided by the editor at runtime
 *   - `better-sqlite3`— a native module; shipped separately and rebuilt for the editor's Electron ABI
 */
const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode", "better-sqlite3"],
  sourcemap: true,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
