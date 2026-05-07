import express from "express";
import multer from "multer";
import {
  applyPermissionScopeToFilters,
  hasPermission,
  maskSensitiveMemberRows,
} from "../auth/permissionModel.js";

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
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(1, maxUploadSizeMb) * 1024 * 1024 },
  });

  router.get("/health", (_req, res) => {
    res.json({ ok: true, service: "analytics-v2", now: new Date().toISOString() });
  });

  router.get("/datasets/latest", async (_req, res) => {
    if (!ensurePermission(_req, res, "canViewDashboard")) return;
    const dataset = await analyticsService.getLatestDatasetSummary({ onlyReady: true });
    return res.json({ ok: true, dataset: dataset || null });
  });

  router.post("/uploads", upload.single("file"), async (req, res) => {
    if (!hasPermission(req.currentUser, "canImportExcel")) {
      return res.status(403).json({ error: "仅管理员可上传或导入数据" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "file is required (multipart field name: file)" });
    }
    let overrides = {};
    try {
      overrides = req.body?.mapping ? JSON.parse(req.body.mapping) : {};
    } catch (_error) {
      return res.status(400).json({ error: "mapping must be valid JSON" });
    }

    const uploadedPath = await ingestionService.persistUploadBuffer(req.file);
    const importedBy = String(req.currentUser?.username || "");
    const job = await jobStore.createJob({
      type: "ingest",
      payload: {
        sourceName: req.file.originalname || "upload.xlsx",
        path: uploadedPath,
        importedBy,
      },
    });
    onImportEvent?.({
      adminUsername: importedBy,
      actionType: "import_excel",
      targetType: "file",
      targetId: req.file.originalname || "upload.xlsx",
      summary: `提交导入任务：${req.file.originalname || "upload.xlsx"}（job: ${job.id.slice(0, 8)}）`,
      meta: {
        jobId: job.id,
        filename: req.file.originalname || "upload.xlsx",
      },
    });

    jobQueue.enqueue(async () => {
      await jobStore.updateJob(job.id, { status: "running", progress: 5, error: null });
      try {
        const result = await ingestionService.ingestDataset({
          sourceName: req.file.originalname,
          filePath: uploadedPath,
          overrides,
          onProgress: async (progress, phase) => {
            await jobStore.updateJob(job.id, { progress, phase });
          },
        });
        await jobStore.updateJob(job.id, {
          status: "completed",
          progress: 100,
          datasetId: result.datasetId,
          stats: {
            rowCount: result.rowCount,
            mapping: result.mapping,
            validation: result.validation,
          },
          warnings: result.validation?.warnings || [],
        });
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

  router.get("/datasets/:datasetId/kpis", async (req, res) => {
    if (!ensurePermission(req, res, "canViewKpi")) return;
    const kpis = await analyticsService.getKpis(req.params.datasetId, parseFilters(req.query, req.accessScope));
    return res.json({ ok: true, kpis });
  });

  router.get("/datasets/:datasetId/rankings/stores", async (req, res) => {
    if (!ensurePermission(req, res, "canViewStoreRanking")) return;
    const rows = await analyticsService.getTopStores(req.params.datasetId, {
      filters: parseFilters(req.query, req.accessScope),
      limit: clamp(req.query.limit, 20, 1, 500),
      offset: clamp(req.query.offset, 0, 0, 1_000_000),
    });
    return res.json({ ok: true, rows });
  });

  router.get("/datasets/:datasetId/rankings/salespeople", async (req, res) => {
    if (!ensurePermission(req, res, "canViewSalespersonRanking")) return;
    const rows = await analyticsService.getTopSalespeople(req.params.datasetId, {
      filters: parseFilters(req.query, req.accessScope),
      limit: clamp(req.query.limit, 20, 1, 500),
      offset: clamp(req.query.offset, 0, 0, 1_000_000),
    });
    return res.json({ ok: true, rows });
  });

  router.get("/datasets/:datasetId/rankings/products", async (req, res) => {
    if (!ensurePermission(req, res, "canViewProductRanking")) return;
    const rows = await analyticsService.getTopProducts(req.params.datasetId, {
      filters: parseFilters(req.query, req.accessScope),
      limit: clamp(req.query.limit, 20, 1, 500),
      offset: clamp(req.query.offset, 0, 0, 1_000_000),
    });
    return res.json({ ok: true, rows });
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
    const options = await analyticsService.getFilterOptions(req.params.datasetId, {
      filters: parseFilters(req.query, req.accessScope),
    });
    return res.json({ ok: true, options });
  });

  router.get("/datasets/:datasetId/trends", async (req, res) => {
    if (!ensurePermission(req, res, "canViewTrendCharts")) return;
    const trends = await analyticsService.getTrendSeries(req.params.datasetId, {
      filters: parseFilters(req.query, req.accessScope),
    });
    return res.json({ ok: true, ...trends });
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
    const result = await analyticsService.getSleepingAnalytics(req.params.datasetId, {
      filters: parseFilters(req.query, req.accessScope),
      sleepDays: Number(req.query.sleepDays || 90),
      sleepMinOrders: Number(req.query.sleepMinOrders || 2),
      sleepMinAmount: Number(req.query.sleepMinAmount || 1000),
      aclassMinAmount: Number(req.query.aclassMinAmount || 3000),
      aclassMinOrders: Number(req.query.aclassMinOrders || 5),
      analysisDate: String(req.query.analysisDate || ""),
      limit: clamp(req.query.limit, 200, 1, 2000),
      offset: clamp(req.query.offset, 0, 0, 1_000_000),
    });
    return res.json({
      ok: true,
      ...result,
      rows: maskSensitiveMemberRows(result.rows, req.currentUser?.allowedMemberFields || {}),
    });
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
