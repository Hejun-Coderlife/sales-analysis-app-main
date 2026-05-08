import express from "express";
import multer from "multer";
import path from "path";
import {
  applyPermissionScopeToFilters,
  hasPermission,
  maskSensitiveMemberRows,
} from "../auth/permissionModel.js";
import { env } from "../config/env.js";
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
  const pickCsv = (value) =>
    String(value || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  const parsed = {
    startDate: String(query.startDate || ""),
    endDate: String(query.endDate || ""),
    stores: pickCsv(query.stores),
    salespeople: pickCsv(query.salespeople),
    products: pickCsv(query.products),
  };
  return applyPermissionScopeToFilters(parsed, scope);
}

function forbidByPermission(res) {
  return res.status(403).json({ error: "你没有权限查看该范围的数据。" });
}

function ensurePermission(req, res, permissionName) {
  if (hasPermission(req.currentUser, permissionName)) return true;
  forbidByPermission(res);
  return false;
}

export function createV2Router({
  ingestionService,
  analyticsService,
  jobStore,
  jobQueue,
  maxUploadSizeMb = 100,
  onImportEvent = null,
}) {
  const router = express.Router();
  const responseCache = new InMemoryTtlCache();
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

  router.post("/uploads", uploadAny, async (req, res) => {
    if (!hasPermission(req.currentUser, "canImportExcel")) {
      return res.status(403).json({ error: "仅管理员可上传或导入数据" });
    }
    const uploadedFiles = collectUploadedFiles(req);
    const fileList = uploadedFiles
      .filter(Boolean)
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
    const summary = await analyticsService.getDatasetSummary(req.params.datasetId);
    if (!summary) return res.status(404).json({ error: "dataset not found" });
    return res.json({ ok: true, summary });
  });

  async function ensureDatasetReady(datasetId) {
    const summary = await analyticsService.getDatasetSummary(datasetId);
    if (!summary) return { ok: false, code: 404, message: "dataset not found" };
    if (String(summary.status || "") !== "ready") {
      return { ok: false, code: 409, message: "数据导入处理中，请稍后重试" };
    }
    return { ok: true };
  }

  function makeCacheKey({ endpointName, datasetId, req, filters, extras = {} }) {
    const scopeHash = scopeHashFromRequest(req);
    return [
      `ep:${endpointName}`,
      `dataset:${String(datasetId || "")}`,
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
      datasetId,
      filters = {},
      cacheTtlMs = DEFAULT_CACHE_TTL_MS,
      cacheExtras = {},
      useCache = true,
      useLimiter = true,
      timeoutMs = ANALYTICS_TIMEOUT_MS,
    } = options || {};
    const cacheKey = makeCacheKey({
      endpointName,
      datasetId,
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
      const ready = await ensureDatasetReady(datasetId);
      if (!ready.ok) return res.status(ready.code).json({ error: ready.message });

      const payload = await withTimeout(
        Promise.resolve().then(() => handler()),
        timeoutMs,
        QUERY_TIMEOUT_MESSAGE
      );
      logSlowQuery({
        endpoint: endpointName,
        durationMs: Date.now() - startedAt,
        user: req.currentUser,
        datasetId,
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

  router.get("/datasets/:datasetId/kpis", async (req, res) => {
    if (!ensurePermission(req, res, "canViewKpi")) return;
    const filters = parseFilters(req.query, req.accessScope);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "kpis",
        datasetId: req.params.datasetId,
        filters,
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async () => {
        const kpis = await analyticsService.getKpis(req.params.datasetId, filters);
        return { ok: true, kpis };
      }
    );
  });

  router.get("/datasets/:datasetId/rankings/stores", async (req, res) => {
    if (!ensurePermission(req, res, "canViewStoreRanking")) return;
    const filters = parseFilters(req.query, req.accessScope);
    const limit = clamp(req.query.limit, 20, 1, 500);
    const offset = clamp(req.query.offset, 0, 0, 1_000_000);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "rankings_stores",
        datasetId: req.params.datasetId,
        filters,
        cacheExtras: { limit, offset },
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async () => {
        const rows = await analyticsService.getTopStores(req.params.datasetId, {
          filters,
          limit,
          offset,
        });
        return { ok: true, rows };
      }
    );
  });

  router.get("/datasets/:datasetId/rankings/salespeople", async (req, res) => {
    if (!ensurePermission(req, res, "canViewSalespersonRanking")) return;
    const filters = parseFilters(req.query, req.accessScope);
    const limit = clamp(req.query.limit, 20, 1, 500);
    const offset = clamp(req.query.offset, 0, 0, 1_000_000);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "rankings_salespeople",
        datasetId: req.params.datasetId,
        filters,
        cacheExtras: { limit, offset },
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async () => {
        const rows = await analyticsService.getTopSalespeople(req.params.datasetId, {
          filters,
          limit,
          offset,
        });
        return { ok: true, rows };
      }
    );
  });

  router.get("/datasets/:datasetId/rankings/products", async (req, res) => {
    if (!ensurePermission(req, res, "canViewProductRanking")) return;
    const filters = parseFilters(req.query, req.accessScope);
    const limit = clamp(req.query.limit, 20, 1, 500);
    const offset = clamp(req.query.offset, 0, 0, 1_000_000);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "rankings_products",
        datasetId: req.params.datasetId,
        filters,
        cacheExtras: { limit, offset },
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async () => {
        const rows = await analyticsService.getTopProducts(req.params.datasetId, {
          filters,
          limit,
          offset,
        });
        return { ok: true, rows };
      }
    );
  });

  router.get("/datasets/:datasetId/members/top", async (req, res) => {
    if (!ensurePermission(req, res, "canViewMemberAnalysis")) return;
    const rows = await analyticsService.getTopMembers(req.params.datasetId, {
      filters: parseFilters(req.query, req.accessScope),
      limit: clamp(req.query.limit, 20, 1, 500),
      offset: clamp(req.query.offset, 0, 0, 1_000_000),
      keyword: String(req.query.keyword || ""),
    });
    return res.json({
      ok: true,
      rows: maskSensitiveMemberRows(rows, req.currentUser?.allowedMemberFields || {}),
    });
  });

  router.get("/datasets/:datasetId/filters/options", async (req, res) => {
    if (!ensurePermission(req, res, "canUseFilters")) return;
    const filters = parseFilters(req.query, req.accessScope);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "filters_options",
        datasetId: req.params.datasetId,
        filters,
        cacheTtlMs: FILTER_OPTIONS_CACHE_TTL_MS,
      },
      async () => {
        const options = await analyticsService.getFilterOptions(req.params.datasetId, {
          filters,
        });
        return { ok: true, options };
      }
    );
  });

  router.get("/datasets/:datasetId/trends", async (req, res) => {
    if (!ensurePermission(req, res, "canViewTrendCharts")) return;
    const filters = parseFilters(req.query, req.accessScope);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "trends",
        datasetId: req.params.datasetId,
        filters,
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      },
      async () => {
        const trends = await analyticsService.getTrendSeries(req.params.datasetId, {
          filters,
        });
        return { ok: true, ...trends };
      }
    );
  });

  router.get("/datasets/:datasetId/data-quality", async (req, res) => {
    if (!ensurePermission(req, res, "canViewDataQuality")) return;
    const report = await analyticsService.getDataQualityReport(req.params.datasetId, {
      filters: parseFilters(req.query, req.accessScope),
    });
    return res.json({ ok: true, ...report });
  });

  router.get("/datasets/:datasetId/members/sleeping", async (req, res) => {
    if (!ensurePermission(req, res, "canViewSleepingMembers")) return;
    const filters = parseFilters(req.query, req.accessScope);
    const sleepDays = Number(req.query.sleepDays || 90);
    const sleepMinOrders = Number(req.query.sleepMinOrders || 2);
    const sleepMinAmount = Number(req.query.sleepMinAmount || 1000);
    const aclassMinAmount = Number(req.query.aclassMinAmount || 3000);
    const aclassMinOrders = Number(req.query.aclassMinOrders || 5);
    const analysisDate = String(req.query.analysisDate || "");
    const limit = clamp(req.query.limit, 200, 1, 2000);
    const offset = clamp(req.query.offset, 0, 0, 1_000_000);
    return executeProtectedQuery(
      req,
      res,
      {
        endpointName: "mobile_sleeping_summary",
        datasetId: req.params.datasetId,
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
      async () => {
        const result = await analyticsService.getSleepingAnalytics(req.params.datasetId, {
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
  });

  router.get("/datasets/:datasetId/orders/highest", async (req, res) => {
    if (!ensurePermission(req, res, "canViewRawRows")) return;
    const row = await analyticsService.getHighestOrder(req.params.datasetId, {
      filters: parseFilters(req.query, req.accessScope),
    });
    return res.json({ ok: true, row });
  });

  router.get("/datasets/:datasetId/orders/top", async (req, res) => {
    if (!ensurePermission(req, res, "canViewRawRows")) return;
    const rows = await analyticsService.getOrders(req.params.datasetId, {
      filters: parseFilters(req.query, req.accessScope),
      limit: clamp(req.query.limit, 20, 1, 500),
      offset: clamp(req.query.offset, 0, 0, 1_000_000),
    });
    return res.json({ ok: true, rows });
  });

  router.get("/datasets/:datasetId/leaders", async (req, res) => {
    if (!ensurePermission(req, res, "canViewTrendCharts")) return;
    const granularity = String(req.query.granularity || "month");
    const rows = await analyticsService.getLeadersByGranularity(req.params.datasetId, {
      granularity,
      filters: parseFilters(req.query, req.accessScope),
      limit: clamp(req.query.limit, 20, 1, 500),
    });
    return res.json({ ok: true, granularity, rows });
  });

  router.get("/datasets/:datasetId/table/:tableName", async (req, res) => {
    if (!ensurePermission(req, res, "canViewRawRows")) return;
    try {
      const data = await analyticsService.getTablePage(req.params.datasetId, req.params.tableName, {
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
    const preferredUserId = String(req.body?.testUserId || cfg?.recipients?.dingtalkTestUserId || env.dingtalkTestUserId || "");
    const result = await sendDingTalkTestWorkNotification({
      appKey: env.dingtalkAppKey,
      appSecret: env.dingtalkAppSecret,
      agentId: env.dingtalkAgentId,
      testUserId: preferredUserId,
      publicBaseUrl: env.publicBaseUrl,
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
    return res.json({
      ok: true,
      message: "已发送钉钉测试通知",
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
