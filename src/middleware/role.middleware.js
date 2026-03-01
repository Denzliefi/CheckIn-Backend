// backend/src/middleware/role.middleware.js
function requireRole(...allowedRoles) {
  const allowed = new Set(allowedRoles.map((r) => String(r || "").trim().toLowerCase()));

  return (req, res, next) => {
    const role = String(req.user?.role || "").trim().toLowerCase();

    if (!role) {
      res.status(403);
      return next(new Error("Access denied: no role assigned"));
    }

    if (!allowed.has(role)) {
      res.status(403);
      return next(new Error("Access denied: insufficient role"));
    }

    return next();
  };
}

module.exports = { requireRole };
