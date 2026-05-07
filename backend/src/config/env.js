import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..", "..");

function asBool(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export const env = {
  backendRoot,
  dataDir: path.resolve(backendRoot, "data"),
  uploadsDir: path.resolve(backendRoot, "data", "uploads"),
  jobsPath: path.resolve(backendRoot, "data", "jobs.json"),
  usersPath: path.resolve(backendRoot, "data", "users.json"),
  sessionDir: path.resolve(backendRoot, "data", "sessions"),
  duckdbPath: process.env.DUCKDB_PATH || path.resolve(backendRoot, "data", "analytics.duckdb"),
  cacheTtlMs: Number(process.env.ANALYTICS_CACHE_TTL_MS || 20_000),
  maxUploadSizeMb: Number(process.env.MAX_UPLOAD_MB || 100),
  sessionSecret: process.env.SESSION_SECRET || "change-this-session-secret",
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_MS || 1000 * 60 * 60 * 12),
  analyticsPathMode: process.env.ANALYTICS_PATH_MODE || "legacy",
  enableShadowParity: asBool(process.env.ANALYTICS_ENABLE_SHADOW_PARITY, false),
};
