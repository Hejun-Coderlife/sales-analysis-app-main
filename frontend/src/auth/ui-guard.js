import { setHtml } from "../dom/safe-dom.js";

function ensureMobileLinkForDashboardToolbar() {
  if (document.getElementById("authMobileDashBtn")) return;
  const host = document.querySelector(".toolbar-meta-right");
  if (!host) return;
  const mobileLink = document.createElement("a");
  mobileLink.id = "authMobileDashBtn";
  mobileLink.href = "/mobile";
  mobileLink.className = "toolbar-action-btn";
  mobileLink.style.textDecoration = "none";
  mobileLink.style.display = "none";
  mobileLink.textContent = "手机看板";
  host.insertBefore(mobileLink, host.firstChild);
  function syncMobileEntryVisibility() {
    const narrow = window.matchMedia("(max-width: 768px)").matches;
    const ua = /Mobile|Android|iPhone|iPad|DingTalk/i.test(navigator.userAgent || "");
    mobileLink.style.display = narrow || ua ? "inline-flex" : "none";
  }
  syncMobileEntryVisibility();
  window.addEventListener("resize", syncMobileEntryVisibility);
}

function ensureAuthActions() {
  if (document.getElementById("dashboardAdminBtn")) {
    ensureMobileLinkForDashboardToolbar();
    return;
  }
  if (document.getElementById("authLogoutBtn")) return;
  const top = document.querySelector(".wrap h1");
  if (!top) return;
  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.justifyContent = "space-between";
  row.style.alignItems = "center";
  row.style.gap = "12px";
  row.style.marginBottom = "6px";

  const userText = document.createElement("div");
  userText.id = "authUserLabel";
  userText.style.fontSize = "12px";
  userText.style.color = "#4b5563";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";
  actions.style.flexWrap = "wrap";

  const mobileLink = document.createElement("a");
  mobileLink.id = "authMobileDashBtn";
  mobileLink.href = "/mobile";
  mobileLink.className = "light btn";
  mobileLink.style.minHeight = "34px";
  mobileLink.style.padding = "6px 10px";
  mobileLink.style.display = "none";
  mobileLink.textContent = "打开手机版看板";

  const adminLink = document.createElement("button");
  adminLink.id = "authAdminBtn";
  adminLink.className = "light btn";
  adminLink.style.minHeight = "34px";
  adminLink.style.padding = "6px 10px";
  adminLink.textContent = "管理后台";
  adminLink.addEventListener("click", () => {
    window.location.href = "/admin";
  });

  const logout = document.createElement("button");
  logout.id = "authLogoutBtn";
  logout.className = "light btn";
  logout.style.minHeight = "34px";
  logout.style.padding = "6px 10px";
  logout.textContent = "退出登录";
  logout.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  });

  actions.appendChild(mobileLink);
  actions.appendChild(adminLink);
  actions.appendChild(logout);
  row.appendChild(userText);
  row.appendChild(actions);
  top.insertAdjacentElement("afterend", row);

  function syncMobileEntryVisibility() {
    const btn = document.getElementById("authMobileDashBtn");
    if (!btn) return;
    const narrow = window.matchMedia("(max-width: 768px)").matches;
    const ua = /Mobile|Android|iPhone|iPad|DingTalk/i.test(navigator.userAgent || "");
    btn.style.display = narrow || ua ? "inline-flex" : "none";
  }
  syncMobileEntryVisibility();
  window.addEventListener("resize", syncMobileEntryVisibility);
}

