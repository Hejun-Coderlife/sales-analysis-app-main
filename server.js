import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import FileStoreFactory from "session-file-store";
import { getV2Router, initV2AnalyticsModule } from "./backend/src/app.js";
import { env } from "./backend/src/config/env.js";
import { AuthService } from "./backend/src/auth/authService.js";
import { createAuthMiddleware } from "./backend/src/auth/middleware.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_HISTORY_MESSAGES = 24;
const sessions = new Map();
const salesContexts = new Map();
const MAX_TOOL_CALL_STEPS = 4;
const authService = new AuthService({ usersPath: env.usersPath });
const { requireAuthApi, requireAuthPage, requireRole } = createAuthMiddleware(authService);

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
  ];
}

function runToolCall(conversationId, toolName, toolArgs) {
  const context = salesContexts.get(conversationId);
  if (!context) {
    return {
      ok: false,
      error: "当前暂无销售数据上下文，请先上传并完成分析。",
    };
  }

  const args = toolArgs && typeof toolArgs === "object" ? toolArgs : {};
  const limit = sanitizeLimit(args.limit, 50, 500);
  const offset = Math.max(0, Math.floor(Number(args.offset || 0)));

  if (toolName === "getKpis") {
    return { ok: true, data: context.kpis, filters: context.filters, updatedAt: context.updatedAt };
  }
  if (toolName === "getTotalSales") {
    return { ok: true, totalSales: context.kpis.totalSales, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopStores") {
    return { ok: true, rows: context.topStores.slice(0, limit), updatedAt: context.updatedAt };
  }
  if (toolName === "getTopSalespeople") {
    return { ok: true, rows: context.topSalespeople.slice(0, limit), updatedAt: context.updatedAt };
  }
  if (toolName === "getAllSalespeoplePerformance") {
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
    const year = String(args.year || "").trim();
    if (!year) return { ok: false, error: "year is required" };
    const rows = (context.salespersonYearlyPerformance || [])
      .filter((x) => String(x.year || "") === year)
      .sort((a, b) => b.performance - a.performance)
      .slice(0, limit)
      .map((x, idx) => ({ rank: idx + 1, year, salesperson: x.salesperson, performance: x.performance }));
    return { ok: true, rows, year, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopSalespeopleByMonth") {
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
    const top = (context.orderSummary || [])[0];
    if (!top) return { ok: true, row: null, message: "No order data available in current filters." };
    return { ok: true, row: top, updatedAt: context.updatedAt };
  }
  if (toolName === "getTopOrders") {
    const rows = (context.orderSummary || []).slice(0, limit);
    return { ok: true, rows, total: (context.orderSummary || []).length, updatedAt: context.updatedAt };
  }
  if (toolName === "getSalespersonStores") {
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
    const month = String(args.month || "").trim();
    if (!month) return { ok: false, error: "month is required" };
    const row = (context.monthlyTrend || []).find((x) => String(x.year_month || "") === month);
    return { ok: true, month, sales_amount: Number(row?.sales_amount || 0), updatedAt: context.updatedAt };
  }
  if (toolName === "getWeeklySales") {
    const weekStart = String(args.weekStart || "").trim();
    if (!weekStart) return { ok: false, error: "weekStart is required" };
    const row = (context.weeklyTrend || []).find((x) => String(x.weekStart || "") === weekStart);
    return { ok: true, weekStart, sales_amount: Number(row?.sales_amount || 0), updatedAt: context.updatedAt };
  }
  if (toolName === "getTopStoresByMonth") {
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
    return { ok: true, rows: context.topProducts.slice(0, limit), updatedAt: context.updatedAt };
  }
  return { ok: false, error: `Unknown tool: ${toolName}` };
}

const FileStore = FileStoreFactory(session);
app.use(express.json({ limit: "20mb" }));
app.use(
  session({
    name: "sales.sid",
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new FileStore({
      path: env.sessionDir,
      retries: 1,
      ttl: Math.floor(env.sessionMaxAgeMs / 1000),
    }),
    cookie: {
      maxAge: env.sessionMaxAgeMs,
      httpOnly: true,
      sameSite: "lax",
    },
  })
);
app.use(express.static(__dirname));

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

app.get("/api/auth/me", (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "未登录" });
  return res.json({ ok: true, user: req.session.user });
});

app.get("/api/admin/users", requireRole("admin"), async (_req, res) => {
  const users = await authService.listUsers();
  return res.json({ ok: true, users });
});

app.use("/api/v2", (req, res, next) => {
  if (req.path === "/health") return next();
  return requireAuthApi(req, res, next);
});
app.use("/api/v2", getV2Router());

app.post("/api/chat/context", requireAuthApi, (req, res) => {
  const conversationId = getConversationId(req.body?.conversationId);
  if (!conversationId) {
    return res.status(400).json({ error: "缺少 conversationId" });
  }
  const salesContext = sanitizeSalesContext(req.body?.salesContext);
  salesContexts.set(conversationId, salesContext);
  return res.json({ ok: true, conversationId });
});

app.post("/api/chat", requireAuthApi, async (req, res) => {
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

  try {
    const systemMessage = {
      role: "system",
      content:
        "You are a helpful sales analytics assistant. " +
        "When user asks for numbers, rankings, or KPI values, call available tools first and answer using tool results. " +
        "When user asks which store a salesperson belongs to or where their sales happened, call getSalespersonStores. " +
        "When user asks for all salespeople, call getAllSalespeoplePerformance and do not claim a top-20 system limit. " +
        "When user asks yearly ranking questions (for example 2024 vs 2025, or whether a store is first every year), call getTopStoresByYear or getStoreYearlyRanks first. " +
        "When user asks weekly or monthly questions, call getWeeklySales/getMonthlySales or getTopStoresByWeek/getTopStoresByMonth first. " +
        "When user asks member questions, call getMemberSummary/getTopMembers/findMember first. " +
        "When user asks about members handled by a salesperson, call getMembersBySalesperson first. " +
        "When user asks for best members in a specific store, call getTopMembersByStore with that store name. " +
        "When user asks highest/single-order questions, call getHighestOrder/getTopOrders first. " +
        "When user asks salesperson ranking by year/month/week/day, call the corresponding salesperson period tools first. " +
        "Do not say period ranking is unsupported if these tools can answer it. " +
        "Do not invent sales figures.",
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

        const toolResult = runToolCall(conversationId, toolName, parsedArgs);
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
    return res.redirect(req.session.user.role === "admin" ? "/admin" : "/dashboard");
  }
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/dashboard", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/index.html", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin", requireRole("admin"), (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});
app.get("/admin.html", requireRole("admin"), (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/", (req, res) => {
  if (!req.session?.user) return res.redirect("/login");
  return res.redirect("/dashboard");
});

Promise.all([initV2AnalyticsModule(), authService.init()])
  .catch((error) => {
    console.error("[startup] init failed:", error?.message || error);
  })
  .finally(() => {
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  });
