import fs from "fs/promises";
import path from "path";
import XLSX from "xlsx";
import { randomUUID } from "crypto";

const HEADER_CANDIDATES = {
  store: ["store", "门店", "店铺", "门店名称", "所属门店"],
  salesperson: ["salesperson", "sales", "导购", "销售员", "销售人员", "员工", "姓名"],
  product: ["product", "商品", "品名", "货品", "款号", "货号"],
  amount: ["amount", "实收", "销售额", "金额", "应收", "支付金额", "付款金额"],
  date: ["date", "日期", "销售日期", "下单日期", "订单日期"],
  order_no: ["order", "订单号", "单号", "流水号", "小票号"],
  qty: ["qty", "数量", "件数", "销售数量"],
  member_id: ["member_id", "会员id", "会员编号", "客户编号"],
  member_name: ["member_name", "会员名", "会员姓名", "会员", "客户姓名", "客户"],
  phone: ["phone", "手机号", "电话", "联系电话", "手机号码"],
};

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（(].*?[)）]/g, "");
}

function detectColumnMap(headers, overrides = {}) {
  const normalizedHeaders = headers.map((h) => ({ raw: h, key: normalizeHeader(h) }));
  const mapping = {};
  const warnings = [];

  for (const [target, candidates] of Object.entries(HEADER_CANDIDATES)) {
    const override = normalizeHeader(overrides[target]);
    if (override) {
      const exact = normalizedHeaders.find((h) => h.key === override);
      if (exact) {
        mapping[target] = exact.raw;
        continue;
      }
    }
    const matched = normalizedHeaders.find((h) =>
      candidates.some((candidate) => h.key.includes(normalizeHeader(candidate)))
    );
    if (matched) mapping[target] = matched.raw;
  }

  if (!mapping.amount) warnings.push("Unable to auto-detect amount column.");
  if (!mapping.date) warnings.push("Unable to auto-detect date column.");
  if (!mapping.store) warnings.push("Unable to auto-detect store column.");
  if (!mapping.salesperson) warnings.push("Unable to auto-detect salesperson column.");
  return { mapping, warnings };
}

function parseNumber(value) {
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function parseDateValue(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d);
  }
  const text = String(value).trim().replace(/[./]/g, "-");
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function startOfWeek(date) {
  const d = new Date(date.getTime());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function cleanText(value, fallback = "Unknown") {
  const out = String(value ?? "").trim();
  return out || fallback;
}

export class IngestionService {
  constructor({ duckdbService, uploadsDir }) {
    this.duckdbService = duckdbService;
    this.uploadsDir = uploadsDir;
  }

  async ensureUploadDir() {
    await fs.mkdir(this.uploadsDir, { recursive: true });
  }

  async persistUploadBuffer(file) {
    await this.ensureUploadDir();
    const filename = `${Date.now()}-${randomUUID()}-${file.originalname || "upload.xlsx"}`;
    const outputPath = path.resolve(this.uploadsDir, filename);
    await fs.writeFile(outputPath, file.buffer);
    return outputPath;
  }

  async parseWorkbook(filePath, overrides = {}) {
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    const cleanedRows = [];
    const warnings = [];
    const mappingBySheet = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
      if (!rows.length) continue;
      const headers = Object.keys(rows[0] || {});
      const { mapping, warnings: sheetWarnings } = detectColumnMap(headers, overrides);
      mappingBySheet.push({ sheet: sheetName, mapping });
      warnings.push(...sheetWarnings.map((w) => `[${sheetName}] ${w}`));

      for (const row of rows) {
        const orderDate = parseDateValue(row[mapping.date]);
        const amount = parseNumber(row[mapping.amount]);
        if (!orderDate || !Number.isFinite(amount)) continue;
        const weekStart = startOfWeek(orderDate);
        cleanedRows.push({
          order_no: cleanText(row[mapping.order_no] || "", ""),
          order_date: toYmd(orderDate),
          year: orderDate.getFullYear(),
          month_key: toYmd(orderDate).slice(0, 7),
          week_start: toYmd(weekStart),
          day_key: toYmd(orderDate),
          store: cleanText(row[mapping.store]),
          salesperson: cleanText(row[mapping.salesperson]),
          product: cleanText(row[mapping.product]),
          qty: parseNumber(row[mapping.qty]),
          amount,
          member_id: cleanText(row[mapping.member_id] || "", ""),
          member_name: cleanText(row[mapping.member_name] || "", ""),
          phone: cleanText(row[mapping.phone] || "", ""),
        });
      }
    }

    return {
      cleanedRows,
      mappingBySheet,
      warnings: [...new Set(warnings)].slice(0, 100),
    };
  }

  async ingestDataset({ sourceName, filePath, overrides = {}, onProgress }) {
    const datasetId = randomUUID();
    await this.duckdbService.ensureSchema();
    onProgress?.(15, "Parsing workbook");
    const parsed = await this.parseWorkbook(filePath, overrides);
    const rows = parsed.cleanedRows;
    const validation = {
      rowCount: rows.length,
      warnings: parsed.warnings,
      valid: rows.length > 0,
    };

    if (!rows.length) {
      return {
        datasetId,
        rowCount: 0,
        mapping: parsed.mappingBySheet,
        validation,
      };
    }

    onProgress?.(45, "Persisting to DuckDB");
    await this.duckdbService.run(
      `INSERT OR REPLACE INTO datasets(dataset_id, source_name, row_count, created_at, status, mapping_json, validation_json)
       VALUES ($dataset_id, $source_name, $row_count, NOW(), 'loading', $mapping_json, $validation_json)`,
      {
        dataset_id: datasetId,
        source_name: sourceName || path.basename(filePath),
        row_count: rows.length,
        mapping_json: JSON.stringify(parsed.mappingBySheet),
        validation_json: JSON.stringify(validation),
      }
    );

    await this.duckdbService.run("DELETE FROM fact_sales WHERE dataset_id = $dataset_id", {
      dataset_id: datasetId,
    });

    let inserted = 0;
    for (const row of rows) {
      // Row-wise inserts keep implementation straightforward and deterministic for phase-1 migration.
      await this.duckdbService.run(
        `INSERT INTO fact_sales (
            dataset_id, order_no, order_date, year, month_key, week_start, day_key, store, salesperson,
            product, qty, amount, member_id, member_name, phone
         ) VALUES (
            $dataset_id, $order_no, $order_date, $year, $month_key, $week_start, $day_key, $store, $salesperson,
            $product, $qty, $amount, $member_id, $member_name, $phone
         )`,
        { dataset_id: datasetId, ...row }
      );
      inserted += 1;
      if (inserted % 500 === 0) {
        const pct = 45 + Math.floor((inserted / rows.length) * 45);
        onProgress?.(Math.min(90, pct), `Inserted ${inserted}/${rows.length}`);
      }
    }

    await this.duckdbService.run(
      `UPDATE datasets
       SET row_count = $row_count, status = 'ready', mapping_json = $mapping_json, validation_json = $validation_json
       WHERE dataset_id = $dataset_id`,
      {
        dataset_id: datasetId,
        row_count: rows.length,
        mapping_json: JSON.stringify(parsed.mappingBySheet),
        validation_json: JSON.stringify(validation),
      }
    );

    onProgress?.(100, "Ingestion completed");
    return {
      datasetId,
      rowCount: rows.length,
      mapping: parsed.mappingBySheet,
      validation,
    };
  }
}
