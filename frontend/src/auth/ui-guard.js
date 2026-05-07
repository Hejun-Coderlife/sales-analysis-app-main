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
  adminLink.textContent = "Admin";
  adminLink.addEventListener("click", () => {
    window.location.href = "/admin";
  });

  const logout = document.createElement("button");
  logout.id = "authLogoutBtn";
  logout.className = "light btn";
  logout.style.minHeight = "34px";
  logout.style.padding = "6px 10px";
  logout.textContent = "Logout";
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
  const isAdmin = role === "admin";
  const uploadBox = document.querySelector(".upload-box");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const adminBtn = document.getElementById("authAdminBtn");
  const userLabel = document.getElementById("authUserLabel");
  if (userLabel) {
    userLabel.textContent = `${user.displayName || user.username} (${role})`;
  }
  if (adminBtn) adminBtn.style.display = isAdmin ? "inline-flex" : "none";

  if (!isAdmin) {
    if (uploadBox) uploadBox.style.display = "none";
    if (analyzeBtn) {
      analyzeBtn.disabled = true;
      analyzeBtn.title = "Only admins can import/analyze files";
    }
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
