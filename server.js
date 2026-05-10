import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import FileStoreFactory from "session-file-store";
import { getV2Router, getV2Services, initV2AnalyticsModule } from "./backend/src/app.js";
import { env } from "./backend/src/config/env.js";
import { AuthService, normalizeAccountName } from "./backend/src/auth/authService.js";
import { createAuthMiddleware, safeInternalRedirectPath, safeLoginNextPath } from "./backend/src/auth/middleware.js";
import { AuditLogStore } from "./backend/src/services/auditLogStore.js";
import { AiChatQueryLogStore, createAiChatQueryMonitor } from "./backend/src/services/aiChatQueryLogStore.js";
import { createAgentDatasetToolsService } from "./backend/src/services/agentDatasetToolsService.js";
import { sendDingTalkTestWorkNotification } from "./backend/src/services/dingtalkWorkNotifyService.js";
import { NotificationStore } from "./backend/src/services/notificationStore.js";
import {
  applyPermissionScopeToFilters,
  finalizeMemberRowsForAgentTools,
  getRolePermissionTemplateByDefinedId,
  hasPermission,
  maskSensitiveMemberRows,
  deepSanitizeAgentToolPayload,
  redactMainlandMobilesInText,
  syncCustomRolesFromCatalog,
  toPublicUser,
} from "./backend/src/auth/permissionModel.js";
import {
  createCustomRole,
  deleteCustomRole,
  getRoleCatalogForApi,
  initRoleCatalog,
  isRoleDefinitionKnown,
  listCustomRoleIdsLoaded,
  patchRoleCatalogEntry,
} from "./backend/src/services/roleCatalogStore.js";

const app = express();
app.disable("x-powered-by");
const port = process.env.PORT || 3000;
const disableV2Api = String(process.env.DISABLE_V2_API || "0") === "1";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_HISTORY_MESSAGES = 24;
const sessions = new Map();
const salesContexts = new Map();
/** LRU-ish activity time per conversation id (sessions + salesContexts share ids). */
const chatConversationActivity = new Map();
/** conversationId -> userId — used for `/api/chat/history` ACL when会话仅有消息条目。 */
const chatConversationOwners = new Map();
const CHAT_STATE_TTL_MS = Math.max(
  60_000,
  Number(process.env.CHAT_STATE_TTL_MS || 4 * 60 * 60 * 1000)
);
const CHAT_MAX_CONVERSATIONS = Math.max(50, Math.min(5000, Number(process.env.CHAT_MAX_CONVERSATIONS || 500)));
/** Model rounds that may each include one or more tool calls; long questions need more than 3–4. */
const MAX_TOOL_CALL_STEPS = 8;
const OUT_OF_SCOPE_MESSAGE = "你没有权限查看该范围的数据。";
const authService = new AuthService({ usersPath: env.usersPath });
const { getCurrentUser, requireAuthApi, requireAuthPage, requirePermission, requireAdminApi } =
  createAuthMiddleware(authService);
const { analyticsService, jobStore, invalidateV2ResponseCache } = getV2Services();
const auditLogStore = new AuditLogStore({ logPath: env.auditLogsPath });
const aiChatQueryLogStore = new AiChatQueryLogStore({ logPath: env.aiChatQueriesLogPath });
const agentDatasetToolsService = createAgentDatasetToolsService({ analyticsService });
const notificationStore = new NotificationStore({ notificationsPath: env.notificationsPath });
const loginAttempts = new Map();
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 10;

const CHAT_API_RATE_WINDOW_MS = Math.max(
  10_000,
  Number(process.env.CHAT_API_RATE_WINDOW_MS || 60_000)
);
const CHAT_API_MAX_PER_WINDOW = Math.max(
  1,
  Math.min(200, Number(process.env.CHAT_API_MAX_PER_WINDOW || 20))
);
const chatApiBuckets = new Map();
const AI_VERIFICATION_TIER = String(process.env.AI_VERIFICATION_TIER || "medium").trim().toLowerCase();
const CHAT_MODEL_MAX_RETRIES =
  AI_VERIFICATION_TIER === "high" ? 3 : AI_VERIFICATION_TIER === "medium" ? 2 : 1;
const MEDIUM_TIER_DOUBLE_CHECK_TOOLS = new Set(["getKpiFromDataset", "getStoreRankingFromDataset"]);

process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[process] uncaughtException:", error);
});

async function appendAuditLog(entry = {}) {
  try {
    await auditLogStore.append(entry);
  } catch (_error) {
    // Audit persistence should never break main business flow.
  }
}

/** Prefer real uploaded filenames when a job lists multiple files (payload.fileNames). */
function formatImportJobDisplayName(job) {
  const payload = job?.payload || {};
  const names = payload.fileNames;
  if (Array.isArray(names) && names.length > 0) {
    const clean = names.map((n) => String(n || "").trim()).filter(Boolean);
    if (!clean.length) return String(payload.sourceName || "");
    if (clean.length === 1) return clean[0];
    const joined = clean.join(" · ");
    if (joined.length <= 200) return joined;
    return `${clean[0]} 等 ${clean.length} 个文件`;
  }
  return String(payload.sourceName || "");
}

async function findIngestJobByDatasetId(datasetId) {
  const id = String(datasetId || "").trim();
  if (!id) return null;
  const data = await jobStore.listJobs({ type: "ingest", limit: 500, offset: 0 });
  return (data.rows || []).find((j) => j.datasetId === id) || null;
}

async function getDingTalkAccessToken({ appKey, appSecret }) {
  const url = new URL("https://oapi.dingtalk.com/gettoken");
  url.searchParams.set("appkey", String(appKey || ""));
  url.searchParams.set("appsecret", String(appSecret || ""));
  const resp = await fetch(url.toString(), { method: "GET" });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("钉钉令牌请求失败");
  if (Number(data.errcode || 0) !== 0 || !data.access_token) {
    throw new Error(data.errmsg || "钉钉令牌获取失败");
  }
  return String(data.access_token);
}

async function getDingTalkUserIdByCode({ accessToken, code }) {
  const url = new URL("https://oapi.dingtalk.com/topapi/v2/user/getuserinfo");
  url.searchParams.set("access_token", String(accessToken || ""));
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: String(code || "") }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("钉钉用户信息请求失败");
  if (Number(data.errcode || 0) !== 0 || !data.result?.userid) {
    throw new Error(data.errmsg || "钉钉免登 code 换取 userid 失败");
  }
  return String(data.result.userid);
}

/** 钉钉端内可能带 code、authCode 或 auth_code，统一读出供换 userid */
function readDingTalkAuthCodeFromQuery(req) {
  const q = req.query || {};
  return String(q.code || q.authCode || q.auth_code || "").trim();
}

function readDingTalkAuthCodeFromBody(body) {
  const b = body && typeof body === "object" ? body : {};
  return String(b.code || b.authCode || b.auth_code || "").trim();
}

function buildDingTalkSsoNoCodeHtml() {
  const mobileUrl = env.publishedMobileUrl;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>请在钉钉内打开</title></head><body style="font-family:system-ui,sans-serif;padding:24px;max-width:520px;margin:40px auto;">
<h2 style="margin:0 0 12px;">请从钉钉工作台打开应用</h2>
<p style="color:#4b5563;line-height:1.6;margin:0;">本入口需要在钉钉客户端内使用（需携带免登码，参数名为 <strong>code</strong> / <strong>authCode</strong> / <strong>auth_code</strong> 均可）。请在 <strong>钉钉工作台</strong> 中将应用首页与端内免登地址配置为 <strong>${mobileUrl}</strong>（与服务器约定一致），或联系管理员获取正确入口。</p>
</body></html>`;
}

const DINGTALK_SSO_ADMIN_FORBIDDEN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>无访问权限</title></head><body style="font-family:system-ui,sans-serif;padding:24px;max-width:520px;margin:40px auto;">
<h2 style="margin:0 0 12px;">无管理后台访问权限</h2>
<p style="color:#4b5563;line-height:1.6;margin:0;">当前登录账号无权进入管理后台。请确认已从钉钉工作台进入「管理员」应用入口，或使用有后台权限的账号；也可在浏览器使用账号密码登录。</p>
</body></html>`;

/**
 * 钉钉端内免登：换 code → userid → 绑定用户 → session（不记录 access_token）
 * @param {{ requireAdminAccess?: boolean, defaultNext?: string }} opts
 */
async function handleDingTalkSso(req, res, opts = {}) {
  const requireAdminAccess = Boolean(opts.requireAdminAccess);
  const defaultNext = String(opts.defaultNext || "/mobile");
  const code = readDingTalkAuthCodeFromQuery(req);
  const nextPath = safeInternalRedirectPath(String(req.query.next || "").trim() || defaultNext, defaultNext);

  if (!code) {
    return res.status(200).type("html").send(buildDingTalkSsoNoCodeHtml());
  }

  try {
    if (!env.dingtalkAppKey || !env.dingtalkAppSecret) {
      return res.redirect(
        `/login?dingtalk_error=${encodeURIComponent("服务端未配置钉钉凭证，请联系管理员配置 DINGTALK_APP_KEY / DINGTALK_APP_SECRET")}`
      );
    }

    const accessToken = await getDingTalkAccessToken({
      appKey: env.dingtalkAppKey,
      appSecret: env.dingtalkAppSecret,
    });
    const dingUid = await getDingTalkUserIdByCode({ accessToken, code });
    const record = await authService.findByDingTalkUserId(dingUid);
    if (!record) {
      return res.redirect(
        `/login?dingtalk_error=${encodeURIComponent("当前钉钉账号尚未绑定系统账号，请联系管理员绑定钉钉 UserID 或使用账号密码登录")}`
      );
    }
    if (!record.enabled || String(record.role || "") === "disabled") {
      return res.redirect(`/login?dingtalk_error=${encodeURIComponent("该账号已停用，无法登录")}`);
    }

    const publicUser = toPublicUser(record);
    if (requireAdminAccess && !hasPermission(publicUser, "canAccessAdmin")) {
      return res.status(403).type("html").send(DINGTALK_SSO_ADMIN_FORBIDDEN_HTML);
    }

    req.session.user = publicUser;
    await authService.touchLastLogin(record.id);
    return res.redirect(nextPath);
  } catch (err) {
    const safeMsg = String(err?.message || "").trim() || "钉钉免登失败，请稍后重试或改用账号密码登录";
    console.warn("[dingtalk-sso] exchange failed:", safeMsg.split(/\s+/).slice(0, 8).join(" "));
    return res.redirect(`/login?dingtalk_error=${encodeURIComponent(safeMsg)}`);
  }
}

function ensurePermissionOrDeny(res, user, permissionName) {
  if (hasPermission(user, permissionName)) return true;
  res.status(403).json({ error: "无权限访问" });
  return false;
}

/** 编辑岗位目录需「管理员」身份 + 人事管理权限，避免大范围岗位被低信任账号改写。 */
function requireRoleCatalogAdmin(req, res) {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canManageUsers")) return false;
  if (String(req.currentUser?.role || "") !== "admin") {
    res.status(403).json({ error: "维护岗位目录需使用管理员账号登录" });
    return false;
  }
  return true;
}

function setSecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
}

function requestLooksSameOrigin(req) {
  const origin = String(req.get("origin") || "").trim();
  const referer = String(req.get("referer") || "").trim();
  const host = String(req.get("host") || "").trim();
  const fallbackBase = host ? `${req.protocol}://${host}` : "";
  const expectedBase = String(env.publicBaseUrl || "").trim() || fallbackBase;
  if (!expectedBase) return true;
  const expected = new URL(expectedBase).origin;
  if (origin) {
    return origin === expected;
  }
  if (referer) {
    try {
      return new URL(referer).origin === expected;
    } catch (_error) {
      return false;
    }
  }
  // Non-browser clients may omit both Origin/Referer. Allow local loopback only.
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  const hostNoPort = host.split(":")[0].toLowerCase();
  return loopbackHosts.has(hostNoPort);
}

function csrfLikeOriginGuard(req, res, next) {
  const method = String(req.method || "").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (!requestLooksSameOrigin(req)) {
    return res.status(403).json({ error: "跨站请求被拒绝" });
  }
  return next();
}

function cleanupExpiredLoginAttempts(nowMs) {
  for (const [key, item] of loginAttempts.entries()) {
    if (!item || nowMs - Number(item.firstAt || 0) > LOGIN_RATE_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}

function loginRateLimit(req, res, next) {
  const now = Date.now();
  cleanupExpiredLoginAttempts(now);
  const username = normalizeAccountName(String(req.body?.username || ""));
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const key = `${ip}|${username || "_"}`;
  const bucket = loginAttempts.get(key);
  if (bucket && now - bucket.firstAt <= LOGIN_RATE_WINDOW_MS && bucket.count >= LOGIN_RATE_MAX_ATTEMPTS) {
    return res.status(429).json({ error: "登录尝试过于频繁，请稍后重试" });
  }
  req.__loginRateKey = key;
  return next();
}

function markLoginAttemptResult(req, ok) {
  const key = req.__loginRateKey;
  if (!key) return;
  if (ok) {
    loginAttempts.delete(key);
    return;
  }
  const now = Date.now();
  const prev = loginAttempts.get(key);
  if (!prev || now - prev.firstAt > LOGIN_RATE_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now });
    return;
  }
  loginAttempts.set(key, { count: Number(prev.count || 0) + 1, firstAt: prev.firstAt });
}

