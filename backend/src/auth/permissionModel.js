const ROLE_SET = new Set(["admin", "manager", "store_user", "salesperson", "viewer", "disabled"]);

export const DASHBOARD_PERMISSION_KEYS = [
  "canViewDashboard",
  "canViewKpi",
  "canViewStoreRanking",
  "canViewSalespersonRanking",
  "canViewProductRanking",
  "canViewMemberAnalysis",
  "canViewSleepingMembers",
  "canViewTrendCharts",
  "canViewRepurchaseAnalysis",
  "canUseFilters",
  "canExportData",
  "canDownloadExcel",
  "canViewRawRows",
  "canViewDataQuality",
];

export const ADMIN_PERMISSION_KEYS = [
  "canAccessAdmin",
  "canManageUsers",
  "canCreateUsers",
  "canDisableUsers",
  "canResetPasswords",
  "canAssignRoles",
  "canAssignDataScopes",
  "canImportExcel",
  "canDeleteImportedData",
  "canViewImportHistory",
  "canViewAuditLogs",
  "canManageSystemSettings",
  "canManageAgentSettings",
  "canManageDingTalkSettings",
  "canManageBackups",
];

export const AGENT_PERMISSION_KEYS = [
  "canUseAgentChat",
  "canAskCompanyWideQuestions",
  "canAskStoreQuestions",
  "canAskSalespersonQuestions",
  "canAskMemberQuestions",
  "canAskSensitiveMemberQuestions",
  "canAskForExport",
  "canAskForRecommendations",
];

export const REMINDER_PERMISSION_KEYS = [
  "canReceiveDingTalkReminders",
  "canReceiveMemberMaintenanceReminders",
  "canReceiveStoreManagementReminders",
  "canReceiveSalespersonPerformanceReminders",
  "canReceiveSleepingMemberReminders",
  "canManageReminderRules",
  "canManageReminderRecipients",
];

export const MEMBER_FIELD_PERMISSION_KEYS = [
  "canViewMemberName",
  "canViewPhone",
  "canViewMemberId",
  "canViewBirthday",
  "canViewAddress",
];

export const ALL_PERMISSION_KEYS = [
  ...DASHBOARD_PERMISSION_KEYS,
  ...ADMIN_PERMISSION_KEYS,
  ...AGENT_PERMISSION_KEYS,
  ...REMINDER_PERMISSION_KEYS,
];

function toBool(value, fallback = false) {
  return value == null ? Boolean(fallback) : Boolean(value);
}

export function normalizeRole(rawRole) {
  const role = String(rawRole || "").trim();
  return ROLE_SET.has(role) ? role : "viewer";
}

export function normalizeArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map((x) => String(x || "").trim()).filter(Boolean);
}

function buildBooleanMap(keys, seed = false) {
  const out = {};
  keys.forEach((key) => {
    out[key] = Boolean(seed);
  });
  return out;
}

function adminTemplate() {
  return {
    enabled: true,
    allowAllStores: true,
    allowAllSalespeople: true,
    allowAllProducts: true,
    permissions: buildBooleanMap(ALL_PERMISSION_KEYS, true),
    allowedMemberFields: buildBooleanMap(MEMBER_FIELD_PERMISSION_KEYS, true),
  };
}

function managerTemplate() {
  const permissions = buildBooleanMap(ALL_PERMISSION_KEYS, false);
  [
    "canViewDashboard",
    "canViewKpi",
    "canViewStoreRanking",
    "canViewSalespersonRanking",
    "canViewProductRanking",
    "canViewMemberAnalysis",
    "canViewSleepingMembers",
    "canViewTrendCharts",
    "canViewRepurchaseAnalysis",
    "canUseFilters",
    "canViewDataQuality",
    "canUseAgentChat",
    "canAskStoreQuestions",
    "canAskSalespersonQuestions",
    "canAskMemberQuestions",
    "canAskForRecommendations",
    "canReceiveStoreManagementReminders",
    "canReceiveSalespersonPerformanceReminders",
    "canReceiveSleepingMemberReminders",
  ].forEach((key) => {
    permissions[key] = true;
  });
  const memberFields = buildBooleanMap(MEMBER_FIELD_PERMISSION_KEYS, false);
  memberFields.canViewMemberName = true;
  memberFields.canViewMemberId = true;
  return {
    enabled: true,
    allowAllStores: false,
    allowAllSalespeople: false,
    allowAllProducts: true,
    permissions,
    allowedMemberFields: memberFields,
  };
}

