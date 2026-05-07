import { featureFlags } from "../config/feature-flags.js";
import {
  getDataQualityReport,
  getDatasetKpis,
  getFilterOptions,
  getLatestDatasetSummary,
  getMemberRankings,
  getPagedTable,
  getProductRankings,
  getSalespersonRankings,
  getSleepingMembers,
  getStoreRankings,
  getTrendSeries,
  startUploadJob,
  waitForJob,
} from "../api/v2-client.js";
import {
  setDatasetId,
  setFilterOptions,
  setLatestJob,
  setLatestResults,
  setV2Loading,
  v2State,
} from "../state/v2-state.js";
import { setHtml } from "../dom/safe-dom.js";
import { renderVirtualTable } from "../tables/virtual-table.js";

function setStatus(message, isError = false) {
  const html = isError ? `<span class="warn">错误：</span>${message}` : message;
  setHtml("status", html);
}

function getFiles() {
  const input = document.getElementById("files");
  return input?.files ? [...input.files] : [];
}

function mapKpisToLegacyShape(kpis) {
  return {
    totalSales: Number(kpis?.totalsales ?? kpis?.totalSales ?? 0),
    totalOrders: Number(kpis?.totalorders ?? kpis?.totalOrders ?? 0),
  };
}

function getDateFilters() {
  return {
    startDate: document.getElementById("dashboardStartDate")?.value || "",
    endDate: document.getElementById("dashboardEndDate")?.value || "",
  };
}

function getSelectedValues(setLike) {
  if (!setLike) return [];
  return Array.isArray(setLike) ? setLike : [...setLike];
}

function getV2Filters() {
  const appState = window.appState || {};
  return {
    ...getDateFilters(),
    stores: getSelectedValues(appState.selectedStores),
    salespeople: getSelectedValues(appState.selectedSalespeople),
    products: getSelectedValues(appState.selectedProducts),
  };
}

function getSleepingConfig() {
  return {
    sleepDays: Number(document.getElementById("sleepDays")?.value || 90),
    sleepMinOrders: Number(document.getElementById("sleepMinOrders")?.value || 2),
    sleepMinAmount: Number(document.getElementById("sleepMinAmount")?.value || 1000),
    aclassMinAmount: Number(document.getElementById("aclassMinAmount")?.value || 3000),
    aclassMinOrders: Number(document.getElementById("aclassMinOrders")?.value || 5),
    analysisDate: document.getElementById("dashboardEndDate")?.value || "",
  };
}

function isPermissionDeniedError(error) {
  const message = String(error?.message || "");
  return (
    message.includes("你没有权限查看该范围的数据。") ||
    message.includes("无权限访问") ||
    message.includes("暂无权限查看此模块") ||
    /\b403\b/i.test(message)
  );
}

function normalizeQualityMessages(messages = []) {
  const normalized = (messages || []).map((msg) =>
    msg === "销售员字段未识别" ? "销售员字段未识别，无法生成销售员排行" : msg
  );
  return [...new Set(normalized)];
}

const MODULE_FORBIDDEN_HTML = '<p class="small" style="padding:12px">暂无权限查看此模块</p>';
const forbiddenRenderIds = new Set();

function queueForbiddenContainers(containerIds) {
  if (!Array.isArray(containerIds)) return;
  containerIds.forEach((id) => forbiddenRenderIds.add(id));
}

function flushForbiddenPlaceholders() {
  for (const id of forbiddenRenderIds) {
    setHtml(id, MODULE_FORBIDDEN_HTML);
  }
  forbiddenRenderIds.clear();
}

async function optionalSection(promiseFactory, fallbackValue, containerIds = null) {
  try {
    return await promiseFactory();
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      queueForbiddenContainers(containerIds);
      return fallbackValue;
    }
    throw error;
  }
}