function getConversationId(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return null;
  return value.slice(0, 64);
}

function deleteChatConversation(conversationId) {
  const id = String(conversationId || "").trim();
  if (!id) return;
  chatConversationActivity.delete(id);
  chatConversationOwners.delete(id);
  sessions.delete(id);
  salesContexts.delete(id);
}

function rememberChatConversationOwner(conversationId, userId) {
  const id = String(conversationId || "").trim();
  const uid = String(userId || "").trim();
  if (!id || !uid) return;
  chatConversationOwners.set(id, uid);
}

/**
 * OpenAI 要求：每条 role=tool 的消息必须紧跟在带对应 tool_calls 的 assistant 之后。
 * 会话用 slice(-N) 截断时，常把前面的 assistant(tool_calls) 切掉、却留下 tool，导致报错：
 * "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'".
 */
function repairChatMessagesForApi(messages) {
  if (!Array.isArray(messages)) return [];
  const m = messages.filter((x) => x && typeof x === "object");

  while (m.length > 0 && String(m[0].role || "") === "tool") {
    m.shift();
  }

  let i = 0;
  while (i < m.length) {
    const role = String(m[i].role || "");
    if (role === "assistant" && Array.isArray(m[i].tool_calls) && m[i].tool_calls.length > 0) {
      const idSet = new Map(
        (m[i].tool_calls || []).map((tc) => [String(tc?.id || "").trim(), true]).filter(([id]) => id)
      );
      let j = i + 1;
      const got = Object.create(null);
      while (j < m.length && String(m[j].role || "") === "tool") {
        const tid = String(m[j].tool_call_id || "").trim();
        if (!idSet.has(tid) || got[tid]) break;
        got[tid] = true;
        j++;
      }
      const complete = idSet.size > 0 && idSet.size === Object.keys(got).length;
      if (complete) {
        i = j;
        continue;
      }
      let end = i + 1;
      while (end < m.length && String(m[end].role || "") === "tool") end += 1;
      m.splice(i, end - i);
      while (i < m.length && String(m[i].role || "") === "tool") m.splice(i, 1);
      continue;
    }
    i += 1;
  }

  while (m.length > 0 && String(m[0].role || "") === "tool") {
    m.shift();
  }
  while (m.length > 0) {
    const last = m[m.length - 1];
    if (String(last.role || "") === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
      m.pop();
      continue;
    }
    break;
  }

  return m;
}

/** Build client-safe bubbles: drop system/tool and assistant rows that only carried tool_calls. */
function sanitizeChatMessagesForHistoryClient(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "");
    if (role === "tool" || role === "system") continue;
    if (role === "user") {
      const c = String(m.content || "").trim();
      if (c) out.push({ role: "user", content: c });
      continue;
    }
    if (role === "assistant") {
      const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      const c = String(m.content || "").trim();
      if (!c || hasTools) continue;
      out.push({ role: "assistant", content: c });
    }
  }
  return out;
}

function userOwnsConversation(conversationId, userId) {
  const id = String(conversationId || "").trim();
  const uid = String(userId || "").trim();
  if (!id || !uid) return false;
  const recorded = chatConversationOwners.get(id);
  const ctxUid = salesContexts.get(id)?.userId;
  const hasStake =
    recorded != null || (ctxUid != null && String(ctxUid || "").trim().length > 0);
  if (!hasStake) return true;
  if (recorded === uid) return true;
  return ctxUid != null && String(ctxUid) === uid;
}

function touchChatConversation(conversationId) {
  const id = String(conversationId || "").trim();
  if (!id) return;
  chatConversationActivity.set(id, Date.now());
  pruneChatStateMaps();
}

function pruneChatStateMaps() {
  const now = Date.now();
  const staleIds = [];
  for (const [id, lastAt] of chatConversationActivity.entries()) {
    if (now - Number(lastAt || 0) > CHAT_STATE_TTL_MS) {
      staleIds.push(id);
    }
  }
  for (const id of staleIds) {
    deleteChatConversation(id);
  }
  if (chatConversationActivity.size <= CHAT_MAX_CONVERSATIONS) return;
  const ordered = [...chatConversationActivity.entries()].sort((a, b) => Number(a[1]) - Number(b[1]));
  while (ordered.length && chatConversationActivity.size > CHAT_MAX_CONVERSATIONS) {
    const [id] = ordered.shift();
    deleteChatConversation(id);
  }
}

function cleanupStaleChatBuckets(nowMs, store, windowMs) {
  for (const [key, item] of store.entries()) {
    if (!item || nowMs - Number(item.windowStart || 0) > windowMs) {
      store.delete(key);
    }
  }
}

function chatApiRateLimit(req, res, next) {
  const now = Date.now();
  cleanupStaleChatBuckets(now, chatApiBuckets, CHAT_API_RATE_WINDOW_MS);
  const userPart = String(req.currentUser?.id || req.session?.user?.id || "").trim();
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const key = userPart ? `u:${userPart}` : `ip:${ip}`;

  const prev = chatApiBuckets.get(key);
  if (!prev || now - prev.windowStart > CHAT_API_RATE_WINDOW_MS) {
    chatApiBuckets.set(key, { count: 1, windowStart: now });
    return next();
  }
  if (prev.count >= CHAT_API_MAX_PER_WINDOW) {
    return res.status(429).json({ error: "对话请求过于频繁，请稍后重试" });
  }
  chatApiBuckets.set(key, { count: prev.count + 1, windowStart: prev.windowStart });
  return next();
}

/** Aligns model tool calls with the last `/api/chat/context` payload so /mobile and /dashboard stay consistent. */
function buildDashboardFilterHintFromSyncedContext(context) {
  if (!context || typeof context !== "object") return "";
  const f = context.filters;
  if (!f || typeof f !== "object") return "";
  const start = String(f.startDate || "").trim();
  const end = String(f.endDate || "").trim();
  const parts = [];
  if (start && end) parts.push(`日期 ${start}～${end}`);
  else if (start || end) parts.push(`日期 ${start || "?"}～${end || "?"}`);
  parts.push(
    "门店/销售员/商品：不与看板多选联动，filters 中 stores、salespeople、products 默认留空＝该账号在后台权限内的全量；仅当用户这句话里明确只要某一店/某人/某品时才在工具参数中收窄"
  );
  return (
    "【本回合数据助手取数口径（与看板列表展示无关）】" +
    parts.join("；") +
    "。凡查询 KPI、排行、趋势、沉睡会员，以及「销售员—门店」（getSalespersonStoreBreakdownFromDataset / getStoresForSalespersonFromDataset）、「给定会员查导购」（getMemberSalespersonBreakdownFromDataset）、「给定导购查名下会员」（getMembersForSalespersonFromDataset），必须在 filters 中传入与上述一致的 startDate/endDate，并按上一句规则处理门店/销售员/商品三项。后台为已导入明细，优先于页面摘要。"
  );
}

/** 典型「哪家店」问法中提取销售员姓名（去空格后匹配） */
function extractSalespersonNameForStoreQuestion(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact || compact.length > 120) return "";
  const patterns = [
    /^([\u4e00-\u9fa5·]{2,16})是哪家店/,
    /^([\u4e00-\u9fa5·]{2,16})是哪个店/,
    /^([\u4e00-\u9fa5·]{2,16})在哪(?:个|间)店/,
    /^([\u4e00-\u9fa5·]{2,16})在哪个门店/,
    /^([\u4e00-\u9fa5·]{2,16})(?:是)?哪个店的(?:销售|导购|营业员)/,
    /哪(?:家|个)(?:门)?店的(?:销售|导购|营业员)[是为]?([\u4e00-\u9fa5·]{2,16})/,
    /(?:销售|导购|营业员)(?:员)?[是为]?([\u4e00-\u9fa5·]{2,16})(?:是)?哪家店/,
  ];
  for (const re of patterns) {
    const m = compact.match(re);
    if (m && m[1]) return String(m[1]).trim();
  }
  return "";
}

/**
 * 对用户提到的销售员自动跑一次「销售员×门店」查询，把结果写进系统提示，避免模型漏调工具仍说「无映射」。
 */
async function maybePrequerySalespersonStoreBlocks(ctxEntry, userMessage, currentUser, accessScope) {
  if (!userMessage || !ctxEntry?.context) return "";
  if (!hasPermission(currentUser, "canViewSalespersonRanking")) return "";
  if (!hasPermission(currentUser, "canViewStoreRanking")) return "";
  const name = extractSalespersonNameForStoreQuestion(userMessage);
  if (!name) return "";
  const f = ctxEntry.context.filters || {};
  const filters = {
    startDate: String(f.startDate || ""),
    endDate: String(f.endDate || ""),
    stores: Array.isArray(f.stores) ? f.stores : [],
    salespeople: Array.isArray(f.salespeople) ? f.salespeople : [],
    products: Array.isArray(f.products) ? f.products : [],
  };
  try {
    const toolResult = await agentDatasetToolsService.runToolCall({
      currentUser,
      accessScope,
      toolName: "getSalespersonStoreBreakdownFromDataset",
      toolArgs: { filters, salespersonContains: name, limit: 80 },
    });
    const fmt = (n) =>
      Number.isFinite(Number(n))
        ? Number(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : "—";
    if (!toolResult?.ok) {
      return (
        `\n\n【系统预查】已尝试按姓名「${name}」查询门店归属，未成功（${String(toolResult?.error || toolResult?.code || "未知")}）。` +
        `请提示用户核对日期筛选是否与页面一致；不要随意说缺少映射表。`
      );
    }
    const summary = toolResult.summary || {};
    const rows = Array.isArray(toolResult.rows) ? toolResult.rows : [];
    if (!rows.length) {
      return (
        `\n\n【系统预查】姓名关键字「${name}」在当前筛选日期与权限下无门店拆分记录；可能姓名与导入不一致或区间内无订单。` +
        `不要说「系统无法关联营业员与门店」。`
      );
    }
    const lines = rows
      .slice(0, 10)
      .map((r) => `  · ${String(r.store || "—")}：${fmt(r.performance)} 元`)
      .join("\n");
    return (
      `\n\n【系统预查·回答时请优先采用以下事实】` +
      `销售员关键字「${name}」：业绩最高的门店为「${summary.primaryStore || rows[0]?.store || "—"}」（约 ${fmt(summary.primaryPerformance)} 元）；` +
      `共 ${summary.storeCount != null ? summary.storeCount : rows.length} 个门店有订单归属。\n门店明细（节选）：\n${lines}\n` +
      `（以上为后台订单按门店聚合；不要说没有营业员与门店的关联。）`
    );
  } catch (_err) {
    return "";
  }
}

/** 写入 AI 提问监控时的页面筛选快照（仅 filters，避免体积过大） */
function buildSalesContextPreviewForMonitor(context) {
  if (!context || typeof context !== "object") return null;
  const f = context.filters;
  if (!f || typeof f !== "object") return null;
  const sliceArr = (arr, max) =>
    Array.isArray(arr) ? arr.slice(0, max).map((x) => String(x || "").trim()).filter(Boolean) : [];
  return {
    startDate: String(f.startDate || "").trim(),
    endDate: String(f.endDate || "").trim(),
    stores: sliceArr(f.stores, 40),
    salespeople: sliceArr(f.salespeople, 40),
    products: sliceArr(f.products, 30),
  };
}

function getSessionMessages(conversationId) {
  if (!conversationId) return [];
  pruneChatStateMaps();
  const id = String(conversationId);
  const lastAt = chatConversationActivity.get(id);
  if (lastAt != null && Date.now() - Number(lastAt) > CHAT_STATE_TTL_MS) {
    deleteChatConversation(id);
    return [];
  }
  touchChatConversation(id);
  const raw = sessions.get(conversationId) || [];
  return repairChatMessagesForApi(raw);
}

function setSessionMessages(conversationId, messages) {
  if (!conversationId || !Array.isArray(messages)) return;
  const truncated = messages.slice(-MAX_HISTORY_MESSAGES);
  sessions.set(conversationId, repairChatMessagesForApi(truncated));
  touchChatConversation(conversationId);
}

let cachedEarthEdgesData = "";
function getEarthEdgesData() {
  if (cachedEarthEdgesData) return cachedEarthEdgesData;
  try {
    const indexPath = path.join(__dirname, "index.html");
    const html = fs.readFileSync(indexPath, "utf8");
    const match = html.match(/<script id="earth-edges-data" type="text\/plain">([\s\S]*?)<\/script>/);
    cachedEarthEdgesData = (match && match[1] ? String(match[1]).trim() : "");
  } catch (_error) {
    cachedEarthEdgesData = "";
  }
  return cachedEarthEdgesData;
}

function stripThinkingBlocks(text) {
  let out = String(text || "");
  const blockPatterns = [
    new RegExp("<think>[\\s\\S]*?<" + "/think>", "gi"),
    new RegExp("<think" + "ing>[\\s\\S]*?<" + "/think" + "ing>", "gi"),
    new RegExp("<think" + "ing>[\\s\\S]*?<" + "/think" + ">", "gi"),
    new RegExp("<redacted_reason" + "ing>[\\s\\S]*?<" + "/redacted_reason" + "ing>", "gi"),
  ];
  for (const re of blockPatterns) {
    out = out.replace(re, "");
  }
  out = out.replace(/<\/?think>/gi, "");
  return out.trim();
}

function normalizeAssistantReply(text) {
  let value = String(text || "");
  // Remove markdown emphasis/heading syntax and normalize bullets.
  value = value
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ");
  // Keep emoji in replies for分段可读性；仅在连续重复时轻度收敛（不删合法表情）。
  value = value.replace(/([\p{Extended_Pictographic}\uFE0F])\1{3,}/gu, "$1$1$1");

  // Convert markdown-like tables to plain text rows.
  const lines = value.split("\n");
  const normalizedLines = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\|?[\s:-]+(\|[\s:-]+)+\|?$/.test(line)) {
      continue; // skip separator rows like |---|---|
    }
    if (line.includes("|")) {
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length) {
        normalizedLines.push(cells.join("｜"));
        continue;
      }
    }
    normalizedLines.push(rawLine);
  }
  value = normalizedLines.join("\n");

  // Clean extra whitespace introduced by replacements.
  value = value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  value = redactMainlandMobilesInText(value);
  return value;
}

