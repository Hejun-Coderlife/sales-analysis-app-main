import {
  ALL_PERMISSION_KEYS,
  DASHBOARD_PERMISSION_KEYS,
  ADMIN_PERMISSION_KEYS,
  AGENT_PERMISSION_KEYS,
  REMINDER_PERMISSION_KEYS,
  MEMBER_FIELD_PERMISSION_KEYS,
} from "./permissionConstants.js";
import { getBuiltinRoleTemplate, BUILTIN_ROLE_SET } from "./roleTemplates.js";
import { getRoleCatalogTemplateIfAny } from "../services/roleCatalogStore.js";

export {
  DASHBOARD_PERMISSION_KEYS,
  ADMIN_PERMISSION_KEYS,
  AGENT_PERMISSION_KEYS,
  REMINDER_PERMISSION_KEYS,
  MEMBER_FIELD_PERMISSION_KEYS,
  ALL_PERMISSION_KEYS,
} from "./permissionConstants.js";

export { BUILTIN_ROLE_IDS, BUILTIN_ROLE_SET, cloneRoleTemplate, getBuiltinRoleTemplate } from "./roleTemplates.js";

/** 与 role-catalog.json 中 kind=custom 的 id 同步；由服务端在目录加载/变更后写入。 */
let customRoleValidity = new Set();

export function syncCustomRolesFromCatalog(customIds = []) {
  customRoleValidity = new Set((Array.isArray(customIds) ? customIds : []).map((x) => String(x || "").trim()).filter(Boolean));
}

function toBool(value, fallback = false) {
  return value == null ? Boolean(fallback) : Boolean(value);
}

export function normalizeRole(rawRole) {
  const role = String(rawRole || "").trim();
  if (!role) return "viewer";
  if (BUILTIN_ROLE_SET.has(role)) return role;
  if (customRoleValidity.has(role)) return role;
  return "viewer";
}

export function normalizeArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map((x) => String(x || "").trim()).filter(Boolean);
}

export function cloneTemplate(template) {
  return JSON.parse(JSON.stringify(template));
}

/** 在未做 normalizeRole 误判前，解析已定义的岗位 id（用于管理端展示）。 */
export function getRolePermissionTemplateByDefinedId(roleIdRaw) {
  const id = String(roleIdRaw || "").trim();
  if (!id) return getBuiltinRoleTemplate("viewer");
  const stored = getRoleCatalogTemplateIfAny(id);
  if (stored) return cloneTemplate(stored);
  return getBuiltinRoleTemplate(id);
}

export function getRolePermissionTemplate(roleInput) {
  const role = normalizeRole(roleInput);
  const stored = getRoleCatalogTemplateIfAny(role);
  if (stored) return cloneTemplate(stored);
  return getBuiltinRoleTemplate(role);
}

export function mergePermissions(role, userPermissions = {}, fallback = {}) {
  const template = getRolePermissionTemplate(role);
  const base = { ...template.permissions, ...fallback };
  const output = {};
  ALL_PERMISSION_KEYS.forEach((key) => {
    output[key] = toBool(userPermissions?.[key], base[key]);
  });
  return output;
}

export function mergeMemberFieldPermissions(role, allowedMemberFields = {}, fallback = {}) {
  const template = getRolePermissionTemplate(role);
  const base = { ...template.allowedMemberFields, ...fallback };
  const output = {};
  MEMBER_FIELD_PERMISSION_KEYS.forEach((key) => {
    output[key] = toBool(allowedMemberFields?.[key], base[key]);
  });
  return output;
}

export function sanitizeUserWithPermissions(user = {}) {
  const role = normalizeRole(user.role);
  const template = getRolePermissionTemplate(role);
  const createdAt = String(user.createdAt || new Date().toISOString());
  return {
    id: String(user.id || ""),
    username: String(user.username || "").trim().toLowerCase(),
    displayName: String(user.displayName || ""),
    role,
    enabled: role === "disabled" ? false : toBool(user.enabled, template.enabled),
    passwordHash: String(user.passwordHash || ""),
    allowedStores: normalizeArray(user.allowedStores),
    allowAllStores: toBool(user.allowAllStores, template.allowAllStores),
    allowedSalespeople: normalizeArray(user.allowedSalespeople),
    allowAllSalespeople: toBool(user.allowAllSalespeople, template.allowAllSalespeople),
    allowedProducts: normalizeArray(user.allowedProducts),
    allowAllProducts: toBool(user.allowAllProducts, template.allowAllProducts),
    permissions: mergePermissions(role, user.permissions),
    allowedMemberFields: mergeMemberFieldPermissions(role, user.allowedMemberFields),
    createdAt,
    updatedAt: String(user.updatedAt || createdAt),
    lastLoginAt: String(user.lastLoginAt || ""),
    dingtalkUserId: String(user.dingtalkUserId || user.dingTalkUserId || user.dingUserId || "").trim(),
    dingtalkBoundAt: String(user.dingtalkBoundAt || ""),
  };
}

