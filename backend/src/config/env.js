import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..", "..");
const projectRoot = path.resolve(backendRoot, "..");

dotenv.config({ path: path.join(projectRoot, ".env") });

/** 与钉钉「网页应用 / 端内免登」对外展示一致；未配置 PUBLIC_BASE_URL 时默认 https://app.hemei.asia */
const DEFAULT_PUBLIC_SITE_ORIGIN = "https://app.hemei.asia";
function resolvePublicSiteOrigin() {
  const raw = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  return raw || DEFAULT_PUBLIC_SITE_ORIGIN;
}

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

function resolveSessionSecret() {
  const raw = String(process.env.SESSION_SECRET || "").trim();
  if (raw) {
    if (process.env.NODE_ENV === "production" && raw === "change-this-session-secret") {
      throw new Error("SESSION_SECRET must not use the default value in production");
    }
    return raw;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production");
  }
  return "change-this-session-secret";
}

const publicSiteOrigin = resolvePublicSiteOrigin();

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
  sessionSecret: resolveSessionSecret(),
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_MS || 1000 * 60 * 60 * 12),
  /** "memory" | "file" — default memory on Windows, file elsewhere unless SESSION_STORE is set */
  sessionStore: resolveSessionStore(),
  analyticsPathMode: process.env.ANALYTICS_PATH_MODE || "legacy",
  enableShadowParity: asBool(process.env.ANALYTICS_ENABLE_SHADOW_PARITY, false),

  /** Public site URL for links in outbound notifications (no trailing slash required). */
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || "").trim(),
  /** Canonical origin actually used when PUBLIC_BASE_URL 为空（默认 app.hemei.asia）。 */
  publicSiteOrigin,
  /** 钉钉工作台建议配置的移动端首页与端内免登地址（完整 URL）。 */
  publishedMobileUrl: `${publicSiteOrigin}/mobile`,
  /** OAuth 可选回调示例 URL（钉钉「重定向 URL」仍可填此项）。 */
  publishedDingtalkCallbackUrl: `${publicSiteOrigin}/dingtalk/callback`,
  /** DingTalk internal app credentials (server-only; never send to frontend). */
  dingtalkCorpId: String(process.env.DINGTALK_CORP_ID || "").trim(),
  dingtalkAppKey: String(process.env.DINGTALK_APP_KEY || "").trim(),
  dingtalkAppSecret: String(process.env.DINGTALK_APP_SECRET || "").trim(),
  dingtalkAgentId: String(process.env.DINGTALK_AGENT_ID || "").trim(),
  dingtalkTestUserId: String(process.env.DINGTALK_TEST_USER_ID || "").trim(),
};
