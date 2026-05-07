function ensureAuthActions() {
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

  actions.appendChild(adminLink);
  actions.appendChild(logout);
  row.appendChild(userText);
  row.appendChild(actions);
  top.insertAdjacentElement("afterend", row);
}

function applyRoleUi(role, user) {
  const roleMap = {
    admin: "管理员",
    manager: "经理",
    store_user: "门店用户",
    salesperson: "销售员",
  };
  const isAdmin = role === "admin";
  const uploadBox = document.querySelector(".upload-box");
  const uploadBoxFallback = document.getElementById("files")?.closest(".upload-box");
  const filesInput = document.getElementById("files");
  const filesLabel = document.querySelector('label[for="files"]');
  const uploadHint = uploadBox?.querySelector(".small");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const downloadBtn = document.getElementById("downloadSleepXlsxBtn");
  const analyzeWrap = analyzeBtn?.closest(".analyze-wrap");
  const controlButtons = document.querySelector(".button-group");
  const adminBtn = document.getElementById("authAdminBtn");
  const userLabel = document.getElementById("authUserLabel");
  if (userLabel) {
    userLabel.textContent = `${user.displayName || user.username}（${roleMap[role] || role}）`;
  }
  if (adminBtn) adminBtn.style.display = isAdmin ? "inline-flex" : "none";

  // Admin keeps import/analyze/download controls. Non-admin users only see filters/charts/tables/chat.
  if (uploadBox) uploadBox.style.display = isAdmin ? "" : "none";
  if (uploadBoxFallback) uploadBoxFallback.style.display = isAdmin ? "" : "none";
  if (controlButtons) controlButtons.style.display = isAdmin ? "" : "none";
  if (filesInput) filesInput.hidden = !isAdmin;
  if (filesLabel) filesLabel.hidden = !isAdmin;
  if (uploadHint) uploadHint.hidden = !isAdmin;
  if (analyzeWrap) analyzeWrap.style.display = isAdmin ? "" : "none";
  if (downloadBtn) downloadBtn.style.display = isAdmin ? "" : "none";

  if (!isAdmin && analyzeBtn) {
    analyzeBtn.disabled = true;
    analyzeBtn.title = "仅管理员可导入并执行分析";
  } else if (isAdmin && analyzeBtn) {
    analyzeBtn.disabled = false;
    analyzeBtn.title = "";
  }
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