function storeUserTemplate() {
  const permissions = buildBooleanMap(ALL_PERMISSION_KEYS, false);
  [
    "canViewDashboard",
    "canViewKpi",
    "canViewStoreRanking",
    "canViewSalespersonRanking",
    "canViewProductRanking",
    "canViewMemberAnalysis",
    "canViewSleepingMembers",
    "canViewTrendCharts",
    "canViewRepurchaseAnalysis",
    "canUseFilters",
    "canUseAgentChat",
    "canAskStoreQuestions",
    "canAskSalespersonQuestions",
    "canAskMemberQuestions",
    "canAskForRecommendations",
    "canReceiveStoreManagementReminders",
    "canReceiveSleepingMemberReminders",
  ].forEach((key) => {
    permissions[key] = true;
  });
  const memberFields = buildBooleanMap(MEMBER_FIELD_PERMISSION_KEYS, false);
  memberFields.canViewMemberName = true;
  return {
    enabled: true,
    allowAllStores: false,
    allowAllSalespeople: false,
    allowAllProducts: true,
    permissions,
    allowedMemberFields: memberFields,
  };
}

function salespersonTemplate() {
  const permissions = buildBooleanMap(ALL_PERMISSION_KEYS, false);
  [
    "canViewDashboard",
    "canViewKpi",
    "canViewSalespersonRanking",
    "canViewProductRanking",
    "canViewMemberAnalysis",
    "canViewSleepingMembers",
    "canViewTrendCharts",
    "canUseFilters",
    "canUseAgentChat",
    "canAskSalespersonQuestions",
    "canAskMemberQuestions",
    "canAskForRecommendations",
    "canReceiveSalespersonPerformanceReminders",
    "canReceiveMemberMaintenanceReminders",
    "canReceiveSleepingMemberReminders",
  ].forEach((key) => {
    permissions[key] = true;
  });
  const memberFields = buildBooleanMap(MEMBER_FIELD_PERMISSION_KEYS, false);
  memberFields.canViewMemberName = true;
  return {
    enabled: true,
    allowAllStores: false,
    allowAllSalespeople: false,
    allowAllProducts: true,
    permissions,
    allowedMemberFields: memberFields,
  };
}

function viewerTemplate() {
  const permissions = buildBooleanMap(ALL_PERMISSION_KEYS, false);
  [
    "canViewDashboard",
    "canViewKpi",
    "canViewStoreRanking",
    "canViewSalespersonRanking",
    "canViewProductRanking",
    "canViewTrendCharts",
    "canUseFilters",
    "canUseAgentChat",
    "canAskStoreQuestions",
    "canAskSalespersonQuestions",
  ].forEach((key) => {
    permissions[key] = true;
  });
  const memberFields = buildBooleanMap(MEMBER_FIELD_PERMISSION_KEYS, false);
  return {
    enabled: true,
    allowAllStores: false,
    allowAllSalespeople: false,
    allowAllProducts: false,
    permissions,
    allowedMemberFields: memberFields,
  };
}

function disabledTemplate() {
  return {
    enabled: false,
    allowAllStores: false,
    allowAllSalespeople: false,
    allowAllProducts: false,
    permissions: buildBooleanMap(ALL_PERMISSION_KEYS, false),
    allowedMemberFields: buildBooleanMap(MEMBER_FIELD_PERMISSION_KEYS, false),
  };
}

export function getRolePermissionTemplate(roleInput) {
  const role = normalizeRole(roleInput);
  if (role === "admin") return adminTemplate();
  if (role === "manager") return managerTemplate();
  if (role === "store_user") return storeUserTemplate();
  if (role === "salesperson") return salespersonTemplate();
  if (role === "disabled") return disabledTemplate();
  return viewerTemplate();
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
    dingtalkUserId: String(user.dingtalkUserId || ""),
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