function mapMemberRows(rows) {
  return (rows || []).map((row) => {
    const totalSpend = Number(row.total_spend || 0);
    const orderCount = Number(row.order_count || 0);
    return {
      member_key: String(row.member_id || row.member_name || ""),
      member_name: String(row.member_name || ""),
      total_spend: totalSpend,
      order_count: orderCount,
      avg_ticket: orderCount ? totalSpend / orderCount : 0,
      repurchase_times: Math.max(0, orderCount - 1),
      last_purchase_date: String(row.last_order_date || ""),
      phone: String(row.phone || ""),
      latest_store: "",
      latest_salesperson: "",
    };
  });
}

function buildTicketRankRows(storeRank = []) {
  return (storeRank || [])
    .map((row) => {
      const totalSales = Number(row.performance || 0);
      const orderCount = Number(row.order_count || row.orderCount || 0);
      return {
        store: String(row.store || ""),
        total_sales: totalSales,
        order_count: orderCount,
        avg_ticket: orderCount > 0 ? totalSales / orderCount : 0,
      };
    })
    .filter((row) => {
      const name = String(row.store || "").trim();
      return name && name !== "Unknown" && name !== "Unregistered";
    })
    .sort((a, b) => b.avg_ticket - a.avg_ticket);
}

function buildRepurchaseDistribution(memberRows = []) {
  const buckets = [
    { key: "6+ orders", min: 6, max: Infinity },
    { key: "4-5 orders", min: 4, max: 5 },
    { key: "3 orders", min: 3, max: 3 },
    { key: "2 orders", min: 2, max: 2 },
    { key: "1 order", min: 1, max: 1 },
  ];
  return buckets.map((bucket) => ({
    order_bucket: bucket.key,
    member_count: (memberRows || []).filter((m) => {
      const c = Number(m.order_count || 0);
      return c >= bucket.min && c <= bucket.max;
    }).length,
  }));
}

function renderUnavailableMessage(containerId, message) {
  setHtml(containerId, `<p class="small" style="padding:12px">${message}</p>`);
}

function applyQualityMessages(results, qualityMessages = []) {
  const normalizedMessages = normalizeQualityMessages(qualityMessages);
  const hasSalespersonMessage = normalizedMessages.includes("销售员字段未识别，无法生成销售员排行");
  const hasProductMessage = normalizedMessages.includes("商品字段未识别或无商品数据");
  const hasMemberMessage = normalizedMessages.includes("会员字段未识别或无会员数据");

  if (hasSalespersonMessage || !(results.salespersonRank || []).length) {
    const msg = hasSalespersonMessage ? "销售员字段未识别，无法生成销售员排行" : "暂无销售员数据";
    ["salesRankTable", "rankingsSalespersonMini", "topSalespeople"].forEach((id) =>
      renderUnavailableMessage(id, msg)
    );
  }
  if (hasProductMessage || !(results.productRank || []).length) {
    const msg = hasProductMessage ? "商品字段未识别或无商品数据" : "暂无商品数据";
    ["productRankTable", "rankingsProductMini", "topProducts"].forEach((id) =>
      renderUnavailableMessage(id, msg)
    );
  }
  if (hasMemberMessage || !(results.memberRank || []).length) {
    const msg = hasMemberMessage ? "会员字段未识别或无会员数据" : "暂无会员数据";
    ["memberRankTable", "sleepListTable", "sleepByStoreTable"].forEach((id) =>
      renderUnavailableMessage(id, msg)
    );
  }
}

function mergeV2IntoLegacyResults(payload) {
  const appState = window.appState || {};
  const prev = appState?.results?.results || {};
  const merged = {
    ...prev,
    kpis: {
      ...(prev.kpis || {}),
      ...(payload.kpis || {}),
      sleepingMembers: Number(payload.sleepList?.length || 0),
      aClassSleepingMembers: Number((payload.sleepList || []).filter((x) => x.priority === "A").length || 0),
    },
    storeRank: payload.storeRank || [],
    salespersonRank: payload.salespersonRank || [],
    memberRank: payload.memberRank || [],
    sleepList: payload.sleepList || [],
    sleepByStore: payload.sleepByStore || [],
    sleepSummary: payload.sleepSummary || [],
    productRank: payload.productRank || [],
    ticketRank: payload.ticketRank || [],
    daily: payload.daily || [],
    weekly: payload.weekly || [],
    monthly: payload.monthly || [],
    repurchaseDistribution: payload.repurchaseDistribution || [],
    fileCheck: payload.fileCheck || [],
  };
  const container = {
    ...(appState.results || {}),
    results: merged,
    originalCleaned: Array.isArray(appState.results?.originalCleaned)
      ? appState.results.originalCleaned
      : [],
    mappings: payload.mappingRows || appState.results?.mappings || [],
    qualityMessages: payload.qualityMessages || [],
    isV2Backed: true,
  };
  appState.results = container;
  window.appState = appState;
  return merged;
}

