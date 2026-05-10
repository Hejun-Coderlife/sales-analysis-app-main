import fs from "fs/promises";
import path from "path";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import seedUsers from "./seed-users.json" with { type: "json" };
import {
  buildPermissionScope,
  getRolePermissionTemplate,
  hasPermission,
  normalizeArray,
  normalizeRole,
  sanitizeUserWithPermissions,
  toPublicUser,
} from "./permissionModel.js";

const BCRYPT_ROUNDS = 10;

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
      this.users = Array.isArray(parsed?.users) ? parsed.users.map(sanitizeUserWithPermissions) : [];
    } catch (_error) {
      if (
        process.env.NODE_ENV === "production" &&
        String(process.env.ALLOW_SEED_USERS_IN_PROD || "").toLowerCase() !== "true"
      ) {
        throw new Error(
          "users.json is missing in production. Refusing to auto-seed demo users; set ALLOW_SEED_USERS_IN_PROD=true only for emergency bootstrap."
        );
      }
      this.users = seedUsers.map(sanitizeUserWithPermissions);
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

  /** 按钉钉 userid 查找已绑定用户（钉钉开放平台 userid，与用户表 dingtalkUserId 一致） */
  async findByDingTalkUserId(dingUserId) {
    await this.init();
    const key = String(dingUserId || "").trim();
    if (!key) return null;
    return (
      this.users.find((u) => {
        const ids = [
          String(u.dingtalkUserId || "").trim(),
          String(u.dingTalkUserId || "").trim(),
          String(u.dingUserId || "").trim(),
        ];
        return ids.includes(key);
      }) || null
    );
  }

  async hashPassword(password) {
    return bcrypt.hash(String(password || ""), BCRYPT_ROUNDS);
  }

  async authenticate(username, password) {
    const user = await this.findByUsername(username);
    if (!user) return { ok: false, error: "账号或密码错误" };
    if (!user.enabled || String(user.role || "") === "disabled") return { ok: false, error: "该账号已被停用" };
    const valid = await bcrypt.compare(String(password || ""), user.passwordHash);
    if (!valid) return { ok: false, error: "账号或密码错误" };
    await this.touchLastLogin(user.id);
    return { ok: true, user: toPublicUser(user) };
  }

  async createUser({
    username,
    displayName,
    role,
    password,
    enabled = true,
    allowedStores = [],
    allowAllStores,
    allowedSalespeople = [],
    allowAllSalespeople,
    allowedProducts = [],
    allowAllProducts,
    permissions = null,
    allowedMemberFields = null,
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
    const normalizedRole = normalizeRole(role);
    const roleDefaults = getRolePermissionTemplate(normalizedRole);
    const nowIso = new Date().toISOString();
    const record = sanitizeUserWithPermissions({
      id: randomUUID(),
      username: normalizedUsername,
      displayName: String(displayName || normalizedUsername),
      role: normalizedRole,
      enabled,
      passwordHash,
      allowedStores,
      allowAllStores,
      allowedSalespeople,
      allowAllSalespeople,
      allowedProducts,
      allowAllProducts,
      permissions: permissions && typeof permissions === "object" ? permissions : roleDefaults.permissions,
      allowedMemberFields:
        allowedMemberFields && typeof allowedMemberFields === "object"
          ? allowedMemberFields
          : roleDefaults.allowedMemberFields,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastLoginAt: "",
    });
    this.users.push(record);
    await this.persist();
    return toPublicUser(record);
  }

  async updateUser(userId, updates = {}) {
    await this.init();
    const user = await this.findById(userId);
    if (!user) throw new Error("用户不存在");
    const nextRole = updates.role != null ? normalizeRole(updates.role) : user.role;
    const applyRoleDefaults = Boolean(updates.applyRoleDefaults);
    const roleDefaults = getRolePermissionTemplate(nextRole);
    user.role = nextRole;
    if (updates.displayName != null) user.displayName = String(updates.displayName || "").trim();
    if (updates.enabled != null) user.enabled = Boolean(updates.enabled);
    if (nextRole === "disabled") user.enabled = false;
    if (updates.allowedStores != null) user.allowedStores = normalizeArray(updates.allowedStores);
    if (updates.allowAllStores != null) user.allowAllStores = Boolean(updates.allowAllStores);
    if (updates.allowedSalespeople != null) user.allowedSalespeople = normalizeArray(updates.allowedSalespeople);
    if (updates.allowAllSalespeople != null) user.allowAllSalespeople = Boolean(updates.allowAllSalespeople);
    if (updates.allowedProducts != null) user.allowedProducts = normalizeArray(updates.allowedProducts);
    if (updates.allowAllProducts != null) user.allowAllProducts = Boolean(updates.allowAllProducts);
    if (applyRoleDefaults) {
      user.permissions = { ...roleDefaults.permissions };
      user.allowedMemberFields = { ...roleDefaults.allowedMemberFields };
      user.allowAllStores = Boolean(roleDefaults.allowAllStores);
      user.allowAllSalespeople = Boolean(roleDefaults.allowAllSalespeople);
      user.allowAllProducts = Boolean(roleDefaults.allowAllProducts);
      if (nextRole === "admin") {
        user.allowedStores = [];
        user.allowedSalespeople = [];
        user.allowedProducts = [];
      }
    } else {
      if (updates.permissions && typeof updates.permissions === "object") {
        user.permissions = { ...(user.permissions || {}), ...updates.permissions };
      }
      if (updates.allowedMemberFields && typeof updates.allowedMemberFields === "object") {
        user.allowedMemberFields = { ...(user.allowedMemberFields || {}), ...updates.allowedMemberFields };
      }
    }
    user.updatedAt = new Date().toISOString();
    const normalized = sanitizeUserWithPermissions(user);
    Object.assign(user, normalized);
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
    user.updatedAt = new Date().toISOString();
    await this.persist();
    return toPublicUser(user);
  }

  async touchLastLogin(userId) {
    const user = await this.findById(userId);
    if (!user) return;
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async bindDingTalkUser(userId, dingtalkUserId) {
    await this.init();
    const user = await this.findById(userId);
    if (!user) throw new Error("用户不存在");
    const boundId = String(dingtalkUserId || "").trim();
    if (!boundId) throw new Error("钉钉用户ID不能为空");
    user.dingtalkUserId = boundId;
    user.dingtalkBoundAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();
    const normalized = sanitizeUserWithPermissions(user);
    Object.assign(user, normalized);
    await this.persist();
    return toPublicUser(user);
  }

  deriveAccessScope(user) {
    return buildPermissionScope(user);
  }

  hasPermission(user, permissionName) {
    return hasPermission(user, permissionName);
  }
}
