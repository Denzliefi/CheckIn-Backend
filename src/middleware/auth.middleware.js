const jwt = require("jsonwebtoken");
const User = require("../models/User.model");

exports.protect = async (req, res, next) => {
  try {
    const auth = req.headers.authorization || "";

    // Expect: Authorization: Bearer <token>
    if (!auth.startsWith("Bearer ")) {
      res.status(401);
      throw new Error("Not authorized, no token");
    }

    const token = auth.split(" ")[1];
    if (!token) {
      res.status(401);
      throw new Error("Not authorized, no token");
    }

    // Must match your signToken() in auth.controller.js
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      res.status(500);
      throw new Error("Server misconfigured: JWT_SECRET missing");
    }

    const decoded = jwt.verify(token, secret);

    // Your payload is { id }
    if (!decoded?.id) {
      res.status(401);
      throw new Error("Not authorized, invalid token payload");
    }

    // Load fresh user from DB
    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      res.status(401);
      throw new Error("Not authorized, user not found");
    }

    req.user = user; // now req.user.id, req.user.role exist

    // ✅ Student lifecycle gate:
    // - pending/terminated students can stay logged in, but cannot access protected APIs
    //   (except GET /api/users/me which is used to show account status on the client).
    const role = String(user.role || "").trim().toLowerCase();
    const status = String(user.status || "active").trim().toLowerCase();

    if (role === "student" && status !== "active") {
      const isMe =
        req.method === "GET" &&
        String(req.baseUrl || "") === "/api/users" &&
        String(req.path || "") === "/me";

      if (!isMe) {
        const message =
          status === "pending"
            ? "account is pending please contact the guidance office for further clarifications"
            : "account is terminated please contact the guidance office for further clarifications";

        return res.status(403).json({
          code: status === "pending" ? "ACCOUNT_PENDING" : "ACCOUNT_TERMINATED",
          status,
          message,
        });
      }
    }

    next();
} catch (err) {
    console.error("PROTECT ERROR:", err?.message);

    const status = res.statusCode && res.statusCode !== 200 ? res.statusCode : 401;

    // If this middleware is ever invoked without a proper next() (rare, but it happens when middleware
    // is called manually), do NOT throw "next is not a function". Respond directly.
    if (res.headersSent) return;
    if (typeof next !== "function") {
      return res.status(status).json({ message: err?.message || "Not authorized" });
    }

    res.status(status);
    return next(err);
  }
};
