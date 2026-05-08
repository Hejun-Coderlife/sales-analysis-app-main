import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..", "..");
const projectRoot = path.resolve(backendRoot, "..");

dotenv.config({ path: path.join(projectRoot, ".env") });

function resolveSessionStore() {
  const raw = String(process.env.SESSION_STORE || "").trim().toLowerCase();
  if (raw === "memory") return "memory";
  if (raw === "file") return "file";
  // session-file-store uses rename-on-write; on Windows this often surfaces as EPERM under AV/indexers/PM2.
  return process.platform === "win32" ? "memory" : "file";
}

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
  auditLogsPath: path.resolve(backendRoot, "data", "audit-logs.json"),
  notificationsPath: path.resolve(backendRoot, "data", "notifications.json"),
  usersPath: path.resolve(backendRoot, "data", "users.json"),
  sessionDir: path.resolve(backendRoot, "data", "sessions"),
  duckdbPath: process.env.DUCKDB_PATH || path.resolve(backendRoot, "data", "analytics.duckdb"),
  cacheTtlMs: Number(process.env.ANALYTICS_CACHE_TTL_MS || 20_000),
  maxUploadSizeMb: Number(process.env.MAX_UPLOAD_MB || 100),
  sessionSecret: process.env.SESSION_SECRET || "change-this-session-secret",
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_MS || 1000 * 60 * 60 * 12),
  /** "memory" | "file" — default memory on Windows, file elsewhere unless SESSION_STORE is set */
  sessionStore: resolveSessionStore(),
  analyticsPathMode: process.env.ANALYTICS_PATH_MODE || "legacy",
  enableShadowParity: asBool(process.env.ANALYTICS_ENABLE_SHADOW_PARITY, false),

  /** Public site URL for links in outbound notifications (no trailing slash required). */
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || "").trim(),
  /** DingTalk internal app credentials (server-only; never send to frontend). */
  dingtalkAppKey: String(process.env.DINGTALK_APP_KEY || "").trim(),
  dingtalkAppSecret: String(process.env.DINGTALK_APP_SECRET || "").trim(),
  dingtalkAgentId: String(process.env.DINGTALK_AGENT_ID || "").trim(),
  dingtalkTestUserId: String(process.env.DINGTALK_TEST_USER_ID || "").trim(),
};
