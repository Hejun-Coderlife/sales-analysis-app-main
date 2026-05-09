import fs from "fs/promises";
import path from "path";
import { normalizeUploadFilename } from "../utils/uploadFilename.js";
import XLSX from "xlsx";
import { randomUUID } from "crypto";

const HEADER_CANDIDATES = {
  store: ["store", "门店", "店铺", "门店名称", "所属门店"],
  salesperson: [
    "salesperson",
    "sales",
    "seller",
    "staff",
    "销售员",
    "销售人员",
    "导购",
    "导购员",
    "专属导购",
    "专属导购编号",
    "店员",
    "员工",
    "员工编号",
    "营业员",
  ],
  product: ["product", "商品", "品名", "货品", "款号", "货号"],
  amount: ["amount", "实收", "销售额", "金额", "应收", "支付金额", "付款金额"],
  date: ["date", "日期", "销售日期", "下单日期", "订单日期"],
  order_no: ["order", "订单号", "单号", "流水号", "小票号"],
  qty: ["qty", "数量", "件数", "销售数量"],
  member_id: ["member_id", "会员id", "会员编号", "客户编号"],
  member_name: ["member_name", "会员名", "会员姓名", "会员", "客户姓名", "客户"],
  phone: ["phone", "手机号", "电话", "联系电话", "手机号码"],
};

const REQUIRED_MAPPINGS = ["store", "salesperson", "product", "amount", "date", "order_no"];

const STRICT_HEADER_ALIASES = {
  store: ["门店名称", "门店", "店铺", "所属门店", "store"],
  salesperson: ["营业员", "销售员", "销售人员", "导购员", "导购", "专属导购名称", "salesperson"],
  product: ["商品名称", "品名", "商品", "货品名称", "product"],
  amount: ["总金额", "实收价", "实收", "销售额", "金额", "支付金额", "付款金额", "amount"],
  date: ["日期", "销售日期", "下单日期", "订单日期", "消费时间", "date"],
  order_no: ["单号", "订单号", "流水号", "小票号", "order"],
  qty: ["数量", "件数", "销售数量", "qty"],
  member_id: ["会员编号", "会员id", "客户编号", "member_id"],
  member_name: ["会员名称", "会员姓名", "会员名", "客户姓名", "客户名称", "member_name"],
  phone: ["手机", "手机号", "手机号码", "联系电话", "电话", "phone"],
};

const CODE_LIKE_HEADER_RE = /(编号|code|id)/i;

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
      warnings.push(`Override column not found for ${target}: ${String(overrides[target])}`);
    }
    const strictCandidates = STRICT_HEADER_ALIASES[target] || [];
    let strictMatched = null;
    for (const candidate of strictCandidates) {
      const normalizedCandidate = normalizeHeader(candidate);
      const exact = normalizedHeaders.find((h) => h.key === normalizedCandidate);
      if (exact) {
        strictMatched = exact;
        break;
      }
    }
    if (strictMatched) {
      mapping[target] = strictMatched.raw;
      continue;
    }

    // Strict-first mapping: fallback is constrained and avoids code-like columns for name fields.
    const fallbackMatched = normalizedHeaders.find((h) => {
      if (["salesperson", "product", "member_name"].includes(target) && CODE_LIKE_HEADER_RE.test(h.raw)) {
        return false;
      }
      return candidates.some((candidate) => h.key.includes(normalizeHeader(candidate)));
    });
    if (fallbackMatched) mapping[target] = fallbackMatched.raw;
  }

  for (const required of REQUIRED_MAPPINGS) {
    if (!mapping[required]) warnings.push(`Unable to auto-detect required column: ${required}.`);
  }
  return { mapping, warnings };
}

