import { ALL_PERMISSION_KEYS, MEMBER_FIELD_PERMISSION_KEYS } from "./permissionConstants.js";

/** 固定内置岗位 id（与历史 users.role 对齐）。自定义岗位另行注册。 */
export const BUILTIN_ROLE_IDS = ["admin", "manager", "store_user", "salesperson", "viewer", "disabled"];
export const BUILTIN_ROLE_SET = new Set(BUILTIN_ROLE_IDS);

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

/**
 * Returns a deep clone suitable for assigning to JSON / custom snapshots.
 */
export function cloneRoleTemplate(roleId) {
  const base = getBuiltinRoleTemplate(roleId);
  return JSON.parse(JSON.stringify(base));
}

export function getBuiltinRoleTemplate(roleInput) {
  const role = String(roleInput || "").trim();
  if (role === "admin") return adminTemplate();
  if (role === "manager") return managerTemplate();
  if (role === "store_user") return storeUserTemplate();
  if (role === "salesperson") return salespersonTemplate();
  if (role === "disabled") return disabledTemplate();
  return viewerTemplate();
}

export function isBuiltinRoleId(roleId) {
  return BUILTIN_ROLE_SET.has(String(roleId || "").trim());
}