function firstRankingRow(result) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (!rows.length) return null;
  return rows[0] || null;
}

function sameFilterRange(a, b) {
  const fa = a && typeof a === "object" ? a : {};
  const fb = b && typeof b === "object" ? b : {};
  return String(fa.startDate || "") === String(fb.startDate || "") && String(fa.endDate || "") === String(fb.endDate || "");
}

function verifyCriticalConsistency(toolName, firstResult, secondResult) {
  if (!firstResult?.ok || !secondResult?.ok) return true;
  if (toolName === "getKpiFromDataset") {
    const a = firstResult?.data || {};
    const b = secondResult?.data || {};
    const salesDiff = Math.abs(Number(a.totalSales || 0) - Number(b.totalSales || 0));
    const orderDiff = Math.abs(Number(a.totalOrders || 0) - Number(b.totalOrders || 0));
    return salesDiff < 0.01 && orderDiff < 0.01 && sameFilterRange(firstResult.filters, secondResult.filters);
  }
  if (toolName === "getStoreRankingFromDataset") {
    const ra = firstRankingRow(firstResult);
    const rb = firstRankingRow(secondResult);
    if (!ra && !rb) return sameFilterRange(firstResult.filters, secondResult.filters);
    if (!ra || !rb) return false;
    const nameA = String(ra.store || ra.name || "").trim();
    const nameB = String(rb.store || rb.name || "").trim();
    const perfDiff = Math.abs(Number(ra.performance || ra.sales_amount || 0) - Number(rb.performance || rb.sales_amount || 0));
    return nameA === nameB && perfDiff < 0.01 && sameFilterRange(firstResult.filters, secondResult.filters);
  }
  return true;
}

async function callChatCompletionsWithRetry(baseUrl, apiKey, payload, maxRetries = 2) {
  let lastStatus = 502;
  let lastData = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, data };
    lastStatus = response.status;
    lastData = data;
    if (attempt >= maxRetries) break;
  }
  return { ok: false, status: lastStatus, data: lastData || {} };
}

function normalizeDatePart(value) {
  return String(value).padStart(2, "0");
}

function extractDateRangeFromText(text) {
  const raw = String(text || "");
  const regex = /(20\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/g;
  const dates = [];
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const year = match[1];
    const month = normalizeDatePart(match[2]);
    const day = normalizeDatePart(match[3]);
    dates.push(`${year}-${month}-${day}`);
    if (dates.length >= 2) break;
  }
  if (!dates.length) return null;
  if (dates.length === 1) return { startDate: dates[0], endDate: dates[0] };
  return { startDate: dates[0], endDate: dates[1] };
}

function deriveUiActions(userMessage) {
  const raw = String(userMessage || "");
  const lower = raw.toLowerCase();
  const salespersonKeywords = [
    "salesperson",
    "sales person",
    "seller",
    "staff",
    "sales rep",
    "销售员",
    "销售人员",
    "导购",
    "销冠",
  ];
  const rankKeywords = [
    "top",
    "best",
    "rank",
    "ranking",
    "highest",
    "number one",
    "第一",
    "排名",
    "最高",
    "冠军",
  ];

  const hasSalespersonIntent = salespersonKeywords.some((k) => lower.includes(k));
  const hasRankIntent = rankKeywords.some((k) => lower.includes(k));
  const dateRange = extractDateRangeFromText(raw);
  const actions = [];

  if (hasSalespersonIntent && hasRankIntent) {
    actions.push({
      type: "focus_view",
      tab: "rankings",
      mode: "salesperson",
      dateRange,
    });
  }

  const memberKeywords = ["member", "members", "会员", "客户", "复购", "注册率", "留存"];
  if (memberKeywords.some((k) => lower.includes(k))) {
    actions.push({
      type: "focus_view",
      tab: "members",
      mode: "spend",
      dateRange,
    });
  }

  const sleepingKeywords = ["sleep", "sleeping", "沉睡", "唤醒", "流失", "休眠"];
  if (sleepingKeywords.some((k) => lower.includes(k))) {
    actions.push({
      type: "focus_view",
      tab: "sleeping",
      mode: "list",
      dateRange,
    });
  }

  const storeRankKeywords = ["门店排名", "店铺排名", "top store", "top stores"];
  if (storeRankKeywords.some((k) => lower.includes(k))) {
    actions.push({
      type: "focus_view",
      tab: "rankings",
      mode: "store",
      dateRange,
    });
  }

  if (storeRankKeywords.some((k) => lower.includes(k)) || lower.includes("门店排行")) {
    actions.push({ type: "mobile_scroll_to", targetId: "rankStoresCard" });
  }
  if ((hasSalespersonIntent && hasRankIntent) || lower.includes("销售员排行")) {
    actions.push({ type: "mobile_scroll_to", targetId: "rankSalesCard" });
  }
  if (sleepingKeywords.some((k) => lower.includes(k))) {
    actions.push({ type: "mobile_scroll_to", targetId: "sleepCard" });
  }
  if (/(最近7天|近7天|过去7天|last\s*7\s*days?)/i.test(raw)) {
    actions.push({ type: "mobile_set_date_preset", preset: "last7d" });
  }

  return actions;
}

function sanitizeLimit(rawLimit, defaultLimit = 20, maxLimit = 500) {
  const n = Number(rawLimit);
  if (!Number.isFinite(n)) return defaultLimit;
  return Math.max(1, Math.min(maxLimit, Math.floor(n)));
}

/**
 * 数据助手应与账号权限内的后台全量一致，不因看板上的门店/销售员/商品多选而缩小取数。
 * 日期（及沉睡页等特殊字段）仍可与页面同步；维度筛选清空后由 `applyPermissionScopeToFilters` 按权限交集。
 */
function stripDashboardDimensionFiltersForAgentChat(context) {
  if (!context || typeof context !== "object") return context;
  const f = context.filters && typeof context.filters === "object" ? context.filters : {};
  return {
    ...context,
    filters: {
      ...f,
      stores: [],
      salespeople: [],
      products: [],
    },
  };
}

function sanitizeSalesContext(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const list = (value, mapper, max = 500) => (Array.isArray(value) ? value.slice(0, max).map(mapper) : []);
  return {
    updatedAt: String(source.updatedAt || new Date().toISOString()),
    filters: {
      startDate: String(source?.filters?.startDate || ""),
      endDate: String(source?.filters?.endDate || ""),
      stores: Array.isArray(source?.filters?.stores) ? source.filters.stores.slice(0, 50).map((x) => String(x || "")) : [],
      salespeople: Array.isArray(source?.filters?.salespeople) ? source.filters.salespeople.slice(0, 50).map((x) => String(x || "")) : [],
      products: Array.isArray(source?.filters?.products) ? source.filters.products.slice(0, 50).map((x) => String(x || "")) : [],
      sleepingSalesperson: String(source?.filters?.sleepingSalesperson || ""),
    },
    kpis: {
      totalSales: Number(source?.kpis?.totalSales || 0),
      totalOrders: Number(source?.kpis?.totalOrders || 0),
      memberRegistrationRate: Number(source?.kpis?.memberRegistrationRate || 0),
      repurchaseRate: Number(source?.kpis?.repurchaseRate || 0),
      averageRepurchaseTimes: Number(source?.kpis?.averageRepurchaseTimes || 0),
      sleepingMembers: Number(source?.kpis?.sleepingMembers || 0),
      aClassSleepingMembers: Number(source?.kpis?.aClassSleepingMembers || 0),
      filesLoaded: Number(source?.kpis?.filesLoaded || 0),
    },
    topStores: list(source?.topStores, (row) => ({
      store: String(row?.store || "Unknown"),
      performance: Number(row?.performance || 0),
    }), 500),
    topSalespeople: list(source?.topSalespeople, (row) => ({
      salesperson: String(row?.salesperson || "Unknown"),
      performance: Number(row?.performance || 0),
    }), 500),
    salespersonStoreStats: list(source?.salespersonStoreStats, (row) => ({
      salesperson: String(row?.salesperson || "Unknown"),
      store: String(row?.store || "Unknown"),
      performance: Number(row?.performance || 0),
    }), 2000),
    yearlyStorePerformance: list(source?.yearlyStorePerformance, (row) => ({
      year: String(row?.year || ""),
      store: String(row?.store || "Unknown"),
      performance: Number(row?.performance || 0),
    }), 8000),
    monthlyStorePerformance: list(source?.monthlyStorePerformance, (row) => ({
      month: String(row?.month || ""),
      store: String(row?.store || "Unknown"),
      performance: Number(row?.performance || 0),
    }), 12000),
    weeklyStorePerformance: list(source?.weeklyStorePerformance, (row) => ({
      weekStart: String(row?.weekStart || ""),
      store: String(row?.store || "Unknown"),
      performance: Number(row?.performance || 0),
    }), 12000),
    topProducts: list(source?.topProducts, (row) => ({
      product: String(row?.product || "Unknown"),
      sales_amount: Number(row?.sales_amount || 0),
      sales_qty: Number(row?.sales_qty || 0),
      sales_orders: Number(row?.sales_orders || 0),
    }), 500),
    memberRank: list(source?.memberRank, (row) => ({
      member_key: String(row?.member_key || ""),
      member_name: String(row?.member_name || ""),
      total_spend: Number(row?.total_spend || 0),
      order_count: Number(row?.order_count || 0),
      avg_ticket: Number(row?.avg_ticket || 0),
      repurchase_times: Number(row?.repurchase_times || 0),
      phone: String(row?.phone || ""),
      latest_store: String(row?.latest_store || ""),
      latest_salesperson: String(row?.latest_salesperson || ""),
    }), 8000),
    sleepList: list(source?.sleepList, (row) => ({
      member_key: String(row?.member_key || ""),
      member_name: String(row?.member_name || ""),
      total_spend: Number(row?.total_spend || 0),
      order_count: Number(row?.order_count || 0),
      sleep_days: Number(row?.sleep_days || 0),
      priority: String(row?.priority || ""),
      risk_level: String(row?.risk_level || ""),
      last_store: String(row?.last_store || ""),
      last_salesperson: String(row?.last_salesperson || ""),
      phone: String(row?.phone || ""),
    }), 8000),
    memberStorePerformance: list(source?.memberStorePerformance, (row) => ({
      member_key: String(row?.member_key || ""),
      member_name: String(row?.member_name || ""),
      store: String(row?.store || ""),
      total_spend: Number(row?.total_spend || 0),
      order_count: Number(row?.order_count || 0),
    }), 12000),
    salespersonYearlyPerformance: list(source?.salespersonYearlyPerformance, (row) => ({
      year: String(row?.year || ""),
      salesperson: String(row?.salesperson || ""),
      performance: Number(row?.performance || 0),
    }), 15000),
    salespersonMonthlyPerformance: list(source?.salespersonMonthlyPerformance, (row) => ({
      month: String(row?.month || ""),
      salesperson: String(row?.salesperson || ""),
      performance: Number(row?.performance || 0),
    }), 20000),
    salespersonWeeklyPerformance: list(source?.salespersonWeeklyPerformance, (row) => ({
      weekStart: String(row?.weekStart || ""),
      salesperson: String(row?.salesperson || ""),
      performance: Number(row?.performance || 0),
    }), 25000),
    salespersonDailyPerformance: list(source?.salespersonDailyPerformance, (row) => ({
      day: String(row?.day || ""),
      salesperson: String(row?.salesperson || ""),
      performance: Number(row?.performance || 0),
    }), 30000),
    orderSummary: list(source?.orderSummary, (row) => ({
      order_key: String(row?.order_key || ""),
      order_no: String(row?.order_no || ""),
      date: String(row?.date || ""),
      store: String(row?.store || ""),
      salesperson: String(row?.salesperson || ""),
      member_key: String(row?.member_key || ""),
      member_name: String(row?.member_name || ""),
      total_amount: Number(row?.total_amount || 0),
      item_count: Number(row?.item_count || 0),
    }), 15000),
    dailyTrend: list(source?.dailyTrend, (row) => ({
      day: String(row?.day || ""),
      sales_amount: Number(row?.sales_amount || 0),
      store_count: Number(row?.store_count || 0),
    }), 5000),
    monthlyTrend: list(source?.monthlyTrend, (row) => ({
      year_month: String(row?.year_month || row?.month || ""),
      sales_amount: Number(row?.sales_amount || 0),
      store_count: Number(row?.store_count || 0),
    }), 5000),
    weeklyTrend: list(source?.weeklyTrend, (row) => ({
      weekStart: String(row?.weekStart || ""),
      sales_amount: Number(row?.sales_amount || 0),
    }), 5000),
  };
}

