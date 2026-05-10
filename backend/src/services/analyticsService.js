function normalizeDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 模糊匹配前规范化（全角空格、连续空格等），减少「姓名看起来对但搜不到」 */
function normalizeSearchNeedle(raw) {
  return String(raw || "")
    .trim()
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ");
}

/** Route token: aggregated analytics over every `status=ready` dataset. */
export const AGGREGATE_ALL_READY_DATASET_ID = "__all_ready__";

function distinctOrderSql() {
  return `CAST(dataset_id AS VARCHAR) || '#' || CAST(COALESCE(order_no,'') AS VARCHAR)`;
}

function buildDatasetWhereClause(datasetIds, filters = {}) {
  const ids = (Array.isArray(datasetIds) ? datasetIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  if (!ids.length) {
    throw new Error("datasetIds is required");
  }
  const clauses = [];
  const params = {};
  if (ids.length === 1) {
    clauses.push("dataset_id = $dataset_id");
    params.dataset_id = ids[0];
  } else {
    clauses.push(`dataset_id IN (${ids.map((_, idx) => `$d_${idx}`).join(", ")})`);
    for (let i = 0; i < ids.length; i += 1) params[`d_${i}`] = ids[i];
  }
  const startDate = normalizeDate(filters.startDate);
  const endDate = normalizeDate(filters.endDate);
  if (startDate) {
    clauses.push("order_date >= CAST($start_date AS DATE)");
    params.start_date = startDate;
  }
  if (endDate) {
    clauses.push("order_date <= CAST($end_date AS DATE)");
    params.end_date = endDate;
  }
  if (Array.isArray(filters.stores) && filters.stores.length) {
    clauses.push(`store IN (${filters.stores.map((_, idx) => `$store_${idx}`).join(", ")})`);
    for (let i = 0; i < filters.stores.length; i += 1) params[`store_${i}`] = String(filters.stores[i]);
  }
  if (Array.isArray(filters.salespeople) && filters.salespeople.length) {
    clauses.push(
      `salesperson IN (${filters.salespeople.map((_, idx) => `$salesperson_${idx}`).join(", ")})`
    );
    for (let i = 0; i < filters.salespeople.length; i += 1) {
      params[`salesperson_${i}`] = String(filters.salespeople[i]);
    }
  }
  if (Array.isArray(filters.products) && filters.products.length) {
    clauses.push(`product IN (${filters.products.map((_, idx) => `$product_${idx}`).join(", ")})`);
    for (let i = 0; i < filters.products.length; i += 1) {
      params[`product_${i}`] = String(filters.products[i]);
    }
  }
  return { whereSql: clauses.join(" AND "), params };
}

function kpisDistinctOrderSelect() {
  return `COUNT(DISTINCT ${distinctOrderSql()})`;
}

function extractPrimaryMapping(mappingRaw) {
  if (!mappingRaw || typeof mappingRaw !== "object") return {};
  if (!Array.isArray(mappingRaw)) {
    return mappingRaw.mapping && typeof mappingRaw.mapping === "object" ? mappingRaw.mapping : mappingRaw;
  }
  for (const entry of mappingRaw) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.mapping && typeof entry.mapping === "object") return entry.mapping;
    if (Array.isArray(entry.sheets)) {
      const sheet = entry.sheets.find((item) => item?.mapping && typeof item.mapping === "object");
      if (sheet) return sheet.mapping;
    }
  }
  return {};
}

function inferImportedFileCount(summaryRow = {}) {
  try {
    const mappingRaw = JSON.parse(String(summaryRow?.mapping_json || "{}"));
    if (Array.isArray(mappingRaw) && mappingRaw.length > 0) {
      return mappingRaw.length;
    }
  } catch (_error) {
    // Fallback to source_name if mapping_json is unavailable.
  }
  const sourceName = String(summaryRow?.source_name || "").trim();
  if (!sourceName) return 0;
  if (sourceName.includes(" · ")) {
    return sourceName
      .split(" · ")
      .map((x) => String(x || "").trim())
      .filter(Boolean).length;
  }
  return 1;
}

export class AnalyticsService {
  constructor({ duckdbService, queryCache, cacheTtlMs }) {
    this.duckdbService = duckdbService;
    this.queryCache = queryCache;
    this.cacheTtlMs = cacheTtlMs;
  }

  async cached(key, fn) {
    const hit = this.queryCache.get(key);
    if (hit) return hit;
    const value = await fn();
    this.queryCache.set(key, value, this.cacheTtlMs);
    return value;
  }

  async getDatasetSummary(datasetId) {
    const rows = await this.duckdbService.query(
      `SELECT dataset_id, source_name, row_count, created_at, status, mapping_json, validation_json
       FROM datasets WHERE dataset_id = $dataset_id LIMIT 1`,
      { dataset_id: datasetId }
    );
    return rows[0] || null;
  }

