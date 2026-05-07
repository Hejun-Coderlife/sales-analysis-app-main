/** Allowed post-login paths for ?next= (open redirect hardening). */
export const LOGIN_REDIRECT_ALLOWLIST = new Set([
  "/dashboard",
  "/admin",
  "/mobile",
  "/mobile.html",
  "/index.html",
]);

export function safeLoginNextPath(raw) {
  const pathOnly = String(raw || "").split("?")[0].split("#")[0];
  if (!pathOnly.startsWith("/") || pathOnly.startsWith("//")) return "";
  return LOGIN_REDIRECT_ALLOWLIST.has(pathOnly) ? pathOnly : "";
}

export function createAuthMiddleware(authService) {
  const getCurrentUser = async (req) => {
    const sessionUser = req.session?.user;
    if (!sessionUser) return null;
    const userId = String(sessionUser.id || "").trim();
    if (!userId) return sessionUser;
    const latest = await authService.findById(userId);
    if (!latest) return null;
    const publicUser = {
      id: latest.id,
      username: latest.username,
      displayName: latest.displayName,
      role: latest.role,
      enabled: latest.enabled,
      permissions: latest.permissions,
      allowedStores: latest.allowedStores,
      allowAllStores: latest.allowAllStores,
      allowedSalespeople: latest.allowedSalespeople,
      allowAllSalespeople: latest.allowAllSalespeople,
      allowedProducts: latest.allowedProducts,
      allowAllProducts: latest.allowAllProducts,
      allowedMemberFields: latest.allowedMemberFields,
      createdAt: latest.createdAt,
      updatedAt: latest.updatedAt,
      lastLoginAt: latest.lastLoginAt,
    };
    req.session.user = publicUser;
    return publicUser;
  };

  const attachUserContext = async (req, res, asPage = false) => {
    const user = await getCurrentUser(req);
    if (!user) {
      if (asPage) {
        const nextPath = safeLoginNextPath(req.path || "");
        res.redirect(nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : "/login");
      } else {
        res.status(401).json({ error: "请先登录" });
      }
      return true;
    }
    if (!user.enabled || String(user.role || "") === "disabled") {
      await new Promise((resolve) => {
        if (req.session) {
          req.session.destroy(() => resolve());
        } else {
          resolve();
        }
      });
      if (asPage) {
        res.redirect("/login");
      } else {
        res.status(403).json({ error: "账号已停用" });
      }
      return true;
    }
    req.currentUser = user;
    req.accessScope = authService.deriveAccessScope(user);
    return false;
  };

  const requireAuthApi = async (req, res, next) => {
    if (await attachUserContext(req, res, false)) return;
    return next();
  };

  const requireAuthPage = async (req, res, next) => {
    if (await attachUserContext(req, res, true)) return;
    return next();
  };

  const requireRole = (...roles) => async (req, res, next) => {
    if (await attachUserContext(req, res, true)) return;
    const userRole = String(req.currentUser?.role || "");
    if (!roles.includes(userRole)) {
      res.status(403).send("无权限访问");
      return;
    }
    return next();
  };

  const requirePermission =
    (permissionName, { asPage = false } = {}) =>
    async (req, res, next) => {
      if (await attachUserContext(req, res, asPage)) return;
      if (!authService.hasPermission(req.currentUser, permissionName)) {
        if (asPage) {
          res.status(403).send("无权限访问");
        } else {
          res.status(403).json({ error: "无权限访问" });
        }
        return;
      }
      return next();
    };

  const requireAdmin = requirePermission("canAccessAdmin", { asPage: true });
  const requireAdminApi = requirePermission("canAccessAdmin");

  return {
    getCurrentUser,
    requireAuthApi,
    requireAuthPage,
    requireRole,
    requirePermission,
    requireAdmin,
    requireAdminApi,
  };
}

export function maskSensitiveMemberFields(row = {}, allowedMemberFields = {}) {
  const next = { ...row };
  if (!allowedMemberFields.canViewMemberName && "member_name" in next) next.member_name = "";
  if (!allowedMemberFields.canViewPhone && "phone" in next) next.phone = "";
  if (!allowedMemberFields.canViewMemberId) {
    if ("member_key" in next) next.member_key = "";
    if ("member_id" in next) next.member_id = "";
  }
  if (!allowedMemberFields.canViewBirthday && "birthday" in next) next.birthday = "";
  if (!allowedMemberFields.canViewAddress && "address" in next) next.address = "";
  return next;
}

export function maskSensitiveMemberRows(rows = [], allowedMemberFields = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => maskSensitiveMemberFields(row, allowedMemberFields));
}

export function denyPermissionMessage() {
  return "你没有权限查看该范围的数据。";
}

export function getNoDataPermissionMessage() {
  return "当前账号暂无可查看数据，请联系管理员配置权限。";
}

export function getModuleForbiddenMessage() {
  return "暂无权限查看此模块";
}

export function getPermissionDeniedPayload() {
  return { error: denyPermissionMessage() };
}

export function getPermissionDeniedApiResponse(res) {
  return res.status(403).json(getPermissionDeniedPayload());
}

export function canUserAccess(user, permissionName, authService) {
  return authService.hasPermission(user, permissionName);
}

export function withPermissionGuard(handler, permissionName, authService) {
  return async (req, res, next) => {
    if (!canUserAccess(req.currentUser, permissionName, authService)) {
      return getPermissionDeniedApiResponse(res);
    }
    return handler(req, res, next);
  };
}

export function buildPermissionScope(user, authService) {
  return authService.deriveAccessScope(user);
}

export function applyPermissionScopeToQuery(filters = {}, scope, permissionModelApplyScope) {
  return permissionModelApplyScope(filters, scope);
}

export function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: "请先登录" });
  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: "请先登录" });
  if (String(req.session.user.role || "") !== "admin") return res.status(403).json({ error: "无权限访问" });
    return next();
}
