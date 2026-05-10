import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { getBuiltinRoleTemplate, isBuiltinRoleId } from "../auth/roleTemplates.js";
import { ALL_PERMISSION_KEYS, MEMBER_FIELD_PERMISSION_KEYS } from "../auth/permissionConstants.js";

const ROLE_SLUG_SAFE = /^[a-z][a-z0-9_-]{2,62}$/;

/** 内置岗位默认展示文案（可被运营在后台改写 label/description） */
const BUILTIN_META_DEFAULTS = [
  {
    id: "admin",
    label: "管理员",
    description: "系统最高权限岗位，默认全量范围。",
    scopePresetLabel: "总部",
    enabledBadge: true,
  },
  {
    id: "manager",
    label: "经理",
    description: "适合店长/区域负责人，默认具备经营分析能力。",
    scopePresetLabel: "总部",
    enabledBadge: true,
  },
  {
    id: "store_user",
    label: "门店用户",
    description: "门店运营岗位，聚焦门店分析与执行。",
    scopePresetLabel: "受限范围",
    enabledBadge: true,
  },
  {
    id: "salesperson",
    label: "销售员",
    description: "销售岗位，聚焦个人/团队销售表现。",
    scopePresetLabel: "受限范围",
    enabledBadge: true,
  },
  {
    id: "viewer",
    label: "查看者",
    description: "只读查看岗位，适合汇报查看。",
    scopePresetLabel: "系统预设",
    enabledBadge: true,
  },
  {
    id: "disabled",
    label: "停用",
    description: "停用岗位，不可登录使用。",
    scopePresetLabel: "系统预设",
    enabledBadge: false,
  },
];

function deepClone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}

function stripAutoUnrestrictedFromTemplate(tpl) {
  const t = deepClone(tpl);
  if (!t || typeof t !== "object") return t;
  t.allowAllStores = false;
  t.allowAllSalespeople = false;
  t.allowAllProducts = false;
  return t;
}

let storePath = "";
/** @type {{ version: number, roles: Array<Record<string, unknown>> } | null} */
let catalogState = null;

function defaultCatalogJson() {
  return {
    version: 1,
    roles: BUILTIN_META_DEFAULTS.map((x) => ({
      id: x.id,
      kind: "builtin",
      label: x.label,
      description: x.description,
      scopePresetLabel: x.scopePresetLabel,
      enabledBadge: x.enabledBadge,
    })),
  };
}

function mergeBuiltinDefaults(state) {
  const byId = new Map((state.roles || []).map((r) => [String(r.id || ""), r]));
  for (const d of BUILTIN_META_DEFAULTS) {
    if (!byId.has(d.id)) {
      byId.set(d.id, {
        id: d.id,
        kind: "builtin",
        label: d.label,
        description: d.description,
        scopePresetLabel: d.scopePresetLabel,
        enabledBadge: d.enabledBadge,
      });
    } else {
      const cur = byId.get(d.id);
      if (String(cur.kind || "") !== "builtin") {
        cur.kind = "builtin";
      }
      cur.id = d.id;
      if (cur.label == null || !String(cur.label).trim()) cur.label = d.label;
      if (cur.description == null) cur.description = d.description;
      if (cur.scopePresetLabel == null) cur.scopePresetLabel = d.scopePresetLabel;
      if (cur.enabledBadge == null) cur.enabledBadge = d.enabledBadge;
    }
  }
  const order = BUILTIN_META_DEFAULTS.map((x) => x.id);
  const rest = [...byId.keys()].filter((id) => !order.includes(id));
  state.roles = [...order, ...rest.sort()].map((id) => byId.get(id)).filter(Boolean);
}

/**
 * @returns {Map<string, Record<string, unknown>>}
 */
function customTemplateById() {
  const m = new Map();
  for (const r of catalogState?.roles || []) {
    if (String(r.kind || "") === "custom" && r.template && typeof r.template === "object") {
      m.set(String(r.id || ""), /** @type {Record<string, unknown>} */ (r.template));
    }
  }
  return m;
}

/** 供 permissionModel：岗位目录中若存在 template，则覆盖代码内置默认（内置/自定义均可，管理员岗除外由接口层禁止写入）。 */
export function getRoleCatalogTemplateIfAny(roleId) {
  const id = String(roleId || "").trim();
  if (!id || !catalogState) return null;
  const entry = getRoleCatalogEntry(id);
  if (!entry?.template || typeof entry.template !== "object") return null;
  return /** @type {Record<string, unknown>} */ (entry.template);
}

/** 供 permissionModel 在未 init 前安全调用（自定义岗；与 getRoleCatalogTemplateIfAny 等价路径保留兼容） */
export function getStoredCustomRoleTemplate(roleId) {
  const id = String(roleId || "").trim();
  if (!id || !catalogState) return null;
  return customTemplateById().get(id) || null;
}

export function listCustomRoleIdsLoaded() {
  if (!catalogState) return [];
  return (catalogState.roles || [])
    .filter((r) => String(r.kind || "") === "custom")
    .map((r) => String(r.id || ""))
    .filter(Boolean);
}

export async function initRoleCatalog(dataDir) {
  storePath = path.resolve(dataDir, "role-catalog.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  try {
    const raw = await fs.readFile(storePath, "utf8");
    catalogState = JSON.parse(raw);
    if (!catalogState || !Array.isArray(catalogState.roles)) {
      catalogState = defaultCatalogJson();
    }
  } catch (_e) {
    catalogState = defaultCatalogJson();
  }
  mergeBuiltinDefaults(catalogState);
  await persistRoleCatalog();
}

export async function persistRoleCatalog() {
  if (!storePath || !catalogState) return;
  await fs.writeFile(storePath, JSON.stringify(catalogState, null, 2), "utf8");
}

