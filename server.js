import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import FileStoreFactory from "session-file-store";
import { getV2Router, getV2Services, initV2AnalyticsModule } from "./backend/src/app.js";
import { env } from "./backend/src/config/env.js";
import { AuthService } from "./backend/src/auth/authService.js";
import { createAuthMiddleware, safeLoginNextPath } from "./backend/src/auth/middleware.js";
import { AuditLogStore } from "./backend/src/services/auditLogStore.js";
import { createAgentDatasetToolsService } from "./backend/src/services/agentDatasetToolsService.js";
import { sendDingTalkTestWorkNotification } from "./backend/src/services/dingtalkWorkNotifyService.js";
import { NotificationStore } from "./backend/src/services/notificationStore.js";
import { hasPermission, maskSensitiveMemberRows } from "./backend/src/auth/permissionModel.js";

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_HISTORY_MESSAGES = 24;
const sessions = new Map();
const salesContexts = new Map();
const MAX_TOOL_CALL_STEPS = 4;
const OUT_OF_SCOPE_MESSAGE = "你没有权限查看该范围的数据。";
const authService = new AuthService({ usersPath: env.usersPath });
const { getCurrentUser, requireAuthApi, requireAuthPage, requirePermission, requireAdminApi } =
  createAuthMiddleware(authService);
const { analyticsService, jobStore } = getV2Services();
const auditLogStore = new AuditLogStore({ logPath: env.auditLogsPath });
const agentDatasetToolsService = createAgentDatasetToolsService({ analyticsService });
const notificationStore = new NotificationStore({ notificationsPath: env.notificationsPath });

