function requireRole(...allowedRoles) {
  return (req, res, next) => {
    // because protect() sets req.user from DB
    const role = req.user?.role;

    if (!role) {
      res.status(403);
      return next(new Error("Access denied: no role assigned"));
    }

    // normalize optional (in case your DB role uses lowercase)
    const normalized = String(role).toLowerCase();
    const allowed = allowedRoles.map((r) => String(r).toLowerCase());

    if (!allowed.includes(normalized)) {
      res.status(403);
      return next(new Error("Access denied: insufficient role"));
    }

    next();
  };
}

module.exports = { requireRole };