function runRenderStep(label, fn) {
  try {
    fn();
  } catch (error) {
    console.warn(`[v2-bridge] render step skipped (${label}):`, error);
  }
}

function renderFromResults(results, keepDropdownOpen = false) {
  if (!results) return;
  document.getElementById("resultArea")?.classList.remove("hidden");
  runRenderStep("renderKpisFromResults", () => window.renderKpisFromResults?.(results));
  runRenderStep("renderAllTablesFromResults", () => window.renderAllTablesFromResults?.(results));
  runRenderStep("updateDashboardCharts", () => window.updateDashboardCharts?.("default"));
  runRenderStep("renderRankingTabCharts", () =>
    window.renderRankingTabCharts?.(window.appState?.rankingsMode || "store")
  );
  runRenderStep("renderMembersTabCharts", () =>
    window.renderMembersTabCharts?.(window.appState?.membersMode || "spend")
  );
  runRenderStep("renderSleepingTabCharts", () =>
    window.renderSleepingTabCharts?.(window.appState?.sleepingMode || "store")
  );
  runRenderStep("applyQualityMessages", () =>
    applyQualityMessages(results, window.appState?.results?.qualityMessages || [])
  );
  flushForbiddenPlaceholders();
  if (!keepDropdownOpen) {
    runRenderStep("updateControlVisibility", () =>
      window.updateControlVisibility?.(document.querySelector(".tab.active")?.dataset.tab || "dashboard")
    );
  }
}