  async getLatestDatasetSummary({ onlyReady = true } = {}) {
    const rows = await this.duckdbService.query(
      `SELECT dataset_id, source_name, row_count, created_at, status
       FROM datasets
       ${onlyReady ? "WHERE status = 'ready'" : ""}
       ORDER BY created_at DESC
       LIMIT 1`
    );
    return rows[0] || null;
  }

  /** All ready datasets (oldest→newest) for merged dashboard analytics. */
  async listReadyDatasetIds() {
    const rows = await this.duckdbService.query(
      `SELECT dataset_id FROM datasets WHERE status = $status ORDER BY created_at ASC`,
      { status: "ready" }
    );
    return rows.map((r) => String(r.dataset_id || "")).filter(Boolean);
  }

  /** Sum declared row counts from dataset metadata. */
  async sumDeclaredRowCountsForDatasetIds(datasetIds) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : []).map((x) => String(x || "").trim()).filter(Boolean);
    if (!ids.length) return 0;
    const inList = ids.map((_, idx) => `$id_${idx}`).join(", ");
    const params = { status: "ready" };
    ids.forEach((id, idx) => {
      params[`id_${idx}`] = id;
    });
    const rows = await this.duckdbService.query(
      `SELECT COALESCE(SUM(row_count), 0)::BIGINT AS total
       FROM datasets
       WHERE status = $status AND dataset_id IN (${inList})`,
      params
    );
    return Number(rows[0]?.total || 0);
  }

  async verifyDatasetIdsReady(datasetIds) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : []).map((x) => String(x || "").trim()).filter(Boolean);
    if (!ids.length) return false;
    const inList = ids.map((_, idx) => `$id_${idx}`).join(", ");
    const params = { status: "ready" };
    ids.forEach((id, idx) => {
      params[`id_${idx}`] = id;
    });
    const rows = await this.duckdbService.query(
      `SELECT COUNT(*)::BIGINT AS c
       FROM datasets
       WHERE status = $status AND dataset_id IN (${inList})`,
      params
    );
    return Number(rows[0]?.c || 0) === ids.length;
  }

  /**
   * Remove one dataset's fact rows and metadata from DuckDB.
   */
  async deleteDatasetById(datasetId) {
    const id = String(datasetId || "").trim();
    if (!id) throw new Error("datasetId is required");
    await this.duckdbService.run("DELETE FROM fact_sales WHERE dataset_id = $dataset_id", {
      dataset_id: id,
    });
    await this.duckdbService.run("DELETE FROM datasets WHERE dataset_id = $dataset_id", {
      dataset_id: id,
    });
    this.queryCache.clear();
    return true;
  }

  async deleteAllDatasets() {
    await this.duckdbService.run("DELETE FROM fact_sales");
    await this.duckdbService.run("DELETE FROM datasets");
    this.queryCache.clear();
    return true;
  }

  async getKpis(datasetIds, filters = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const key = `kpis:${ids.sort().join("|")}:${JSON.stringify(filters)}`;
    return this.cached(key, async () => {
      const { whereSql, params } = buildDatasetWhereClause(ids, filters);
      const distinctOrderSelect = kpisDistinctOrderSelect();
      const rows = await this.duckdbService.query(
        `WITH base AS (
           SELECT *
           FROM fact_sales
           WHERE ${whereSql}
         ),
         order_view AS (
           SELECT
             ${distinctOrderSql()} AS order_key,
             MAX(
               CASE
                 WHEN COALESCE(NULLIF(member_id, ''), NULLIF(phone, ''), NULLIF(member_name, '')) <> '' THEN 1
                 ELSE 0
               END
             ) AS is_member_order
           FROM base
           GROUP BY 1
         ),
         member_order_counts AS (
           SELECT
             COALESCE(NULLIF(member_id, ''), NULLIF(phone, ''), NULLIF(member_name, '')) ||
               '|||' || COALESCE(member_name, '') AS member_group_key,
             COUNT(DISTINCT ${distinctOrderSql()})::BIGINT AS order_count
           FROM base
           WHERE COALESCE(NULLIF(member_id, ''), NULLIF(phone, ''), NULLIF(member_name, '')) <> ''
           GROUP BY 1
         )
         SELECT
           COALESCE((SELECT SUM(amount) FROM base), 0) AS totalSales,
           COALESCE((SELECT ${distinctOrderSelect} FROM base), 0)::BIGINT AS totalOrders,
           COALESCE((SELECT COUNT(*) FROM order_view WHERE is_member_order = 1), 0)::BIGINT AS memberOrders,
           COALESCE((SELECT COUNT(*) FROM member_order_counts), 0)::BIGINT AS uniqueMembers,
           COALESCE((SELECT COUNT(*) FROM member_order_counts WHERE order_count >= 2), 0)::BIGINT AS repurchasingMembers,
           COALESCE(
             (
               SELECT AVG(CAST(order_count - 1 AS DOUBLE))
               FROM member_order_counts
               WHERE order_count >= 2
             ),
             0
           ) AS averageRepurchaseTimes,
           COALESCE((SELECT COUNT(*) FROM base), 0)::BIGINT AS totalRows`,
        params
      );
      const kpi = rows[0] || {};
      let filesLoaded = 0;
      if (ids.length === 1) {
        const summary = await this.getDatasetSummary(ids[0]);
        filesLoaded = inferImportedFileCount(summary);
      } else {
        const inList = ids.map((_, idx) => `$sum_${idx}`).join(", ");
        const sumParams = {};
        ids.forEach((id, idx) => {
          sumParams[`sum_${idx}`] = id;
        });
        const summaries = await this.duckdbService.query(
          `SELECT dataset_id, source_name, mapping_json
           FROM datasets
           WHERE dataset_id IN (${inList})`,
          sumParams
        );
        filesLoaded = summaries.reduce((acc, row) => acc + inferImportedFileCount(row), 0);
      }
      const totalOrders = Number(kpi.totalOrders || 0);
      const memberOrders = Number(kpi.memberOrders || 0);
      const uniqueMembers = Number(kpi.uniqueMembers || 0);
      const repurchasingMembers = Number(kpi.repurchasingMembers || 0);
      return {
        totalSales: Number(kpi.totalSales || 0),
        totalOrders,
        memberOrders,
        memberRegistrationRate: totalOrders > 0 ? memberOrders / totalOrders : 0,
        uniqueMembers,
        repurchasingMembers,
        repurchaseRate: uniqueMembers > 0 ? repurchasingMembers / uniqueMembers : 0,
        averageRepurchaseTimes: Number(kpi.averageRepurchaseTimes || 0),
        filesLoaded: Math.max(0, Number(filesLoaded || 0)),
        totalRows: Number(kpi.totalRows || 0),
      };
    });
  }

  async getTopStores(datasetIds, { filters = {}, limit = 20, offset = 0 } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const dOrder = distinctOrderSql();
    return this.duckdbService.query(
      `SELECT
          store,
          SUM(amount) AS performance,
          COUNT(DISTINCT ${dOrder})::BIGINT AS orderCount
       FROM fact_sales
       WHERE ${whereSql}
       GROUP BY store
       ORDER BY performance DESC
       LIMIT $limit OFFSET $offset`,
      { ...params, limit: Number(limit), offset: Number(offset) }
    );
  }

  async getTopSalespeople(datasetIds, { filters = {}, limit = 20, offset = 0 } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const dOrder = distinctOrderSql();
    return this.duckdbService.query(
      `SELECT
          salesperson,
          SUM(amount) AS performance,
          COUNT(DISTINCT ${dOrder})::BIGINT AS orderCount
       FROM fact_sales
       WHERE ${whereSql}
       GROUP BY salesperson
       ORDER BY performance DESC
       LIMIT $limit OFFSET $offset`,
      { ...params, limit: Number(limit), offset: Number(offset) }
    );
  }

  /**
   * 销售员 × 门店交叉汇总（后台 fact_sales），用于回答「某导购主要在哪家店开单」等。
   */
  async getSalespersonStoreBreakdown(datasetIds, { filters = {}, limit = 100, offset = 0, salespersonContains = "" } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const dOrder = distinctOrderSql();
    const needle = normalizeSearchNeedle(salespersonContains);
    const spClause = needle
      ? ` AND LOWER(CAST(salesperson AS VARCHAR)) LIKE $salesperson_needle`
      : "";
    const queryParams = { ...params, limit: Number(limit), offset: Number(offset) };
    if (needle) {
      queryParams.salesperson_needle = `%${needle.toLowerCase()}%`;
    }
    return this.duckdbService.query(
      `SELECT
          salesperson,
          store,
          SUM(amount) AS performance,
          COUNT(DISTINCT ${dOrder})::BIGINT AS order_count
       FROM fact_sales
       WHERE ${whereSql}${spClause}
       GROUP BY salesperson, store
       ORDER BY performance DESC
       LIMIT $limit OFFSET $offset`,
      queryParams
    );
  }

  /**
   * 会员 × 销售员汇总（同一会员在不同导购下的消费明细）。
   */
  async getMemberSalespersonBreakdown(datasetIds, { filters = {}, limit = 80, offset = 0, memberContains = "" } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const dOrder = distinctOrderSql();
    const needle = normalizeSearchNeedle(memberContains);
    const memberClause = needle
      ? ` AND (
            LOWER(CAST(member_name AS VARCHAR)) LIKE $member_needle
            OR LOWER(CAST(COALESCE(member_id, '') AS VARCHAR)) LIKE $member_needle
          )`
      : "";
    const queryParams = { ...params, limit: Number(limit), offset: Number(offset) };
    if (needle) {
      queryParams.member_needle = `%${needle.toLowerCase()}%`;
    }
    return this.duckdbService.query(
      `SELECT
          COALESCE(NULLIF(TRIM(member_id), ''), TRIM(member_name) || '|' || TRIM(COALESCE(phone, ''))) AS member_key,
          TRIM(member_name) AS member_name,
          TRIM(salesperson) AS salesperson,
          SUM(amount) AS performance,
          COUNT(DISTINCT ${dOrder})::BIGINT AS order_count
       FROM fact_sales
       WHERE ${whereSql}
         AND COALESCE(TRIM(member_name), '') <> ''
         ${memberClause}
       GROUP BY 1, 2, 3
       ORDER BY performance DESC
       LIMIT $limit OFFSET $offset`,
      queryParams
    );
  }

  /**
   * 某销售员名下的会员列表（订单行的 salesperson + member），用于「导购手里有哪些顾客」。
   */
  async getMembersForSalesperson(datasetIds, { filters = {}, limit = 100, offset = 0, salespersonContains = "" } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const dOrder = distinctOrderSql();
    const needle = normalizeSearchNeedle(salespersonContains);
    const spClause = needle
      ? ` AND LOWER(CAST(salesperson AS VARCHAR)) LIKE $salesperson_needle`
      : "";
    const queryParams = { ...params, limit: Number(limit), offset: Number(offset) };
    if (needle) {
      queryParams.salesperson_needle = `%${needle.toLowerCase()}%`;
    }
    return this.duckdbService.query(
      `SELECT
          COALESCE(NULLIF(TRIM(member_id), ''), TRIM(member_name) || '|' || TRIM(COALESCE(phone, ''))) AS member_key,
          TRIM(member_name) AS member_name,
          TRIM(COALESCE(phone, '')) AS phone,
          SUM(amount) AS total_spend,
          COUNT(DISTINCT ${dOrder})::BIGINT AS order_count
       FROM fact_sales
       WHERE ${whereSql}
         AND COALESCE(TRIM(member_name), '') <> ''
         ${spClause}
       GROUP BY 1, 2, 3
       ORDER BY total_spend DESC
       LIMIT $limit OFFSET $offset`,
      queryParams
    );
  }

  async getTopProducts(datasetIds, { filters = {}, limit = 20, offset = 0 } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const dOrder = distinctOrderSql();
    return this.duckdbService.query(
      `SELECT
          product,
          SUM(amount) AS sales_amount,
          SUM(qty) AS sales_qty,
          COUNT(DISTINCT ${dOrder})::BIGINT AS sales_orders
       FROM fact_sales
       WHERE ${whereSql}
       GROUP BY product
       ORDER BY sales_amount DESC
       LIMIT $limit OFFSET $offset`,
      { ...params, limit: Number(limit), offset: Number(offset) }
    );
  }

  async getTopMembers(datasetIds, { filters = {}, limit = 20, offset = 0, keyword = "" } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const search = String(keyword || "").trim();
    const memberClause = search
      ? ` AND (member_name LIKE $keyword OR phone LIKE $keyword OR member_id LIKE $keyword)`
      : "";
    const dOrder = distinctOrderSql();
    return this.duckdbService.query(
      `SELECT
          COALESCE(NULLIF(member_id, ''), member_name || '|' || phone) AS member_id,
          member_name,
          phone,
          SUM(amount) AS total_spend,
          COUNT(DISTINCT ${dOrder})::BIGINT AS order_count,
          CAST(MAX(order_date) AS VARCHAR) AS last_order_date
       FROM fact_sales
       WHERE ${whereSql}
         AND COALESCE(member_name, '') <> ''
         ${memberClause}
       GROUP BY COALESCE(NULLIF(member_id, ''), member_name || '|' || phone), member_name, phone
       ORDER BY total_spend DESC
       LIMIT $limit OFFSET $offset`,
      {
        ...params,
        limit: Number(limit),
        offset: Number(offset),
        keyword: `%${search}%`,
      }
    );
  }

  async getRepurchaseDistribution(datasetIds, { filters = {} } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    return this.duckdbService.query(
      `WITH member_order_counts AS (
         SELECT
           COALESCE(NULLIF(member_id, ''), NULLIF(phone, ''), NULLIF(member_name, '')) AS member_key,
           COUNT(DISTINCT ${distinctOrderSql()})::BIGINT AS order_count
         FROM fact_sales
         WHERE ${whereSql}
           AND COALESCE(NULLIF(member_id, ''), NULLIF(phone, ''), NULLIF(member_name, '')) <> ''
         GROUP BY 1
       )
       SELECT order_bucket, member_count
       FROM (
         SELECT '6+ orders' AS order_bucket, COUNT(*)::BIGINT AS member_count
         FROM member_order_counts
         WHERE order_count >= 6
         UNION ALL
         SELECT '4-5 orders' AS order_bucket, COUNT(*)::BIGINT AS member_count
         FROM member_order_counts
         WHERE order_count BETWEEN 4 AND 5
         UNION ALL
         SELECT '3 orders' AS order_bucket, COUNT(*)::BIGINT AS member_count
         FROM member_order_counts
         WHERE order_count = 3
         UNION ALL
         SELECT '2 orders' AS order_bucket, COUNT(*)::BIGINT AS member_count
         FROM member_order_counts
         WHERE order_count = 2
         UNION ALL
         SELECT '1 order' AS order_bucket, COUNT(*)::BIGINT AS member_count
         FROM member_order_counts
         WHERE order_count = 1
       ) t
       ORDER BY CASE order_bucket
         WHEN '6+ orders' THEN 1
         WHEN '4-5 orders' THEN 2
         WHEN '3 orders' THEN 3
         WHEN '2 orders' THEN 4
         ELSE 5
       END`,
      params
    );
  }

  async getFilterOptions(datasetIds, { filters = {} } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const [stores, salespeople, products, dateRange] = await Promise.all([
      this.duckdbService.query(
        `SELECT DISTINCT store FROM fact_sales WHERE ${whereSql} AND COALESCE(store, '') <> '' ORDER BY store`,
        params
      ),
      this.duckdbService.query(
        `SELECT DISTINCT salesperson FROM fact_sales WHERE ${whereSql} AND COALESCE(salesperson, '') <> '' ORDER BY salesperson`,
        params
      ),
      this.duckdbService.query(
        `SELECT DISTINCT product FROM fact_sales WHERE ${whereSql} AND COALESCE(product, '') <> '' ORDER BY product`,
        params
      ),
      this.duckdbService.query(
        `SELECT
           CAST(MIN(order_date) AS VARCHAR) AS min_date,
           CAST(MAX(order_date) AS VARCHAR) AS max_date
         FROM fact_sales
         WHERE ${whereSql}`,
        params
      ),
    ]);
    return {
      stores: stores.map((x) => String(x.store || "")).filter(Boolean),
      salespeople: salespeople.map((x) => String(x.salesperson || "")).filter(Boolean),
      products: products.map((x) => String(x.product || "")).filter(Boolean),
      dateRange: {
        minDate: String(dateRange?.[0]?.min_date || ""),
        maxDate: String(dateRange?.[0]?.max_date || ""),
      },
    };
  }

  async getTrendSeries(datasetIds, { filters = {} } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const [daily, weekly, monthly] = await Promise.all([
      this.duckdbService.query(
        `SELECT
           day_key AS day,
           SUM(amount) AS sales_amount,
           COUNT(DISTINCT store) AS store_count
         FROM fact_sales
         WHERE ${whereSql}
         GROUP BY day_key
         ORDER BY day_key ASC`,
        params
      ),
      this.duckdbService.query(
        `SELECT
           CAST(week_start AS VARCHAR) AS weekStart,
           SUM(amount) AS sales_amount,
           COUNT(DISTINCT store) AS store_count
         FROM fact_sales
         WHERE ${whereSql}
         GROUP BY week_start
         ORDER BY week_start ASC`,
        params
      ),
      this.duckdbService.query(
        `SELECT
           month_key AS year_month,
           SUM(amount) AS sales_amount,
           COUNT(DISTINCT store) AS store_count
         FROM fact_sales
         WHERE ${whereSql}
         GROUP BY month_key
         ORDER BY month_key ASC`,
        params
      ),
    ]);
    return { daily, weekly, monthly };
  }

  async getDataQualityReport(datasetIds, { filters = {} } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const inList = ids.map((_, idx) => `$sum_${idx}`).join(", ");
    const sumParams = {};
    ids.forEach((id, idx) => {
      sumParams[`sum_${idx}`] = id;
    });
    const summaryRows =
      ids.length === 1
        ? [(await this.getDatasetSummary(ids[0]))].filter(Boolean)
        : await this.duckdbService.query(
            `SELECT dataset_id, source_name, row_count, created_at, status, mapping_json, validation_json
             FROM datasets
             WHERE dataset_id IN (${inList})
             ORDER BY created_at DESC`,
            sumParams
          );
    const summary = summaryRows[0] || null;
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const [fileCheckRows, unknownStats] = await Promise.all([
      this.duckdbService.query(
        `SELECT
           COUNT(*) AS included_rows,
           COUNT(DISTINCT ${distinctOrderSql()}) AS order_count,
           SUM(amount) AS q_sum,
           SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) AS negative_rows,
           SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS negative_sum
         FROM fact_sales
         WHERE ${whereSql}`,
        params
      ),
      this.duckdbService.query(
        `SELECT
           COUNT(*) AS total_rows,
           SUM(CASE WHEN COALESCE(TRIM(salesperson), '') = '' OR salesperson IN ('Unknown', 'Unregistered') THEN 1 ELSE 0 END) AS unknown_salesperson_rows,
           SUM(CASE WHEN COALESCE(TRIM(product), '') = '' OR product IN ('Unknown', 'Unregistered') THEN 1 ELSE 0 END) AS unknown_product_rows,
           SUM(CASE WHEN COALESCE(TRIM(member_name), '') = '' THEN 1 ELSE 0 END) AS empty_member_rows
         FROM fact_sales
         WHERE ${whereSql}`,
        params
      ),
    ]);

    let mappingRaw = {};
    let validation = {};
    try {
      mappingRaw = JSON.parse(String(summary?.mapping_json || "{}"));
    } catch (_error) {
      mappingRaw = {};
    }
    const mapping = extractPrimaryMapping(mappingRaw);
    try {
      validation = JSON.parse(String(summary?.validation_json || "{}"));
    } catch (_error) {
      validation = {};
    }
    const warnings = Array.isArray(validation?.warnings) ? validation.warnings.map((x) => String(x)) : [];
    const stat = unknownStats?.[0] || {};
    const totalRows = Number(stat.total_rows || 0);
    const unknownSalespersonRows = Number(stat.unknown_salesperson_rows || 0);
    const unknownProductRows = Number(stat.unknown_product_rows || 0);
    const emptyMemberRows = Number(stat.empty_member_rows || 0);
    const messages = [];

    const hasSalespersonMapping = Boolean(mapping?.salesperson);
    const hasProductMapping = Boolean(mapping?.product);
    const hasMemberMapping = Boolean(mapping?.member_name || mapping?.member_id || mapping?.phone);
    if (!hasSalespersonMapping || (totalRows > 0 && unknownSalespersonRows >= totalRows)) {
      messages.push("销售员字段未识别");
    }
    if (!hasProductMapping || (totalRows > 0 && unknownProductRows >= totalRows)) {
      messages.push("商品字段未识别或无商品数据");
    }
    if (!hasMemberMapping || (totalRows > 0 && emptyMemberRows >= totalRows)) {
      messages.push("会员字段未识别或无会员数据");
    }

    const sourceName =
      ids.length > 1
        ? `全部导入汇总（${ids.length} 个数据集，映射取最近一次导入）`
        : String(summary?.source_name || "当前数据集");
    const statRow = fileCheckRows?.[0] || {};
    const fileCheck = [
      {
        source_file: sourceName,
        included_rows: Number(statRow.included_rows || 0),
        order_count: Number(statRow.order_count || 0),
        q_sum: Number(statRow.q_sum || 0),
        negative_rows: Number(statRow.negative_rows || 0),
        negative_sum: Number(statRow.negative_sum || 0),
      },
    ];

    return {
      summary: {
        source_file: ids.length > 1 ? sourceName : String(summary?.source_name || ""),
        included_rows:
          ids.length > 1
            ? Number(statRow.included_rows || totalRows || 0)
            : Number(summary?.row_count || 0),
        metric: ids.length > 1 ? "合并数据集（全部就绪导入）" : "后端数据集",
        value: ids.length > 1 ? AGGREGATE_ALL_READY_DATASET_ID : String(summary?.dataset_id || ""),
      },
      fileCheck,
      mappingRows: Object.entries(mapping || {}).map(([target, source]) => ({
        target_field: String(target),
        source_field: String(source || ""),
      })),
      warnings,
      messages,
    };
  }

  async getSleepingAnalytics(
    datasetIds,
    {
      filters = {},
      sleepDays = 90,
      sleepMinOrders = 2,
      sleepMinAmount = 1000,
      aclassMinAmount = 3000,
      aclassMinOrders = 5,
      analysisDate = "",
      limit = 200,
      offset = 0,
    } = {}
  ) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    const effectiveAnalysisDate = normalizeDate(analysisDate) || normalizeDate(filters.endDate) || "";
    const maxDateRow = await this.duckdbService.query(
      `SELECT CAST(MAX(order_date) AS VARCHAR) AS max_date FROM fact_sales WHERE ${whereSql}`,
      params
    );
    const resolvedAnalysisDate = effectiveAnalysisDate || String(maxDateRow[0]?.max_date || "");
    if (!resolvedAnalysisDate) {
      return {
        rows: [],
        sleepByStore: [],
        sleepSummary: [],
        page: { limit: Number(limit), offset: Number(offset), total: 0 },
      };
    }

    const sqlBase = `
      WITH member_base AS (
        SELECT
          COALESCE(NULLIF(member_id, ''), member_name || '|' || phone) AS member_key,
          member_name,
          phone,
          SUM(amount) AS total_spend,
          COUNT(DISTINCT ${distinctOrderSql()}) AS order_count,
          CAST(MAX(order_date) AS DATE) AS last_purchase_date
        FROM fact_sales
        WHERE ${whereSql} AND COALESCE(member_name, '') <> ''
        GROUP BY COALESCE(NULLIF(member_id, ''), member_name || '|' || phone), member_name, phone
      ),
      recent_touch AS (
        SELECT
          COALESCE(NULLIF(member_id, ''), member_name || '|' || phone) AS member_key,
          store AS last_store,
          salesperson AS last_salesperson,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(NULLIF(member_id, ''), member_name || '|' || phone)
            ORDER BY order_date DESC, dataset_id DESC, order_no DESC
          ) AS rn
        FROM fact_sales
        WHERE ${whereSql} AND COALESCE(member_name, '') <> ''
      ),
      member_enriched AS (
        SELECT
          m.member_key,
          m.member_name,
          m.phone,
          m.total_spend,
          m.order_count,
          m.last_purchase_date,
          COALESCE(r.last_store, '') AS last_store,
          COALESCE(r.last_salesperson, '') AS last_salesperson,
          CASE
            WHEN m.total_spend >= $aclass_min_amount OR m.order_count >= $aclass_min_orders THEN 'A'
            WHEN m.total_spend >= GREATEST($sleep_min_amount * 2, 2000) OR m.order_count >= GREATEST($sleep_min_orders + 1, 3) THEN 'B'
            ELSE 'C'
          END AS priority,
          CASE
            WHEN DATE_DIFF('day', m.last_purchase_date, CAST($analysis_date AS DATE)) >= 180 THEN 'Deep Sleep'
            WHEN DATE_DIFF('day', m.last_purchase_date, CAST($analysis_date AS DATE)) >= 91 THEN 'High Risk'
            ELSE 'Warning'
          END AS risk_level,
          DATE_DIFF('day', m.last_purchase_date, CAST($analysis_date AS DATE)) AS sleep_days
        FROM member_base m
        LEFT JOIN recent_touch r ON r.member_key = m.member_key AND r.rn = 1
      ),
      sleeping AS (
        SELECT
          member_key,
          member_name,
          phone,
          total_spend,
          order_count,
          total_spend / NULLIF(order_count, 0) AS avg_ticket,
          GREATEST(order_count - 1, 0) AS repurchase_times,
          CAST(last_purchase_date AS VARCHAR) AS last_purchase_date,
          last_store,
          last_salesperson,
          sleep_days,
          priority,
          risk_level
        FROM member_enriched
        WHERE
          order_count >= $sleep_min_orders
          AND total_spend >= $sleep_min_amount
          AND sleep_days >= $sleep_days
      )
    `;

    const sleepParams = {
      ...params,
      analysis_date: resolvedAnalysisDate,
      sleep_days: Number(sleepDays),
      sleep_min_orders: Number(sleepMinOrders),
      sleep_min_amount: Number(sleepMinAmount),
      aclass_min_amount: Number(aclassMinAmount),
      aclass_min_orders: Number(aclassMinOrders),
      limit: Number(limit),
      offset: Number(offset),
    };

    const rows = await this.duckdbService.query(
      `${sqlBase}
       SELECT * FROM sleeping
       ORDER BY priority ASC, total_spend DESC, sleep_days DESC
       LIMIT $limit OFFSET $offset`,
      sleepParams
    );
    const totalRows = await this.duckdbService.query(
      `${sqlBase}
       SELECT COUNT(*) AS total FROM sleeping`,
      sleepParams
    );
    const sleepByStore = await this.duckdbService.query(
      `${sqlBase}
       SELECT
         COALESCE(last_store, 'Unknown') AS last_store,
         COUNT(*) AS sleeping_members,
         SUM(total_spend) AS historical_spend
       FROM sleeping
       GROUP BY COALESCE(last_store, 'Unknown')
       ORDER BY sleeping_members DESC, historical_spend DESC`,
      sleepParams
    );
    const summaryRows = await this.duckdbService.query(
      `${sqlBase}
       SELECT
         COUNT(*) AS sleeping_members,
         SUM(total_spend) AS sleeping_historical_spend,
         SUM(CASE WHEN priority = 'A' THEN 1 ELSE 0 END) AS a_class_members,
         SUM(CASE WHEN priority = 'A' THEN total_spend ELSE 0 END) AS a_class_historical_spend,
         SUM(CASE WHEN priority = 'B' THEN 1 ELSE 0 END) AS b_class_members,
         SUM(CASE WHEN priority = 'C' THEN 1 ELSE 0 END) AS c_class_members
       FROM sleeping`,
      sleepParams
    );
    const summary = summaryRows[0] || {};
    const sleepSummary = [
      { metric: "分析截止日期", value: resolvedAnalysisDate },
      { metric: "沉睡会员人数", value: Number(summary.sleeping_members || 0) },
      { metric: "沉睡会员历史消费额", value: Number(summary.sleeping_historical_spend || 0) },
      { metric: "A 类会员人数", value: Number(summary.a_class_members || 0) },
      { metric: "A 类历史消费额", value: Number(summary.a_class_historical_spend || 0) },
      { metric: "B 类会员人数", value: Number(summary.b_class_members || 0) },
      { metric: "C 类会员人数", value: Number(summary.c_class_members || 0) },
    ];

    return {
      rows,
      sleepByStore,
      sleepSummary,
      page: {
        limit: Number(limit),
        offset: Number(offset),
        total: Number(totalRows[0]?.total || 0),
      },
    };
  }

  async getOrders(datasetIds, { filters = {}, limit = 20, offset = 0 } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    return this.duckdbService.query(
      `SELECT
          order_no,
          order_date,
          store,
          salesperson,
          SUM(amount) AS total_amount
       FROM fact_sales
       WHERE ${whereSql}
       GROUP BY dataset_id, order_no, order_date, store, salesperson
       ORDER BY total_amount DESC
       LIMIT $limit OFFSET $offset`,
      { ...params, limit: Number(limit), offset: Number(offset) }
    );
  }

  async getHighestOrder(datasetIds, { filters = {} } = {}) {
    const rows = await this.getOrders(datasetIds, { filters, limit: 1, offset: 0 });
    return rows[0] || null;
  }

  async getLeadersByGranularity(datasetIds, { granularity = "month", filters = {}, limit = 20 } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const groupExpr =
      granularity === "year"
        ? "CAST(year AS VARCHAR)"
        : granularity === "week"
          ? "CAST(week_start AS VARCHAR)"
          : granularity === "day"
            ? "day_key"
            : "month_key";
    const groupAlias = granularity === "year" ? "year" : granularity === "week" ? "weekStart" : granularity;
    const { whereSql, params } = buildDatasetWhereClause(ids, filters);
    return this.duckdbService.query(
      `WITH agg AS (
        SELECT ${groupExpr} AS period, salesperson, SUM(amount) AS performance
        FROM fact_sales
        WHERE ${whereSql}
        GROUP BY period, salesperson
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER(PARTITION BY period ORDER BY performance DESC) AS rn
        FROM agg
      )
      SELECT period AS ${groupAlias}, salesperson, performance
      FROM ranked
      WHERE rn = 1
      ORDER BY period DESC
      LIMIT $limit`,
      { ...params, limit: Number(limit) }
    );
  }

  async getTablePage(datasetIds, tableName, { limit = 100, offset = 0 } = {}) {
    const ids = (Array.isArray(datasetIds) ? datasetIds : [datasetIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const safeTable = String(tableName || "").trim();
    const supported = new Set(["fact_sales"]);
    if (!supported.has(safeTable)) {
      throw new Error(`Unsupported table for paging: ${safeTable}`);
    }
    if (!ids.length) {
      throw new Error("datasetIds is required");
    }
    const inClause = ids.map((_, idx) => `$tid_${idx}`).join(", ");
    const baseParams = {};
    ids.forEach((id, idx) => {
      baseParams[`tid_${idx}`] = id;
    });
    const rows = await this.duckdbService.query(
      `SELECT * FROM ${safeTable}
       WHERE dataset_id IN (${inClause})
       LIMIT $limit OFFSET $offset`,
      {
        ...baseParams,
        limit: Number(limit),
        offset: Number(offset),
      }
    );
    const totalRows = await this.duckdbService.query(
      `SELECT COUNT(*) AS total FROM ${safeTable} WHERE dataset_id IN (${inClause})`,
      baseParams
    );
    return {
      rows,
      page: {
        limit: Number(limit),
        offset: Number(offset),
        total: Number(totalRows[0]?.total || 0),
      },
    };
  }
}
