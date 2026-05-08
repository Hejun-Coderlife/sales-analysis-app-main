import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

function toIsoNow() {
  return new Date().toISOString();
}

function normalizeType(value) {
  const t = String(value || "").trim();
  if (t === "daily" || t === "warning") return t;
  return "test";
}

function normalizeStatus(value) {
  const s = String(value || "").trim();
  return s === "read" ? "read" : "unread";
}

export class NotificationStore {
  constructor({ notificationsPath }) {
    this.notificationsPath = notificationsPath;
    this.notifications = [];
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await fs.mkdir(path.dirname(this.notificationsPath), { recursive: true });
    try {
      const raw = await fs.readFile(this.notificationsPath, "utf8");
      const parsed = JSON.parse(raw);
      this.notifications = Array.isArray(parsed?.notifications) ? parsed.notifications : [];
    } catch (_error) {
      this.notifications = [];
    }
    this.ready = true;
  }

  async persist() {
    await fs.writeFile(
      this.notificationsPath,
      JSON.stringify(
        {
          updatedAt: toIsoNow(),
          notifications: this.notifications,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  async create({ userId = "", username = "", title = "", content = "", type = "test", link = "" } = {}) {
    await this.init();
    const record = {
      id: randomUUID(),
      userId: String(userId || ""),
      username: String(username || ""),
      title: String(title || ""),
      content: String(content || ""),
      type: normalizeType(type),
      status: "unread",
      createdAt: toIsoNow(),
      link: String(link || ""),
    };
    this.notifications.unshift(record);
    this.notifications = this.notifications.slice(0, 3000);
    await this.persist();
    return record;
  }

  async listForUser({ userId = "", username = "", limit = 50, offset = 0 } = {}) {
    await this.init();
    const uid = String(userId || "");
    const uname = String(username || "");
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = this.notifications.filter((n) => {
      if (uid && String(n.userId || "") === uid) return true;
      if (!uid && uname && String(n.username || "") === uname) return true;
      return false;
    });
    return {
      rows: rows.slice(safeOffset, safeOffset + safeLimit),
      total: rows.length,
      unread: rows.reduce((sum, n) => sum + (String(n.status || "") === "unread" ? 1 : 0), 0),
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  async markRead({ id, userId = "", username = "" } = {}) {
    await this.init();
    const uid = String(userId || "");
    const uname = String(username || "");
    const nid = String(id || "");
    const idx = this.notifications.findIndex((n) => String(n.id || "") === nid);
    if (idx < 0) return { ok: false, code: 404, message: "not found" };
    const cur = this.notifications[idx];
    const owned =
      (uid && String(cur.userId || "") === uid) || (!uid && uname && String(cur.username || "") === uname);
    if (!owned) return { ok: false, code: 403, message: "forbidden" };
    const next = { ...cur, status: normalizeStatus("read") };
    this.notifications[idx] = next;
    await this.persist();
    return { ok: true, notification: next };
  }
}