async function fetchV2ResultBundle(datasetId) {
  const filters = getV2Filters();
  const sleepConfig = getSleepingConfig();
  const storeForbiddenTargets = ["topStores", "rankingsStoreMini", "storeRankTable"];
  const salespersonForbiddenTargets = ["topSalespeople", "rankingsSalespersonMini", "salesRankTable"];
  const productForbiddenTargets = ["topProducts", "rankingsProductMini", "productRankTable"];
  const ticketForbiddenTargets = ["rankingsTicketMini", "ticketRankTable"];
  const memberForbiddenTargets = ["memberRankTable"];
  const sleepForbiddenTargets = ["sleepListTable", "sleepByStoreTable", "sleepSummary"];
  const qualityForbiddenTargets = ["fileCheckTable", "mappingTable"];

  const [kpis, storeRank, salespersonRank, productRank, memberRankRaw, sleepingData, trends, quality] =
    await Promise.all([
      optionalSection(() => getDatasetKpis(datasetId, filters), { totalSales: 0, totalOrders: 0 }),
      optionalSection(
        () => getStoreRankings(datasetId, { filters, ...v2State.pagination.storeRank }),
        [],
        storeForbiddenTargets
      ),
      optionalSection(
        () => getSalespersonRankings(datasetId, { filters, ...v2State.pagination.salespersonRank }),
        [],
        [...salespersonForbiddenTargets, ...ticketForbiddenTargets]
      ),
      optionalSection(
        () => getProductRankings(datasetId, { filters, ...v2State.pagination.storeRank }),
        [],
        productForbiddenTargets
      ),
      optionalSection(
        () => getMemberRankings(datasetId, { filters, ...v2State.pagination.memberRank }),
        [],
        memberForbiddenTargets
      ),
      optionalSection(
        () =>
          getSleepingMembers(datasetId, {
            filters,
            ...sleepConfig,
            ...v2State.pagination.sleepList,
          }),
        { rows: [], sleepByStore: [], sleepSummary: [] },
        sleepForbiddenTargets
      ),
      optionalSection(() => getTrendSeries(datasetId, filters), { daily: [], weekly: [], monthly: [] }),
      optionalSection(
        () => getDataQualityReport(datasetId, filters),
        { fileCheck: [], mappingRows: [], messages: [] },
        qualityForbiddenTargets
      ),
    ]);
  const mappedSalespersonRows = salespersonRank
    .map((row) => ({
    salesperson: String(row.salesperson || ""),
    performance: Number(row.performance || 0),
    order_count: Number(row.orderCount || row.order_count || 0),
    }))
    .filter((row) => {
      const name = String(row.salesperson || "").trim();
      return name && name !== "Unknown" && name !== "Unregistered";
    });
  const salespersonMissing = mappedSalespersonRows.length === 0;
  const memberRank = mapMemberRows(memberRankRaw);
  const normalizedStoreRank = storeRank.map((row) => ({
    store: String(row.store || ""),
    performance: Number(row.performance || 0),
    order_count: Number(row.orderCount || row.order_count || 0),
  }));
  const ticketRank = buildTicketRankRows(normalizedStoreRank);
  const repurchaseDistribution = buildRepurchaseDistribution(memberRank);
  const monthlyRows = Array.isArray(trends?.monthly) ? trends.monthly : [];
  const dailyRows = Array.isArray(trends?.daily) ? trends.daily : [];
  const safeMonthlyRows =
    monthlyRows.length || Number(kpis?.totalSales || 0) <= 0
      ? monthlyRows
      : [{ year_month: getDateFilters().startDate || "当前区间", sales_amount: Number(kpis?.totalSales || 0), store_count: 0 }];
  return {
    kpis: mapKpisToLegacyShape(kpis),
    storeRank: normalizedStoreRank,
    salespersonRank: mappedSalespersonRows,
    productRank: (productRank || []).map((row) => ({
      product: String(row.product || ""),
      sales_amount: Number(row.sales_amount || 0),
      sales_qty: Number(row.sales_qty || 0),
      sales_orders: Number(row.sales_orders || 0),
    })),
    ticketRank,
    memberRank,
    sleepList: sleepingData.rows || [],
    sleepByStore: sleepingData.sleepByStore || [],
    sleepSummary: sleepingData.sleepSummary || [],
    daily: dailyRows,
    weekly: trends?.weekly || [],
    monthly: safeMonthlyRows,
    repurchaseDistribution,
    fileCheck: quality?.fileCheck || [],
    mappingRows: quality?.mappingRows || [],
    qualityMessages: salespersonMissing
      ? normalizeQualityMessages([...(quality?.messages || []), "销售员字段未识别，无法生成销售员排行"])
      : normalizeQualityMessages(quality?.messages || []),
  };
}

async function populateV2FilterOptions() {
  if (!v2State.activeDatasetId) return;
  const options = await getFilterOptions(v2State.activeDatasetId, getDateFilters());
  setFilterOptions(options);
  const startInput = document.getElementById("dashboardStartDate");
  const endInput = document.getElementById("dashboardEndDate");
  const minDate = String(options?.dateRange?.minDate || "");
  const maxDate = String(options?.dateRange?.maxDate || "");
  if (startInput && minDate && !startInput.value) startInput.value = minDate;
  if (endInput && maxDate && !endInput.value) endInput.value = maxDate;
  window.updateDateRangeTriggerText?.();
}

