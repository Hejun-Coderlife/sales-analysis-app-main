import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import {
  applyPermissionScopeToFilters,
  hasPermission,
  maskSensitiveMemberRows,
} from "../auth/permissionModel.js";
import { env } from "../config/env.js";
import { AGGREGATE_ALL_READY_DATASET_ID } from "../services/analyticsService.js";
import { normalizeUploadFilename } from "../utils/uploadFilename.js";
import { sendDingTalkTestWorkNotification } from "../services/dingtalkWorkNotifyService.js";
import { NotificationService } from "../services/notificationService.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const FILTER_OPTIONS_CACHE_TTL_MS = 5 * 60_000;
const ANALYTICS_TIMEOUT_MS = 12_000;
const SLOW_QUERY_MS = 2_000;
const MAX_CONCURRENT_ANALYTICS = 4;
const MAX_QUEUE_WAIT_MS = 1_500;
const QUERY_TIMEOUT_MESSAGE = "查询耗时较长，请稍后重试";
const QUERY_BUSY_MESSAGE = "系统正在处理较多请求，请稍后再试";
const notificationConfigPath = path.resolve(env.dataDir, "notification-config.json");
const notificationService = new NotificationService({ configPath: notificationConfigPath });
const notificationServiceReady = notificationService.init().catch(() => null);

async function safeUnlink(filePath) {
  const target = String(filePath || "").trim();
  if (!target) return;
  try {
    await fs.unlink(target);
  } catch (_error) {
    // Ignore cleanup errors: temp files may already be removed.
  }
}

function collectUploadedFiles(req) {
  const fromAny = Array.isArray(req?.files) ? req.files : [];
  const fromFields =
    req?.files && !Array.isArray(req.files)
      ? Object.values(req.files)
          .flatMap((x) => (Array.isArray(x) ? x : []))
          .filter(Boolean)
      : [];
  return [...fromAny, ...fromFields];
}

function pickTestReceiverUserId({ configUserId, currentUser, envUserId }) {
  const fromConfig = String(configUserId || "").trim();
  if (fromConfig) return { userId: fromConfig, source: "config" };
  const fromCurrentUser = String(currentUser?.dingtalkUserId || currentUser?.dingTalkUserId || "").trim();
  if (fromCurrentUser) return { userId: fromCurrentUser, source: "currentAdmin" };
  const fromEnv = String(envUserId || "").trim();
  if (fromEnv) return { userId: fromEnv, source: "env" };
  return { userId: "", source: "none" };
}

function stableJson(value) {
  if (value == null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((x) => stableJson(x)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

function createShortHash(raw) {
  const text = String(raw || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function scopeHashFromRequest(req) {
  const user = req.currentUser || {};
  const scope = req.accessScope || {};
  const compact = {
    userId: String(user.id || user.user_id || user.username || ""),
    role: String(user.role || ""),
    allowAllStores: !!scope.allowAllStores,
    allowAllSalespeople: !!scope.allowAllSalespeople,
    allowAllProducts: !!scope.allowAllProducts,
    stores: Array.isArray(scope.allowedStores) ? [...scope.allowedStores].sort() : [],
    salespeople: Array.isArray(scope.allowedSalespeople) ? [...scope.allowedSalespeople].sort() : [],
    products: Array.isArray(scope.allowedProducts) ? [...scope.allowedProducts].sort() : [],
  };
  return createShortHash(stableJson(compact));
}

class InMemoryTtlCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key, value, ttlMs) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + Math.max(100, Number(ttlMs) || DEFAULT_CACHE_TTL_MS),
    });
  }

  clear() {
    this.store.clear();
  }
}

class ConcurrencyLimiter {
  constructor(limit = 4) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.queue = [];
  }

  acquire(maxWaitMs = MAX_QUEUE_WAIT_MS) {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const ticket = {
        done: false,
        resolve: (ok) => {
          if (ticket.done) return;
          ticket.done = true;
          resolve(ok);
        },
      };
      ticket.timer = setTimeout(() => {
        this.queue = this.queue.filter((x) => x !== ticket);
        ticket.resolve(false);
      }, Math.max(100, Number(maxWaitMs) || MAX_QUEUE_WAIT_MS));
      this.queue.push(ticket);
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length) {
      const next = this.queue.shift();
      if (!next || next.done) continue;
      clearTimeout(next.timer);
      this.active += 1;
      next.resolve(true);
      break;
    }
  }
}

