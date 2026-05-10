import {
  applyPermissionScopeToFilters,
  finalizeMemberRowsForAgentTools,
  hasPermission,
} from "../auth/permissionModel.js";
import { AGGREGATE_ALL_READY_DATASET_ID } from "./analyticsService.js";

const OUT_OF_SCOPE_MESSAGE = "你没有权限查看该范围的数据。";
const DATA_NOT_READY_MESSAGE = "当前数据不足以判断。";
const QUERY_FAILED_MESSAGE = "数据查询失败，请稍后重试。";

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

/** 与 analyticsService.normalizeSearchNeedle 对齐，用于参数预处理 */
function normalizeNeedleArg(raw) {
  return String(raw || "")
    .trim()
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ");
}

/** 从销售员×门店明细生成摘要，避免模型误答「没有门店归属」 */
function summarizeSalespersonStoreRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let totalPerformance = 0;
  let primaryStore = "";
  let maxP = -1;
  const storeSet = new Set();
  for (const r of list) {
    const p = Number(r.performance || 0);
    totalPerformance += p;
    const st = String(r.store ?? "").trim();
    if (st) storeSet.add(st);
    if (p > maxP) {
      maxP = p;
      primaryStore = st;
    }
  }
  const storeCount = storeSet.size;
  const distinctStores = [...storeSet];
  const fmt = (n) =>
    Number.isFinite(Number(n))
      ? Number(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";
  return {
    storeCount,
    distinctStores,
    primaryStore,
    primaryPerformance: maxP >= 0 ? maxP : 0,
    totalPerformance,
    hint:
      list.length === 0
        ? "在当前日期、权限与姓名关键字下，订单明细未匹配到「销售员×门店」拆分结果。"
        : `业绩最高的门店为「${primaryStore}」（${fmt(maxP)} 元）；该销售员在本筛选范围内共出现在 ${storeCount} 个门店的业绩中，合计 ${fmt(totalPerformance)} 元。`,
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
  if (accessScope?.forceNoData) {
    return { ok: false, error: OUT_OF_SCOPE_MESSAGE };
  }
  const requested = sanitizeFilters(rawFilters);
  if (!validateRequestedScope(accessScope, requested)) {
    return { ok: false, error: OUT_OF_SCOPE_MESSAGE };
  }
  const scoped = applyPermissionScopeToFilters(requested, accessScope);
  return { ok: true, requested, scoped };
}

function buildContextMeta(currentUser, accessScope, filters) {
  return {
    userId: String(currentUser?.id || currentUser?.username || ""),
    role: String(currentUser?.role || ""),
    scope: {
      unrestricted: !!accessScope?.unrestricted,
      allowAllStores: !!accessScope?.allowAllStores,
      allowAllSalespeople: !!accessScope?.allowAllSalespeople,
      allowAllProducts: !!accessScope?.allowAllProducts,
      forceNoData: !!accessScope?.forceNoData,
      allowedStoresCount: Array.isArray(accessScope?.allowedStores) ? accessScope.allowedStores.length : 0,
      allowedSalespeopleCount: Array.isArray(accessScope?.allowedSalespeople) ? accessScope.allowedSalespeople.length : 0,
      allowedProductsCount: Array.isArray(accessScope?.allowedProducts) ? accessScope.allowedProducts.length : 0,
    },
    filters: filters || {},
  };
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
  /**
   * Must match mobile /dashboard `/api/v2` aggregate scope: every `status=ready` dataset,
   * not only the latest row in `datasets` — otherwise AI KPIs can be 0 while the UI shows sales.
   */
  async function getReadyDatasetIds() {
    return await analyticsService.listReadyDatasetIds();
  }

  function routeDatasetIdForAgent(ids) {
    if (!Array.isArray(ids) || !ids.length) return "";
    if (ids.length === 1) return String(ids[0]);
    return AGGREGATE_ALL_READY_DATASET_ID;
  }

  function getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "getKpiFromDataset",
          description:
            "Query KPI from all ready datasets; the server intersects filters with the user's allowed stores/salespeople/products, so results match what this user may see in the dashboard.",
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
          name: "getSalespersonStoreBreakdownFromDataset",
          description:
            "【店员归属哪家门店—必用】后台订单表每一行同时包含门店(store)与销售员(salesperson)，关联来自按订单聚合，不是单独的映射表。用户问「某某是哪个店的销售」「哪家店」「在哪些门店」时必须调用；传入 salespersonContains=姓名关键字（如谢元平）。返回 rows 为各门店业绩，summary.primaryStore 为业绩最高的门店。禁止答复「系统没有销售员与门店的映射」。filters.startDate/endDate 与当前会话同步的日期一致；stores/salespeople/products 默认留空（权限内全部门店），除非用户明确只要某一店/人/品。",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 200 },
              salespersonContains: { type: "string", description: "可选，销售员姓名关键字，模糊匹配" },
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
          name: "getStoresForSalespersonFromDataset",
          description:
            "与 getSalespersonStoreBreakdownFromDataset 完全相同，别名入口。专用于口语「某某是哪家店的销售」「哪个门店」；参数与返回一致，优先选此工具若更符合用户问法。",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 200 },
              salespersonContains: { type: "string", description: "销售员姓名关键字，模糊匹配" },
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
          name: "getMemberSalespersonBreakdownFromDataset",
          description:
            "仅当用户说的是「某个会员/顾客」、要问他在哪位导购名下消费时使用：按会员关键字汇总各销售员业绩。memberContains=会员姓名或编号片段。**禁止**用于「某销售员有哪些顾客」类问题（那种情况必须用 getMembersForSalespersonFromDataset）。",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 150 },
              memberContains: { type: "string", description: "必填，会员姓名或会员编号片段" },
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
            required: ["memberContains"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getMembersForSalespersonFromDataset",
          description:
            "从后台订单明细列出「某销售员/导购名下有哪些会员顾客」（按会员聚合消费）。用户问「张维手里有哪些顾客」「某导购名下会员清单」等时必须调用；salespersonContains 填销售员姓名片段。**不要**误用 getMemberSalespersonBreakdownFromDataset（那是输入会员名查导购）。filters.startDate/endDate 与当前会话同步；门店/销售员/商品维度默认留空（不按看板多选缩小），除非用户明确点名收窄。",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 200 },
              salespersonContains: { type: "string", description: "必填，销售员姓名关键字（模糊匹配）" },
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
            required: ["salespersonContains"],
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
      {
        type: "function",
        function: {
          name: "getDataCompletenessFromDataset",
          description: "Check data completeness and missing fields from current dataset.",
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
    ];
  }

  async function runToolCall({ currentUser, accessScope, toolName, toolArgs }) {
    try {
      const args = toolArgs && typeof toolArgs === "object" ? toolArgs : {};
      const deny = () => ({ ok: false, error: OUT_OF_SCOPE_MESSAGE, code: "OUT_OF_SCOPE" });
      const datasetIds = await getReadyDatasetIds();
      if (!datasetIds.length) {
        return { ok: false, error: DATA_NOT_READY_MESSAGE, code: "DATA_NOT_READY" };
      }
      const datasetId = routeDatasetIdForAgent(datasetIds);

      if (toolName === "getKpiFromDataset") {
        if (!hasPermission(currentUser, "canViewKpi")) return deny();
        const scoped = buildScopedFilters(args.filters, accessScope);
        if (!scoped.ok) return deny();
        const kpis = await analyticsService.getKpis(datasetIds, scoped.scoped);
        const totalSales = Number(kpis?.totalSales ?? kpis?.totalsales ?? 0);
        const totalOrders = Number(kpis?.totalOrders ?? kpis?.totalorders ?? 0);
        const uniqueMembers = Number(kpis?.uniqueMembers ?? kpis?.uniquemembers ?? 0);
        const avgTicket = totalOrders > 0 ? totalSales / totalOrders : 0;
        return {
          ok: true,
          datasetId,
          filters: scoped.scoped,
          contextMeta: buildContextMeta(currentUser, accessScope, scoped.scoped),
          data: { totalSales, totalOrders, uniqueMembers, avgTicket },
        };
      }

      if (toolName === "getStoreRankingFromDataset") {
        if (!hasPermission(currentUser, "canViewStoreRanking")) return deny();
        const scoped = buildScopedFilters(args.filters, accessScope);
        if (!scoped.ok) return deny();
        const limit = sanitizeLimit(args.limit, 20, 200);
        const rows = await analyticsService.getTopStores(datasetIds, { filters: scoped.scoped, limit, offset: 0 });
        return {
          ok: true,
          datasetId,
          rows,
          total: rows.length,
          filters: scoped.scoped,
          contextMeta: buildContextMeta(currentUser, accessScope, scoped.scoped),
        };
      }

      if (toolName === "getSalespersonRankingFromDataset") {
        if (!hasPermission(currentUser, "canViewSalespersonRanking")) return deny();
        const scoped = buildScopedFilters(args.filters, accessScope);
        if (!scoped.ok) return deny();
        const limit = sanitizeLimit(args.limit, 20, 200);
        const rows = await analyticsService.getTopSalespeople(datasetIds, { filters: scoped.scoped, limit, offset: 0 });
        return {
          ok: true,
          datasetId,
          rows,
          total: rows.length,
          filters: scoped.scoped,
          contextMeta: buildContextMeta(currentUser, accessScope, scoped.scoped),
        };
      }

      if (toolName === "getProductRankingFromDataset") {
        if (!hasPermission(currentUser, "canViewProductRanking")) return deny();
        const scoped = buildScopedFilters(args.filters, accessScope);
        if (!scoped.ok) return deny();
        const limit = sanitizeLimit(args.limit, 20, 200);
        const rows = await analyticsService.getTopProducts(datasetIds, { filters: scoped.scoped, limit, offset: 0 });
        return {
          ok: true,
          datasetId,
          rows,
          total: rows.length,
          filters: scoped.scoped,
          contextMeta: buildContextMeta(currentUser, accessScope, scoped.scoped),
        };
      }

      if (toolName === "getSalespersonStoreBreakdownFromDataset" || toolName === "getStoresForSalespersonFromDataset") {
        if (!hasPermission(currentUser, "canViewSalespersonRanking")) return deny();
        if (!hasPermission(currentUser, "canViewStoreRanking")) return deny();
        const scoped = buildScopedFilters(args.filters, accessScope);
        if (!scoped.ok) return deny();
        const limit = sanitizeLimit(args.limit, 80, 200);
        const spNeedle = normalizeNeedleArg(args.salespersonContains);
        const rows = await analyticsService.getSalespersonStoreBreakdown(datasetIds, {
          filters: scoped.scoped,
          limit,
          offset: 0,
          salespersonContains: spNeedle,
        });
        const summary = summarizeSalespersonStoreRows(rows);
        return {
          ok: true,
          datasetId,
          rows,
          summary,
          total: rows.length,
          filters: scoped.scoped,
          contextMeta: buildContextMeta(currentUser, accessScope, scoped.scoped),
        };
      }

      if (toolName === "getMemberSalespersonBreakdownFromDataset") {
        if (!hasPermission(currentUser, "canViewMemberAnalysis")) return deny();
        if (!hasPermission(currentUser, "canViewSalespersonRanking")) return deny();
        const scoped = buildScopedFilters(args.filters, accessScope);
        if (!scoped.ok) return deny();
        const memberNeedle = normalizeNeedleArg(args.memberContains);
        if (!memberNeedle) {
          return { ok: false, error: "请提供 memberContains（会员姓名或编号片段）", code: "INVALID_ARGUMENT" };
        }
        const limit = sanitizeLimit(args.limit, 60, 150);
        const rows = await analyticsService.getMemberSalespersonBreakdown(datasetIds, {
          filters: scoped.scoped,
          limit,
          offset: 0,
          memberContains: memberNeedle,
        });
        return {
          ok: true,
          datasetId,
          rows,
          total: rows.length,
          filters: scoped.scoped,
          contextMeta: buildContextMeta(currentUser, accessScope, scoped.scoped),
        };
      }

      if (toolName === "getMembersForSalespersonFromDataset") {
        if (!hasPermission(currentUser, "canViewMemberAnalysis")) return deny();
        if (!hasPermission(currentUser, "canViewSalespersonRanking")) return deny();
        const scoped = buildScopedFilters(args.filters, accessScope);
        if (!scoped.ok) return deny();
        const spNeedle = normalizeNeedleArg(args.salespersonContains);
        if (!spNeedle) {
          return { ok: false, error: "请提供 salespersonContains（销售员姓名片段）", code: "INVALID_ARGUMENT" };
        }
        const limit = sanitizeLimit(args.limit, 80, 200);
        const rows = await analyticsService.getMembersForSalesperson(datasetIds, {
          filters: scoped.scoped,
          limit,
          offset: 0,
          salespersonContains: spNeedle,
        });
        const masked = finalizeMemberRowsForAgentTools(rows || [], currentUser?.allowedMemberFields || {});
        return {
          ok: true,
          datasetId,
          rows: masked,
          distinctMemberCount: Array.isArray(masked) ? masked.length : 0,
          note:
            "distinctMemberCount 与 rows 长度一致，均为当前筛选日期与权限范围内、订单归属到该销售员关键字下的去重会员数；勿与未调用本工具得到的其它口径混用。",
          filters: scoped.scoped,
          contextMeta: buildContextMeta(currentUser, accessScope, scoped.scoped),
        };
      }

      if (toolName === "getSleepingMembersSummaryFromDataset") {
        if (!hasPermission(currentUser, "canViewSleepingMembers")) return deny();
        const scoped = buildScopedFilters(args.filters, accessScope);
        if (!scoped.ok) return deny();
        const limit = sanitizeLimit(args.limit, 20, 100);
        const sleeping = await analyticsService.getSleepingAnalytics(datasetIds, {
          filters: scoped.scoped,
          analysisDate: scoped.scoped.endDate || "",
          limit,
          offset: 0,
        });
        return {
          ok: true,
          datasetId,
          filters: scoped.scoped,
          contextMeta: buildContextMeta(currentUser, accessScope, scoped.scoped),
          sleepSummary: sleeping.sleepSummary || [],
          rows: finalizeMemberRowsForAgentTools(sleeping.rows || [], currentUser?.allowedMemberFields || {}),
        };
      }

      if (toolName === "getTrendFromDataset") {
        if (!hasPermission(currentUser, "canViewTrendCharts")) return deny();
        const preset = String(args.preset || "last7d");
        if (!["last7d", "last30d", "thisMonth"].includes(preset)) {
          return { ok: false, error: "preset must be last7d/last30d/thisMonth", code: "INVALID_ARGUMENT" };
        }
        const scoped = buildScopedFilters(args.filters, accessScope);
        if (!scoped.ok) return deny();
        const range = buildTrendRange(preset);
        const trendFilters = {
          ...scoped.scoped,
          startDate: range.startDate,
          endDate: range.endDate,
        };
        const trends = await analyticsService.getTrendSeries(datasetIds, { filters: trendFilters });
        return {
          ok: true,
          datasetId,
          preset,
          filters: trendFilters,
          contextMeta: buildContextMeta(currentUser, accessScope, trendFilters),
          daily: trends.daily || [],
        };
      }

      if (toolName === "getDataCompletenessFromDataset") {
        if (!hasPermission(currentUser, "canViewDataQuality")) return deny();
        const scoped = buildScopedFilters(args.filters, accessScope);
        if (!scoped.ok) return deny();
        const report = await analyticsService.getDataQualityReport(datasetIds, { filters: scoped.scoped });
        const messages = Array.isArray(report?.messages) ? report.messages : [];
        const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
        const suggestions = [];
        if (messages.some((m) => String(m).includes("销售员字段未识别"))) {
          suggestions.push("请确认订单表包含销售员字段，并检查导入映射是否匹配“销售员/营业员/导购”等列名。");
        }
        if (messages.some((m) => String(m).includes("商品字段未识别"))) {
          suggestions.push("请确认订单表包含商品字段，并检查导入映射是否匹配“商品/品名/货品名称”等列名。");
        }
        if (messages.some((m) => String(m).includes("会员字段未识别"))) {
          suggestions.push("请补充会员相关字段（会员编号/会员姓名/手机号），否则会员注册率、复购率等指标无法完整计算。");
        }
        if (!messages.length && !warnings.length) {
          suggestions.push("当前数据字段识别正常，可继续核查时间范围和筛选条件是否与分析目标一致。");
        }
        suggestions.push("如仍异常，请联系管理员在后台重新导入并检查字段映射明细。");
        return {
          ok: true,
          datasetId,
          filters: scoped.scoped,
          contextMeta: buildContextMeta(currentUser, accessScope, scoped.scoped),
          completeness: {
            messages,
            warnings: warnings.slice(0, 20),
            mappingRows: report?.mappingRows || [],
            summary: report?.summary || {},
            suggestions,
          },
        };
      }

      return null;
    } catch (error) {
      return {
        ok: false,
        error: QUERY_FAILED_MESSAGE,
        code: "TOOL_QUERY_FAILED",
      };
    }
  }

  return {
    getToolDefinitions,
    runToolCall,
  };
}