export function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    enabled: user.enabled,
    permissions: user.permissions,
    allowedStores: user.allowedStores,
    allowAllStores: user.allowAllStores,
    allowedSalespeople: user.allowedSalespeople,
    allowAllSalespeople: user.allowAllSalespeople,
    allowedProducts: user.allowedProducts,
    allowAllProducts: user.allowAllProducts,
    allowedMemberFields: user.allowedMemberFields,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    dingtalkUserId: user.dingtalkUserId || "",
    dingtalkBoundAt: user.dingtalkBoundAt || "",
  };
}

function intersectAllowed(requested, allowed, allowAll) {
  if (allowAll) return Array.isArray(requested) ? requested : [];
  if (!Array.isArray(allowed) || !allowed.length) return [];
  if (!Array.isArray(requested) || !requested.length) return allowed.slice();
  const allowSet = new Set(allowed);
  return requested.filter((item) => allowSet.has(item));
}

/**
 * Derives server-side data scope for `/api/v2`, AI tools (`agentDatasetToolsService`), and synced chat context.
 *
 * - **全库（字面全集团）:** 仅 **`admin`** → `unrestricted: true`，可看库里全部门店/销售员/商品。
 * - **非管理员:** 在账号配置的 `allowAll*` / `allowedStores` / `allowedSalespeople` / `allowedProducts` 内，
 *   可取到**该范围内的一切订单与指标**（例如管辖多店时，即这些店里的全部数据，不是“抽一部分”）。
 * - **`canAskCompanyWideQuestions`:** 允许在对话中使用「全公司/整体」等表述（见 `server.js` `/api/chat` 关键字），
 *   汇总口径仍以**本人数据范围**为准；与上一条一致，不是额外缩小取数。
 * - **No scope configured:** `forceNoData: true`。
 */
export function buildPermissionScope(user) {
  if (!user) {
    return {
      unrestricted: false,
      role: "",
      forceNoData: true,
      allowAllStores: false,
      allowAllSalespeople: false,
      allowAllProducts: false,
      allowedStores: [],
      allowedSalespeople: [],
      allowedProducts: [],
    };
  }
  const role = normalizeRole(user.role);
  if (role === "admin") {
    return {
      unrestricted: true,
      role,
      forceNoData: false,
      allowAllStores: true,
      allowAllSalespeople: true,
      allowAllProducts: true,
      allowedStores: [],
      allowedSalespeople: [],
      allowedProducts: [],
    };
  }
  const allowAllStores = Boolean(user.allowAllStores);
  const allowAllSalespeople = Boolean(user.allowAllSalespeople);
  const allowAllProducts = Boolean(user.allowAllProducts);
  const allowedStores = normalizeArray(user.allowedStores);
  const allowedSalespeople = normalizeArray(user.allowedSalespeople);
  const allowedProducts = normalizeArray(user.allowedProducts);
  const hasAnyScope =
    allowAllStores ||
    allowAllSalespeople ||
    allowAllProducts ||
    allowedStores.length > 0 ||
    allowedSalespeople.length > 0 ||
    allowedProducts.length > 0;
  return {
    unrestricted: false,
    role,
    forceNoData: !hasAnyScope,
    allowAllStores,
    allowAllSalespeople,
    allowAllProducts,
    allowedStores,
    allowedSalespeople,
    allowedProducts,
  };
}

export function applyPermissionScopeToFilters(filters = {}, scope = null) {
  const normalized = {
    startDate: String(filters.startDate || ""),
    endDate: String(filters.endDate || ""),
    stores: normalizeArray(filters.stores),
    salespeople: normalizeArray(filters.salespeople),
    products: normalizeArray(filters.products),
  };
  if (!scope || scope.unrestricted) return normalized;
  if (scope.forceNoData) {
    return {
      ...normalized,
      stores: ["__NO_ACCESS_STORE__"],
      salespeople: ["__NO_ACCESS_SALESPERSON__"],
      products: ["__NO_ACCESS_PRODUCT__"],
    };
  }
  return {
    ...normalized,
    stores: intersectAllowed(normalized.stores, scope.allowedStores, scope.allowAllStores),
    salespeople: intersectAllowed(normalized.salespeople, scope.allowedSalespeople, scope.allowAllSalespeople),
    products: intersectAllowed(normalized.products, scope.allowedProducts, scope.allowAllProducts),
  };
}

export function hasPermission(user, permissionName) {
  if (!user || !permissionName) return false;
  const role = normalizeRole(user.role);
  if (role === "admin") return true;
  return Boolean(user.permissions?.[permissionName]);
}

