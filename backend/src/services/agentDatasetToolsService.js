import {
  applyPermissionScopeToFilters,
  hasPermission,
  maskSensitiveMemberRows,
} from "../auth/permissionModel.js";

const OUT_OF_SCOPE_MESSAGE = "你没有权限查看该范围的数据。";

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  return text;
}

function sanitizeLimit(raw, fallback = 20, max = 200) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function normalizeStringArray(value, max = 50) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

function sanitizeFilters(rawFilters) {
  const source = rawFilters && typeof rawFilters === "object" ? rawFilters : {};
  return {
    startDate: normalizeDate(source.startDate),
    endDate: normalizeDate(source.endDate),
    stores: normalizeStringArray(source.stores, 50),
    salespeople: normalizeStringArray(source.salespeople, 50),
    products: normalizeStringArray(source.products, 50),
  };
}

function validateRequestedScope(scope, requestedFilters) {
  if (!scope || scope.unrestricted) return true;
  const ensureAllowed = (requested, allowed, allowAll) => {
    if (!Array.isArray(requested) || !requested.length) return true;
    if (allowAll) return true;
    const allowSet = new Set(Array.isArray(allowed) ? allowed : []);
    return requested.every((item) => allowSet.has(item));
  };
  return (
    ensureAllowed(requestedFilters.stores, scope.allowedStores, scope.allowAllStores) &&
    ensureAllowed(requestedFilters.salespeople, scope.allowedSalespeople, scope.allowAllSalespeople) &&
    ensureAllowed(requestedFilters.products, scope.allowedProducts, scope.allowAllProducts)
  );
}

function buildScopedFilters(rawFilters, accessScope) {
  const requested = sanitizeFilters(rawFilters);
  if (!validateRequestedScope(accessScope, requested)) {
    return { ok: false, error: OUT_OF_SCOPE_MESSAGE };
  }
  const scoped = applyPermissionScopeToFilters(requested, accessScope);
  return { ok: true, requested, scoped };
}

function buildTrendRange(preset) {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  if (preset === "last30d") {
    const start = new Date(end);
    start.setDate(end.getDate() - 29);
    return { startDate: fmt(start), endDate: fmt(end) };
  }
  if (preset === "thisMonth") {
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    return { startDate: fmt(start), endDate: fmt(end) };
  }
  const start = new Date(end);
  start.setDate(end.getDate() - 6);
  return { startDate: fmt(start), endDate: fmt(end) };
}

