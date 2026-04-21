const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

const initialEnvKeys = new Set(Object.keys(process.env));

function loadEnvFile(filename, options = {}) {
  const filePath = path.join(process.cwd(), filename);

  if (!fs.existsSync(filePath)) {
    return;
  }

  const parsed = dotenv.parse(fs.readFileSync(filePath));

  for (const [key, value] of Object.entries(parsed)) {
    if (initialEnvKeys.has(key)) {
      continue;
    }

    if (options.overrideLoaded || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local", { overrideLoaded: true });

const cwd = process.cwd();

function resolvePath(filePath, fallback) {
  const target = filePath || fallback;
  return path.isAbsolute(target) ? target : path.join(cwd, target);
}

function getSupabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
}

function requireSupabaseEnv() {
  if (!process.env.SUPABASE_URL || !getSupabaseKey()) {
    throw new Error(
      "SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY wajib diisi sebelum menjalankan sync.",
    );
  }
}

module.exports = {
  cwd,
  defaultSource: process.env.DEFAULT_SOURCE || "codex",
  dbPath: resolvePath(process.env.LOCAL_DB_PATH, ".data/codex-chat.sqlite"),
  getSupabaseKey,
  pollIntervalMs: Number(process.env.SYNC_POLL_INTERVAL_MS || 5000),
  requireSupabaseEnv,
  supabaseUrl: process.env.SUPABASE_URL || "",
};