function renderCheckboxOptions({
  wrap,
  values,
  selectedSet,
  allId,
  allLabel,
  emptyInScopeMessage,
  searchValue,
  onChange,
}) {
  if (!wrap) return;
  const search = String(searchValue || "").trim().toLowerCase();
  const filtered = values.filter((v) => selectedSet.has(v) || !search || v.toLowerCase().includes(search));
  const optionsHtml = filtered
    .map((value) => {
      const checked = selectedSet.has(value);
      return `<label class="store-option"><input type="checkbox" value="${value.replace(/"/g, "&quot;")}"${
        checked ? " checked" : ""
      }> <span>${value}</span></label>`;
    })
    .join("");
  setHtml(
    wrap,
    `<label class="store-option"><input type="checkbox" id="${allId}"> <span>${allLabel}</span></label>${
      optionsHtml || `<div class="small">${values.length ? "暂无匹配结果" : emptyInScopeMessage}</div>`
    }`
  );
  const allOpt = document.getElementById(allId);
  if (allOpt) {
    allOpt.checked = values.length > 0 && values.every((x) => selectedSet.has(x));
    allOpt.addEventListener("change", () => {
      if (allOpt.checked) values.forEach((v) => selectedSet.add(v));
      else selectedSet.clear();
      onChange();
    });
  }
  wrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    if (cb === allOpt) return;
    cb.addEventListener("change", () => {
      const value = String(cb.value || "");
      if (cb.checked) selectedSet.add(value);
      else selectedSet.delete(value);
      onChange();
    });
  });
}

function wireV2FilterMenus() {
  const appState = window.appState;
  if (!appState) return;
  const storeSearch = document.getElementById("dashboardStoreSearch");
  const salespersonSearch = document.getElementById("dashboardSalespersonSearch");
  const productSearch = document.getElementById("dashboardProductSearch");

  const redraw = () => {
    renderCheckboxOptions({
      wrap: document.getElementById("dashboardStoreOptions"),
      values: v2State.filterOptions.stores,
      selectedSet: appState.selectedStores,
      allId: "dashboardStoreAllOptionV2",
      allLabel: "全部门店",
      emptyInScopeMessage: "当前账号暂无可选门店",
      searchValue: storeSearch?.value || "",
      onChange: async () => {
        window.updateDashboardStoreSelectedText?.();
        await refreshV2Results(true);
      },
    });
    renderCheckboxOptions({
      wrap: document.getElementById("dashboardSalespersonOptions"),
      values: v2State.filterOptions.salespeople,
      selectedSet: appState.selectedSalespeople,
      allId: "dashboardSalespeopleAllOptionV2",
      allLabel: "全部销售员",
      emptyInScopeMessage: "当前账号暂无可选销售员",
      searchValue: salespersonSearch?.value || "",
      onChange: async () => {
        window.updateDashboardSalespersonSelectedText?.();
        await refreshV2Results(true);
      },
    });
    renderCheckboxOptions({
      wrap: document.getElementById("dashboardProductOptions"),
      values: v2State.filterOptions.products,
      selectedSet: appState.selectedProducts,
      allId: "dashboardProductAllOptionV2",
      allLabel: "全部商品",
      emptyInScopeMessage: "当前账号暂无可选商品",
      searchValue: productSearch?.value || "",
      onChange: async () => {
        window.updateDashboardProductSelectedText?.();
        await refreshV2Results(true);
      },
    });
  };

  const safeRedraw = (event) => {
    if (!v2State.activeDatasetId) return;
    redraw();
  };
  document.getElementById("dashboardStoreTrigger")?.addEventListener("click", safeRedraw, true);
  document.getElementById("dashboardSalespersonTrigger")?.addEventListener("click", safeRedraw, true);
  document.getElementById("dashboardProductTrigger")?.addEventListener("click", safeRedraw, true);
  storeSearch?.addEventListener("input", safeRedraw, true);
  salespersonSearch?.addEventListener("input", safeRedraw, true);
  productSearch?.addEventListener("input", safeRedraw, true);
}

