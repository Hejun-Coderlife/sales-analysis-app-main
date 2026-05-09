import { featureFlags } from "../config/feature-flags.js";
import {
  getAggregateScope,
  getDataQualityReport,
  getDatasetKpis,
  getFilterOptions,
  getLatestDatasetSummary,
  getMemberRankings,
  getPagedTable,
  getProductRankings,
  getRepurchaseDistribution,
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

let readyDatasetImportCount = 0;
const AGGREGATE_ALL_READY_DATASET_ID = "__all_ready__";

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
    memberOrders: Number(kpis?.memberorders ?? kpis?.memberOrders ?? 0),
    memberRegistrationRate: Number(kpis?.memberregistrationrate ?? kpis?.memberRegistrationRate ?? 0),
    uniqueMembers: Number(kpis?.uniquemembers ?? kpis?.uniqueMembers ?? 0),
    repurchasingMembers: Number(kpis?.repurchasingmembers ?? kpis?.repurchasingMembers ?? 0),
    repurchaseRate: Number(kpis?.repurchaserate ?? kpis?.repurchaseRate ?? 0),
    averageRepurchaseTimes: Number(kpis?.averagerepurchasetimes ?? kpis?.averageRepurchaseTimes ?? 0),
    filesLoaded: Number(kpis?.filesloaded ?? kpis?.filesLoaded ?? 0),
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
    console.warn("[v2-bridge] section failed (using fallback):", error?.message || error);
    return fallbackValue;
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

function getSummaryMetricValue(rows = [], metricName, fallback = 0) {
  const hit = (Array.isArray(rows) ? rows : []).find((row) => String(row?.metric || "") === metricName);
  const value = Number(hit?.value);
  return Number.isFinite(value) ? value : fallback;
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
      filesLoaded: Number(payload.kpis?.filesLoaded ?? payload.fileCheck?.length ?? 0),
      sleepingMembers: getSummaryMetricValue(payload.sleepSummary, "Sleeping Members", payload.sleepList?.length || 0),
      aClassSleepingMembers: getSummaryMetricValue(
        payload.sleepSummary,
        "A-Class Members",
        (payload.sleepList || []).filter((x) => x.priority === "A").length || 0
      ),
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

  const [kpis, storeRank, salespersonRank, productRank, memberRankRaw, repurchaseDistribution, sleepingData, trends, quality] =
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
      optionalSection(() => getRepurchaseDistribution(datasetId, filters), []),
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
  const monthlyRows = Array.isArray(trends?.monthly) ? trends.monthly : [];
  const dailyRows = Array.isArray(trends?.daily) ? trends.daily : [];
  const safeMonthlyRows =
    monthlyRows.length || Number(kpis?.totalSales || 0) <= 0
      ? monthlyRows
      : [{ year_month: getDateFilters().startDate || "当前区间", sales_amount: Number(kpis?.totalSales || 0), store_count: 0 }];
  return {
    kpis: {
      ...mapKpisToLegacyShape(kpis),
    },
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
    readyDatasetImportCount,
    qualityMessages: salespersonMissing
      ? normalizeQualityMessages([...(quality?.messages || []), "销售员字段未识别，无法生成销售员排行"])
      : normalizeQualityMessages(quality?.messages || []),
  };
}

function isDateOutOfBounds(dateValue, minDate, maxDate) {
  if (!dateValue) return true;
  if (minDate && dateValue < minDate) return true;
  if (maxDate && dateValue > maxDate) return true;
  return false;
}

/** Duck/API may return timestamps; `<input type="date">` only accepts YYYY-MM-DD. */
function normalizeApiDateToInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const head = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (head) return head[1];
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function populateV2FilterOptions({ forceResetDate = false } = {}) {
  if (!v2State.activeDatasetId) return;
  // Always query canonical date bounds without current date filters.
  // Otherwise stale inputs (e.g. old dataset range) can keep narrowing new datasets.
  const options = await getFilterOptions(v2State.activeDatasetId, {});
  setFilterOptions(options);
  const startInput = document.getElementById("dashboardStartDate");
  const endInput = document.getElementById("dashboardEndDate");
  const minDate = normalizeApiDateToInput(options?.dateRange?.minDate);
  const maxDate = normalizeApiDateToInput(options?.dateRange?.maxDate);
  if (startInput && minDate) {
    if (forceResetDate || isDateOutOfBounds(startInput.value, minDate, maxDate)) {
      startInput.value = minDate;
    }
  }
  if (endInput && maxDate) {
    if (forceResetDate || isDateOutOfBounds(endInput.value, minDate, maxDate)) {
      endInput.value = maxDate;
    }
  }
  if (startInput && endInput && startInput.value && endInput.value && startInput.value > endInput.value) {
    startInput.value = minDate || "";
    endInput.value = maxDate || "";
  }
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

async function refreshV2Results(keepDropdownOpen = false, options = {}) {
  if (!v2State.activeDatasetId) return;
  document.getElementById("resultArea")?.classList.remove("hidden");
  forbiddenRenderIds.clear();
  setV2Loading(true);
  if ((window.__CURRENT_USER || {}).role === "admin") window.setAnalyzeLoading?.(true);
  setStatus("正在加载 v2 分析结果...");
  try {
    try {
      await populateV2FilterOptions(options);
    } catch (filterErr) {
      console.warn("[v2-bridge] filter options skipped:", filterErr);
      window.showToast?.("筛选项未能更新，已用当前条件继续加载看板。", "warning");
    }
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
    const msg = error?.message || "v2 分析刷新失败";
    setStatus(msg, true);
    window.showToast?.(msg, "error");
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
  setStatus("正在上传文件并创建异步导入任务...");
  const started = await startUploadJob(files);
  const completed = await waitForJob(started.jobId, (job) => {
    setLatestJob(job);
    setStatus(`导入状态：${job?.status || "running"}（${job?.progress ?? 0}%）`);
  });
  const datasetId = completed?.datasetId;
  if (!datasetId) {
    throw new Error("导入任务已完成，但缺少 datasetId");
  }
  try {
    const scope = await getAggregateScope();
    readyDatasetImportCount = Math.max(0, Number(scope?.datasetCount ?? 0));
    if (featureFlags.enableAggregateReadyDatasets && readyDatasetImportCount > 0) {
      setDatasetId(AGGREGATE_ALL_READY_DATASET_ID);
    } else {
      setDatasetId(String(datasetId));
      readyDatasetImportCount = 1;
    }
  } catch (_e) {
    setDatasetId(String(datasetId));
    readyDatasetImportCount = Math.max(1, readyDatasetImportCount);
  }
  await refreshV2Results(false, { forceResetDate: true });
  if (featureFlags.enableVirtualizedTable) {
    const firstPage = await getPagedTable(String(datasetId), "fact_sales", { limit: 400, offset: 0 });
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
  setStatus(
    `<span class="ok">完成。</span>v2 数据已导入并已汇总到全部看板（本批 dataset ${datasetId.slice(0, 8)}…）`
  );
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
  readyDatasetImportCount = 0;
  let latest = null;
  let scope = null;
  if (featureFlags.enableAggregateReadyDatasets) {
    try {
      scope = await getAggregateScope();
    } catch (_error) {
      scope = null;
    }
    const datasetCount = Math.max(0, Number(scope?.datasetCount || 0));
    if (datasetCount > 0) {
      readyDatasetImportCount = datasetCount;
      setDatasetId(AGGREGATE_ALL_READY_DATASET_ID);
      setStatus(`已加载全部导入汇总（共 ${datasetCount} 个数据集），正在刷新看板…`);
      await refreshV2Results(false, { forceResetDate: true });
      return;
    }
  }
  try {
    latest = await getLatestDatasetSummary();
  } catch (_) {
    latest = null;
  }
  if (!latest?.dataset_id) {
    const msg =
      "看板没有加载数据：未找到就绪数据集。请确认后台已导入；若仍如此，对本页强制刷新（Ctrl+F5 或 ⌘⇧R）并重开 Node。";
    setStatus(msg, true);
    window.showToast?.(msg, "error");
    return;
  }
  readyDatasetImportCount = 1;
  setDatasetId(String(latest.dataset_id));
  setStatus("已加载最近一次导入的数据集，正在刷新看板…");
  await refreshV2Results(false, { forceResetDate: true });
}

export function initV2Bridge() {
  const currentUser = window.__CURRENT_USER || null;
  if (!currentUser) return;
  document.getElementById("resultArea")?.classList.remove("hidden");
  const analyzeBtn = document.getElementById("analyzeBtn");
  wireV2FilterRefreshHooks();
  wireV2FilterMenus();
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !v2State.activeDatasetId) return;
    void refreshV2Results(false, { forceResetDate: true });
  });
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