async function appendAuditLog(entry = {}) {
  try {
    await auditLogStore.append(entry);
  } catch (_error) {
    // Audit persistence should never break main business flow.
  }
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

function ensurePermissionOrDeny(res, user, permissionName) {
  if (hasPermission(user, permissionName)) return true;
  res.status(403).json({ error: "无权限访问" });
  return false;
}

function getConversationId(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return null;
  return value.slice(0, 64);
}

function getSessionMessages(conversationId) {
  if (!conversationId) return [];
  return sessions.get(conversationId) || [];
}

function setSessionMessages(conversationId, messages) {
  if (!conversationId || !Array.isArray(messages)) return;
  sessions.set(conversationId, messages.slice(-MAX_HISTORY_MESSAGES));
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
  const raw = String(text || "");
  return raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
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
  // Remove emoji/pictograph symbols that look noisy in compact chat bubbles.
  value = value.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "");

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
        normalizedLines.push(cells.join("  "));
        continue;
      }
    }
    normalizedLines.push(rawLine);
  }
  value = normalizedLines.join("\n");

  // Clean extra whitespace introduced by replacements.
  value = value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return value;
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
        const latest = await analyticsService.getLatestDatasetSummary({ onlyReady: true });
        const datasetId = context.datasetId || latest?.dataset_id;
        if (datasetId) {
          const scopedFilters = {
            ...contextFilters,
            startDate: intersectStart,
            endDate: intersectEnd,
          };
          const queriedRows = await analyticsService.getTopSalespeople(datasetId, {
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
    const rows = (context.memberRank || [])
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
    const rows = (context.memberRank || [])
      .filter((m) => {
        const name = String(m.member_name || "").toLowerCase();
        const phone = String(m.phone || "").toLowerCase();
        const memberKey = String(m.member_key || "").toLowerCase();
        return name.includes(keyword) || phone.includes(keyword) || memberKey.includes(keyword);
      })
      .slice(0, memberLimit);
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
    const rows = matched.slice(0, memberLimit).map((m, idx) => ({
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

app.post("/api/auth/login", async (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  const result = await authService.authenticate(username, password);
  if (!result.ok) return res.status(401).json({ error: result.error || "登录失败" });
  req.session.user = result.user;
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

app.get("/api/dingtalk/config", requireAuthApi, (_req, res) => {
  return res.json({
    ok: true,
    corpId: env.dingtalkCorpId || "",
  });
});

app.post("/api/dingtalk/bind", requireAuthApi, async (req, res) => {
  const code = String(req.body?.code || "").trim();
  if (!code) return res.status(400).json({ error: "code 不能为空" });
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
  return res.json({ ok: true, latest: latest || null });
});

app.get("/api/admin/import/history", requireAdminApi, async (req, res) => {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canViewImportHistory")) return;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await jobStore.listJobs({ type: "ingest", limit, offset });
  const rows = (data.rows || []).map((job) => ({
    jobId: job.id,
    filename: String(job?.payload?.sourceName || ""),
    importedAt: job.updatedAt || job.createdAt,
    rowCount: Number(job?.stats?.rowCount || 0),
    status: String(job?.status || ""),
    importedBy: String(job?.payload?.importedBy || ""),
    datasetId: job?.datasetId || null,
  }));
  return res.json({ ok: true, rows, total: data.total, limit: data.limit, offset: data.offset });
});

app.get("/api/admin/audit-logs", requireAdminApi, async (req, res) => {
  if (!ensurePermissionOrDeny(res, req.currentUser, "canViewAuditLogs")) return;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await auditLogStore.list({ limit, offset });
  return res.json({ ok: true, ...data });
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
      publicBaseUrl: env.publicBaseUrl,
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

app.post("/api/chat/context", requireAuthApi, (req, res) => {
  if (!hasPermission(req.currentUser, "canUseAgentChat")) {
    return res.status(403).json({ error: OUT_OF_SCOPE_MESSAGE });
  }
  const conversationId = getConversationId(req.body?.conversationId);
  if (!conversationId) {
    return res.status(400).json({ error: "缺少 conversationId" });
  }
  const salesContext = applyScopeToSalesContext(req.body?.salesContext, req.currentUser, req.accessScope);
  salesContexts.set(conversationId, {
    userId: String(req.currentUser?.id || ""),
    context: salesContext,
  });
  return res.json({ ok: true, conversationId });
});

app.post("/api/chat", requireAuthApi, async (req, res) => {
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

  try {
    const systemMessage = {
      role: "system",
      content:
        "You are an operations advisor for retail business users. " +
        "Always answer in Chinese and in this order: 先给结论，再给数据依据，最后给可执行建议。 " +
        "Do not use technical words such as tool, API, SQL, context, endpoint, schema. " +
        "When data is not enough, explicitly say: 当前数据不足以判断。 " +
        "When key fields are missing or unrecognized (for example salesperson field), state it directly and do not guess. " +
        "If metrics like 会员注册率/复购率/订单明细 are unavailable, guide user to检查导入字段映射并联系管理员补充数据。 " +
        "Never invent numbers.",
    };
    const workingMessages = [systemMessage, ...getSessionMessages(conversationId), { role: "user", content: userMessage }];
    const tools = getToolDefinitions();
    let finalReply = "";
    let finalUsage = null;

    for (let step = 0; step < MAX_TOOL_CALL_STEPS; step += 1) {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: workingMessages,
          tools,
          tool_choice: "auto",
          temperature: 0.3,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({
          error: data?.error?.message || "上游 AI 接口调用失败",
        });
      }

      finalUsage = data?.usage || finalUsage;
      const assistantMessage = data?.choices?.[0]?.message;
      if (!assistantMessage) {
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
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(toolCall?.function?.arguments || "{}");
        } catch (_error) {
          parsedArgs = {};
        }

        const contextEntry = salesContexts.get(conversationId);
        if (contextEntry?.userId && contextEntry.userId !== String(req.currentUser?.id || "")) {
          return res.status(403).json({ error: OUT_OF_SCOPE_MESSAGE });
        }
        const toolResult = await runToolCall(contextEntry, req.currentUser, req.accessScope, toolName, parsedArgs);
        workingMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        });
      }
    }

    if (!finalReply) {
      return res.status(502).json({ error: "工具调用结束，但未生成最终回答" });
    }

    setSessionMessages(conversationId, workingMessages.slice(1));
    const uiActions = deriveUiActions(userMessage);
    return res.json({
      reply: finalReply,
      usage: finalUsage,
      conversationId,
      uiActions,
    });
  } catch (error) {
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
  sessions.delete(conversationId);
  salesContexts.delete(conversationId);
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

app.get("/mobile", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(__dirname, "mobile.html"));
});
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

app.use(express.static(__dirname, { index: false }));

Promise.all([initV2AnalyticsModule(), authService.init(), auditLogStore.init(), notificationStore.init()])
  .catch((error) => {
    console.error("[startup] init failed:", error?.message || error);
  })
  .finally(() => {
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
      console.log(
        `[session] store=${env.sessionStore}` +
          (env.sessionStore === "memory"
            ? " (sessions cleared on process restart; set SESSION_STORE=file on non-Windows if you need disk persistence)"
            : ` (files in ${env.sessionDir})`)
      );
    });
  });
