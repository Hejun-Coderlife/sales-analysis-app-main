import { DuckDBService } from "../backend/src/services/duckdbService.js";
import { QueryCache } from "../backend/src/services/queryCache.js";
import { AnalyticsService } from "../backend/src/services/analyticsService.js";
import { randomUUID } from "crypto";

function assertClose(actual, expected, label, epsilon = 1e-6) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const db = new DuckDBService({ duckdbPath: ":memory:" });
  const cache = new QueryCache({ ttlMs: 5_000 });
  const analytics = new AnalyticsService({ duckdbService: db, queryCache: cache, cacheTtlMs: 5_000 });
  await db.ensureSchema();

  const datasetId = randomUUID();
  const rows = [
    {
      order_no: "A-1",
      order_date: "2025-03-03",
      year: 2025,
      month_key: "2025-03",
      week_start: "2025-03-03",
      day_key: "2025-03-03",
      store: "一店",
      salesperson: "张三",
      product: "衬衫",
      qty: 1,
      amount: 200,
      member_id: "M1",
      member_name: "吴莉",
      phone: "13800000001",
    },
    {
      order_no: "A-2",
      order_date: "2025-03-04",
      year: 2025,
      month_key: "2025-03",
      week_start: startOfWeek("2025-03-04"),
      day_key: "2025-03-04",
      store: "二店",
      salesperson: "李四",
      product: "裤子",
      qty: 2,
      amount: 500,
      member_id: "M2",
      member_name: "王芳",
      phone: "13800000002",
    },
    {
      order_no: "A-3",
      order_date: "2025-03-04",
      year: 2025,
      month_key: "2025-03",
      week_start: startOfWeek("2025-03-04"),
      day_key: "2025-03-04",
      store: "一店",
      salesperson: "张三",
      product: "衬衫",
      qty: 3,
      amount: 300,
      member_id: "M1",
      member_name: "吴莉",
      phone: "13800000001",
    },
  ];

  await db.run(
    `INSERT OR REPLACE INTO datasets(dataset_id, source_name, row_count, created_at, status, mapping_json, validation_json)
     VALUES ($dataset_id, 'fixture.xlsx', $row_count, NOW(), 'ready', '[]', '{}')`,
    { dataset_id: datasetId, row_count: rows.length }
  );
  for (const row of rows) {
    await db.run(
      `INSERT INTO fact_sales (
        dataset_id, order_no, order_date, year, month_key, week_start, day_key,
        store, salesperson, product, qty, amount, member_id, member_name, phone
      ) VALUES (
        $dataset_id, $order_no, $order_date, $year, $month_key, $week_start, $day_key,
        $store, $salesperson, $product, $qty, $amount, $member_id, $member_name, $phone
      )`,
      { dataset_id: datasetId, ...row }
    );
  }

  const kpis = await analytics.getKpis(datasetId);
  assertClose(Number(kpis.totalSales), 1000, "totalSales");
  assertClose(Number(kpis.totalOrders), 3, "totalOrders");
  assertClose(Number(kpis.uniqueMembers), 2, "uniqueMembers");

  const topStore = await analytics.getTopStores(datasetId, { limit: 1 });
  assertClose(Number(topStore[0]?.performance || 0), 500, "top store performance");

  const topSalesperson = await analytics.getTopSalespeople(datasetId, { limit: 1 });
  if (String(topSalesperson[0]?.salesperson) !== "张三") throw new Error("top salesperson mismatch");

  const highestOrder = await analytics.getHighestOrder(datasetId);
  assertClose(Number(highestOrder?.total_amount || 0), 500, "highestOrder");

  const members = await analytics.getTopMembers(datasetId, { limit: 1 });
  assertClose(Number(members[0]?.total_spend || 0), 500, "top member spend");

  const leadersByDay = await analytics.getLeadersByGranularity(datasetId, {
    granularity: "day",
    limit: 10,
  });
  if (!leadersByDay.length) throw new Error("leaders by day should not be empty");

  const tablePage = await analytics.getTablePage(datasetId, "fact_sales", { limit: 2, offset: 0 });
  if (tablePage.page.total !== 3 || tablePage.rows.length !== 2) {
    throw new Error("table paging mismatch");
  }

  console.log("v2 parity check passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
