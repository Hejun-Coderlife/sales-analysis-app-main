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

function buildWhereClause({ datasetId, filters = {} }) {
  const clauses = ["dataset_id = $dataset_id"];
  const params = { dataset_id: datasetId };
  const startDate = normalizeDate(filters.startDate);
  const endDate = normalizeDate(filters.endDate);
  if (startDate) {
    clauses.push("order_date >= $start_date");
    params.start_date = startDate;
  }
  if (endDate) {
    clauses.push("order_date <= $end_date");
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
  return { whereSql: clauses.join(" AND "), params };
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
      `SELECT dataset_id, source_name, row_count, created_at, status
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

  async getKpis(datasetId, filters = {}) {
    const key = `kpis:${datasetId}:${JSON.stringify(filters)}`;
    return this.cached(key, async () => {
      const { whereSql, params } = buildWhereClause({ datasetId, filters });
      const rows = await this.duckdbService.query(
        `SELECT
          COALESCE(SUM(amount), 0) AS totalSales,
          COALESCE(COUNT(DISTINCT order_no), 0) AS totalOrders,
          COALESCE(COUNT(DISTINCT member_id), 0) AS uniqueMembers,
          COALESCE(COUNT(*), 0) AS totalRows
         FROM fact_sales
         WHERE ${whereSql}`,
        params
      );
      return rows[0] || { totalSales: 0, totalOrders: 0, uniqueMembers: 0, totalRows: 0 };
    });
  }

  async getTopStores(datasetId, { filters = {}, limit = 20, offset = 0 } = {}) {
    const { whereSql, params } = buildWhereClause({ datasetId, filters });
    return this.duckdbService.query(
      `SELECT
          store,
          SUM(amount) AS performance,
          COUNT(DISTINCT order_no) AS orderCount
       FROM fact_sales
       WHERE ${whereSql}
       GROUP BY store
       ORDER BY performance DESC
       LIMIT $limit OFFSET $offset`,
      { ...params, limit: Number(limit), offset: Number(offset) }
    );
  }

  async getTopSalespeople(datasetId, { filters = {}, limit = 20, offset = 0 } = {}) {
    const { whereSql, params } = buildWhereClause({ datasetId, filters });
    return this.duckdbService.query(
      `SELECT
          salesperson,
          SUM(amount) AS performance,
          COUNT(DISTINCT order_no) AS orderCount
       FROM fact_sales
       WHERE ${whereSql}
       GROUP BY salesperson
       ORDER BY performance DESC
       LIMIT $limit OFFSET $offset`,
      { ...params, limit: Number(limit), offset: Number(offset) }
    );
  }

  async getTopProducts(datasetId, { filters = {}, limit = 20, offset = 0 } = {}) {
    const { whereSql, params } = buildWhereClause({ datasetId, filters });
    return this.duckdbService.query(
      `SELECT
          product,
          SUM(amount) AS sales_amount,
          SUM(qty) AS sales_qty,
          COUNT(DISTINCT order_no) AS sales_orders
       FROM fact_sales
       WHERE ${whereSql}
       GROUP BY product
       ORDER BY sales_amount DESC
       LIMIT $limit OFFSET $offset`,
      { ...params, limit: Number(limit), offset: Number(offset) }
    );
  }

  async getTopMembers(datasetId, { filters = {}, limit = 20, offset = 0, keyword = "" } = {}) {
    const { whereSql, params } = buildWhereClause({ datasetId, filters });
    const search = String(keyword || "").trim();
    const memberClause = search
      ? ` AND (member_name LIKE $keyword OR phone LIKE $keyword OR member_id LIKE $keyword)`
      : "";
    return this.duckdbService.query(
      `SELECT
          COALESCE(NULLIF(member_id, ''), member_name || '|' || phone) AS member_id,
          member_name,
          phone,
          SUM(amount) AS total_spend,
          COUNT(DISTINCT order_no) AS order_count,
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

  async getFilterOptions(datasetId, { filters = {} } = {}) {
    const { whereSql, params } = buildWhereClause({ datasetId, filters });
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

  async getSleepingAnalytics(
    datasetId,
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
    const { whereSql, params } = buildWhereClause({ datasetId, filters });
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
          COUNT(DISTINCT order_no) AS order_count,
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
            ORDER BY order_date DESC, order_no DESC
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
      { metric: "Analysis Cutoff Date", value: resolvedAnalysisDate },
      { metric: "Sleeping Members", value: Number(summary.sleeping_members || 0) },
      { metric: "Sleeping Members Historical Spend", value: Number(summary.sleeping_historical_spend || 0) },
      { metric: "A-Class Members", value: Number(summary.a_class_members || 0) },
      { metric: "A-Class Historical Spend", value: Number(summary.a_class_historical_spend || 0) },
      { metric: "B-Class Members", value: Number(summary.b_class_members || 0) },
      { metric: "C-Class Members", value: Number(summary.c_class_members || 0) },
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

  async getOrders(datasetId, { filters = {}, limit = 20, offset = 0 } = {}) {
    const { whereSql, params } = buildWhereClause({ datasetId, filters });
    return this.duckdbService.query(
      `SELECT
          order_no,
          order_date,
          store,
          salesperson,
          SUM(amount) AS total_amount
       FROM fact_sales
       WHERE ${whereSql}
       GROUP BY order_no, order_date, store, salesperson
       ORDER BY total_amount DESC
       LIMIT $limit OFFSET $offset`,
      { ...params, limit: Number(limit), offset: Number(offset) }
    );
  }

  async getHighestOrder(datasetId, { filters = {} } = {}) {
    const rows = await this.getOrders(datasetId, { filters, limit: 1, offset: 0 });
    return rows[0] || null;
  }

  async getLeadersByGranularity(datasetId, { granularity = "month", filters = {}, limit = 20 } = {}) {
    const groupExpr =
      granularity === "year"
        ? "CAST(year AS VARCHAR)"
        : granularity === "week"
          ? "CAST(week_start AS VARCHAR)"
          : granularity === "day"
            ? "day_key"
            : "month_key";
    const groupAlias = granularity === "year" ? "year" : granularity === "week" ? "weekStart" : granularity;
    const { whereSql, params } = buildWhereClause({ datasetId, filters });
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

  async getTablePage(datasetId, tableName, { limit = 100, offset = 0 } = {}) {
    const safeTable = String(tableName || "").trim();
    const supported = new Set(["fact_sales"]);
    if (!supported.has(safeTable)) {
      throw new Error(`Unsupported table for paging: ${safeTable}`);
    }
    const rows = await this.duckdbService.query(
      `SELECT * FROM ${safeTable}
       WHERE dataset_id = $dataset_id
       LIMIT $limit OFFSET $offset`,
      {
        dataset_id: datasetId,
        limit: Number(limit),
        offset: Number(offset),
      }
    );
    const totalRows = await this.duckdbService.query(
      `SELECT COUNT(*) AS total FROM ${safeTable} WHERE dataset_id = $dataset_id`,
      { dataset_id: datasetId }
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
