export function createAuthMiddleware(authService) {
  const requireAuthApi = (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: "请先登录" });
    req.currentUser = req.session.user;
    req.accessScope = authService.deriveAccessScope(req.currentUser);
    return next();
  };

  const requireAuthPage = (req, res, next) => {
    if (!req.session?.user) return res.redirect("/login");
    req.currentUser = req.session.user;
    req.accessScope = authService.deriveAccessScope(req.currentUser);
    return next();
  };

  const requireRole = (...roles) => (req, res, next) => {
    if (!req.session?.user) return res.redirect("/login");
    const userRole = String(req.session.user?.role || "");
    if (!roles.includes(userRole)) return res.status(403).send("无权限访问");
    req.currentUser = req.session.user;
    req.accessScope = authService.deriveAccessScope(req.currentUser);
    return next();
  };

  return { requireAuthApi, requireAuthPage, requireRole };
}
