async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let data = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }
  }
  if (!response.ok) {
    const fromJson = typeof data?.error === "string" && data.error.trim() ? data.error.trim() : "";
    const snippet = raw.trim().replace(/\s+/g, " ").slice(0, 220);
    const message = fromJson || snippet || `HTTP ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

export async function startUploadJob(files, mapping = {}) {
  const fileList = Array.isArray(files) ? files.filter(Boolean) : files ? [files] : [];
  if (!fileList.length) throw new Error("请选择至少一个文件");
  const form = new FormData();
  fileList.forEach((file) => {
    form.append("files", file);
  });
  form.append("mapping", JSON.stringify(mapping || {}));
  return fetchJson("/api/v2/uploads", {
    method: "POST",
    body: form,
  });
}

export async function getJob(jobId) {
  return fetchJson(`/api/v2/jobs/${encodeURIComponent(jobId)}`);
}

export async function waitForJob(jobId, onProgress) {
  while (true) {
    const data = await getJob(jobId);
    onProgress?.(data.job);
    if (data.job?.status === "completed") return data.job;
    if (data.job?.status === "failed") throw new Error(data.job?.error || "任务失败");
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}

/** 多选筛选用重复 query 键（products=a&products=b），避免逗号 join 与商品名里的「,」冲突 */
function appendFiltersToUrl(url, filters = {}) {
  for (const [key, value] of Object.entries(filters || {})) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const v = String(item ?? "").trim();
        if (v) url.searchParams.append(key, v);
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

/** 大量商品会把 GET URL 推到浏览器/代理上限，前端会静默回退成全 0。 */
function filtersNeedPostBody(filters = {}) {
  const pc = Array.isArray(filters.products) ? filters.products.length : 0;
  if (pc >= 18) return true;
  try {
    const probe = new URL("http://_/");
    appendFiltersToUrl(probe, filters || {});
    return probe.search.length > 2000;
  } catch (_e) {
    return pc >= 10;
  }
}

function applyQueryToUrl(url, query = {}) {
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
}

function shouldRetryAnalyticsPostAsGet(error) {
  const status = Number(error?.status);
  const msg = String(error?.message || "");
  if (status === 404) return true;
  if (/\b404\b/.test(msg)) return true;
  if (/cannot post/i.test(msg)) return true;
  return false;
}

async function datasetFilteredRequest(datasetId, subPath, filters, query = {}) {
  const basePath = `/api/v2/datasets/${encodeURIComponent(datasetId)}${subPath}`;
  const usePost = filtersNeedPostBody(filters || {});

  const doGet = () => {
    const url = new URL(basePath, window.location.origin);
    appendFiltersToUrl(url, filters || {});
    applyQueryToUrl(url, query);
    return fetchJson(`${url.pathname}${url.search}`);
  };

  if (!usePost) {
    return doGet();
  }

  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === "") continue;
    q.set(k, String(v));
  }
  const qs = q.toString();
  const urlOnly = qs ? `${basePath}?${qs}` : basePath;
  try {
    return await fetchJson(urlOnly, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: filters || {} }),
    });
  } catch (error) {
    if (!shouldRetryAnalyticsPostAsGet(error)) throw error;
    console.warn(
      "[v2-client] POST analytics 未命中路由或服务端过旧，已改用 GET 重试:",
      basePath,
      String(error?.message || error)
    );
    return doGet();
  }
}

export async function getDatasetKpis(datasetId, filters = {}) {
  const data = await datasetFilteredRequest(datasetId, "/kpis", filters);
  return data.kpis;
}

export async function getPagedTable(datasetId, tableName, { limit = 100, offset = 0 } = {}) {
  const url = `/api/v2/datasets/${encodeURIComponent(datasetId)}/table/${encodeURIComponent(tableName)}?limit=${limit}&offset=${offset}`;
  return fetchJson(url);
}

function withFilterParams(url, filters = {}) {
  appendFiltersToUrl(url, filters);
  return url;
}

export async function getStoreRankings(datasetId, { filters = {}, limit = 200, offset = 0 } = {}) {
  const data = await datasetFilteredRequest(datasetId, "/rankings/stores", filters, { limit, offset });
  return data.rows || [];
}

export async function getSalespersonRankings(datasetId, { filters = {}, limit = 200, offset = 0 } = {}) {
  const data = await datasetFilteredRequest(datasetId, "/rankings/salespeople", filters, { limit, offset });
  return data.rows || [];
}

export async function getProductRankings(datasetId, { filters = {}, limit = 200, offset = 0 } = {}) {
  const data = await datasetFilteredRequest(datasetId, "/rankings/products", filters, { limit, offset });
  return data.rows || [];
}

export async function getMemberRankings(
  datasetId,
  { filters = {}, limit = 500, offset = 0, keyword = "" } = {}
) {
  const query = { limit, offset };
  if (keyword) query.keyword = String(keyword);
  const data = await datasetFilteredRequest(datasetId, "/members/top", filters, query);
  return data.rows || [];
}

export async function getRepurchaseDistribution(datasetId, filters = {}) {
  const data = await datasetFilteredRequest(datasetId, "/members/repurchase-distribution", filters);
  return data.rows || [];
}

export async function getSleepingMembers(
  datasetId,
  {
    filters = {},
    sleepDays = 90,
    sleepMinOrders = 2,
    sleepMinAmount = 1000,
    aclassMinAmount = 3000,
    aclassMinOrders = 5,
    analysisDate = "",
    limit = 500,
    offset = 0,
  } = {}
) {
  const basePath = `/api/v2/datasets/${encodeURIComponent(datasetId)}/members/sleeping`;
  const paging = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const qsPaging = paging.toString();
  const sleepBody = {
    sleepDays,
    sleepMinOrders,
    sleepMinAmount,
    aclassMinAmount,
    aclassMinOrders,
  };
  if (analysisDate) sleepBody.analysisDate = String(analysisDate);

  const doGetSleeping = () => {
    const url = new URL(basePath, window.location.origin);
    withFilterParams(url, filters);
    for (const [k, v] of Object.entries({ ...sleepBody, limit, offset })) {
      url.searchParams.set(k, String(v));
    }
    return fetchJson(`${url.pathname}${url.search}`);
  };

  if (!filtersNeedPostBody(filters)) {
    return doGetSleeping();
  }

  try {
    return await fetchJson(`${basePath}?${qsPaging}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: filters || {}, ...sleepBody }),
    });
  } catch (error) {
    if (!shouldRetryAnalyticsPostAsGet(error)) throw error;
    console.warn("[v2-client] sleeping POST 404/未注册，改用 GET:", String(error?.message || error));
    return doGetSleeping();
  }
}

export async function getFilterOptions(datasetId, filters = {}) {
  const data = await datasetFilteredRequest(datasetId, "/filters/options", filters);
  return data.options || { stores: [], salespeople: [], products: [], dateRange: { minDate: "", maxDate: "" } };
}

export async function getLatestDatasetSummary() {
  const data = await fetchJson("/api/v2/datasets/latest");
  return data.dataset || null;
}

/** Resolved ready imports count for merged dashboard bootstrap (see `AGGREGATE_ALL_READY_DATASET_ID`). */
export async function getAggregateScope() {
  return fetchJson("/api/v2/datasets/aggregate-scope");
}

export async function getTrendSeries(datasetId, filters = {}) {
  return datasetFilteredRequest(datasetId, "/trends", filters);
}

export async function getDataQualityReport(datasetId, filters = {}) {
  return datasetFilteredRequest(datasetId, "/data-quality", filters);
}
