import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

export class JobStore {
  constructor({ jobsPath }) {
    this.jobsPath = jobsPath;
    this.jobs = new Map();
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await fs.mkdir(path.dirname(this.jobsPath), { recursive: true });
    try {
      const raw = await fs.readFile(this.jobsPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.jobs)) {
        for (const job of parsed.jobs) {
          if (job?.id) this.jobs.set(job.id, job);
        }
      }
    } catch (_error) {
      // First boot can legitimately have no persisted jobs.
    }
    this.ready = true;
  }

  async persist() {
    const payload = {
      updatedAt: new Date().toISOString(),
      jobs: [...this.jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    };
    await fs.writeFile(this.jobsPath, JSON.stringify(payload, null, 2), "utf8");
  }

  async createJob(meta = {}) {
    await this.init();
    const now = new Date().toISOString();
    const id = randomUUID();
    const job = {
      id,
      type: meta.type || "ingest",
      status: "queued",
      progress: 0,
      createdAt: now,
      updatedAt: now,
      datasetId: null,
      error: null,
      warnings: [],
      stats: {},
      payload: meta.payload || {},
    };
    this.jobs.set(id, job);
    await this.persist();
    return job;
  }

  async updateJob(id, patch) {
    await this.init();
    const prev = this.jobs.get(id);
    if (!prev) return null;
    const next = {
      ...prev,
      ...(patch || {}),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(id, next);
    await this.persist();
    return next;
  }

  async getJob(id) {
    await this.init();
    return this.jobs.get(id) || null;
  }

  async listJobs({ type = "", limit = 100, offset = 0 } = {}) {
    await this.init();
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const key = String(type || "").trim();
    const rows = [...this.jobs.values()]
      .filter((job) => (!key ? true : String(job.type || "") === key))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return {
      rows: rows.slice(safeOffset, safeOffset + safeLimit),
      total: rows.length,
      limit: safeLimit,
      offset: safeOffset,
    };
  }
}
