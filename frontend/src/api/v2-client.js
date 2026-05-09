async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error || `HTTP ${response.status}`;
    throw new Error(message);
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

export async function getDatasetKpis(datasetId, filters = {}) {
  const url = new URL(`/api/v2/datasets/${encodeURIComponent(datasetId)}/kpis`, window.location.origin);
  for (const [key, value] of Object.entries(filters || {})) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length) url.searchParams.set(key, value.join(","));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  const data = await fetchJson(url.pathname + url.search);
  return data.kpis;
}

export async function getPagedTable(datasetId, tableName, { limit = 100, offset = 0 } = {}) {
  const url = `/api/v2/datasets/${encodeURIComponent(datasetId)}/table/${encodeURIComponent(tableName)}?limit=${limit}&offset=${offset}`;
  return fetchJson(url);
}

function withFilterParams(url, filters = {}) {
  for (const [key, value] of Object.entries(filters || {})) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length) url.searchParams.set(key, value.join(","));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export async function getStoreRankings(datasetId, { filters = {}, limit = 200, offset = 0 } = {}) {
  const url = new URL(
    `/api/v2/datasets/${encodeURIComponent(datasetId)}/rankings/stores`,
    window.location.origin
  );
  withFilterParams(url, filters);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  const data = await fetchJson(url.pathname + url.search);
  return data.rows || [];
}

export async function getSalespersonRankings(datasetId, { filters = {}, limit = 200, offset = 0 } = {}) {
  const url = new URL(
    `/api/v2/datasets/${encodeURIComponent(datasetId)}/rankings/salespeople`,
    window.location.origin
  );
  withFilterParams(url, filters);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  const data = await fetchJson(url.pathname + url.search);
  return data.rows || [];
}

export async function getProductRankings(datasetId, { filters = {}, limit = 200, offset = 0 } = {}) {
  const url = new URL(
    `/api/v2/datasets/${encodeURIComponent(datasetId)}/rankings/products`,
    window.location.origin
  );
  withFilterParams(url, filters);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  const data = await fetchJson(url.pathname + url.search);
  return data.rows || [];
}

export async function getMemberRankings(
  datasetId,
  { filters = {}, limit = 500, offset = 0, keyword = "" } = {}
) {
  const url = new URL(`/api/v2/datasets/${encodeURIComponent(datasetId)}/members/top`, window.location.origin);
  withFilterParams(url, filters);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  if (keyword) url.searchParams.set("keyword", String(keyword));
  const data = await fetchJson(url.pathname + url.search);
  return data.rows || [];
}

export async function getRepurchaseDistribution(datasetId, filters = {}) {
  const url = new URL(
    `/api/v2/datasets/${encodeURIComponent(datasetId)}/members/repurchase-distribution`,
    window.location.origin
  );
  withFilterParams(url, filters);
  const data = await fetchJson(url.pathname + url.search);
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
  const url = new URL(
    `/api/v2/datasets/${encodeURIComponent(datasetId)}/members/sleeping`,
    window.location.origin
  );
  withFilterParams(url, filters);
  url.searchParams.set("sleepDays", String(sleepDays));
  url.searchParams.set("sleepMinOrders", String(sleepMinOrders));
  url.searchParams.set("sleepMinAmount", String(sleepMinAmount));
  url.searchParams.set("aclassMinAmount", String(aclassMinAmount));
  url.searchParams.set("aclassMinOrders", String(aclassMinOrders));
  if (analysisDate) url.searchParams.set("analysisDate", String(analysisDate));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  return fetchJson(url.pathname + url.search);
}

export async function getFilterOptions(datasetId, filters = {}) {
  const url = new URL(
    `/api/v2/datasets/${encodeURIComponent(datasetId)}/filters/options`,
    window.location.origin
  );
  withFilterParams(url, filters);
  const data = await fetchJson(url.pathname + url.search);
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
  const url = new URL(`/api/v2/datasets/${encodeURIComponent(datasetId)}/trends`, window.location.origin);
  withFilterParams(url, filters);
  return fetchJson(url.pathname + url.search);
}

export async function getDataQualityReport(datasetId, filters = {}) {
  const url = new URL(`/api/v2/datasets/${encodeURIComponent(datasetId)}/data-quality`, window.location.origin);
  withFilterParams(url, filters);
  return fetchJson(url.pathname + url.search);
}