async function refreshV2Results(keepDropdownOpen = false) {
  if (!v2State.activeDatasetId) return;
  forbiddenRenderIds.clear();
  setV2Loading(true);
  if ((window.__CURRENT_USER || {}).role === "admin") window.setAnalyzeLoading?.(true);
  setStatus("正在加载 v2 分析结果...");
  try {
    await populateV2FilterOptions();
    const payload = await fetchV2ResultBundle(v2State.activeDatasetId);
    const merged = mergeV2IntoLegacyResults(payload);
    setLatestResults(merged);
    renderFromResults(merged, keepDropdownOpen);
    const messageAddon = (payload.qualityMessages || []).length
      ? `（${payload.qualityMessages.join("；")}）`
      : "";
    setStatus(`<span class="ok">完成。</span>v2 分析结果已刷新。${messageAddon}`);
  } catch (error) {
    forbiddenRenderIds.clear();
    console.error("[v2-bridge] refresh failed:", error);
    setStatus(error?.message || "v2 分析刷新失败", true);
  } finally {
    setV2Loading(false);
    if ((window.__CURRENT_USER || {}).role === "admin") window.setAnalyzeLoading?.(false);
  }
}

async function runBackendUploadPath() {
  const files = getFiles();
  if (!files.length) {
    setStatus("请至少上传一个文件。", true);
    return;
  }
  const firstFile = files[0];
  setStatus("正在上传文件并创建异步导入任务...");
  const started = await startUploadJob(firstFile);
  const completed = await waitForJob(started.jobId, (job) => {
    setLatestJob(job);
    setStatus(`导入状态：${job?.status || "running"}（${job?.progress ?? 0}%）`);
  });
  const datasetId = completed?.datasetId;
  if (!datasetId) {
    throw new Error("导入任务已完成，但缺少 datasetId");
  }
  setDatasetId(datasetId);
  await refreshV2Results(false);
  if (featureFlags.enableVirtualizedTable) {
    const firstPage = await getPagedTable(datasetId, "fact_sales", { limit: 400, offset: 0 });
    let container = document.getElementById("v2VirtualTable");
    if (!container) {
      container = document.createElement("div");
      container.id = "v2VirtualTable";
      container.style.margin = "12px 0";
      container.style.border = "1px solid rgba(0,0,0,0.08)";
      container.style.borderRadius = "8px";
      container.style.background = "#fff";
      const resultArea = document.getElementById("resultArea");
      resultArea?.prepend(container);
    }
    const rows = firstPage?.rows || [];
    if (rows.length) {
      renderVirtualTable({
        container,
        columns: Object.keys(rows[0]),
        rows,
        viewportHeight: 320,
      });
    }
  }
  setStatus(`<span class="ok">完成。</span>v2 数据导入完成，数据集 ${datasetId.slice(0, 8)}...`);
}

function wireV2FilterRefreshHooks() {
  const originalOnGlobal = window.onGlobalFiltersChanged;
  window.onGlobalFiltersChanged = async (keepDropdownOpen = false) => {
    if (!v2State.activeDatasetId) {
      return originalOnGlobal?.(keepDropdownOpen);
    }
    await refreshV2Results(keepDropdownOpen);
  };
}

async function loadLatestDatasetOnBoot() {
  const latest = await getLatestDatasetSummary();
  if (!latest?.dataset_id) {
    setStatus("暂无数据，请管理员先在后台导入 Excel", true);
    return;
  }
  setDatasetId(String(latest.dataset_id));
  setStatus("已加载后台最新数据集，正在刷新看板...");
  await refreshV2Results(false);
}

export function initV2Bridge() {
  const currentUser = window.__CURRENT_USER || null;
  if (!currentUser) return;
  const analyzeBtn = document.getElementById("analyzeBtn");
  wireV2FilterRefreshHooks();
  wireV2FilterMenus();
  void loadLatestDatasetOnBoot();

  if (featureFlags.enableV2Upload && currentUser.role === "admin" && analyzeBtn) {
    // Admin debug path: capture analyze click into backend upload when feature flag is on.
    analyzeBtn.addEventListener(
      "click",
      async (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
          window.setAnalyzeLoading?.(true);
          await runBackendUploadPath();
        } catch (error) {
          console.error("[v2-bridge] fallback to legacy due to:", error);
          setStatus(error?.message || "v2 导入失败，请重试。", true);
        } finally {
          window.setAnalyzeLoading?.(false);
        }
      },
      true
    );
  }
}
