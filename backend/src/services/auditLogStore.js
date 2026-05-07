import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

export class AuditLogStore {
  constructor({ logPath }) {
    this.logPath = logPath;
    this.logs = [];
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    try {
      const raw = await fs.readFile(this.logPath, "utf8");
      const parsed = JSON.parse(raw);
      this.logs = Array.isArray(parsed?.logs) ? parsed.logs : [];
    } catch (_error) {
      this.logs = [];
    }
    this.ready = true;
  }

  async persist() {
    await fs.writeFile(
      this.logPath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          logs: this.logs,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  async append(entry = {}) {
    await this.init();
    const record = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      adminUsername: String(entry.adminUsername || ""),
      actionType: String(entry.actionType || "unknown"),
      targetType: String(entry.targetType || ""),
      targetId: String(entry.targetId || ""),
      summary: String(entry.summary || ""),
      meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {},
    };
    this.logs.unshift(record);
    this.logs = this.logs.slice(0, 3000);
    await this.persist();
    return record;
  }

  async list({ limit = 100, offset = 0 } = {}) {
    await this.init();
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return {
      rows: this.logs.slice(safeOffset, safeOffset + safeLimit),
      total: this.logs.length,
      limit: safeLimit,
      offset: safeOffset,
    };
  }
}
