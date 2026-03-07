// backend/src/middleware/role.middleware.js
function requireRole(...allowedRoles) {
  const allowed = new Set(allowedRoles.map((r) => String(r || "").trim().toLowerCase()));

  return (req, res, next) => {
    const role = String(req.user?.role || "").trim().toLowerCase();

    if (!role) {
      return res.status(403).json({ message: "Access denied: no role assigned" });
    }

    if (!allowed.has(role)) {
      return res.status(403).json({ message: "Access denied: insufficient role" });
    }

    if (typeof next === "function") return next();
    // Extremely defensive fallback
    return res.status(500).json({ message: "Server error: middleware chain broken." });
  };
}

module.exports = { requireRole };
