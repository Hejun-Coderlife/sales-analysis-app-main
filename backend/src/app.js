import { env } from "./config/env.js";
import { DuckDBService } from "./services/duckdbService.js";
import { JobStore } from "./services/jobStore.js";
import { JobQueue } from "./services/jobQueue.js";
import { IngestionService } from "./services/ingestionService.js";
import { QueryCache } from "./services/queryCache.js";
import { AnalyticsService } from "./services/analyticsService.js";
import { createV2Router } from "./routes/v2.js";

const duckdbService = new DuckDBService({ duckdbPath: env.duckdbPath });
const jobStore = new JobStore({ jobsPath: env.jobsPath });
const jobQueue = new JobQueue();
const queryCache = new QueryCache({ ttlMs: env.cacheTtlMs });
const ingestionService = new IngestionService({
  duckdbService,
  uploadsDir: env.uploadsDir,
});
const analyticsService = new AnalyticsService({
  duckdbService,
  queryCache,
  cacheTtlMs: env.cacheTtlMs,
});

export async function initV2AnalyticsModule() {
  await duckdbService.ensureSchema();
  await jobStore.init();
}

export function getV2Router() {
  return createV2Router({
    ingestionService,
    analyticsService,
    jobStore,
    jobQueue,
    maxUploadSizeMb: env.maxUploadSizeMb,
  });
}

export function getV2Services() {
  return {
    analyticsService,
    jobStore,
  };
}