function applyScopeToSalesContext(sourceContext, user, scope) {
  const context = sanitizeSalesContext(sourceContext);
  if (!scope || scope.unrestricted) {
    if (!hasPermission(user, "canAskSensitiveMemberQuestions")) {
      context.memberRank = maskSensitiveMemberRows(context.memberRank, user?.allowedMemberFields || {});
      context.sleepList = maskSensitiveMemberRows(context.sleepList, user?.allowedMemberFields || {});
    }
    return context;
  }
  if (scope.forceNoData) {
    return {
      ...context,
      kpis: {
        ...context.kpis,
        totalSales: 0,
        totalOrders: 0,
        memberRegistrationRate: 0,
        repurchaseRate: 0,
        averageRepurchaseTimes: 0,
        sleepingMembers: 0,
        aClassSleepingMembers: 0,
      },
      topStores: [],
      topSalespeople: [],
      salespersonStoreStats: [],
      yearlyStorePerformance: [],
      monthlyStorePerformance: [],
      weeklyStorePerformance: [],
      topProducts: [],
      memberRank: [],
      sleepList: [],
      memberStorePerformance: [],
      salespersonYearlyPerformance: [],
      salespersonMonthlyPerformance: [],
      salespersonWeeklyPerformance: [],
      salespersonDailyPerformance: [],
      orderSummary: [],
      dailyTrend: [],
      monthlyTrend: [],
      weeklyTrend: [],
    };
  }

  const storeSet = new Set(scope.allowedStores || []);
  const salespersonSet = new Set(scope.allowedSalespeople || []);
  const productSet = new Set(scope.allowedProducts || []);
  const canStore = (store) => scope.allowAllStores || !String(store || "").trim() || storeSet.has(String(store || ""));
  const canSalesperson = (salesperson) =>
    scope.allowAllSalespeople ||
    !String(salesperson || "").trim() ||
    salespersonSet.has(String(salesperson || ""));
  const canProduct = (product) =>
    scope.allowAllProducts || !String(product || "").trim() || productSet.has(String(product || ""));

  context.topStores = (context.topStores || []).filter((row) => canStore(row.store));
  context.topSalespeople = (context.topSalespeople || []).filter((row) => canSalesperson(row.salesperson));
  context.salespersonStoreStats = (context.salespersonStoreStats || []).filter(
    (row) => canStore(row.store) && canSalesperson(row.salesperson)
  );
  context.yearlyStorePerformance = (context.yearlyStorePerformance || []).filter((row) => canStore(row.store));
  context.monthlyStorePerformance = (context.monthlyStorePerformance || []).filter((row) => canStore(row.store));
  context.weeklyStorePerformance = (context.weeklyStorePerformance || []).filter((row) => canStore(row.store));
  context.topProducts = (context.topProducts || []).filter((row) => canProduct(row.product));
  context.memberRank = (context.memberRank || []).filter(
    (row) => canStore(row.latest_store) && canSalesperson(row.latest_salesperson)
  );
  context.sleepList = (context.sleepList || []).filter(
    (row) => canStore(row.last_store) && canSalesperson(row.last_salesperson)
  );
  context.memberStorePerformance = (context.memberStorePerformance || []).filter((row) => canStore(row.store));
  context.salespersonYearlyPerformance = (context.salespersonYearlyPerformance || []).filter((row) =>
    canSalesperson(row.salesperson)
  );
  context.salespersonMonthlyPerformance = (context.salespersonMonthlyPerformance || []).filter((row) =>
    canSalesperson(row.salesperson)
  );
  context.salespersonWeeklyPerformance = (context.salespersonWeeklyPerformance || []).filter((row) =>
    canSalesperson(row.salesperson)
  );
  context.salespersonDailyPerformance = (context.salespersonDailyPerformance || []).filter((row) =>
    canSalesperson(row.salesperson)
  );
  context.orderSummary = (context.orderSummary || []).filter(
    (row) => canStore(row.store) && canSalesperson(row.salesperson)
  );

  context.memberRank = maskSensitiveMemberRows(context.memberRank, user?.allowedMemberFields || {});
  context.sleepList = maskSensitiveMemberRows(context.sleepList, user?.allowedMemberFields || {});
  return context;
}

function getToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "getKpis",
        description: "Get current KPI metrics from uploaded sales data and active dashboard filters.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTotalSales",
        description: "Get the exact total sales amount under current dashboard filters.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopStores",
        description: "Get top stores by sales amount.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopSalespeople",
        description: "Get top salespeople by sales amount.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getAllSalespeoplePerformance",
        description: "Get full salespeople performance list under current filters.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500 },
            offset: { type: "integer", minimum: 0, maximum: 5000 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopSalespeopleByYear",
        description: "Get salesperson ranking for a specific year.",
        parameters: {
          type: "object",
          properties: {
            year: { type: "string", description: "Year like 2024" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopSalespeopleByMonth",
        description: "Get salesperson ranking for a specific month (YYYY-MM).",
        parameters: {
          type: "object",
          properties: {
            month: { type: "string", description: "Month like 2025-03" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopSalespeopleByWeek",
        description: "Get salesperson ranking for a specific week start date (YYYY-MM-DD, Monday).",
        parameters: {
          type: "object",
          properties: {
            weekStart: { type: "string", description: "Week start date like 2025-03-03" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopSalespeopleByDay",
        description: "Get salesperson ranking for a specific day (YYYY-MM-DD).",
        parameters: {
          type: "object",
          properties: {
            day: { type: "string", description: "Day like 2025-03-08" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getSalespersonLeadersByGranularity",
        description: "Get top salesperson per period for all periods in a granularity (year/month/week/day).",
        parameters: {
          type: "object",
          properties: {
            granularity: { type: "string", enum: ["year", "month", "week", "day"] },
            limitPerPeriod: { type: "integer", minimum: 1, maximum: 20 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getMemberSummary",
        description: "Get overall member metrics and sleeping-member summary.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopMembers",
        description: "Get top members by total spend under current filters.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "findMember",
        description: "Find member details by name, phone, or member key.",
        parameters: {
          type: "object",
          properties: {
            keyword: { type: "string", description: "Member name, phone, or id" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getMembersBySalesperson",
        description: "Get members associated with a salesperson under current filters.",
        parameters: {
          type: "object",
          properties: {
            salesperson: { type: "string", description: "Salesperson name to query" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopMembersByStore",
        description: "Get top members in a specific store by total spend.",
        parameters: {
          type: "object",
          properties: {
            store: { type: "string", description: "Store name to query" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getHighestOrder",
        description: "Get the highest single order under current filters.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopOrders",
        description: "Get top orders by amount under current filters.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getSalespersonStores",
        description:
          "Find which store(s) a salesperson's sales come from under the current filters, with sales amounts by store.",
        parameters: {
          type: "object",
          properties: {
            salesperson: { type: "string", description: "Salesperson name to query" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopStoresByYear",
        description: "Get store ranking for a specific year based on current filtered data.",
        parameters: {
          type: "object",
          properties: {
            year: { type: "string", description: "Year like 2024" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getStoreYearlyRanks",
        description: "Check one store's rank and sales across available years.",
        parameters: {
          type: "object",
          properties: {
            store: { type: "string", description: "Store name to query" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getMonthlySales",
        description: "Get total sales for a specific month (YYYY-MM).",
        parameters: {
          type: "object",
          properties: {
            month: { type: "string", description: "Month like 2025-03" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getWeeklySales",
        description: "Get total sales for a specific week start date (Monday, YYYY-MM-DD).",
        parameters: {
          type: "object",
          properties: {
            weekStart: { type: "string", description: "Week start date like 2025-03-03" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopStoresByMonth",
        description: "Get store ranking for a specific month (YYYY-MM).",
        parameters: {
          type: "object",
          properties: {
            month: { type: "string", description: "Month like 2025-03" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopStoresByWeek",
        description: "Get store ranking for a specific week start date (YYYY-MM-DD).",
        parameters: {
          type: "object",
          properties: {
            weekStart: { type: "string", description: "Week start date like 2025-03-03" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getTopProducts",
        description: "Get top products by sales amount.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    ...agentDatasetToolsService.getToolDefinitions(),
  ];
}

async function runToolCall(contextEntry, currentUser, accessScope, toolName, toolArgs) {
  const datasetToolResult = await agentDatasetToolsService.runToolCall({
    currentUser,
    accessScope,
    toolName,
    toolArgs,
  });
  if (datasetToolResult) return datasetToolResult;
  /** Legacy tools read mostly from pre-synced `salesContext` (already scoped in `/api/chat/context`).
   *  Any live `analyticsService` fallback MUST apply `accessScope` via `applyPermissionScopeToFilters`. */
  const context = contextEntry?.context || null;
  if (!context) {
    return {
      ok: false,
      error: "当前暂无销售数据上下文，请先上传并完成分析。",
    };
  }
  const deny = () => ({ ok: false, error: OUT_OF_SCOPE_MESSAGE });

  const args = toolArgs && typeof toolArgs === "object" ? toolArgs : {};
  const limit = sanitizeLimit(args.limit, 50, 500);
  const offset = Math.max(0, Math.floor(Number(args.offset || 0)));

  if (toolName === "getKpis") {
    if (!hasPermission(currentUser, "canViewKpi")) return deny();
    return { ok: true, data: context.kpis, filters: context.filters, updatedAt: context.updatedAt };
  }
  if (toolName === "getTotalSales") {
    if (!hasPermission(currentUser, "canViewKpi")) return deny();
    return { ok: true, totalSales: context.kpis.totalSales, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopStores") {
    if (!hasPermission(currentUser, "canAskStoreQuestions")) return deny();
    return { ok: true, rows: context.topStores.slice(0, limit), updatedAt: context.updatedAt };
  }
  if (toolName === "getTopSalespeople") {
    if (!hasPermission(currentUser, "canAskSalespersonQuestions")) return deny();
    return { ok: true, rows: context.topSalespeople.slice(0, limit), updatedAt: context.updatedAt };
  }
  if (toolName === "getAllSalespeoplePerformance") {
    if (!hasPermission(currentUser, "canAskSalespersonQuestions")) return deny();
    const allRows = context.topSalespeople || [];
    return {
      ok: true,
      rows: allRows.slice(offset, offset + limit),
      total: allRows.length,
      offset,
      limit,
      updatedAt: context.updatedAt,
    };
  }
  if (toolName === "getTopSalespeopleByYear") {
    if (!hasPermission(currentUser, "canAskSalespersonQuestions")) return deny();
    const year = String(args.year || "").trim();
    if (!year) return { ok: false, error: "year is required" };
    let rows = (context.salespersonYearlyPerformance || [])
      .filter((x) => String(x.year || "") === year)
      .sort((a, b) => b.performance - a.performance)
      .slice(0, limit)
      .map((x, idx) => ({ rank: idx + 1, year, salesperson: x.salesperson, performance: x.performance }));
    if (!rows.length) {
      const startYear = String((context.filters && context.filters.startDate) || "").slice(0, 4);
      const endYear = String((context.filters && context.filters.endDate) || "").slice(0, 4);
      const isSingleYearFilter = startYear && endYear && startYear === endYear;
      if (isSingleYearFilter && startYear === year) {
        rows = (context.topSalespeople || [])
          .slice()
          .sort((a, b) => Number(b.performance || 0) - Number(a.performance || 0))
          .slice(0, limit)
          .map((x, idx) => ({
            rank: idx + 1,
            year,
            salesperson: String(x.salesperson || ""),
            performance: Number(x.performance || 0),
          }));
      }
    }
    if (!rows.length) {
      const yearStart = `${year}-01-01`;
      const yearEnd = `${year}-12-31`;
      const contextFilters = context.filters && typeof context.filters === "object" ? context.filters : {};
      const intersectStart = contextFilters.startDate && contextFilters.startDate > yearStart ? contextFilters.startDate : yearStart;
      const intersectEnd = contextFilters.endDate && contextFilters.endDate < yearEnd ? contextFilters.endDate : yearEnd;
      if (intersectStart <= intersectEnd) {
        const datasetIds = await analyticsService.listReadyDatasetIds();
        if (datasetIds.length) {
          const scopedFilters = applyPermissionScopeToFilters(
            {
              ...contextFilters,
              startDate: intersectStart,
              endDate: intersectEnd,
            },
            accessScope
          );
          const queriedRows = await analyticsService.getTopSalespeople(datasetIds, {
            filters: scopedFilters,
            limit,
            offset: 0,
          });
          rows = (queriedRows || []).map((x, idx) => ({
            rank: idx + 1,
            year,
            salesperson: String(x.salesperson || ""),
            performance: Number(x.performance || 0),
          }));
        }
      }
    }
    return { ok: true, rows, year, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopSalespeopleByMonth") {
    if (!hasPermission(currentUser, "canAskSalespersonQuestions")) return deny();
    const month = String(args.month || "").trim();
    if (!month) return { ok: false, error: "month is required" };
    const rows = (context.salespersonMonthlyPerformance || [])
      .filter((x) => String(x.month || "") === month)
      .sort((a, b) => b.performance - a.performance)
      .slice(0, limit)
      .map((x, idx) => ({ rank: idx + 1, month, salesperson: x.salesperson, performance: x.performance }));
    return { ok: true, rows, month, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopSalespeopleByWeek") {
    if (!hasPermission(currentUser, "canAskSalespersonQuestions")) return deny();
    const weekStart = String(args.weekStart || "").trim();
    if (!weekStart) return { ok: false, error: "weekStart is required" };
    const rows = (context.salespersonWeeklyPerformance || [])
      .filter((x) => String(x.weekStart || "") === weekStart)
      .sort((a, b) => b.performance - a.performance)
      .slice(0, limit)
      .map((x, idx) => ({ rank: idx + 1, weekStart, salesperson: x.salesperson, performance: x.performance }));
    return { ok: true, rows, weekStart, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopSalespeopleByDay") {
    if (!hasPermission(currentUser, "canAskSalespersonQuestions")) return deny();
    const day = String(args.day || "").trim();
    if (!day) return { ok: false, error: "day is required" };
    const rows = (context.salespersonDailyPerformance || [])
      .filter((x) => String(x.day || "") === day)
      .sort((a, b) => b.performance - a.performance)
      .slice(0, limit)
      .map((x, idx) => ({ rank: idx + 1, day, salesperson: x.salesperson, performance: x.performance }));
    return { ok: true, rows, day, updatedAt: context.updatedAt };
  }
  if (toolName === "getSalespersonLeadersByGranularity") {
    if (!hasPermission(currentUser, "canAskSalespersonQuestions")) return deny();
    const granularity = String(args.granularity || "").trim();
    const limitPerPeriod = sanitizeLimit(args.limitPerPeriod, 1, 20);
    let sourceRows = [];
    let periodField = "";
    if (granularity === "year") {
      sourceRows = context.salespersonYearlyPerformance || [];
      periodField = "year";
    } else if (granularity === "month") {
      sourceRows = context.salespersonMonthlyPerformance || [];
      periodField = "month";
    } else if (granularity === "week") {
      sourceRows = context.salespersonWeeklyPerformance || [];
      periodField = "weekStart";
    } else if (granularity === "day") {
      sourceRows = context.salespersonDailyPerformance || [];
      periodField = "day";
    } else {
      return { ok: false, error: "granularity must be year/month/week/day" };
    }
    const byPeriod = new Map();
    sourceRows.forEach((r) => {
      const period = String(r?.[periodField] || "");
      if (!period) return;
      if (!byPeriod.has(period)) byPeriod.set(period, []);
      byPeriod.get(period).push(r);
    });
    const periods = [...byPeriod.keys()].sort();
    const rows = [];
    periods.forEach((period) => {
      const top = byPeriod.get(period)
        .sort((a, b) => Number(b.performance || 0) - Number(a.performance || 0))
        .slice(0, limitPerPeriod);
      top.forEach((entry, idx) => {
        rows.push({
          period,
          rank: idx + 1,
          salesperson: entry.salesperson,
          performance: Number(entry.performance || 0),
        });
      });
    });
    return { ok: true, granularity, rows, updatedAt: context.updatedAt };
  }
  if (toolName === "getMemberSummary") {
    if (!hasPermission(currentUser, "canAskMemberQuestions")) return deny();
    const memberRows = context.memberRank || [];
    const sleepingRows = context.sleepList || [];
    return {
      ok: true,
      summary: {
        uniqueMembers: memberRows.length,
        sleepingMembers: sleepingRows.length,
        aClassSleepingMembers: Number(context.kpis?.aClassSleepingMembers || 0),
        memberRegistrationRate: Number(context.kpis?.memberRegistrationRate || 0),
        repurchaseRate: Number(context.kpis?.repurchaseRate || 0),
        averageRepurchaseTimes: Number(context.kpis?.averageRepurchaseTimes || 0),
      },
      updatedAt: context.updatedAt,
    };
  }
  if (toolName === "getTopMembers") {
    if (!hasPermission(currentUser, "canAskMemberQuestions")) return deny();
    const rowsRaw = (context.memberRank || [])
      .slice(0, limit)
      .map((m, idx) => ({
        rank: idx + 1,
        member_key: m.member_key,
        member_name: m.member_name,
        phone: m.phone,
        total_spend: m.total_spend,
        order_count: m.order_count,
        avg_ticket: m.avg_ticket,
        latest_store: m.latest_store,
        latest_salesperson: m.latest_salesperson,
      }));
    const rows = finalizeMemberRowsForAgentTools(rowsRaw, currentUser?.allowedMemberFields || {});
    return { ok: true, rows, total: (context.memberRank || []).length, updatedAt: context.updatedAt };
  }
  if (toolName === "findMember") {
    if (!hasPermission(currentUser, "canAskMemberQuestions")) return deny();
    const keywordRaw = String(args.keyword || "").trim();
    const maybeSensitive =
      /\d{6,}/.test(keywordRaw) || keywordRaw.includes("手机号") || keywordRaw.toLowerCase().includes("phone");
    if (maybeSensitive && !hasPermission(currentUser, "canAskSensitiveMemberQuestions")) return deny();
    const keyword = String(args.keyword || "").trim().toLowerCase();
    if (!keyword) return { ok: false, error: "keyword is required" };
    const memberLimit = sanitizeLimit(args.limit, 10, 100);
    const rowsMatched = (context.memberRank || [])
      .filter((m) => {
        const name = String(m.member_name || "").toLowerCase();
        const phone = String(m.phone || "").toLowerCase();
        const memberKey = String(m.member_key || "").toLowerCase();
        return name.includes(keyword) || phone.includes(keyword) || memberKey.includes(keyword);
      })
      .slice(0, memberLimit);
    const rows = finalizeMemberRowsForAgentTools(rowsMatched, currentUser?.allowedMemberFields || {});
    return {
      ok: true,
      rows,
      total: rows.length,
      updatedAt: context.updatedAt,
    };
  }
  if (toolName === "getMembersBySalesperson") {
    if (!hasPermission(currentUser, "canAskMemberQuestions")) return deny();
    const salesperson = String(args.salesperson || "").trim().toLowerCase();
    if (!salesperson) return { ok: false, error: "salesperson is required" };
    const memberLimit = sanitizeLimit(args.limit, 30, 500);
    const matched = (context.memberRank || [])
      .filter((m) => String(m.latest_salesperson || "").trim().toLowerCase().includes(salesperson))
      .sort((a, b) => Number(b.total_spend || 0) - Number(a.total_spend || 0));
    const rowsRaw = matched.slice(0, memberLimit).map((m, idx) => ({
      rank: idx + 1,
      member_key: m.member_key,
      member_name: m.member_name,
      phone: m.phone,
      total_spend: m.total_spend,
      order_count: m.order_count,
      avg_ticket: m.avg_ticket,
      latest_store: m.latest_store,
      latest_salesperson: m.latest_salesperson,
    }));
    const rows = finalizeMemberRowsForAgentTools(rowsRaw, currentUser?.allowedMemberFields || {});
    const totalSpend = matched.reduce((sum, m) => sum + Number(m.total_spend || 0), 0);
    return {
      ok: true,
      rows,
      total_members: matched.length,
      total_spend: totalSpend,
      updatedAt: context.updatedAt,
    };
  }
  if (toolName === "getTopMembersByStore") {
    if (!hasPermission(currentUser, "canAskMemberQuestions")) return deny();
    const store = String(args.store || "").trim().toLowerCase();
    if (!store) return { ok: false, error: "store is required" };
    const storeLimit = sanitizeLimit(args.limit, 20, 200);
    const rows = (context.memberStorePerformance || [])
      .filter((m) => String(m.store || "").trim().toLowerCase().includes(store))
      .sort((a, b) => b.total_spend - a.total_spend)
      .slice(0, storeLimit)
      .map((m, idx) => ({
        rank: idx + 1,
        member_key: m.member_key,
        member_name: m.member_name,
        store: m.store,
        total_spend: m.total_spend,
        order_count: m.order_count,
      }));
    return {
      ok: true,
      rows,
      total: rows.length,
      updatedAt: context.updatedAt,
    };
  }
  if (toolName === "getHighestOrder") {
    if (!hasPermission(currentUser, "canViewRawRows")) return deny();
    const top = (context.orderSummary || [])[0];
    if (!top) return { ok: true, row: null, message: "No order data available in current filters." };
    return { ok: true, row: top, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopOrders") {
    if (!hasPermission(currentUser, "canViewRawRows")) return deny();
    const rows = (context.orderSummary || []).slice(0, limit);
    return { ok: true, rows, total: (context.orderSummary || []).length, updatedAt: context.updatedAt };
  }
  if (toolName === "getSalespersonStores") {
    if (!hasPermission(currentUser, "canAskSalespersonQuestions")) return deny();
    const requested = String(args.salesperson || "").trim().toLowerCase();
    if (!requested) {
      return { ok: false, error: "salesperson is required" };
    }
    const rows = (context.salespersonStoreStats || [])
      .filter((x) => String(x.salesperson || "").trim().toLowerCase().includes(requested))
      .slice(0, limit);
    if (!rows.length) {
      return {
        ok: true,
        rows: [],
        message: "No store mapping found for this salesperson in current filtered data.",
        updatedAt: context.updatedAt,
      };
    }
    return { ok: true, rows, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopStoresByYear") {
    if (!hasPermission(currentUser, "canAskStoreQuestions")) return deny();
    const year = String(args.year || "").trim();
    if (!year) {
      return { ok: false, error: "year is required" };
    }
    const rows = (context.yearlyStorePerformance || [])
      .filter((x) => String(x.year || "") === year)
      .sort((a, b) => b.performance - a.performance)
      .slice(0, limit)
      .map((x, idx) => ({ rank: idx + 1, year, store: x.store, performance: x.performance }));
    return { ok: true, rows, year, updatedAt: context.updatedAt };
  }
  if (toolName === "getStoreYearlyRanks") {
    if (!hasPermission(currentUser, "canAskStoreQuestions")) return deny();
    const storeRequested = String(args.store || "").trim().toLowerCase();
    if (!storeRequested) {
      return { ok: false, error: "store is required" };
    }
    const all = (context.yearlyStorePerformance || []);
    const years = [...new Set(all.map((x) => String(x.year || "")).filter(Boolean))].sort();
    const result = [];
    years.forEach((year) => {
      const rows = all.filter((x) => String(x.year || "") === year).sort((a, b) => b.performance - a.performance);
      const rankIndex = rows.findIndex((x) => String(x.store || "").trim().toLowerCase().includes(storeRequested));
      if (rankIndex >= 0) {
        const hit = rows[rankIndex];
        result.push({
          year,
          rank: rankIndex + 1,
          store: hit.store,
          performance: hit.performance,
          totalStores: rows.length,
        });
      }
    });
    return { ok: true, rows: result, updatedAt: context.updatedAt };
  }
  if (toolName === "getMonthlySales") {
    if (!hasPermission(currentUser, "canAskStoreQuestions")) return deny();
    const month = String(args.month || "").trim();
    if (!month) return { ok: false, error: "month is required" };
    const row = (context.monthlyTrend || []).find((x) => String(x.year_month || "") === month);
    return { ok: true, month, sales_amount: Number(row?.sales_amount || 0), updatedAt: context.updatedAt };
  }
  if (toolName === "getWeeklySales") {
    if (!hasPermission(currentUser, "canAskStoreQuestions")) return deny();
    const weekStart = String(args.weekStart || "").trim();
    if (!weekStart) return { ok: false, error: "weekStart is required" };
    const row = (context.weeklyTrend || []).find((x) => String(x.weekStart || "") === weekStart);
    return { ok: true, weekStart, sales_amount: Number(row?.sales_amount || 0), updatedAt: context.updatedAt };
  }
  if (toolName === "getTopStoresByMonth") {
    if (!hasPermission(currentUser, "canAskStoreQuestions")) return deny();
    const month = String(args.month || "").trim();
    if (!month) return { ok: false, error: "month is required" };
    const rows = (context.monthlyStorePerformance || [])
      .filter((x) => String(x.month || "") === month)
      .sort((a, b) => b.performance - a.performance)
      .slice(0, limit)
      .map((x, idx) => ({ rank: idx + 1, month, store: x.store, performance: x.performance }));
    return { ok: true, rows, month, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopStoresByWeek") {
    if (!hasPermission(currentUser, "canAskStoreQuestions")) return deny();
    const weekStart = String(args.weekStart || "").trim();
    if (!weekStart) return { ok: false, error: "weekStart is required" };
    const rows = (context.weeklyStorePerformance || [])
      .filter((x) => String(x.weekStart || "") === weekStart)
      .sort((a, b) => b.performance - a.performance)
      .slice(0, limit)
      .map((x, idx) => ({ rank: idx + 1, weekStart, store: x.store, performance: x.performance }));
    return { ok: true, rows, weekStart, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopProducts") {
    if (!hasPermission(currentUser, "canViewProductRanking")) return deny();
    return { ok: true, rows: context.topProducts.slice(0, limit), updatedAt: context.updatedAt };
  }
  return { ok: false, error: `Unknown tool: ${toolName}` };
}

const sessionOptions = {
  name: "sales.sid",
  secret: env.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: env.sessionMaxAgeMs,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  },
};
if (env.sessionStore === "file") {
  const FileStore = FileStoreFactory(session);
  sessionOptions.store = new FileStore({
    path: env.sessionDir,
    retries: 0,
    ttl: Math.floor(env.sessionMaxAgeMs / 1000),
  });
}

app.use(express.json({ limit: "20mb" }));
app.use(session(sessionOptions));
app.use(setSecurityHeaders);
app.use("/api", csrfLikeOriginGuard);

app.post("/api/auth/login", loginRateLimit, async (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  const result = await authService.authenticate(username, password);
  if (!result.ok) {
    markLoginAttemptResult(req, false);
    return res.status(401).json({ error: result.error || "登录失败" });
  }
  req.session.user = result.user;
  markLoginAttemptResult(req, true);
  return res.json({ ok: true, user: result.user });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("sales.sid");
    return res.json({ ok: true });
  });
});

app.get("/api/auth/me", async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "未登录" });
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "未登录" });
  return res.json({ ok: true, user });
});

/**
 * 兼容旧入口：统一到移动端首页免登（与钉钉后台填写的 https://…/mobile 一致）。
 * 查询串（含 code、next 等）原样带到 /mobile。
 */
app.get("/dingtalk/login", (req, res) => {
  const q = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(302, `/mobile${q}`);
});

/** 钉钉端内免登 → 需具备 canAccessAdmin，默认进入后台 */
app.get("/dingtalk/admin-login", async (req, res) => {
  await handleDingTalkSso(req, res, { defaultNext: "/admin", requireAdminAccess: true });
});

/**
 * 钉钉开发者后台「重定向 URL」指向此处时：将 code（及 next）转到移动端首页完成免登。
 * 亦可直接把「重定向 URL」设为 env.publishedMobileUrl（同一逻辑见 GET /mobile）。
 */
app.get("/dingtalk/callback", (req, res) => {
  const code = readDingTalkAuthCodeFromQuery(req);
  const next = safeInternalRedirectPath(String(req.query.next || "").trim() || "/mobile", "/mobile");
  if (!code) {
    return res.status(200).type("html").send(buildDingTalkSsoNoCodeHtml());
  }
  const qp = new URLSearchParams();
  if (req.query.code != null && String(req.query.code).trim()) qp.set("code", String(req.query.code).trim());
  else if (req.query.authCode != null && String(req.query.authCode).trim())
    qp.set("authCode", String(req.query.authCode).trim());
  else if (req.query.auth_code != null && String(req.query.auth_code).trim())
    qp.set("auth_code", String(req.query.auth_code).trim());
  else qp.set("code", code);
  if (next !== "/mobile") qp.set("next", next);
  return res.redirect(302, `/mobile?${qp.toString()}`);
});

app.get("/api/dingtalk/config", requireAuthApi, (_req, res) => {
  return res.json({
    ok: true,
    corpId: env.dingtalkCorpId || "",
  });
});

app.post("/api/dingtalk/bind", requireAuthApi, async (req, res) => {
  const code = readDingTalkAuthCodeFromBody(req.body);
  if (!code) return res.status(400).json({ error: "免登码不能为空（请传 code、authCode 或 auth_code）" });
  if (!env.dingtalkAppKey || !env.dingtalkAppSecret || !env.dingtalkCorpId) {
    return res.status(400).json({ error: "服务端未配置钉钉免登参数" });
  }
  try {
    const accessToken = await getDingTalkAccessToken({
      appKey: env.dingtalkAppKey,
      appSecret: env.dingtalkAppSecret,
    });
    const dingtalkUserId = await getDingTalkUserIdByCode({
      accessToken,
      code,
    });
    const updatedUser = await authService.bindDingTalkUser(
      String(req.currentUser?.id || ""),
      dingtalkUserId
    );
    req.session.user = updatedUser;
    return res.json({ ok: true, dingtalkUserId: updatedUser.dingtalkUserId || dingtalkUserId });
  } catch (err) {
    return res.status(502).json({ error: err?.message || "钉钉绑定失败" });
  }
});

app.get("/api/notifications", requireAuthApi, async (req, res) => {
  const userId = String(req.currentUser?.id || "");
  const username = String(req.currentUser?.username || "");
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await notificationStore.listForUser({ userId, username, limit, offset });
  return res.json({ ok: true, ...data });
});

app.post("/api/notifications/:id/read", requireAuthApi, async (req, res) => {
  const userId = String(req.currentUser?.id || "");
  const username = String(req.currentUser?.username || "");
  const result = await notificationStore.markRead({ id: req.params.id, userId, username });
  if (!result.ok) {
    if (result.code === 404) return res.status(404).json({ error: "消息不存在" });
    if (result.code === 403) return res.status(403).json({ error: "无权限访问" });
    return res.status(400).json({ error: "操作失败" });
  }
  return res.json({ ok: true, notification: result.notification });
});

app.post("/api/admin/notifications/test", requireAdminApi, async (req, res) => {
  if (String(req.currentUser?.role || "") !== "admin") {
    return res.status(403).json({ ok: false, error: "仅管理员可发送应用内测试通知" });
  }
  const userId = String(req.currentUser?.id || "");
  const username = String(req.currentUser?.username || "");
  const title = "赫眉经营助手测试提醒";
  const content = "这是一条应用内测试提醒，说明消息中心已可用。";
  const created = await notificationStore.create({
    userId,
    username,
    title,
    content,
    type: "test",
    link: "/mobile",
  });
  return res.json({ ok: true, notification: { id: created.id, createdAt: created.createdAt } });
});

app.get("/api/admin/users", requireAdminApi, async (_req, res) => {
  if (!ensurePermissionOrDeny(res, _req.currentUser, "canManageUsers")) return;
  const users = await authService.listUsers();
  return res.json({ ok: true, users });
});

app.get("/api/admin/audit-logs", requireAdminApi, async (req, res) => {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canViewAuditLogs")) return;
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const data = await auditLogStore.list({ limit, offset });
    return res.json({ ok: true, ...data });
  } catch (error) {
    console.warn("[admin] audit-logs list", error?.message || error);
    return res.status(500).json({ error: error?.message || "读取审计日志失败" });
  }
});

/** 用户向内置 AI 提问的调试日志（需「查看审计日志」权限）；另注册 /api/v2 前缀以防代理或旧进程路径不一致 */
async function handleAdminAiChatQueriesList(req, res) {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canViewAuditLogs")) return;
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const data = await aiChatQueryLogStore.list({ limit, offset });
    return res.json({ ok: true, ...data });
  } catch (error) {
    console.warn("[admin] ai-chat-queries list", error?.message || error);
    return res.status(500).json({ error: error?.message || "读取 AI 提问日志失败" });
  }
}

app.get("/api/admin/ai-chat-queries", requireAdminApi, handleAdminAiChatQueriesList);
app.get("/api/v2/admin/ai-chat-queries", requireAdminApi, handleAdminAiChatQueriesList);

app.get("/api/admin/roles/catalog", requireAdminApi, async (req, res) => {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canManageUsers")) return;
  return res.json({ ok: true, ...getRoleCatalogForApi() });
});

app.get("/api/admin/roles/:roleId/template", requireAdminApi, async (req, res) => {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canManageUsers")) return;
  const roleId = String(req.params.roleId || "").trim();
  if (!isRoleDefinitionKnown(roleId)) {
    return res.status(404).json({ error: "岗位不存在" });
  }
  return res.json({ ok: true, roleId, template: getRolePermissionTemplateByDefinedId(roleId) });
});

app.patch("/api/admin/roles/:roleId", requireAdminApi, async (req, res) => {
  if (!requireRoleCatalogAdmin(req, res)) return;
  try {
    const roleId = String(req.params.roleId || "").trim();
    if (!isRoleDefinitionKnown(roleId)) {
      return res.status(404).json({ error: "岗位不存在" });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const partial = {};
    if ("label" in body) partial.label = body.label;
    if ("description" in body) partial.description = body.description;
    if ("scopePresetLabel" in body) partial.scopePresetLabel = body.scopePresetLabel;
    if ("template" in body) partial.template = body.template;
    await patchRoleCatalogEntry(roleId, partial);
    await appendAuditLog({
      adminUsername: req.currentUser?.username,
      actionType: "update_role_catalog",
      targetType: "role",
      targetId: roleId,
      summary: `更新岗位目录：${roleId}`,
      meta: {
        label: body.label,
        touchedTemplate: "template" in body && body.template != null,
      },
    });
    return res.json({ ok: true, ...getRoleCatalogForApi() });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "更新岗位失败" });
  }
});

app.post("/api/admin/roles", requireAdminApi, async (req, res) => {
  if (!requireRoleCatalogAdmin(req, res)) return;
  try {
    const cloneFrom = String(req.body?.cloneFromRoleId || "").trim();
    if (!cloneFrom || !isRoleDefinitionKnown(cloneFrom)) {
      return res.status(400).json({ error: "请选择有效的参考岗位" });
    }
    const templateSeed = structuredClone(getRolePermissionTemplateByDefinedId(cloneFrom));
    const row = await createCustomRole({
      id: req.body?.id ? String(req.body.id).trim().toLowerCase() : "",
      label: req.body?.label,
      description: req.body?.description,
      cloneFromRoleId: cloneFrom,
      template: templateSeed,
    });
    syncCustomRolesFromCatalog(listCustomRoleIdsLoaded());
    await appendAuditLog({
      adminUsername: req.currentUser?.username,
      actionType: "create_custom_role",
      targetType: "role",
      targetId: row.id,
      summary: `新增自定义岗位：${row.label}（${row.id}）`,
    });
    const { template: _t, ...safe } = row;
    return res.status(201).json({ ok: true, role: safe, catalog: getRoleCatalogForApi() });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "创建岗位失败" });
  }
});

app.delete("/api/admin/roles/:roleId", requireAdminApi, async (req, res) => {
  if (!requireRoleCatalogAdmin(req, res)) return;
  try {
    const roleId = String(req.params.roleId || "").trim();
    await deleteCustomRole(roleId, { authService });
    syncCustomRolesFromCatalog(listCustomRoleIdsLoaded());
    await appendAuditLog({
      adminUsername: req.currentUser?.username,
      actionType: "delete_custom_role",
      targetType: "role",
      targetId: roleId,
      summary: `删除自定义岗位：${roleId}`,
    });
    return res.json({ ok: true, ...getRoleCatalogForApi() });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "删除岗位失败" });
  }
});

app.post("/api/admin/users", requireAdminApi, async (req, res) => {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canCreateUsers")) return;
  try {
    const user = await authService.createUser({
      username: req.body?.username,
      displayName: req.body?.displayName,
      role: req.body?.role,
      password: req.body?.password,
      enabled: req.body?.enabled !== false,
      allowedStores: req.body?.allowedStores,
      allowAllStores: req.body?.allowAllStores,
      allowedSalespeople: req.body?.allowedSalespeople,
      allowAllSalespeople: req.body?.allowAllSalespeople,
      allowedProducts: req.body?.allowedProducts,
      allowAllProducts: req.body?.allowAllProducts,
      permissions: req.body?.permissions,
      allowedMemberFields: req.body?.allowedMemberFields,
    });
    await appendAuditLog({
      adminUsername: req.currentUser?.username,
      actionType: "create_user",
      targetType: "user",
      targetId: user.id,
      summary: `创建用户：${user.username}（角色：${user.role}）`,
      meta: { username: user.username, role: user.role },
    });
    return res.status(201).json({ ok: true, user });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "创建用户失败" });
  }
});

app.patch("/api/admin/users/:id", requireAdminApi, async (req, res) => {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canManageUsers")) return;
  try {
    const beforeRecord = await authService.findById(req.params.id);
    if (!beforeRecord) return res.status(404).json({ error: "用户不存在" });
    const before = {
      role: beforeRecord.role,
      enabled: Boolean(beforeRecord.enabled),
      allowedStores: [...(beforeRecord.allowedStores || [])],
      allowedSalespeople: [...(beforeRecord.allowedSalespeople || [])],
      allowedProducts: [...(beforeRecord.allowedProducts || [])],
      permissions: { ...(beforeRecord.permissions || {}) },
      allowedMemberFields: { ...(beforeRecord.allowedMemberFields || {}) },
    };
    const user = await authService.updateUser(req.params.id, {
      displayName: req.body?.displayName,
      role: req.body?.role,
      enabled: req.body?.enabled,
      allowedStores: req.body?.allowedStores,
      allowAllStores: req.body?.allowAllStores,
      allowedSalespeople: req.body?.allowedSalespeople,
      allowAllSalespeople: req.body?.allowAllSalespeople,
      allowedProducts: req.body?.allowedProducts,
      allowAllProducts: req.body?.allowAllProducts,
      permissions: req.body?.permissions,
      allowedMemberFields: req.body?.allowedMemberFields,
      applyRoleDefaults: req.body?.applyRoleDefaults,
    });
    if (String(before.role || "") !== String(user.role || "")) {
      await appendAuditLog({
        adminUsername: req.currentUser?.username,
        actionType: "update_user_role",
        targetType: "user",
        targetId: user.id,
        summary: `修改角色：${user.username}（${before.role} -> ${user.role}）`,
      });
    }
    if (Boolean(before.enabled) !== Boolean(user.enabled)) {
      await appendAuditLog({
        adminUsername: req.currentUser?.username,
        actionType: "toggle_user_enabled",
        targetType: "user",
        targetId: user.id,
        summary: `${user.enabled ? "启用" : "停用"}账号：${user.username}`,
      });
    }
    if (JSON.stringify(before.allowedStores || []) !== JSON.stringify(user.allowedStores || [])) {
      await appendAuditLog({
        adminUsername: req.currentUser?.username,
        actionType: "update_allowed_stores",
        targetType: "user",
        targetId: user.id,
        summary: `更新门店权限：${user.username}（${(user.allowedStores || []).length} 项）`,
      });
    }
    if (
      JSON.stringify(before.allowedSalespeople || []) !== JSON.stringify(user.allowedSalespeople || [])
    ) {
      await appendAuditLog({
        adminUsername: req.currentUser?.username,
        actionType: "update_allowed_salespeople",
        targetType: "user",
        targetId: user.id,
        summary: `更新销售员权限：${user.username}（${(user.allowedSalespeople || []).length} 项）`,
      });
    }
    if (JSON.stringify(before.allowedProducts || []) !== JSON.stringify(user.allowedProducts || [])) {
      await appendAuditLog({
        adminUsername: req.currentUser?.username,
        actionType: "update_allowed_products",
        targetType: "user",
        targetId: user.id,
        summary: `更新商品权限：${user.username}（${(user.allowedProducts || []).length} 项）`,
      });
    }
    if (JSON.stringify(before.permissions || {}) !== JSON.stringify(user.permissions || {})) {
      await appendAuditLog({
        adminUsername: req.currentUser?.username,
        actionType: "update_feature_permissions",
        targetType: "user",
        targetId: user.id,
        summary: `更新功能权限：${user.username}`,
      });
    }
    if (
      JSON.stringify(before.allowedMemberFields || {}) !== JSON.stringify(user.allowedMemberFields || {})
    ) {
      await appendAuditLog({
        adminUsername: req.currentUser?.username,
        actionType: "update_sensitive_fields",
        targetType: "user",
        targetId: user.id,
        summary: `更新敏感字段权限：${user.username}`,
      });
    }
    return res.json({ ok: true, user });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "更新用户失败" });
  }
});

app.post("/api/admin/users/:id/reset-password", requireAdminApi, async (req, res) => {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canResetPasswords")) return;
  try {
    const user = await authService.resetPassword(req.params.id, req.body?.password);
    await appendAuditLog({
      adminUsername: req.currentUser?.username,
      actionType: "reset_password",
      targetType: "user",
      targetId: user.id,
      summary: `重置密码：${user.username}`,
    });
    return res.json({ ok: true, user });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "重置密码失败" });
  }
});

app.get("/api/admin/permission-options", requireAdminApi, async (_req, res) => {
  if (!ensurePermissionOrDeny(res, _req.currentUser, "canAssignDataScopes")) return;
  const latest = await analyticsService.getLatestDatasetSummary();
  if (!latest?.dataset_id) {
    return res.json({
      ok: true,
      latestDataset: null,
      options: { stores: [], salespeople: [], products: [] },
    });
  }
  const options = await analyticsService.getFilterOptions(latest.dataset_id, { filters: {} });
  return res.json({
    ok: true,
    latestDataset: latest,
    options: {
      stores: options.stores || [],
      salespeople: options.salespeople || [],
      products: options.products || [],
    },
  });
});

app.get("/api/admin/import/latest", requireAdminApi, async (_req, res) => {
  if (!ensurePermissionOrDeny(res, _req.currentUser, "canViewImportHistory")) return;
  const latest = await analyticsService.getLatestDatasetSummary();
  if (!latest) return res.json({ ok: true, latest: null });
  const job = await findIngestJobByDatasetId(latest.dataset_id);
  const display_source_name = job ? formatImportJobDisplayName(job) : String(latest.source_name || "");
  return res.json({
    ok: true,
    latest: {
      ...latest,
      display_source_name: display_source_name || String(latest.source_name || ""),
    },
  });
});

app.get("/api/admin/import/history", requireAdminApi, async (req, res) => {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canViewImportHistory")) return;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await jobStore.listJobs({ type: "ingest", limit, offset });
  const rows = (data.rows || []).map((job) => ({
    jobId: job.id,
    filename: formatImportJobDisplayName(job) || String(job?.payload?.sourceName || ""),
    importedAt: job.updatedAt || job.createdAt,
    rowCount: Number(job?.stats?.rowCount || 0),
    status: String(job?.status || ""),
    importedBy: String(job?.payload?.importedBy || ""),
    datasetId: job?.datasetId || null,
  }));
  return res.json({ ok: true, rows, total: data.total, limit: data.limit, offset: data.offset });
});

app.delete("/api/admin/import/jobs/:jobId", requireAdminApi, async (req, res) => {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canDeleteImportedData")) return;
  const jobId = String(req.params.jobId || "").trim();
  const forceDelete = String(req.query.force || "").trim() === "1";
  if (!jobId) {
    return res.status(400).json({ error: "缺少导入任务 ID" });
  }
  const job = await jobStore.getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: "未找到该导入记录" });
  }
  const status = String(job.status || "").toLowerCase();
  if (!forceDelete && (status === "queued" || status === "running")) {
    const lastUpdateMs = new Date(job.updatedAt || job.createdAt || 0).getTime();
    const ageMs = Number.isFinite(lastUpdateMs) ? Date.now() - lastUpdateMs : 0;
    const STALE_JOB_THRESHOLD_MS = 15 * 60 * 1000;
    if (ageMs < STALE_JOB_THRESHOLD_MS) {
      return res.status(409).json({ error: "该导入仍在排队或进行中，请稍后再试删除" });
    }
  }
  try {
    const datasetId = job.datasetId ? String(job.datasetId).trim() : "";
    if (datasetId) {
      await analyticsService.deleteDatasetById(datasetId);
    }
    const removed = await jobStore.deleteJob(jobId);
    if (!removed) {
      return res.status(404).json({ error: "删除导入记录失败" });
    }
    const remainingIngest = await jobStore.listJobs({ type: "ingest", limit: 1, offset: 0 });
    let clearedOrphanedData = false;
    if (Number(remainingIngest?.total || 0) === 0) {
      // Keep admin history and frontend dataset state consistent:
      // when no ingest job remains, clear residual datasets (including legacy orphan datasets).
      await analyticsService.deleteAllDatasets();
      clearedOrphanedData = true;
    }
    invalidateV2ResponseCache?.();
    await appendAuditLog({
      adminUsername: req.currentUser?.username,
      actionType: "delete_import_job",
      targetType: "import_job",
      targetId: jobId,
      summary: datasetId
        ? `删除导入记录并移除数据集 ${datasetId}${forceDelete ? "（强制）" : ""}${clearedOrphanedData ? "；已清理残留数据" : ""}`
        : `删除导入记录（无数据集）${forceDelete ? "（强制）" : ""}${clearedOrphanedData ? "；已清理残留数据" : ""}`,
    });
    return res.json({ ok: true, jobId, clearedOrphanedData });
  } catch (error) {
    console.warn("[admin] delete import job", error?.message || error);
    return res.status(400).json({ error: error?.message || "删除失败" });
  }
});

app.post("/api/admin/dingtalk/test-notification", requireAdminApi, async (req, res) => {
  if (String(req.currentUser?.role || "") !== "admin") {
    return res.status(403).json({ ok: false, error: "仅管理员可发送钉钉测试通知" });
  }
  try {
    const result = await sendDingTalkTestWorkNotification({
      appKey: env.dingtalkAppKey,
      appSecret: env.dingtalkAppSecret,
      agentId: env.dingtalkAgentId,
      testUserId: env.dingtalkTestUserId,
    });
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error || "发送失败" });
    }
    return res.json({
      ok: true,
      message: "已发送测试通知",
      dingtalk: result.dingtalk ? { task_id: result.dingtalk.task_id, errcode: result.dingtalk.errcode } : undefined,
    });
  } catch (err) {
    console.warn("[dingtalk] test-notification handler error", err?.message || err);
    return res.status(500).json({ ok: false, error: "服务器发送钉钉通知时出错，请稍后重试" });
  }
});

if (disableV2Api) {
  app.use("/api/v2", (_req, res) => {
    return res.status(503).json({
      error: "v2 分析接口临时维护中，请先使用页面内置分析流程。",
      code: "V2_TEMP_DISABLED",
    });
  });
} else {
  app.use("/api/v2", (req, res, next) => {
    if (req.path === "/health") return next();
    return requireAuthApi(req, res, next);
  });
  app.use(
    "/api/v2",
    getV2Router({
      onImportEvent: (entry) => appendAuditLog(entry),
    })
  );
}

app.post("/api/chat/context", requireAuthApi, (req, res) => {
  if (!hasPermission(req.currentUser, "canUseAgentChat")) {
    return res.status(403).json({ error: OUT_OF_SCOPE_MESSAGE });
  }
  const conversationId = getConversationId(req.body?.conversationId);
  if (!conversationId) {
    return res.status(400).json({ error: "缺少 conversationId" });
  }
  const salesContext = stripDashboardDimensionFiltersForAgentChat(
    applyScopeToSalesContext(req.body?.salesContext, req.currentUser, req.accessScope)
  );
  salesContexts.set(conversationId, {
    userId: String(req.currentUser?.id || ""),
    context: salesContext,
  });
  rememberChatConversationOwner(conversationId, String(req.currentUser?.id || ""));
  touchChatConversation(conversationId);
  return res.json({ ok: true, conversationId });
});

app.get("/api/chat/history", requireAuthApi, (req, res) => {
  if (!hasPermission(req.currentUser, "canUseAgentChat")) {
    return res.status(403).json({ error: OUT_OF_SCOPE_MESSAGE });
  }
  const conversationId = getConversationId(req.query?.conversationId);
  if (!conversationId) {
    return res.status(400).json({ error: "缺少 conversationId" });
  }
  const uid = String(req.currentUser?.id || "");
  if (!userOwnsConversation(conversationId, uid)) {
    return res.status(403).json({ error: OUT_OF_SCOPE_MESSAGE });
  }
  const raw = getSessionMessages(conversationId);
  const messages = sanitizeChatMessagesForHistoryClient(raw);
  return res.json({ ok: true, conversationId, messages });
});

app.post("/api/chat", requireAuthApi, chatApiRateLimit, async (req, res) => {
  if (!hasPermission(req.currentUser, "canUseAgentChat")) {
    return res.status(403).json({ error: OUT_OF_SCOPE_MESSAGE });
  }
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.AI_MODEL || "gpt-4o-mini";
  const userMessage = (req.body?.message || "").trim();
  const conversationId = getConversationId(req.body?.conversationId);

  if (!apiKey) {
    return res.status(500).json({
      error: "服务器未配置 AI_API_KEY",
    });
  }

  if (!conversationId) {
    return res.status(400).json({
      error: "缺少 conversationId",
    });
  }

  if (!userMessage) {
    return res.status(400).json({
      error: "消息内容不能为空",
    });
  }
  if (
    !hasPermission(req.currentUser, "canAskCompanyWideQuestions") &&
    /(全公司|全部门店|公司整体|company[-\s]?wide|all stores|overall company)/i.test(userMessage)
  ) {
    return res.status(403).json({ error: OUT_OF_SCOPE_MESSAGE });
  }

  const uidChat = String(req.currentUser?.id || "");
  const mappedOwner = chatConversationOwners.get(conversationId);
  const ctxUserId = salesContexts.get(conversationId)?.userId;
  const hasConversationStake = !!(mappedOwner || ctxUserId);
  if (hasConversationStake && !userOwnsConversation(conversationId, uidChat)) {
    return res.status(403).json({ error: OUT_OF_SCOPE_MESSAGE });
  }

  let aiChatMonitor = null;
  try {
    const ctxEntry = conversationId ? salesContexts.get(conversationId) : null;
    aiChatMonitor = createAiChatQueryMonitor(res, aiChatQueryLogStore, {
      userId: uidChat,
      username: String(req.currentUser?.username || ""),
      conversationId,
      message: userMessage,
      model,
      salesContextPreview: buildSalesContextPreviewForMonitor(ctxEntry?.context || null),
    });
    const filterHint = buildDashboardFilterHintFromSyncedContext(ctxEntry?.context || null);
    const baseSystem =
      "你是面向店长、导购主管和老板的零售经营助手，必须用简体中文回复。\n\n" +
      "【后台数据优先】金额、排行、门店、销售员、会员相关结论，必须以服务端数据集工具查询后台已导入订单（DuckDB）的结果为准；例如 getKpiFromDataset、getStoreRankingFromDataset、getSalespersonRankingFromDataset、getProductRankingFromDataset、getSalespersonStoreBreakdownFromDataset（销售员在哪些门店有业绩）、getMemberSalespersonBreakdownFromDataset（输入会员名→查各导购业绩）、getMembersForSalespersonFromDataset（输入导购名→列名下会员）等。页面同步的 salesContext 只是缓存摘要，不能代替上述查询；也不要在未调用工具前断言「导入缺少某字段」。调用工具时：startDate/endDate 须与下方「本回合数据助手取数口径」一致；门店/销售员/商品三项默认留空（不按看板多选缩小），仅在用户明确点名某一店/人/品时才在 filters 里收窄。\n\n" +
      "【问法与工具要对上】用户问「某销售员/导购手下有哪些顾客、会员」→ getMembersForSalespersonFromDataset（salespersonContains）。用户问「某某是哪个店的销售 / 哪家门店 / 谢元平是谁家的」→ 必须调用 getSalespersonStoreBreakdownFromDataset 或别名 getStoresForSalespersonFromDataset，禁止误用 getMemberSalespersonBreakdownFromDataset（后者仅用于输入会员名查导购）。\n\n" +
      "【门店与销售员关系】后台订单明细每一行同时有门店与销售员，不存在「缺映射表就无法关联」。只有在对应工具返回 rows 为空时，才可提示核对姓名或日期筛选；禁止答复「系统无法关联营业员与门店」之类话术。\n\n" +
      "【数字不得打架】同一条回复里，会员人数、名单必须与**同一工具、同一 filters**下的结果一致；不得把 KPI/摘要里的「消费会员人数」与另一工具返回的会员列表混在同一结论里；若只跑了名单工具，会员数以该工具返回的 distinctMemberCount 或 rows 长度为准。\n\n" +
      "【准确性】数字与事实必须可追溯：优先采用工具返回值；若与页面摘要不一致，以工具为准。所有金额、人数、名次须与来源一致，严禁编造。若没有返回某项，就说「当前这笔数据拿不到」或「当前数据不足以判断」，一句话说明即可。\n\n" +
      "【手机号】会员手机号一律为 11 位大陆号格式：前三位 + 中间四位掩码 + 后四位；掩码须为四个星号（工具返回为全角＊，形如 189＊＊＊＊0972）。禁止写成连续七位数字、禁止在中间插空格；禁止还原完整号码。\n\n" +
      "【口语与人话】用短句、口语表达，像在微信里给同事解释一样；不要用公文腔、研报腔。禁止空话套话（如「综上所述」「值得一提的是」），禁止重复用户原话当铺垫，禁止长篇开场白和收场白。\n\n" +
      "【篇幅】只回答解决问题所需的内容：能一段话讲完就不要分两页；列举时条目要少而准，每条一行，说清楚即止。\n\n" +
      "【排版与表情】分段清晰：段与段之间空一行。可用单独成行的小标题（如 📌 结论｜📊 关键数｜💡 建议），每条回复里使用大约 2～6 个常用表情符号帮助扫读即可；不要每个句号都加表情，不要刷屏。\n\n" +
      "【叙述顺序】优先：先一句话结论 → 再列关键数字（只写与用户问题相关的）→ 必要时再给简短可执行建议。\n\n" +
      "English operational rules (follow internally): You are an operations advisor. Tool/query numbers reflect this user's data-access scope; within that scope, aggregates cover all permitted stores/salespeople/products（管辖范围内全量，不是抽样）. " +
      "Do not invent figures; do not use technical words when speaking to the user（对用户不要说 tool、API、SQL、数据库、上下文、接口等）. " +
      "If tool returns ok:true and amounts are zero, explain as 所选日期范围内可能没有订单或暂无导入数据；unless tool result has code OUT_OF_SCOPE, do not blame permissions. " +
      "If synced salesContext omits a breakdown, prefer calling dataset tools before claiming missing mapping; salesperson-store links exist on each fact_sales row. " +
      "Never invent numbers.";
    const prequeryBlock = await maybePrequerySalespersonStoreBlocks(
      ctxEntry,
      userMessage,
      req.currentUser,
      req.accessScope
    );
    const mergedSystem = baseSystem + prequeryBlock;
    const systemMessage = {
      role: "system",
      content: filterHint ? `${mergedSystem}\n\n${filterHint}` : mergedSystem,
    };
    const workingMessages = [systemMessage, ...getSessionMessages(conversationId), { role: "user", content: userMessage }];
    const tools = getToolDefinitions();
    let finalReply = "";
    let finalUsage = null;

    for (let step = 0; step < MAX_TOOL_CALL_STEPS; step += 1) {
      const completion = await callChatCompletionsWithRetry(
        baseUrl,
        apiKey,
        {
          model,
          messages: workingMessages,
          tools,
          tool_choice: "auto",
          temperature: 0.32,
        },
        CHAT_MODEL_MAX_RETRIES
      );
      if (!completion.ok) {
        aiChatMonitor?.setError(completion?.data?.error?.message || "上游 AI 接口调用失败");
        return res.status(completion.status || 502).json({
          error: completion?.data?.error?.message || "上游 AI 接口调用失败",
        });
      }
      const data = completion.data || {};

      finalUsage = data?.usage || finalUsage;
      const assistantMessage = data?.choices?.[0]?.message;
      if (!assistantMessage) {
        aiChatMonitor?.setError("AI 接口未返回助手消息");
        return res.status(502).json({ error: "AI 接口未返回助手消息" });
      }

      const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
      if (!toolCalls.length) {
        finalReply = normalizeAssistantReply(stripThinkingBlocks(assistantMessage.content || "暂无回复"));
        workingMessages.push({
          role: "assistant",
          content: finalReply || "暂无回复",
        });
        break;
      }

      workingMessages.push({
        role: "assistant",
        content: assistantMessage.content || "",
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const toolName = toolCall?.function?.name || "";
        aiChatMonitor?.addTool(toolName);
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(toolCall?.function?.arguments || "{}");
        } catch (_error) {
          parsedArgs = {};
        }

        const contextEntry = salesContexts.get(conversationId);
        if (contextEntry?.userId && contextEntry.userId !== String(req.currentUser?.id || "")) {
          aiChatMonitor?.setError(OUT_OF_SCOPE_MESSAGE);
          return res.status(403).json({ error: OUT_OF_SCOPE_MESSAGE });
        }
        let toolResult = await runToolCall(contextEntry, req.currentUser, req.accessScope, toolName, parsedArgs);
        if (AI_VERIFICATION_TIER === "medium" && MEDIUM_TIER_DOUBLE_CHECK_TOOLS.has(toolName) && toolResult?.ok) {
          const secondCheck = await runToolCall(contextEntry, req.currentUser, req.accessScope, toolName, parsedArgs);
          if (!verifyCriticalConsistency(toolName, toolResult, secondCheck)) {
            toolResult = {
              ok: false,
              error: "关键指标核验未通过，请稍后重试",
              code: "CONSISTENCY_CHECK_FAILED",
            };
          }
        }
        const toolPayloadForModel = deepSanitizeAgentToolPayload(toolResult);
        workingMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolPayloadForModel),
        });
      }
    }

    if (!finalReply) {
      try {
        const lastPass = await callChatCompletionsWithRetry(
          baseUrl,
          apiKey,
          {
            model,
            messages: workingMessages,
            temperature: 0.32,
          },
          CHAT_MODEL_MAX_RETRIES
        );
        if (lastPass.ok) {
          const lastData = lastPass.data || {};
          const lastMsg = lastData?.choices?.[0]?.message;
          const txt = stripThinkingBlocks(lastMsg?.content || "");
          if (txt && String(txt).trim()) {
            finalReply = normalizeAssistantReply(txt);
            workingMessages.push({
              role: "assistant",
              content: finalReply || "暂无回复",
            });
          }
        }
      } catch (_e) {
        // fall through to 502 below
      }
    }

    if (!finalReply) {
      aiChatMonitor?.setError("工具调用结束，但未生成最终回答");
      return res.status(502).json({ error: "工具调用结束，但未生成最终回答" });
    }

    aiChatMonitor?.setReplyPreview(finalReply);
    aiChatMonitor?.setUsage(finalUsage);

    setSessionMessages(conversationId, workingMessages.slice(1));
    rememberChatConversationOwner(conversationId, String(req.currentUser?.id || ""));
    const uiActions = deriveUiActions(userMessage);
    return res.json({
      reply: finalReply,
      usage: finalUsage,
      conversationId,
      uiActions,
    });
  } catch (error) {
    aiChatMonitor?.setError(error?.message || "服务器异常");
    return res.status(500).json({
      error: error?.message || "服务器异常",
    });
  }
});

app.post("/api/chat/reset", requireAuthApi, (req, res) => {
  const conversationId = getConversationId(req.body?.conversationId);
  if (!conversationId) {
    return res.status(400).json({ error: "缺少 conversationId" });
  }
  deleteChatConversation(conversationId);
  return res.json({ ok: true, conversationId });
});

app.get("/login", (req, res) => {
  if (req.session?.user) {
    const next = safeLoginNextPath(String(req.query.next || ""));
    if (next) return res.redirect(next);
    return res.redirect(hasPermission(req.session.user, "canAccessAdmin") ? "/admin" : "/dashboard");
  }
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/api/public/earth-edges-data", (_req, res) => {
  return res.json({ data: getEarthEdgesData() });
});

app.get("/dashboard", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/index.html", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get(
  "/mobile",
  async (req, res, next) => {
    const code = readDingTalkAuthCodeFromQuery(req);
    if (!code) return next();
    if (req.session?.user) {
      return res.redirect(302, "/mobile");
    }
    await handleDingTalkSso(req, res, { defaultNext: "/mobile", requireAdminAccess: false });
  },
  requireAuthPage,
  (_req, res) => {
    res.sendFile(path.join(__dirname, "mobile.html"));
  }
);
app.get("/mobile.html", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(__dirname, "mobile.html"));
});

app.get("/admin", requirePermission("canAccessAdmin", { asPage: true }), (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});
app.get("/admin.html", requirePermission("canAccessAdmin", { asPage: true }), (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/", (req, res) => {
  if (!req.session?.user) return res.redirect("/login");
  return res.redirect("/dashboard");
});

function setFrontendStaticHeaders(res, absolutePath) {
  const norm = absolutePath.replace(/\\/g, "/");
  // Dev-friendly: dashboard loads many ES-module chunks (`import "./x.js"` has no cache-bust).
  // Stale chunks produced "shell loads, KPI/charts stay "-" / empty".
  if (norm.includes("/frontend/") && norm.endsWith(".js")) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  }
}

app.get(["/favicon.png", "/favicon.ico"], (_req, res) => {
  res.sendFile(path.join(__dirname, "favicon.png"));
});

app.use(
  "/frontend",
  express.static(path.join(__dirname, "frontend"), {
    index: false,
    dotfiles: "ignore",
    setHeaders: setFrontendStaticHeaders,
  })
);

async function bootstrap() {
  await initRoleCatalog(env.dataDir);
  syncCustomRolesFromCatalog(listCustomRoleIdsLoaded());
  await Promise.all([
    initV2AnalyticsModule(),
    authService.init(),
    auditLogStore.init(),
    aiChatQueryLogStore.init(),
    notificationStore.init(),
  ]);
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(
      "[routes] AI 提问监控: GET /api/admin/ai-chat-queries（备用 GET /api/v2/admin/ai-chat-queries）"
    );
    console.log(
      `[session] store=${env.sessionStore}` +
        (env.sessionStore === "memory"
          ? " (sessions cleared on process restart; set SESSION_STORE=file on non-Windows if you need disk persistence)"
          : ` (files in ${env.sessionDir})`)
    );
  });
}

bootstrap().catch((error) => {
  console.error("[startup] init failed:", error?.message || error);
  process.exitCode = 1;
});
