import { DuckDBService } from "../backend/src/services/duckdbService.js";
import { QueryCache } from "../backend/src/services/queryCache.js";
import { AnalyticsService } from "../backend/src/services/analyticsService.js";
import { randomUUID } from "crypto";

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

async function main() {
  const rowCount = Number(process.env.PERF_ROWS || 20000);
  const datasetId = randomUUID();
  const db = new DuckDBService({ duckdbPath: ":memory:" });
  const cache = new QueryCache({ ttlMs: 5_000 });
  const analytics = new AnalyticsService({ duckdbService: db, queryCache: cache, cacheTtlMs: 5_000 });
  await db.ensureSchema();

  await db.run(
    `INSERT OR REPLACE INTO datasets(dataset_id, source_name, row_count, created_at, status, mapping_json, validation_json)
     VALUES ($dataset_id, 'perf-fixture.xlsx', $row_count, NOW(), 'ready', '[]', '{}')`,
    { dataset_id: datasetId, row_count: rowCount }
  );

  const stores = ["一店", "二店", "三店", "四店", "五店"];
  const salespeople = ["张三", "李四", "王五", "赵六", "陈七", "刘八"];
  const products = ["衬衫", "裤子", "鞋子", "包", "外套"];
  const now = Date.now();

  for (let i = 0; i < rowCount; i += 1) {
    const d = new Date(now - Math.floor(Math.random() * 120) * 86400000);
    const ymd = d.toISOString().slice(0, 10);
    await db.run(
      `INSERT INTO fact_sales (
        dataset_id, order_no, order_date, year, month_key, week_start, day_key,
        store, salesperson, product, qty, amount, member_id, member_name, phone
      ) VALUES (
        $dataset_id, $order_no, $order_date, $year, $month_key, $week_start, $day_key,
        $store, $salesperson, $product, $qty, $amount, $member_id, $member_name, $phone
      )`,
      {
        dataset_id: datasetId,
        order_no: `ORD-${i}`,
        order_date: ymd,
        year: d.getFullYear(),
        month_key: ymd.slice(0, 7),
        week_start: ymd,
        day_key: ymd,
        store: randomItem(stores),
        salesperson: randomItem(salespeople),
        product: randomItem(products),
        qty: (i % 5) + 1,
        amount: ((i % 17) + 1) * 35,
        member_id: `M-${i % 1000}`,
        member_name: `会员${i % 1000}`,
        phone: `1380000${String(i % 10000).padStart(4, "0")}`,
      }
    );
  }

  const started = Date.now();
  await analytics.getKpis(datasetId);
  await analytics.getTopStores(datasetId, { limit: 50 });
  await analytics.getTopSalespeople(datasetId, { limit: 50 });
  await analytics.getTopProducts(datasetId, { limit: 50 });
  await analytics.getTopMembers(datasetId, { limit: 50 });
  await analytics.getOrders(datasetId, { limit: 50 });
  const elapsed = Date.now() - started;

  console.log(`v2 performance smoke finished: ${rowCount} rows, query bundle ${elapsed}ms`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
