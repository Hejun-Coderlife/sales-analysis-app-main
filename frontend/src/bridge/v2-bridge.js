import { featureFlags } from "../config/feature-flags.js";
import {
  getDatasetKpis,
  getFilterOptions,
  getLatestDatasetSummary,
  getMemberRankings,
  getPagedTable,
  getSalespersonRankings,
  getSleepingMembers,
  getStoreRankings,
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
import { renderVirtualTable } from "../tables/virtual-table.js";

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  if (!status) return;
  status.innerHTML = isError ? `<span class="warn">错误：</span>${message}` : message;
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
  };
  const container = {
    ...(appState.results || {}),
    results: merged,
    originalCleaned: Array.isArray(appState.results?.originalCleaned)
      ? appState.results.originalCleaned
      : [],
    isV2Backed: true,
  };
  appState.results = container;
  window.appState = appState;
  return merged;
}

function renderFromResults(results, keepDropdownOpen = false) {
  if (!results) return;
  document.getElementById("resultArea")?.classList.remove("hidden");
  window.renderKpisFromResults?.(results);
  window.renderAllTablesFromResults?.(results);
  window.updateDashboardCharts?.("default");
  window.renderRankingTabCharts?.(window.appState?.rankingsMode || "store");
  window.renderMembersTabCharts?.(window.appState?.membersMode || "spend");
  window.renderSleepingTabCharts?.(window.appState?.sleepingMode || "store");
  if (!keepDropdownOpen) {
    window.updateControlVisibility?.(document.querySelector(".tab.active")?.dataset.tab || "dashboard");
  }
}

async function fetchV2ResultBundle(datasetId) {
  const filters = getV2Filters();
  const sleepConfig = getSleepingConfig();
  const [kpis, storeRank, salespersonRank, memberRankRaw, sleepingData] = await Promise.all([
    getDatasetKpis(datasetId, filters),
    getStoreRankings(datasetId, { filters, ...v2State.pagination.storeRank }),
    getSalespersonRankings(datasetId, { filters, ...v2State.pagination.salespersonRank }),
    getMemberRankings(datasetId, { filters, ...v2State.pagination.memberRank }),
    getSleepingMembers(datasetId, {
      filters,
      ...sleepConfig,
      ...v2State.pagination.sleepList,
    }),
  ]);
  return {
    kpis: mapKpisToLegacyShape(kpis),
    storeRank: storeRank.map((row) => ({
      store: String(row.store || ""),
      performance: Number(row.performance || 0),
      order_count: Number(row.orderCount || row.order_count || 0),
    })),
    salespersonRank: salespersonRank.map((row) => ({
      salesperson: String(row.salesperson || ""),
      performance: Number(row.performance || 0),
      order_count: Number(row.orderCount || row.order_count || 0),
    })),
    memberRank: mapMemberRows(memberRankRaw),
    sleepList: sleepingData.rows || [],
    sleepByStore: sleepingData.sleepByStore || [],
    sleepSummary: sleepingData.sleepSummary || [],
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
  wrap.innerHTML = `<label class="store-option"><input type="checkbox" id="${allId}"> <span>${allLabel}</span></label>${
    optionsHtml || '<div class="small">暂无匹配结果</div>'
  }`;
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
      searchValue: productSearch?.value || "",
      onChange: async () => {
        window.updateDashboardProductSelectedText?.();
        await refreshV2Results(true);
      },
    });
  };

  const safeRedraw = (event) => {
    if (!v2State.activeDatasetId) return;
    event?.stopImmediatePropagation?.();
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
  setV2Loading(true);
  if ((window.__CURRENT_USER || {}).role === "admin") window.setAnalyzeLoading?.(true);
  setStatus("正在加载 v2 分析结果...");
  try {
    await populateV2FilterOptions();
    const payload = await fetchV2ResultBundle(v2State.activeDatasetId);
    const merged = mergeV2IntoLegacyResults(payload);
    setLatestResults(merged);
    renderFromResults(merged, keepDropdownOpen);
    setStatus(`<span class="ok">完成。</span>v2 分析结果已刷新。`);
  } catch (error) {
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