async function withTimeout(taskPromise, timeoutMs, timeoutMessage = QUERY_TIMEOUT_MESSAGE) {
  let timer = null;
  try {
    return await Promise.race([
      taskPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(timeoutMessage);
          error.code = "QUERY_TIMEOUT";
          reject(error);
        }, Math.max(200, Number(timeoutMs) || ANALYTICS_TIMEOUT_MS));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function logSlowQuery({ endpoint, durationMs, user, datasetId }) {
  if (durationMs < SLOW_QUERY_MS) return;
  console.warn("[slow-query]", {
    endpoint,
    durationMs,
    user: String(user?.id || user?.username || ""),
    datasetId: String(datasetId || ""),
  });
}

function clamp(value, fallback, min = 1, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseFilters(query = {}, scope = null) {
  /** 支持同一键多次出现 stores=a&stores=b；老客户端仍可能用逗号拼接单参数。 */
  const pickList = (raw) => {
    if (Array.isArray(raw)) {
      return raw.map((x) => String(x ?? "").trim()).filter(Boolean);
    }
    return String(raw || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  };

  const parsed = {
    startDate: String(query.startDate || ""),
    endDate: String(query.endDate || ""),
    stores: pickList(query.stores),
    salespeople: pickList(query.salespeople),
    products: pickList(query.products),
  };
  return applyPermissionScopeToFilters(parsed, scope);
}

const filteredPostJsonParser = express.json({ limit: "4mb" });

/**
 * POST body: `{ filters: { startDate, endDate, stores?, salespeople?, products? } }`
 * （数组或逗号分隔字符串，与 query 语义一致，避免数百个 `products=` 撑爆 URL。）
 */
function parseFiltersFromPostBody(body, scope) {
  const f = body?.filters;
  if (!f || typeof f !== "object") return null;
  const list = (raw) => {
    if (Array.isArray(raw)) {
      return raw.map((x) => String(x ?? "").trim()).filter(Boolean);
    }
    return String(raw || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  };
  const parsed = {
    startDate: String(f.startDate || ""),
    endDate: String(f.endDate || ""),
    stores: list(f.stores),
    salespeople: list(f.salespeople),
    products: list(f.products),
  };
  return applyPermissionScopeToFilters(parsed, scope);
}

function filtersFromRequest(req) {
  if ((req.method === "POST" || req.method === "PUT") && req.body) {
    const fromBody = parseFiltersFromPostBody(req.body, req.accessScope);
    if (fromBody) return fromBody;
  }
  return parseFilters(req.query, req.accessScope);
}

function forbidByPermission(res) {
  return res.status(403).json({ error: "你没有权限查看该范围的数据。" });
}

function ensurePermission(req, res, permissionName) {
  if (hasPermission(req.currentUser, permissionName)) return true;
  forbidByPermission(res);
  return false;
}

async function expandRouteDatasetIds(analyticsService, routeDatasetId) {
  const raw = String(routeDatasetId || "").trim();
  if (raw === AGGREGATE_ALL_READY_DATASET_ID) {
    return await analyticsService.listReadyDatasetIds();
  }
  if (!raw) return [];
  return [raw];
}

export function createV2Router({
  ingestionService,
  analyticsService,
  jobStore,
  jobQueue,
  maxUploadSizeMb = 100,
  onImportEvent = null,
  registerResponseCacheInvalidate = null,
}) {
  const router = express.Router();
  const responseCache = new InMemoryTtlCache();
  if (typeof registerResponseCacheInvalidate === "function") {
    registerResponseCacheInvalidate(() => responseCache.clear());
  }
  const queryLimiter = new ConcurrencyLimiter(MAX_CONCURRENT_ANALYTICS);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(1, maxUploadSizeMb) * 1024 * 1024 },
  });
  const uploadAny = upload.any();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, service: "analytics-v2", now: new Date().toISOString() });
  });

  router.get("/datasets/latest", async (_req, res) => {
    if (!ensurePermission(_req, res, "canViewDashboard")) return;
    const dataset = await analyticsService.getLatestDatasetSummary({ onlyReady: true });
    return res.json({ ok: true, dataset: dataset || null });
  });

  /** Bootstrap: IDs included in merged dashboard (`__all_ready__`). */
  router.get("/datasets/aggregate-scope", async (_req, res) => {
    if (!ensurePermission(_req, res, "canViewDashboard")) return;
    const datasetIds = await analyticsService.listReadyDatasetIds();
    return res.json({
      ok: true,
      aggregateDatasetId: AGGREGATE_ALL_READY_DATASET_ID,
      datasetIds,
      datasetCount: datasetIds.length,
    });
  });

  router.post("/uploads", uploadAny, async (req, res) => {
    if (!hasPermission(req.currentUser, "canImportExcel")) {
      return res.status(403).json({ error: "仅管理员可上传或导入数据" });
    }
    const uploadedFiles = collectUploadedFiles(req);
    const fileList = uploadedFiles
      .filter(Boolean)
      .map((f) => ({ ...f, originalname: normalizeUploadFilename(f.originalname) }))
      .filter((f) => {
        const name = String(f.originalname || "").toLowerCase();
        return name.endsWith(".xls") || name.endsWith(".xlsx");
      });
    if (!fileList.length) {
      const providedFieldNames = [...new Set(uploadedFiles.map((f) => String(f.fieldname || "")).filter(Boolean))];
      return res.status(400).json({
        error: "未检测到可导入的 Excel 文件（支持 .xls/.xlsx）",
        details: {
          expectedFields: ["file", "files"],
          providedFieldNames,
        },
      });
    }
    let overrides = {};
    try {
      overrides = req.body?.mapping ? JSON.parse(req.body.mapping) : {};
    } catch (_error) {
      return res.status(400).json({ error: "mapping must be valid JSON" });
    }

    const uploadedPaths = [];
    for (const file of fileList) {
      const uploadedPath = await ingestionService.persistUploadBuffer(file);
      uploadedPaths.push(uploadedPath);
    }
    const importedBy = String(req.currentUser?.username || "");
    const job = await jobStore.createJob({
      type: "ingest",
      payload: {
        sourceName: fileList.length === 1 ? fileList[0].originalname || "upload.xlsx" : `multi-file-${fileList.length}`,
        fileNames: fileList.map((f) => String(f.originalname || "upload.xlsx")),
        paths: uploadedPaths,
        fileCount: fileList.length,
        importedBy,
      },
    });
    onImportEvent?.({
      adminUsername: importedBy,
      actionType: "import_excel",
      targetType: "file",
      targetId: fileList.length === 1 ? fileList[0].originalname || "upload.xlsx" : `multi-file-${fileList.length}`,
      summary: `提交导入任务：${fileList.length} 个文件（job: ${job.id.slice(0, 8)}）`,
      meta: {
        jobId: job.id,
        fileCount: fileList.length,
        fileNames: fileList.map((f) => String(f.originalname || "upload.xlsx")),
      },
    });

    jobQueue.enqueue(async () => {
      await jobStore.updateJob(job.id, { status: "running", progress: 5, error: null });
      try {
        const result = await ingestionService.ingestMultiFileDataset({
          sourceNames: fileList.map((f) => String(f.originalname || "upload.xlsx")),
          filePaths: uploadedPaths,
          overrides,
          onProgress: async (progress, phase, importProgress = {}) => {
            await jobStore.updateJob(job.id, {
              progress,
              phase,
              stats: {
                ...(job.stats || {}),
                importProgress: {
                  currentFileIndex: Number(importProgress.currentFileIndex || 0),
                  fileCount: Number(importProgress.fileCount || fileList.length),
                  currentFileName: String(importProgress.currentFileName || ""),
                  cumulativeRowCount: Number(importProgress.cumulativeRowCount || 0),
                  successfulFileCount: Number(importProgress.successfulFileCount || 0),
                  failedFileCount: Number(importProgress.failedFileCount || 0),
                  duplicateRowsSkipped: Number(importProgress.duplicateRowsSkipped || 0),
                },
              },
            });
          },
        });
        const allFailed = Array.isArray(result.failedFiles) && result.failedFiles.length >= fileList.length;
        await jobStore.updateJob(job.id, {
          status: allFailed ? "failed" : "completed",
          progress: 100,
          datasetId: result.datasetId,
          stats: {
            rowCount: result.rowCount,
            mapping: result.mapping,
            validation: result.validation,
            duplicateRowsSkipped: Number(result.duplicateRowsSkipped || 0),
            successfulFiles: result.successfulFiles || [],
            failedFiles: result.failedFiles || [],
            importProgress: {
              currentFileIndex: fileList.length,
              fileCount: fileList.length,
              currentFileName: "",
              cumulativeRowCount: Number(result.rowCount || 0),
              successfulFileCount: Array.isArray(result.successfulFiles) ? result.successfulFiles.length : 0,
              failedFileCount: Array.isArray(result.failedFiles) ? result.failedFiles.length : 0,
              duplicateRowsSkipped: Number(result.duplicateRowsSkipped || 0),
            },
          },
          warnings: result.validation?.warnings || [],
          error: allFailed ? "所有文件均导入失败，请检查文件格式和字段映射" : null,
        });
        responseCache.clear();
        analyticsService?.queryCache?.clear?.();
        analyticsService?.clearCache?.();
      } catch (error) {
        await jobStore.updateJob(job.id, {
          status: "failed",
          progress: 100,
          error: error?.message || "导入失败",
        });
      } finally {
        await Promise.all(uploadedPaths.map((p) => safeUnlink(p)));
      }
    });

    return res.status(202).json({
      ok: true,
      jobId: job.id,
      statusUrl: `/api/v2/jobs/${job.id}`,
    });
  });

  router.get("/jobs/:id", async (req, res) => {
    if (!ensurePermission(req, res, "canViewImportHistory")) return;
    const job = await jobStore.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "job not found" });
    return res.json({ ok: true, job });
  });

  router.get("/datasets/:datasetId/summary", async (req, res) => {
    if (!ensurePermission(req, res, "canViewDashboard")) return;
    const param = req.params.datasetId;
    if (param === AGGREGATE_ALL_READY_DATASET_ID) {
      const datasetIds = await analyticsService.listReadyDatasetIds();
      if (!datasetIds.length) {
        return res.status(404).json({ error: "暂无就绪数据集" });
      }
      const totalRows = await analyticsService.sumDeclaredRowCountsForDatasetIds(datasetIds);
      return res.json({
        ok: true,
        summary: {
          dataset_id: AGGREGATE_ALL_READY_DATASET_ID,
          source_name: `全部就绪导入汇总（${datasetIds.length} 个数据集）`,
          row_count: totalRows,
          merged_dataset_ids: datasetIds,
          status: "ready",
        },
      });
    }
    const summary = await analyticsService.getDatasetSummary(param);
    if (!summary) return res.status(404).json({ error: "dataset not found" });
    return res.json({ ok: true, summary });
  });

  /** Resolves `__all_ready__` to all ready dataset IDs; validates before query. */
  async function ensureRouteDatasetsReady(routeDatasetId) {
    const ids = await expandRouteDatasetIds(analyticsService, routeDatasetId);
    if (!ids.length) {
      return { ok: false, code: 404, message: "暂无就绪数据，请先在后台导入 Excel" };
    }
    const verified = await analyticsService.verifyDatasetIdsReady(ids);
    if (!verified) {
      return { ok: false, code: 409, message: "数据导入处理中或数据集不可用，请稍后重试" };
    }
    return { ok: true, datasetIds: ids };
  }

  function makeCacheKey({ endpointName, routeDatasetId, req, filters, extras = {} }) {
    const scopeHash = scopeHashFromRequest(req);
    return [
      `ep:${endpointName}`,
      `dataset:${String(routeDatasetId || "")}`,
      `scope:${scopeHash}`,
      `filters:${stableJson({
        startDate: String(filters?.startDate || ""),
        endDate: String(filters?.endDate || ""),
        stores: Array.isArray(filters?.stores) ? filters.stores : [],
        salespeople: Array.isArray(filters?.salespeople) ? filters.salespeople : [],
        products: Array.isArray(filters?.products) ? filters.products : [],
      })}`,
      `extra:${stableJson(extras)}`,
    ].join("|");
  }

  async function executeProtectedQuery(req, res, options, handler) {
    const {
      endpointName,
      routeDatasetId,
      filters = {},
      cacheTtlMs = DEFAULT_CACHE_TTL_MS,
      cacheExtras = {},
      useCache = true,
      useLimiter = true,
      timeoutMs = ANALYTICS_TIMEOUT_MS,
    } = options || {};
    const cacheKey = makeCacheKey({
      endpointName,
      routeDatasetId,
      req,
      filters,
      extras: cacheExtras,
    });
    if (useCache) {
      const hit = responseCache.get(cacheKey);
      if (hit) return res.json(hit);
    }

    let acquired = false;
    const startedAt = Date.now();
    try {
      if (useLimiter) {
        acquired = await queryLimiter.acquire(MAX_QUEUE_WAIT_MS);
        if (!acquired) {
          return res.status(503).json({ error: QUERY_BUSY_MESSAGE });
        }
      }
      const ready = await ensureRouteDatasetsReady(routeDatasetId);
      if (!ready.ok) return res.status(ready.code).json({ error: ready.message });
      const datasetIds = ready.datasetIds;

      const payload = await withTimeout(
        Promise.resolve().then(() => handler(datasetIds)),
        timeoutMs,
        QUERY_TIMEOUT_MESSAGE
      );
      logSlowQuery({
        endpoint: endpointName,
        durationMs: Date.now() - startedAt,
        user: req.currentUser,
        datasetId: routeDatasetId,
      });
      if (useCache) responseCache.set(cacheKey, payload, cacheTtlMs);
      return res.json(payload);
    } catch (error) {
      if (error?.code === "QUERY_TIMEOUT") {
        return res.status(504).json({ error: QUERY_TIMEOUT_MESSAGE });
      }
      const message = String(error?.message || "查询失败");
      return res.status(500).json({ error: message });
    } finally {
      if (acquired) queryLimiter.release();
    }
  }

  async function handleDatasetKpis(req, res) {
    if (!ensurePermission(req, res, "canViewKpi")) return;
    const filters = filtersFromRequest(req);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "kpis",
        routeDatasetId: req.params.datasetId,
        filters,
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async (datasetIds) => {
        const kpis = await analyticsService.getKpis(datasetIds, filters);
        return { ok: true, kpis };
      }
    );
  }
  router.get("/datasets/:datasetId/kpis", handleDatasetKpis);
  router.post("/datasets/:datasetId/kpis", filteredPostJsonParser, handleDatasetKpis);

  router.get("/datasets/:datasetId/rankings/stores", async (req, res) => {
    if (!ensurePermission(req, res, "canViewStoreRanking")) return;
    const filters = filtersFromRequest(req);
    const limit = clamp(req.query.limit, 20, 1, 500);
    const offset = clamp(req.query.offset, 0, 0, 1_000_000);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "rankings_stores",
        routeDatasetId: req.params.datasetId,
        filters,
        cacheExtras: { limit, offset },
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async (datasetIds) => {
        const rows = await analyticsService.getTopStores(datasetIds, {
          filters,
          limit,
          offset,
        });
        return { ok: true, rows };
      }
    );
  });
  router.post(
    "/datasets/:datasetId/rankings/stores",
    filteredPostJsonParser,
    async (req, res) => {
      if (!ensurePermission(req, res, "canViewStoreRanking")) return;
      const filters = filtersFromRequest(req);
      const limit = clamp(req.query.limit, 20, 1, 500);
      const offset = clamp(req.query.offset, 0, 0, 1_000_000);
      return executeProtectedQuery(
        req,
        res,
        {
          endpointName: "rankings_stores",
          routeDatasetId: req.params.datasetId,
          filters,
          cacheExtras: { limit, offset },
          cacheTtlMs: DEFAULT_CACHE_TTL_MS,
        },
        async (datasetIds) => {
          const rows = await analyticsService.getTopStores(datasetIds, {
            filters,
            limit,
            offset,
          });
          return { ok: true, rows };
        }
      );
    }
  );

  router.get("/datasets/:datasetId/rankings/salespeople", async (req, res) => {
    if (!ensurePermission(req, res, "canViewSalespersonRanking")) return;
    const filters = filtersFromRequest(req);
    const limit = clamp(req.query.limit, 20, 1, 500);
    const offset = clamp(req.query.offset, 0, 0, 1_000_000);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "rankings_salespeople",
        routeDatasetId: req.params.datasetId,
        filters,
        cacheExtras: { limit, offset },
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async (datasetIds) => {
        const rows = await analyticsService.getTopSalespeople(datasetIds, {
          filters,
          limit,
          offset,
        });
        return { ok: true, rows };
      }
    );
  });
  router.post(
    "/datasets/:datasetId/rankings/salespeople",
    filteredPostJsonParser,
    async (req, res) => {
      if (!ensurePermission(req, res, "canViewSalespersonRanking")) return;
      const filters = filtersFromRequest(req);
      const limit = clamp(req.query.limit, 20, 1, 500);
      const offset = clamp(req.query.offset, 0, 0, 1_000_000);
      return executeProtectedQuery(
        req,
        res,
        {
          endpointName: "rankings_salespeople",
          routeDatasetId: req.params.datasetId,
          filters,
          cacheExtras: { limit, offset },
          cacheTtlMs: DEFAULT_CACHE_TTL_MS,
        },
        async (datasetIds) => {
          const rows = await analyticsService.getTopSalespeople(datasetIds, {
            filters,
            limit,
            offset,
          });
          return { ok: true, rows };
        }
      );
    }
  );

  router.get("/datasets/:datasetId/rankings/products", async (req, res) => {
    if (!ensurePermission(req, res, "canViewProductRanking")) return;
    const filters = filtersFromRequest(req);
    const limit = clamp(req.query.limit, 20, 1, 500);
    const offset = clamp(req.query.offset, 0, 0, 1_000_000);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "rankings_products",
        routeDatasetId: req.params.datasetId,
        filters,
        cacheExtras: { limit, offset },
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async (datasetIds) => {
        const rows = await analyticsService.getTopProducts(datasetIds, {
          filters,
          limit,
          offset,
        });
        return { ok: true, rows };
      }
    );
  });
  router.post(
    "/datasets/:datasetId/rankings/products",
    filteredPostJsonParser,
    async (req, res) => {
      if (!ensurePermission(req, res, "canViewProductRanking")) return;
      const filters = filtersFromRequest(req);
      const limit = clamp(req.query.limit, 20, 1, 500);
      const offset = clamp(req.query.offset, 0, 0, 1_000_000);
      return executeProtectedQuery(
        req,
        res,
        {
          endpointName: "rankings_products",
          routeDatasetId: req.params.datasetId,
          filters,
          cacheExtras: { limit, offset },
          cacheTtlMs: DEFAULT_CACHE_TTL_MS,
        },
        async (datasetIds) => {
          const rows = await analyticsService.getTopProducts(datasetIds, {
            filters,
            limit,
            offset,
          });
          return { ok: true, rows };
        }
      );
    }
  );

  async function handleMembersTop(req, res) {
    if (!ensurePermission(req, res, "canViewMemberAnalysis")) return;
    const ready = await ensureRouteDatasetsReady(req.params.datasetId);
    if (!ready.ok) return res.status(ready.code).json({ error: ready.message });
    const q = req.query || {};
    const b = req.body || {};
    const rows = await analyticsService.getTopMembers(ready.datasetIds, {
      filters: filtersFromRequest(req),
      limit: clamp(q.limit ?? b.limit, 20, 1, 500),
      offset: clamp(q.offset ?? b.offset, 0, 0, 1_000_000),
      keyword: String(q.keyword ?? b.keyword ?? ""),
    });
    return res.json({
      ok: true,
      rows: maskSensitiveMemberRows(rows, req.currentUser?.allowedMemberFields || {}),
    });
  }
  router.get("/datasets/:datasetId/members/top", handleMembersTop);
  router.post("/datasets/:datasetId/members/top", filteredPostJsonParser, handleMembersTop);

  async function handleRepurchaseDistribution(req, res) {
    if (!ensurePermission(req, res, "canViewMemberAnalysis")) return;
    const ready = await ensureRouteDatasetsReady(req.params.datasetId);
    if (!ready.ok) return res.status(ready.code).json({ error: ready.message });
    const rows = await analyticsService.getRepurchaseDistribution(ready.datasetIds, {
      filters: filtersFromRequest(req),
    });
    return res.json({ ok: true, rows });
  }
  router.get("/datasets/:datasetId/members/repurchase-distribution", handleRepurchaseDistribution);
  router.post(
    "/datasets/:datasetId/members/repurchase-distribution",
    filteredPostJsonParser,
    handleRepurchaseDistribution
  );

  async function handleFilterOptions(req, res) {
    if (!ensurePermission(req, res, "canUseFilters")) return;
    const filters = filtersFromRequest(req);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "filters_options",
        routeDatasetId: req.params.datasetId,
        filters,
        cacheTtlMs: FILTER_OPTIONS_CACHE_TTL_MS,
      },
      async (datasetIds) => {
        const options = await analyticsService.getFilterOptions(datasetIds, {
          filters,
        });
        return { ok: true, options };
      }
    );
  }
  router.get("/datasets/:datasetId/filters/options", handleFilterOptions);
  router.post("/datasets/:datasetId/filters/options", filteredPostJsonParser, handleFilterOptions);

  async function handleTrends(req, res) {
    if (!ensurePermission(req, res, "canViewTrendCharts")) return;
    const filters = filtersFromRequest(req);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "trends",
        routeDatasetId: req.params.datasetId,
        filters,
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async (datasetIds) => {
        const trends = await analyticsService.getTrendSeries(datasetIds, {
          filters,
        });
        return { ok: true, ...trends };
      }
    );
  }
  router.get("/datasets/:datasetId/trends", handleTrends);
  router.post("/datasets/:datasetId/trends", filteredPostJsonParser, handleTrends);

  async function handleDataQuality(req, res) {
    if (!ensurePermission(req, res, "canViewDataQuality")) return;
    const ready = await ensureRouteDatasetsReady(req.params.datasetId);
    if (!ready.ok) return res.status(ready.code).json({ error: ready.message });
    const report = await analyticsService.getDataQualityReport(ready.datasetIds, {
      filters: filtersFromRequest(req),
    });
    return res.json({ ok: true, ...report });
  }
  router.get("/datasets/:datasetId/data-quality", handleDataQuality);
  router.post("/datasets/:datasetId/data-quality", filteredPostJsonParser, handleDataQuality);

  async function handleSleeping(req, res) {
    if (!ensurePermission(req, res, "canViewSleepingMembers")) return;
    const q = req.query || {};
    const b = req.body || {};
    const filters = filtersFromRequest(req);
    const sleepDays = Number(b.sleepDays ?? q.sleepDays ?? 90);
    const sleepMinOrders = Number(b.sleepMinOrders ?? q.sleepMinOrders ?? 2);
    const sleepMinAmount = Number(b.sleepMinAmount ?? q.sleepMinAmount ?? 1000);
    const aclassMinAmount = Number(b.aclassMinAmount ?? q.aclassMinAmount ?? 3000);
    const aclassMinOrders = Number(b.aclassMinOrders ?? q.aclassMinOrders ?? 5);
    const analysisDate = String(b.analysisDate ?? q.analysisDate ?? "");
    const limit = clamp(b.limit ?? q.limit, 200, 1, 2000);
    const offset = clamp(b.offset ?? q.offset, 0, 0, 1_000_000);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "mobile_sleeping_summary",
        routeDatasetId: req.params.datasetId,
        filters,
        cacheExtras: {
          sleepDays,
          sleepMinOrders,
          sleepMinAmount,
          aclassMinAmount,
          aclassMinOrders,
          analysisDate,
          limit,
          offset,
        },
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async (datasetIds) => {
        const result = await analyticsService.getSleepingAnalytics(datasetIds, {
          filters,
          sleepDays,
          sleepMinOrders,
          sleepMinAmount,
          aclassMinAmount,
          aclassMinOrders,
          analysisDate,
          limit,
          offset,
        });
        return {
          ok: true,
          ...result,
          rows: maskSensitiveMemberRows(result.rows, req.currentUser?.allowedMemberFields || {}),
        };
      }
    );
  }
  router.get("/datasets/:datasetId/members/sleeping", handleSleeping);
  router.post("/datasets/:datasetId/members/sleeping", filteredPostJsonParser, handleSleeping);

  async function handleOrdersHighest(req, res) {
    if (!ensurePermission(req, res, "canViewRawRows")) return;
    const ready = await ensureRouteDatasetsReady(req.params.datasetId);
    if (!ready.ok) return res.status(ready.code).json({ error: ready.message });
    const row = await analyticsService.getHighestOrder(ready.datasetIds, {
      filters: filtersFromRequest(req),
    });
    return res.json({ ok: true, row });
  }
  router.get("/datasets/:datasetId/orders/highest", handleOrdersHighest);
  router.post("/datasets/:datasetId/orders/highest", filteredPostJsonParser, handleOrdersHighest);

  async function handleOrdersTop(req, res) {
    if (!ensurePermission(req, res, "canViewRawRows")) return;
    const ready = await ensureRouteDatasetsReady(req.params.datasetId);
    if (!ready.ok) return res.status(ready.code).json({ error: ready.message });
    const q = req.query || {};
    const b = req.body || {};
    const rows = await analyticsService.getOrders(ready.datasetIds, {
      filters: filtersFromRequest(req),
      limit: clamp(q.limit ?? b.limit, 20, 1, 500),
      offset: clamp(q.offset ?? b.offset, 0, 0, 1_000_000),
    });
    return res.json({ ok: true, rows });
  }
  router.get("/datasets/:datasetId/orders/top", handleOrdersTop);
  router.post("/datasets/:datasetId/orders/top", filteredPostJsonParser, handleOrdersTop);

  async function handleLeaders(req, res) {
    if (!ensurePermission(req, res, "canViewTrendCharts")) return;
    const ready = await ensureRouteDatasetsReady(req.params.datasetId);
    if (!ready.ok) return res.status(ready.code).json({ error: ready.message });
    const q = req.query || {};
    const b = req.body || {};
    const granularity = String(q.granularity ?? b.granularity ?? "month");
    const rows = await analyticsService.getLeadersByGranularity(ready.datasetIds, {
      granularity,
      filters: filtersFromRequest(req),
      limit: clamp(q.limit ?? b.limit, 20, 1, 500),
    });
    return res.json({ ok: true, granularity, rows });
  }
  router.get("/datasets/:datasetId/leaders", handleLeaders);
  router.post("/datasets/:datasetId/leaders", filteredPostJsonParser, handleLeaders);

  router.get("/datasets/:datasetId/table/:tableName", async (req, res) => {
    if (!ensurePermission(req, res, "canViewRawRows")) return;
    const ready = await ensureRouteDatasetsReady(req.params.datasetId);
    if (!ready.ok) return res.status(ready.code).json({ error: ready.message });
    try {
      const data = await analyticsService.getTablePage(ready.datasetIds, req.params.tableName, {
        limit: clamp(req.query.limit, 100, 1, 2000),
        offset: clamp(req.query.offset, 0, 0, 10_000_000),
      });
      return res.json({ ok: true, ...data });
    } catch (error) {
      return res.status(400).json({ error: error?.message || "表格查询失败" });
    }
  });

  router.get("/admin/notifications/config", async (req, res) => {
    if (!ensurePermission(req, res, "canManageDingTalkSettings")) return;
    await notificationServiceReady;
    return res.json({
      ok: true,
      config: notificationService.getSafeConfig(),
      envStatus: {
        corpIdConfigured: !!env.dingtalkCorpId,
        appKeyConfigured: !!env.dingtalkAppKey,
        appSecretConfigured: !!env.dingtalkAppSecret,
        agentIdConfigured: !!env.dingtalkAgentId,
      },
      currentAdminBinding: {
        bound: !!String(req.currentUser?.dingtalkUserId || req.currentUser?.dingTalkUserId || "").trim(),
      },
    });
  });

  router.put("/admin/notifications/config", express.json(), async (req, res) => {
    if (!ensurePermission(req, res, "canManageDingTalkSettings")) return;
    await notificationServiceReady;
    const nextConfig = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
    const saved = await notificationService.updateConfig(
      nextConfig,
      String(req.currentUser?.username || req.currentUser?.id || "")
    );
    return res.json({ ok: true, config: saved });
  });

  router.post("/admin/notifications/test-dingtalk", express.json(), async (req, res) => {
    if (!ensurePermission(req, res, "canManageDingTalkSettings")) return;
    await notificationServiceReady;
    const cfg = notificationService.getSafeConfig();
    if (!cfg?.channels?.dingtalkEnabled) {
      return res.status(400).json({ ok: false, error: "钉钉通知渠道未启用，请先开启后再测试" });
    }
    const receiver = pickTestReceiverUserId({
      configUserId: cfg?.recipients?.dingtalkTestUserId,
      currentUser: req.currentUser,
      envUserId: env.dingtalkTestUserId,
    });
    if (!receiver.userId) {
      return res.status(400).json({
        ok: false,
        error: "当前账号未绑定钉钉用户，请先在钉钉内打开手机版完成绑定，或在后台配置测试接收人。",
      });
    }
    const result = await sendDingTalkTestWorkNotification({
      appKey: env.dingtalkAppKey,
      appSecret: env.dingtalkAppSecret,
      agentId: env.dingtalkAgentId,
      testUserId: receiver.userId,
      publicBaseUrl: env.publicBaseUrl,
      checkSendResult: true,
    });
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.error || "钉钉测试通知发送失败",
        dingtalk: {
          errcode: result?.dingtalk?.errcode ?? null,
          errmsg: result?.dingtalk?.errmsg ? String(result.dingtalk.errmsg) : "",
        },
      });
    }
    if (Number(result?.sendResult?.invalidUserIdCount || 0) > 0) {
      return res.status(400).json({
        ok: false,
        error: "钉钉已受理任务，但接收人 userid 无效，请检查是否属于当前企业或当前应用可见范围。",
        dingtalk: {
          errcode: result?.dingtalk?.errcode ?? 0,
          errmsg: "ok",
          task_id: result?.dingtalk?.task_id || "",
          invalidUserIdCount: Number(result?.sendResult?.invalidUserIdCount || 0),
        },
      });
    }
    const sourceHint =
      receiver.source === "env"
        ? "当前使用环境变量测试接收人，建议绑定当前管理员钉钉账号。"
        : "";
    return res.json({
      ok: true,
      message: sourceHint || "已发送钉钉测试通知",
      receiverSource: receiver.source,
      dingtalk: {
        errcode: result?.dingtalk?.errcode ?? 0,
        errmsg: "ok",
        task_id: result?.dingtalk?.task_id || "",
      },
    });
  });

  router.get("/feature-flags", (_req, res) => {
    return res.json({
      ok: true,
      flags: {
        analyticsPathMode: process.env.ANALYTICS_PATH_MODE || "legacy",
        enableShadowParity: String(process.env.ANALYTICS_ENABLE_SHADOW_PARITY || "false") === "true",
      },
    });
  });

  return router;
}