export function getRoleCatalogForApi() {
  const roles = (catalogState?.roles || []).map((r) => {
    const row = { ...r };
    delete row.template;
    return row;
  });
  return { version: catalogState?.version || 1, roles };
}

export function getRoleCatalogEntry(roleId) {
  const id = String(roleId || "").trim();
  return (catalogState?.roles || []).find((r) => String(r.id || "") === id) || null;
}

export function isRoleDefinitionKnown(roleId) {
  const id = String(roleId || "").trim();
  if (!id) return false;
  if (isBuiltinRoleId(id)) return true;
  return !!getRoleCatalogEntry(id);
}

/**
 * 校验并合并写入岗位目录中的权限模板（非 admin）。
 * admin 必须由代码固定，避免出现「弱化管理员锁死后台」的配置事故。
 */
function buildTemplateFromInput(roleId, input) {
  if (!input || typeof input !== "object") throw new Error("权限模板格式无效");
  const id = String(roleId || "").trim();
  if (id === "admin") throw new Error("管理员岗位权限模板不可写入目录");
  const baseSeed = isBuiltinRoleId(id) ? id : "viewer";
  const base = /** @type {Record<string, any>} */ (deepClone(getBuiltinRoleTemplate(baseSeed)));
  const inPerms = input.permissions && typeof input.permissions === "object" ? input.permissions : {};
  const inMem = input.allowedMemberFields && typeof input.allowedMemberFields === "object" ? input.allowedMemberFields : {};
  ALL_PERMISSION_KEYS.forEach((k) => {
    base.permissions[k] = Boolean(inPerms[k]);
  });
  MEMBER_FIELD_PERMISSION_KEYS.forEach((k) => {
    base.allowedMemberFields[k] = Boolean(inMem[k]);
  });
  base.enabled = input.enabled !== false;
  base.allowAllStores = false;
  base.allowAllSalespeople = false;
  base.allowAllProducts = false;
  return base;
}

/**
 * @param {{ label?: string, description?: string, scopePresetLabel?: string, template?: object }} partial
 */
export async function patchRoleCatalogEntry(roleId, partial = {}) {
  const id = String(roleId || "").trim();
  const entry = getRoleCatalogEntry(id);
  if (!entry) throw new Error("岗位不存在");
  if ("template" in partial && partial.template != null && typeof partial.template === "object") {
    entry.template = buildTemplateFromInput(id, partial.template);
  }
  if (partial.label != null) entry.label = String(partial.label || "").trim();
  if (partial.description != null) entry.description = String(partial.description || "").trim();
  if (partial.scopePresetLabel != null) entry.scopePresetLabel = String(partial.scopePresetLabel || "").trim();
  catalogState.updatedAt = new Date().toISOString();
  await persistRoleCatalog();
  return getRoleCatalogForApi();
}

export async function updateRoleMetadata(roleId, opts = {}) {
  return patchRoleCatalogEntry(roleId, {
    label: opts.label,
    description: opts.description,
    scopePresetLabel: opts.scopePresetLabel,
  });
}

/**
 * @param {{ label: string, description?: string, cloneFromRoleId: string, id?: string, template: object }} body
 */
export async function createCustomRole(body) {
  const cloneFrom = String(body?.cloneFromRoleId || "").trim();
  if (!cloneFrom) {
    throw new Error("请选择「参考岗位」以复制默认权限");
  }
  if (cloneFrom === "admin") {
    throw new Error("不可基于「管理员」创建自定义岗位（安全限制）");
  }
  const tpl = body?.template;
  if (!tpl || typeof tpl !== "object") throw new Error("岗位权限模板无效");
  const template = stripAutoUnrestrictedFromTemplate(tpl);

  const label = String(body?.label || "").trim();
  if (!label) throw new Error("岗位名称不能为空");

  let slug = String(body?.id || "")
    .trim()
    .toLowerCase();
  if (slug) {
    if (!ROLE_SLUG_SAFE.test(slug)) {
      throw new Error("岗位代号仅支持小写字母开头、3-63 位，含小写字母数字、连字符与下划线");
    }
    if (isBuiltinRoleId(slug)) throw new Error("该代号为系统内置岗位，不可用");
    if (getRoleCatalogEntry(slug)) throw new Error("该岗位代号已存在");
  } else {
    slug = `role_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  }

  const cloneEntry = getRoleCatalogEntry(cloneFrom);
  const roleRow = {
    id: slug,
    kind: "custom",
    label,
    description: String(body?.description || "").trim(),
    cloneFromRoleId: cloneFrom,
    scopePresetLabel: "参考 " + (cloneEntry?.label || cloneFrom),
    enabledBadge: cloneFrom !== "disabled",
    template,
  };
  catalogState.roles.push(roleRow);
  catalogState.updatedAt = new Date().toISOString();
  await persistRoleCatalog();
  return roleRow;
}

export async function deleteCustomRole(roleId, { authService } = {}) {
  const id = String(roleId || "").trim();
  if (!id) throw new Error("缺少岗位 id");
  if (isBuiltinRoleId(id)) throw new Error("系统内置岗位不可删除");
  const entry = getRoleCatalogEntry(id);
  if (!entry) throw new Error("岗位不存在");
  if (String(entry.kind || "") !== "custom") throw new Error("仅自定义岗位可删除");
  if (authService) {
    const users = await authService.listUsers();
    if (users.some((u) => String(u.role || "") === id)) {
      throw new Error("仍有员工使用该岗位，请先改为其它岗位后再删除");
    }
  }
  catalogState.roles = catalogState.roles.filter((r) => String(r.id || "") !== id);
  catalogState.updatedAt = new Date().toISOString();
  await persistRoleCatalog();
}