function parseNumber(value, { allowEmpty = true } = {}) {
  if (value == null || value === "") {
    return { value: 0, valid: !!allowEmpty, empty: true };
  }
  let text = String(value).trim();
  if (!text) return { value: 0, valid: !!allowEmpty, empty: true };
  text = text.replace(/[，,]/g, "");
  if (text.startsWith("¥") || text.startsWith("￥")) text = text.slice(1);
  if (text.startsWith("(") && text.endsWith(")")) text = `-${text.slice(1, -1)}`;
  const n = Number(text);
  return { value: Number.isFinite(n) ? n : 0, valid: Number.isFinite(n), empty: false };
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

function createRowDedupKey(row) {
  const orderNo = String(row?.order_no || "").trim();
  const orderDate = String(row?.order_date || "").trim();
  const store = String(row?.store || "").trim();
  const salesperson = String(row?.salesperson || "").trim();
  const product = String(row?.product || "").trim();
  const qty = Number(row?.qty || 0);
  const amount = Number(row?.amount || 0);
  const memberId = String(row?.member_id || "").trim();
  if (orderNo) {
    return [
      "order",
      orderNo,
      orderDate,
      store,
      salesperson,
      product,
      qty,
      amount,
      memberId,
    ].join("|");
  }
  return [
    "row",
    orderDate,
    store,
    salesperson,
    product,
    qty,
    amount,
    memberId,
    String(row?.member_name || "").trim(),
    String(row?.phone || "").trim(),
  ].join("|");
}

const INSERT_COLUMNS = [
  "dataset_id",
  "order_no",
  "order_date",
  "year",
  "month_key",
  "week_start",
  "day_key",
  "store",
  "salesperson",
  "product",
  "qty",
  "amount",
  "member_id",
  "member_name",
  "phone",
];

const INSERT_SQL = `INSERT INTO fact_sales (
  dataset_id, order_no, order_date, year, month_key, week_start, day_key, store, salesperson,
  product, qty, amount, member_id, member_name, phone
) VALUES (?, ?, CAST(? AS DATE), ?, ?, CAST(? AS DATE), ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const BATCH_INSERT_ROW_SIZE = 200;

const IMPORT_PROGRESS_ROW_STEP = 2000;
const IMPORT_PROGRESS_TIME_STEP_MS = 1200;

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
    const baseRaw = normalizeUploadFilename(file.originalname) || "upload.xlsx";
    const safeBase = String(baseRaw).replace(/[/\\?*:|"<>]/g, "_").slice(0, 180) || "upload.xlsx";
    const filename = `${Date.now()}-${randomUUID()}-${safeBase}`;
    const outputPath = path.resolve(this.uploadsDir, filename);
    await fs.writeFile(outputPath, file.buffer);
    return outputPath;
  }

  async parseWorkbook(filePath, overrides = {}) {
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    const cleanedRows = [];
    const warnings = [];
    const hardErrors = [];
    const mappingBySheet = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
      if (!rows.length) continue;
      const headers = Object.keys(rows[0] || {});
      const { mapping, warnings: sheetWarnings } = detectColumnMap(headers, overrides);
      mappingBySheet.push({ sheet: sheetName, mapping });
      warnings.push(...sheetWarnings.map((w) => `[${sheetName}] ${w}`));
      const missingRequired = REQUIRED_MAPPINGS.filter((key) => !mapping[key]);
      if (missingRequired.length) {
        hardErrors.push(
          `[${sheetName}] 缺少必填映射字段：${missingRequired.join(", ")}。请在导入时提供严格 mapping。`
        );
        continue;
      }
      const optionalHints = [];
      if (!mapping.member_id) optionalHints.push("member_id");
      if (!mapping.member_name) optionalHints.push("member_name");
      if (!mapping.phone) optionalHints.push("phone");
      if (!mapping.qty) optionalHints.push("qty");
      if (optionalHints.length) {
        warnings.push(
          `[${sheetName}] 可选字段未识别：${optionalHints.join(", ")}。这可能导致会员注册率、复购率、数量相关指标不完整。`
        );
      }

      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        const excelRowNo = rowIndex + 2; // sheet_to_json treats first row as header.
        const orderDate = parseDateValue(row[mapping.date]);
        const amountParsed = parseNumber(row[mapping.amount], { allowEmpty: false });
        const qtyParsed = parseNumber(row[mapping.qty], { allowEmpty: true });
        if (!orderDate) {
          warnings.push(`[${sheetName}] 第 ${excelRowNo} 行日期无效，已跳过。`);
          continue;
        }
        if (!amountParsed.valid) {
          hardErrors.push(`[${sheetName}] 第 ${excelRowNo} 行金额字段(${mapping.amount})不是数字：${String(row[mapping.amount] ?? "")}`);
          continue;
        }
        if (!qtyParsed.valid) {
          hardErrors.push(`[${sheetName}] 第 ${excelRowNo} 行数量字段(${mapping.qty})不是数字：${String(row[mapping.qty] ?? "")}`);
          continue;
        }
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
          qty: qtyParsed.value,
          amount: amountParsed.value,
          member_id: cleanText(row[mapping.member_id] || "", ""),
          member_name: cleanText(row[mapping.member_name] || "", ""),
          phone: cleanText(row[mapping.phone] || "", ""),
        });
      }
    }

    if (hardErrors.length) {
      const shown = hardErrors.slice(0, 20);
      const suffix = hardErrors.length > shown.length ? `（另有 ${hardErrors.length - shown.length} 条）` : "";
      throw new Error(`检测到严格映射/数值格式错误：${shown.join("；")}${suffix}`);
    }

    return {
      cleanedRows,
      mappingBySheet,
      warnings: [...new Set(warnings)].slice(0, 100),
    };
  }

  /**
   * Write rows in a single DB connection + transaction to avoid per-row
   * connection setup/teardown overhead.
   */
  async writeRowsToDataset(datasetId, rows, onProgress) {
    const total = Array.isArray(rows) ? rows.length : 0;
    if (!total) return 0;
    const buildBatchInsertSql = (rowCount) => {
      if (rowCount <= 1) return INSERT_SQL;
      const tuple = "(?, ?, CAST(? AS DATE), ?, ?, CAST(? AS DATE), ?, ?, ?, ?, ?, ?, ?, ?, ?)";
      const tuples = new Array(rowCount).fill(tuple).join(", ");
      return `INSERT INTO fact_sales (
  dataset_id, order_no, order_date, year, month_key, week_start, day_key, store, salesperson,
  product, qty, amount, member_id, member_name, phone
) VALUES ${tuples}`;
    };

    await this.duckdbService.withConnection(async (conn) => {
      await conn.run("BEGIN");
      try {
        await conn.run("DELETE FROM fact_sales WHERE dataset_id = ?", [datasetId]);
        let inserted = 0;
        let lastProgressAt = Date.now();
        for (let i = 0; i < rows.length; i += BATCH_INSERT_ROW_SIZE) {
          const batch = rows.slice(i, i + BATCH_INSERT_ROW_SIZE);
          const sql = buildBatchInsertSql(batch.length);
          const values = [];
          for (const row of batch) {
            for (const col of INSERT_COLUMNS) {
              values.push(col === "dataset_id" ? datasetId : row[col]);
            }
          }
          await conn.run(sql, values);
          inserted += batch.length;
          if (
            onProgress &&
            (inserted % IMPORT_PROGRESS_ROW_STEP === 0 ||
              Date.now() - lastProgressAt >= IMPORT_PROGRESS_TIME_STEP_MS ||
              inserted === total)
          ) {
            lastProgressAt = Date.now();
            onProgress(inserted, total);
          }
        }
        await conn.run("COMMIT");
      } catch (error) {
        try {
          await conn.run("ROLLBACK");
        } catch (_rollbackError) {
          // noop: original error should be propagated
        }
        throw error;
      }
    });
    return total;
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

    await this.writeRowsToDataset(datasetId, rows, (inserted, total) => {
      const pct = 45 + Math.floor((inserted / Math.max(1, total)) * 45);
      onProgress?.(Math.min(90, pct), `Inserted ${inserted}/${total}`);
    });

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

  async ingestMultiFileDataset({ sourceNames = [], filePaths = [], overrides = {}, onProgress }) {
    const entries = (Array.isArray(filePaths) ? filePaths : [])
      .map((filePath, index) => ({
        filePath: String(filePath || ""),
        sourceName: String(sourceNames[index] || path.basename(String(filePath || "")) || `file-${index + 1}`),
      }))
      .filter((entry) => entry.filePath);
    if (!entries.length) {
      throw new Error("未收到可导入的文件");
    }

    const datasetId = randomUUID();
    await this.duckdbService.ensureSchema();
    const allRows = [];
    const mapping = [];
    const warnings = [];
    const successfulFiles = [];
    const failedFiles = [];
    let duplicateRowsSkipped = 0;

    let cumulativeRows = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const fileNo = index + 1;
      const fileCount = entries.length;
      try {
        onProgress?.(
          5 + Math.floor((index / Math.max(1, fileCount)) * 35),
          `正在导入第 ${fileNo}/${fileCount} 个文件`,
          {
            currentFileIndex: fileNo,
            fileCount,
            currentFileName: entry.sourceName,
            cumulativeRowCount: cumulativeRows,
          }
        );
        const parsed = await this.parseWorkbook(entry.filePath, overrides);
        const beforeRows = allRows.length;
        for (const row of parsed.cleanedRows) {
          allRows.push(row);
        }
        const uniqueAdded = allRows.length - beforeRows;
        const duplicateInFile = 0;
        cumulativeRows += uniqueAdded;
        successfulFiles.push({
          fileName: entry.sourceName,
          rawRows: parsed.cleanedRows.length,
          uniqueRowsAdded: uniqueAdded,
          duplicateRowsSkipped: duplicateInFile,
        });
        mapping.push({
          fileName: entry.sourceName,
          sheets: parsed.mappingBySheet,
        });
        warnings.push(
          ...parsed.warnings.map((w) => `[${entry.sourceName}] ${w}`)
        );
        onProgress?.(
          5 + Math.floor(((index + 1) / Math.max(1, fileCount)) * 35),
          `文件解析完成：${fileNo}/${fileCount}`,
          {
            currentFileIndex: fileNo,
            fileCount,
            currentFileName: entry.sourceName,
            cumulativeRowCount: cumulativeRows,
            successfulFileCount: successfulFiles.length,
            failedFileCount: failedFiles.length,
            duplicateRowsSkipped,
          }
        );
      } catch (error) {
        failedFiles.push({
          fileName: entry.sourceName,
          reason: String(error?.message || "解析失败"),
        });
        onProgress?.(
          5 + Math.floor(((index + 1) / Math.max(1, fileCount)) * 35),
          `文件解析失败：${fileNo}/${fileCount}`,
          {
            currentFileIndex: fileNo,
            fileCount,
            currentFileName: entry.sourceName,
            cumulativeRowCount: cumulativeRows,
            successfulFileCount: successfulFiles.length,
            failedFileCount: failedFiles.length,
            duplicateRowsSkipped,
          }
        );
      }
    }

    const validation = {
      rowCount: allRows.length,
      warnings: [...new Set(warnings)].slice(0, 200),
      valid: allRows.length > 0,
      fileCount: entries.length,
      successFileCount: successfulFiles.length,
      failedFileCount: failedFiles.length,
      duplicateRowsSkipped,
      successfulFiles,
      failedFiles,
    };

    onProgress?.(45, "正在写入 DuckDB", {
      currentFileIndex: entries.length,
      fileCount: entries.length,
      currentFileName: "",
      cumulativeRowCount: allRows.length,
      successfulFileCount: successfulFiles.length,
      failedFileCount: failedFiles.length,
      duplicateRowsSkipped,
    });

    await this.duckdbService.run(
      `INSERT OR REPLACE INTO datasets(dataset_id, source_name, row_count, created_at, status, mapping_json, validation_json)
       VALUES ($dataset_id, $source_name, $row_count, NOW(), 'loading', $mapping_json, $validation_json)`,
      {
        dataset_id: datasetId,
        source_name: successfulFiles.length
          ? `多文件导入（${successfulFiles.length}/${entries.length}）`
          : `多文件导入（0/${entries.length}）`,
        row_count: allRows.length,
        mapping_json: JSON.stringify(mapping),
        validation_json: JSON.stringify(validation),
      }
    );

    await this.writeRowsToDataset(datasetId, allRows, (inserted, total) => {
      const pct = 45 + Math.floor((inserted / Math.max(1, total)) * 45);
      onProgress?.(Math.min(90, pct), `已写入 ${inserted}/${total} 行`, {
        currentFileIndex: entries.length,
        fileCount: entries.length,
        currentFileName: "",
        cumulativeRowCount: inserted,
        successfulFileCount: successfulFiles.length,
        failedFileCount: failedFiles.length,
        duplicateRowsSkipped,
      });
    });

    await this.duckdbService.run(
      `UPDATE datasets
       SET row_count = $row_count, status = 'ready', mapping_json = $mapping_json, validation_json = $validation_json
       WHERE dataset_id = $dataset_id`,
      {
        dataset_id: datasetId,
        row_count: allRows.length,
        mapping_json: JSON.stringify(mapping),
        validation_json: JSON.stringify(validation),
      }
    );

    onProgress?.(100, "导入完成", {
      currentFileIndex: entries.length,
      fileCount: entries.length,
      currentFileName: "",
      cumulativeRowCount: allRows.length,
      successfulFileCount: successfulFiles.length,
      failedFileCount: failedFiles.length,
      duplicateRowsSkipped,
    });

    return {
      datasetId,
      rowCount: allRows.length,
      mapping,
      validation,
      duplicateRowsSkipped,
      successfulFiles,
      failedFiles,
    };
  }
}
