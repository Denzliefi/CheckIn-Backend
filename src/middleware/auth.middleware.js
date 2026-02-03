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

    // Your payload is { id, role }
    if (!decoded?.id) {
      res.status(401);
      throw new Error("Not authorized, invalid token payload");
    }

    // Load fresh user from DB (so req.user is a real user doc)
    const user = await User.findById(decoded.id).select("-passwordHash");
    if (!user) {
      res.status(401);
      throw new Error("Not authorized, user not found");
    }

    req.user = user; // now req.user.id, req.user.role exist
    next();
  } catch (err) {
    console.error("PROTECT ERROR:", err?.message);
    res.status(res.statusCode && res.statusCode !== 200 ? res.statusCode : 401);
    next(err);
  }
};
