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