export function createAgentDatasetToolsService({ analyticsService }) {
  async function getReadyDatasetId() {
    const latest = await analyticsService.getLatestDatasetSummary({ onlyReady: true });
    return String(latest?.dataset_id || "");
  }

  function getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "getKpiFromDataset",
          description: "Query KPI from current dataset with permission-scoped filters.",
          parameters: {
            type: "object",
            properties: {
              filters: {
                type: "object",
                properties: {
                  startDate: { type: "string" },
                  endDate: { type: "string" },
                  stores: { type: "array", items: { type: "string" } },
                  salespeople: { type: "array", items: { type: "string" } },
                  products: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getStoreRankingFromDataset",
          description: "Query store ranking from current dataset with permission-scoped filters.",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 200 },
              filters: {
                type: "object",
                properties: {
                  startDate: { type: "string" },
                  endDate: { type: "string" },
                  stores: { type: "array", items: { type: "string" } },
                  salespeople: { type: "array", items: { type: "string" } },
                  products: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getSalespersonRankingFromDataset",
          description: "Query salesperson ranking from current dataset with permission-scoped filters.",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 200 },
              filters: {
                type: "object",
                properties: {
                  startDate: { type: "string" },
                  endDate: { type: "string" },
                  stores: { type: "array", items: { type: "string" } },
                  salespeople: { type: "array", items: { type: "string" } },
                  products: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getProductRankingFromDataset",
          description: "Query product ranking from current dataset with permission-scoped filters.",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 200 },
              filters: {
                type: "object",
                properties: {
                  startDate: { type: "string" },
                  endDate: { type: "string" },
                  stores: { type: "array", items: { type: "string" } },
                  salespeople: { type: "array", items: { type: "string" } },
                  products: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getSleepingMembersSummaryFromDataset",
          description: "Query sleeping members summary from dataset with permission-scoped filters.",
          parameters: {
            type: "object",
            properties: {
              filters: {
                type: "object",
                properties: {
                  startDate: { type: "string" },
                  endDate: { type: "string" },
                  stores: { type: "array", items: { type: "string" } },
                  salespeople: { type: "array", items: { type: "string" } },
                  products: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getTrendFromDataset",
          description: "Query trend from dataset for last7d / last30d / thisMonth.",
          parameters: {
            type: "object",
            properties: {
              preset: { type: "string", enum: ["last7d", "last30d", "thisMonth"] },
              filters: {
                type: "object",
                properties: {
                  stores: { type: "array", items: { type: "string" } },
                  salespeople: { type: "array", items: { type: "string" } },
                  products: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
    ];
  }

  async function runToolCall({ currentUser, accessScope, toolName, toolArgs }) {
    const args = toolArgs && typeof toolArgs === "object" ? toolArgs : {};
    const deny = () => ({ ok: false, error: OUT_OF_SCOPE_MESSAGE });
    const datasetId = await getReadyDatasetId();
    if (!datasetId) {
      return { ok: false, error: "当前数据不足以判断" };
    }

    if (toolName === "getKpiFromDataset") {
      if (!hasPermission(currentUser, "canViewKpi")) return deny();
      const scoped = buildScopedFilters(args.filters, accessScope);
      if (!scoped.ok) return deny();
      const kpis = await analyticsService.getKpis(datasetId, scoped.scoped);
      const totalSales = Number(kpis?.totalSales ?? kpis?.totalsales ?? 0);
      const totalOrders = Number(kpis?.totalOrders ?? kpis?.totalorders ?? 0);
      const uniqueMembers = Number(kpis?.uniqueMembers ?? kpis?.uniquemembers ?? 0);
      const avgTicket = totalOrders > 0 ? totalSales / totalOrders : 0;
      return { ok: true, datasetId, filters: scoped.scoped, data: { totalSales, totalOrders, uniqueMembers, avgTicket } };
    }

    if (toolName === "getStoreRankingFromDataset") {
      if (!hasPermission(currentUser, "canViewStoreRanking")) return deny();
      const scoped = buildScopedFilters(args.filters, accessScope);
      if (!scoped.ok) return deny();
      const limit = sanitizeLimit(args.limit, 20, 200);
      const rows = await analyticsService.getTopStores(datasetId, { filters: scoped.scoped, limit, offset: 0 });
      return { ok: true, datasetId, rows, total: rows.length, filters: scoped.scoped };
    }

    if (toolName === "getSalespersonRankingFromDataset") {
      if (!hasPermission(currentUser, "canViewSalespersonRanking")) return deny();
      const scoped = buildScopedFilters(args.filters, accessScope);
      if (!scoped.ok) return deny();
      const limit = sanitizeLimit(args.limit, 20, 200);
      const rows = await analyticsService.getTopSalespeople(datasetId, { filters: scoped.scoped, limit, offset: 0 });
      return { ok: true, datasetId, rows, total: rows.length, filters: scoped.scoped };
    }

    if (toolName === "getProductRankingFromDataset") {
      if (!hasPermission(currentUser, "canViewProductRanking")) return deny();
      const scoped = buildScopedFilters(args.filters, accessScope);
      if (!scoped.ok) return deny();
      const limit = sanitizeLimit(args.limit, 20, 200);
      const rows = await analyticsService.getTopProducts(datasetId, { filters: scoped.scoped, limit, offset: 0 });
      return { ok: true, datasetId, rows, total: rows.length, filters: scoped.scoped };
    }

    if (toolName === "getSleepingMembersSummaryFromDataset") {
      if (!hasPermission(currentUser, "canViewSleepingMembers")) return deny();
      const scoped = buildScopedFilters(args.filters, accessScope);
      if (!scoped.ok) return deny();
      const limit = sanitizeLimit(args.limit, 20, 100);
      const sleeping = await analyticsService.getSleepingAnalytics(datasetId, {
        filters: scoped.scoped,
        analysisDate: scoped.scoped.endDate || "",
        limit,
        offset: 0,
      });
      return {
        ok: true,
        datasetId,
        filters: scoped.scoped,
        sleepSummary: sleeping.sleepSummary || [],
        rows: maskSensitiveMemberRows(sleeping.rows || [], currentUser?.allowedMemberFields || {}),
      };
    }

    if (toolName === "getTrendFromDataset") {
      if (!hasPermission(currentUser, "canViewTrendCharts")) return deny();
      const preset = String(args.preset || "last7d");
      if (!["last7d", "last30d", "thisMonth"].includes(preset)) {
        return { ok: false, error: "preset must be last7d/last30d/thisMonth" };
      }
      const scoped = buildScopedFilters(args.filters, accessScope);
      if (!scoped.ok) return deny();
      const range = buildTrendRange(preset);
      const trendFilters = {
        ...scoped.scoped,
        startDate: range.startDate,
        endDate: range.endDate,
      };
      const trends = await analyticsService.getTrendSeries(datasetId, { filters: trendFilters });
      return { ok: true, datasetId, preset, filters: trendFilters, daily: trends.daily || [] };
    }

    return null;
  }

  return {
    getToolDefinitions,
    runToolCall,
  };
}
