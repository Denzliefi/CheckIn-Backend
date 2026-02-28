// src/utils/hash.js
const bcrypt = require("bcryptjs");

async function hashPassword(plain) {
  const p = String(plain || "");
  if (!p) throw new Error("Password is required.");
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(p, salt);
}

async function comparePassword(plain, hashed) {
  return bcrypt.compare(String(plain || ""), String(hashed || ""));
}

module.exports = {
  hashPassword,
  comparePassword,
};
