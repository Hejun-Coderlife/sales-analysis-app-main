import fs from "fs/promises";
import path from "path";
import bcrypt from "bcryptjs";
import seedUsers from "./seed-users.json" with { type: "json" };

function normalizeArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map((x) => String(x || "").trim()).filter(Boolean);
}

function sanitizeUserRecord(user) {
  return {
    id: String(user?.id || ""),
    username: String(user?.username || "").trim().toLowerCase(),
    displayName: String(user?.displayName || ""),
    role: String(user?.role || "salesperson"),
    enabled: user?.enabled !== false,
    passwordHash: String(user?.passwordHash || ""),
    allowedStores: normalizeArray(user?.allowedStores),
    allowedSalespeople: normalizeArray(user?.allowedSalespeople),
  };
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    enabled: user.enabled,
    allowedStores: user.allowedStores,
    allowedSalespeople: user.allowedSalespeople,
  };
}

export class AuthService {
  constructor({ usersPath }) {
    this.usersPath = usersPath;
    this.users = [];
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.usersPath), { recursive: true });
    try {
      const raw = await fs.readFile(this.usersPath, "utf8");
      const parsed = JSON.parse(raw);
      this.users = Array.isArray(parsed?.users) ? parsed.users.map(sanitizeUserRecord) : [];
    } catch (_error) {
      this.users = seedUsers.map(sanitizeUserRecord);
      await this.persist();
    }
    this.loaded = true;
  }

  async persist() {
    await fs.writeFile(
      this.usersPath,
      JSON.stringify({ updatedAt: new Date().toISOString(), users: this.users }, null, 2),
      "utf8"
    );
  }

  async listUsers() {
    await this.init();
    return this.users.map(toPublicUser);
  }

  async findByUsername(username) {
    await this.init();
    const key = String(username || "").trim().toLowerCase();
    if (!key) return null;
    return this.users.find((x) => x.username === key) || null;
  }

  async authenticate(username, password) {
    const user = await this.findByUsername(username);
    if (!user) return { ok: false, error: "账号或密码错误" };
    if (!user.enabled) return { ok: false, error: "该账号已被停用" };
    const valid = await bcrypt.compare(String(password || ""), user.passwordHash);
    if (!valid) return { ok: false, error: "账号或密码错误" };
    return { ok: true, user: toPublicUser(user) };
  }

  deriveAccessScope(user) {
    const role = String(user?.role || "");
    if (!user || role === "admin") {
      return { role, allowedStores: [], allowedSalespeople: [], unrestricted: true };
    }
    const allowedStores = normalizeArray(user.allowedStores);
    const allowedSalespeople = normalizeArray(user.allowedSalespeople);
    return {
      role,
      allowedStores,
      allowedSalespeople,
      unrestricted: false,
    };
  }
}