export function maskSensitiveMemberFields(row, allowedMemberFields = {}) {
  const next = { ...(row || {}) };
  if (!allowedMemberFields.canViewMemberName) {
    if ("member_name" in next) next.member_name = "";
  }
  if (!allowedMemberFields.canViewPhone) {
    if ("phone" in next) next.phone = "";
  }
  if (!allowedMemberFields.canViewMemberId) {
    if ("member_key" in next) next.member_key = "";
    if ("member_id" in next) next.member_id = "";
  }
  if (!allowedMemberFields.canViewBirthday && "birthday" in next) {
    next.birthday = "";
  }
  if (!allowedMemberFields.canViewAddress && "address" in next) {
    next.address = "";
  }
  return next;
}

export function maskSensitiveMemberRows(rows = [], allowedMemberFields = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows.map((row) => maskSensitiveMemberFields(row, allowedMemberFields));
}

/** 中间四位掩码：全角星号，避免半角 * 在 Markdown/表格里被吃掉后变成「1890972」七位拼接 */
const PHONE_MASK_MID = "\uFF0A\uFF0A\uFF0A\uFF0A";

/** 11 位大陆手机号脱敏：前三位 + 中间四位掩码 + 后四位，例如 189＊＊＊＊0972 */
export function maskPhoneDigitsForDisplay(rawPhone) {
  const compact = String(rawPhone ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^\+86/, "");
  if (/^1[3-9]\d{9}$/.test(compact)) {
    return `${compact.slice(0, 3)}${PHONE_MASK_MID}${compact.slice(-4)}`;
  }
  const digits = compact.replace(/\D/g, "");
  if (/^1[3-9]\d{9}$/.test(digits)) {
    return `${digits.slice(0, 3)}${PHONE_MASK_MID}${digits.slice(-4)}`;
  }
  return compact ? "\uFF0A\uFF0A\uFF0A" : "";
}

/**
 * 任意文本中脱敏 11 位大陆手机号（含 +86 前缀），用于 member_key 拼接或 AI 最终回复兜底。
 * 使用「非数字边界」避免误伤更长数字串中的子串；若需更严可再收紧。
 */
export function redactMainlandMobilesInText(text) {
  let s = String(text ?? "");
  s = s.replace(/(?<![0-9])\+?86[-\s]?1[3-9]\d{9}(?![0-9])/g, (m) => {
    const tail = m.replace(/\D/g, "").slice(-11);
    return /^1[3-9]\d{9}$/.test(tail) ? maskPhoneDigitsForDisplay(tail) : PHONE_MASK_MID;
  });
  // 常见分段：180 6906 7789、180-6906-7789
  s = s.replace(/\b(1[3-9]\d[\s\-]*\d{4}[\s\-]*\d{4})\b/g, (m) => {
    const tail = m.replace(/\D/g, "");
    return /^1[3-9]\d{9}$/.test(tail) ? maskPhoneDigitsForDisplay(tail) : m;
  });
  s = s.replace(/(?<![0-9])1[3-9]\d{9}(?![0-9])/g, (m) => maskPhoneDigitsForDisplay(m));
  return s;
}

/**
 * 写入 AI 多轮对话前对工具 JSON 再扫一遍：防止 DuckDB/汇总字段以数字或非标准字段名带出完整手机号。
 */
export function deepSanitizeAgentToolPayload(value, depth = 0) {
  if (depth > 18) return value;
  if (value == null) return value;
  const t = typeof value;
  if (t === "bigint") {
    const s = value.toString();
    return /^1[3-9]\d{9}$/.test(s) ? maskPhoneDigitsForDisplay(s) : value;
  }
  if (t === "number") {
    if (!Number.isFinite(value)) return value;
    const s = String(Math.trunc(value));
    if (/^1[3-9]\d{9}$/.test(s)) return maskPhoneDigitsForDisplay(s);
    return value;
  }
  if (t === "string") {
    return redactMainlandMobilesInText(value);
  }
  if (t !== "object") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((x) => deepSanitizeAgentToolPayload(x, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = deepSanitizeAgentToolPayload(v, depth + 1);
  }
  return out;
}

/**
 * 数据集工具返回给内置 AI 的会员行：先按字段权限脱敏，再**始终**对手机号类字段做展示级脱敏，
 * 避免即使用户有「查看手机号」权限也在对话里泄露完整号码。
 */
export function finalizeMemberRowsForAgentTools(rows = [], allowedMemberFields = {}) {
  const base = maskSensitiveMemberRows(rows, allowedMemberFields);
  return base.map((row) => {
    const r = { ...row };
    if ("phone" in r && r.phone) {
      r.phone = maskPhoneDigitsForDisplay(String(r.phone));
    }
    if ("member_key" in r && r.member_key) {
      r.member_key = redactMainlandMobilesInText(String(r.member_key));
    }
    if ("member_id" in r && r.member_id) {
      const mid = String(r.member_id).trim();
      const d = mid.replace(/\D/g, "");
      if (/^1[3-9]\d{9}$/.test(d)) {
        r.member_id = maskPhoneDigitsForDisplay(d);
      }
    }
    return r;
  });
}
