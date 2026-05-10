import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

const MAX_ENTRIES = 5000;

/**
 * 持久化记录用户向内置 AI 发送的问题（及摘要结果），供后台调试。
 */
export class AiChatQueryLogStore {
  constructor({ logPath }) {
    this.logPath = logPath;
    this.entries = [];
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    try {
      const raw = await fs.readFile(this.logPath, "utf8");
      const parsed = JSON.parse(raw);
      this.entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch (_error) {
      this.entries = [];
    }
    this.ready = true;
  }

  async persist() {
    await fs.writeFile(
      this.logPath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          entries: this.entries,
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
      id: String(entry.id || randomUUID()),
      timestamp: String(entry.timestamp || new Date().toISOString()),
      userId: String(entry.userId || ""),
      username: String(entry.username || ""),
      conversationId: String(entry.conversationId || ""),
      message: String(entry.message || "").slice(0, 15000),
      model: String(entry.model || ""),
      salesContextPreview:
        entry.salesContextPreview && typeof entry.salesContextPreview === "object"
          ? entry.salesContextPreview
          : null,
      toolsUsed: Array.isArray(entry.toolsUsed) ? [...entry.toolsUsed] : [],
      toolSteps: Number(entry.toolSteps) || (Array.isArray(entry.toolsUsed) ? entry.toolsUsed.length : 0),
      replyPreview: String(entry.replyPreview || "").slice(0, 2000),
      usage: entry.usage && typeof entry.usage === "object" ? entry.usage : null,
      error: String(entry.error || "").slice(0, 1000),
      httpStatus: entry.httpStatus != null ? Number(entry.httpStatus) : null,
      durationMs: entry.durationMs != null ? Number(entry.durationMs) : null,
    };
    this.entries.unshift(record);
    this.entries = this.entries.slice(0, MAX_ENTRIES);
    await this.persist();
    return record;
  }

  async list({ limit = 100, offset = 0 } = {}) {
    await this.init();
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return {
      rows: this.entries.slice(safeOffset, safeOffset + safeLimit),
      total: this.entries.length,
      limit: safeLimit,
      offset: safeOffset,
    };
  }
}

/**
 * 在响应结束时写入一条监控记录；同一请求内可逐步填充 tools、回复摘要等字段。
 */
export function createAiChatQueryMonitor(res, store, baseFields) {
  const record = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    userId: String(baseFields.userId || ""),
    username: String(baseFields.username || ""),
    conversationId: String(baseFields.conversationId || ""),
    message: String(baseFields.message || "").slice(0, 15000),
    model: String(baseFields.model || ""),
    salesContextPreview:
      baseFields.salesContextPreview && typeof baseFields.salesContextPreview === "object"
        ? baseFields.salesContextPreview
        : null,
    toolsUsed: [],
    replyPreview: "",
    usage: null,
    error: "",
    httpStatus: null,
    durationMs: null,
    toolSteps: 0,
  };
  const started = Date.now();
  res.on("finish", () => {
    record.httpStatus = res.statusCode;
    record.durationMs = Date.now() - started;
    record.toolSteps = record.toolsUsed.length;
    void store.append(record).catch(() => {});
  });
  return {
    addTool(name) {
      const n = String(name || "").trim();
      if (n) record.toolsUsed.push(n);
    },
    setReplyPreview(text) {
      record.replyPreview = String(text || "").slice(0, 2000);
    },
    setUsage(u) {
      record.usage = u && typeof u === "object" ? u : null;
    },
    setError(msg) {
      if (msg) record.error = String(msg).slice(0, 1000);
    },
  };
}
