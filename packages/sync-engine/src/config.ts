import { config as loadDotenv } from "dotenv";

/**
 * cursorsync runtime configuration, loaded from environment (.env in dev).
 * No secrets are ever committed: real values live in a gitignored `.env`.
 * Only the Supabase ANON key is used (RLS-scoped) — never the service_role key.
 */
export interface CursorsyncConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  powersyncUrl: string;
  cursorDbPath?: string;
  syncAgentBlobs: boolean;
}

let loaded = false;

/** Load `.env` once (no-op if already loaded or running where env is pre-populated). */
export function ensureEnvLoaded(): void {
  if (!loaded) {
    loadDotenv();
    loaded = true;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith("YOUR-") || v.startsWith("your-")) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

/** Build validated config from the environment. Throws if required vars are absent. */
export function loadConfig(): CursorsyncConfig {
  ensureEnvLoaded();
  return {
    supabaseUrl: required("SUPABASE_URL"),
    supabaseAnonKey: required("SUPABASE_ANON_KEY"),
    powersyncUrl: required("POWERSYNC_URL"),
    cursorDbPath: process.env.CURSOR_DB_PATH || undefined,
    syncAgentBlobs: /^true$/i.test(process.env.SYNC_AGENT_BLOBS ?? "false"),
  };
}
