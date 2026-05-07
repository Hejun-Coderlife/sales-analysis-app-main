import fs from "fs/promises";
import path from "path";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import seedUsers from "./seed-users.json" with { type: "json" };

const USER_ROLES = new Set(["admin", "manager", "store_user", "salesperson"]);
const BCRYPT_ROUNDS = 10;

function normalizeArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map((x) => String(x || "").trim()).filter(Boolean);
}

function sanitizeRole(role) {
  const key = String(role || "").trim();
  return USER_ROLES.has(key) ? key : "salesperson";
}

function sanitizeUserRecord(user) {
  return {
    id: String(user?.id || ""),
    username: String(user?.username || "").trim().toLowerCase(),
    displayName: String(user?.displayName || ""),
    role: sanitizeRole(user?.role),
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

  async findById(userId) {
    await this.init();
    const key = String(userId || "").trim();
    if (!key) return null;
    return this.users.find((x) => x.id === key) || null;
  }

  async hashPassword(password) {
    return bcrypt.hash(String(password || ""), BCRYPT_ROUNDS);
  }

  async authenticate(username, password) {
    const user = await this.findByUsername(username);
    if (!user) return { ok: false, error: "账号或密码错误" };
    if (!user.enabled) return { ok: false, error: "该账号已被停用" };
    const valid = await bcrypt.compare(String(password || ""), user.passwordHash);
    if (!valid) return { ok: false, error: "账号或密码错误" };
    return { ok: true, user: toPublicUser(user) };
  }

  async createUser({
    username,
    displayName,
    role,
    password,
    enabled = true,
    allowedStores = [],
    allowedSalespeople = [],
  }) {
    await this.init();
    const normalizedUsername = String(username || "").trim().toLowerCase();
    if (!normalizedUsername) throw new Error("账号不能为空");
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(normalizedUsername)) {
      throw new Error("账号格式不合法（仅支持字母、数字、._-，长度 3-64）");
    }
    if (await this.findByUsername(normalizedUsername)) throw new Error("账号已存在");
    const rawPassword = String(password || "");
    if (rawPassword.length < 8) throw new Error("密码至少 8 位");
    const passwordHash = await this.hashPassword(rawPassword);
    const record = sanitizeUserRecord({
      id: randomUUID(),
      username: normalizedUsername,
      displayName: String(displayName || normalizedUsername),
      role,
      enabled,
      passwordHash,
      allowedStores,
      allowedSalespeople,
    });
    this.users.push(record);
    await this.persist();
    return toPublicUser(record);
  }

  async updateUser(userId, updates = {}) {
    await this.init();
    const user = await this.findById(userId);
    if (!user) throw new Error("用户不存在");
    if (updates.role != null) user.role = sanitizeRole(updates.role);
    if (updates.displayName != null) user.displayName = String(updates.displayName || "").trim();
    if (updates.enabled != null) user.enabled = Boolean(updates.enabled);
    if (updates.allowedStores != null) user.allowedStores = normalizeArray(updates.allowedStores);
    if (updates.allowedSalespeople != null) user.allowedSalespeople = normalizeArray(updates.allowedSalespeople);
    await this.persist();
    return toPublicUser(user);
  }

  async resetPassword(userId, newPassword) {
    await this.init();
    const user = await this.findById(userId);
    if (!user) throw new Error("用户不存在");
    const rawPassword = String(newPassword || "");
    if (rawPassword.length < 8) throw new Error("密码至少 8 位");
    user.passwordHash = await this.hashPassword(rawPassword);
    await this.persist();
    return toPublicUser(user);
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
      forceNoData: !allowedStores.length && !allowedSalespeople.length,
      unrestricted: false,
    };
  }
}
