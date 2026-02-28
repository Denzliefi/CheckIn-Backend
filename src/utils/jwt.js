// src/utils/jwt.js
const jwt = require("jsonwebtoken");

function signJwt(payload, options = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is missing in environment variables.");
  const expiresIn = options.expiresIn || process.env.JWT_EXPIRES_IN || "30d";
  return jwt.sign(payload, secret, { expiresIn });
}

function verifyJwt(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is missing in environment variables.");
  return jwt.verify(token, secret);
}

module.exports = {
  signJwt,
  verifyJwt,
};