function applyRoleUi(role, user) {
  const roleMap = {
    admin: "管理员",
    manager: "经理",
    store_user: "门店用户",
    salesperson: "销售员",
    viewer: "查看者",
    disabled: "停用账号",
  };
  const permissions = user?.permissions || {};
  const isAdmin = role === "admin";
  const canAccessAdmin = isAdmin || Boolean(permissions.canAccessAdmin);
  const canImportExcel = canAccessAdmin && Boolean(permissions.canImportExcel);
  const canDownloadExcel = Boolean(permissions.canDownloadExcel);
  const canUseFilters = Boolean(permissions.canUseFilters);
  const canViewKpi = Boolean(permissions.canViewKpi);
  const uploadBox = document.querySelector(".upload-box");
  const uploadBoxFallback = document.getElementById("files")?.closest(".upload-box");
  const filesInput = document.getElementById("files");
  const filesLabel = document.querySelector('label[for="files"]');
  const uploadHint = uploadBox?.querySelector(".small");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const downloadBtn = document.getElementById("downloadSleepXlsxBtn");
  const analyzeWrap = analyzeBtn?.closest(".analyze-wrap");
  const controlButtons = document.querySelector(".button-group");
  const adminBtn = document.getElementById("authAdminBtn") || document.getElementById("dashboardAdminBtn");
  const userLabel = document.getElementById("authUserLabel");
  const dashUserVal = document.getElementById("dashboardCurrentUserVal");
  if (userLabel) {
    userLabel.textContent = `${user.displayName || user.username}（${roleMap[role] || role}）`;
  }
  if (dashUserVal) {
    while (dashUserVal.firstChild) dashUserVal.removeChild(dashUserVal.firstChild);
    const nameSpan = document.createElement("span");
    nameSpan.className = "toolbar-user-value";
    nameSpan.textContent = user.displayName || user.username || "--";
    dashUserVal.appendChild(nameSpan);
    const roleSpan = document.createElement("span");
    roleSpan.className = "toolbar-sub-cn";
    roleSpan.textContent = `（${roleMap[role] || role}）`;
    dashUserVal.appendChild(roleSpan);
  }
  /* 显示/隐藏交给 CSS（.toolbar-action-btn），避免仅「管理后台」被设成 inline-flex 与「退出登录」不齐 */
  if (adminBtn) adminBtn.style.display = canAccessAdmin ? "" : "none";

  // Import/analyze/download must always follow backend permissions, not role name only.
  if (uploadBox) uploadBox.style.display = canImportExcel ? "" : "none";
  if (uploadBoxFallback) uploadBoxFallback.style.display = canImportExcel ? "" : "none";
  if (controlButtons) controlButtons.style.display = canImportExcel || canDownloadExcel ? "" : "none";
  if (filesInput) filesInput.hidden = !canImportExcel;
  if (filesLabel) filesLabel.hidden = !canImportExcel;
  if (uploadHint) uploadHint.hidden = !canImportExcel;
  if (analyzeWrap) analyzeWrap.style.display = canImportExcel ? "" : "none";
  if (downloadBtn) downloadBtn.style.display = canDownloadExcel ? "" : "none";

  if (!canImportExcel && analyzeBtn) {
    analyzeBtn.disabled = true;
    analyzeBtn.title = "仅管理员可导入并执行分析";
  } else if (analyzeBtn) {
    analyzeBtn.disabled = false;
    analyzeBtn.title = "";
  }

  // Respect module-level permissions on dashboard tabs.
  const tabRules = {
    dashboard: Boolean(permissions.canViewDashboard),
    rankings:
      Boolean(permissions.canViewStoreRanking) ||
      Boolean(permissions.canViewSalespersonRanking) ||
      Boolean(permissions.canViewProductRanking),
    members: Boolean(permissions.canViewMemberAnalysis),
    sleeping: Boolean(permissions.canViewSleepingMembers),
    validation: Boolean(permissions.canViewDataQuality),
  };
  document.querySelectorAll(".tab").forEach((tabEl) => {
    const tabKey = tabEl.dataset.tab;
    const allowed = tabRules[tabKey] !== false;
    tabEl.style.display = allowed ? "" : "none";
    const panel = tabKey ? document.getElementById(tabKey) : null;
    if (panel && !allowed) {
      setHtml(panel, '<div class="card"><p class="small">暂无权限查看此模块</p></div>');
      panel.classList.add("hidden");
    }
  });

  const firstVisibleTab = document.querySelector(".tab:not([style*='display: none'])");
  if (firstVisibleTab) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    firstVisibleTab.classList.add("active");
    const panel = document.getElementById(firstVisibleTab.dataset.tab || "dashboard");
    panel?.classList.remove("hidden");
  }

  const kpiGrid = document.querySelector("#resultArea .grid.grid-4");
  if (kpiGrid) {
    kpiGrid.style.display = canViewKpi ? "" : "none";
    if (!canViewKpi) {
      const parent = kpiGrid.parentElement;
      if (parent && !parent.querySelector(".kpi-permission-tip")) {
        const tip = document.createElement("p");
        tip.className = "small kpi-permission-tip";
        tip.textContent = "暂无权限查看此模块";
        parent.insertBefore(tip, kpiGrid.nextSibling);
      }
    }
  }

  const filterFields = document.querySelectorAll(".control-field[data-control='dashboardDateRange'], .control-field[data-control='dashboardMultiFilters']");
  filterFields.forEach((el) => {
    el.style.display = canUseFilters ? "" : "none";
  });
}

export async function initAuthUiGuard() {
  ensureAuthActions();
  const response = await fetch("/api/auth/me");
  if (!response.ok) {
    window.location.href = "/login";
    return null;
  }
  const data = await response.json();
  const user = data?.user || null;
  if (!user) {
    window.location.href = "/login";
    return null;
  }
  window.__CURRENT_USER = user;
  applyRoleUi(String(user.role || ""), user);
  return user;
}
