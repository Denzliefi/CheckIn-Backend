// src/services/auth.service.js
const crypto = require("crypto");
const User = require("../models/User.model");
const { sendPasswordResetEmail } = require("./mailer.service");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function getTtlMinutes() {
  const v = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : 15;
}

function getMinIntervalSeconds() {
  const v = Number(process.env.PASSWORD_RESET_MIN_REQUEST_INTERVAL_SECONDS);
  return Number.isFinite(v) && v >= 0 ? v : 60;
}

/**
 * Request a password reset.
 * - Always "succeeds" from the caller POV (controller returns a generic message).
 * - Only creates tokens for local accounts that actually have a password.
 */
async function requestPasswordReset(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return;

  const user = await User.findOne({ email: normalizedEmail }).select(
    "+password +passwordResetTokenHash +passwordResetExpires +passwordResetRequestedAt"
  );

  // If user doesn't exist, do nothing (caller returns generic message)
  if (!user) return;

  // Google-only accounts (no password) => do nothing (caller returns generic message)
  if (!user.password) return;

  // Basic throttling per account
  const minIntervalSec = getMinIntervalSeconds();
  if (minIntervalSec > 0 && user.passwordResetRequestedAt) {
    const diffMs = Date.now() - new Date(user.passwordResetRequestedAt).getTime();
    if (diffMs < minIntervalSec * 1000) return;
  }

  const rawToken = crypto.randomBytes(32).toString("hex"); // 64 chars
  const tokenHash = sha256Hex(rawToken);

  const ttlMinutes = getTtlMinutes();
  user.passwordResetTokenHash = tokenHash;
  user.passwordResetExpires = new Date(Date.now() + ttlMinutes * 60 * 1000);
  user.passwordResetRequestedAt = new Date();

  // Save without touching password hashing
  await user.save();

  const clientUrl = String(process.env.CLIENT_URL || "").replace(/\/+$/, "");
  const resetUrl = `${clientUrl || ""}/reset-password?token=${encodeURIComponent(rawToken)}`;

  try {
    await sendPasswordResetEmail({
      to: user.email,
      name: user.fullName || user.firstName || "",
      resetUrl,
      ttlMinutes,
    });
  } catch (err) {
    // Do not crash reset flow if email fails; controller returns generic message anyway.
    console.error("MAIL_SEND_ERROR:", err);
  }
}

async function resetPasswordWithToken({ token, newPassword }) {
  const raw = String(token || "").trim();
  const nextPass = String(newPassword || "");

  if (!raw) throw new Error("Reset token is required.");
  if (nextPass.length < 8) throw new Error("Password must be at least 8 characters.");

  const tokenHash = sha256Hex(raw);

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select("+passwordResetTokenHash +passwordResetExpires +passwordResetRequestedAt");

  if (!user) throw new Error("Reset link is invalid or expired.");

  user.password = nextPass; // User model pre-save hook will hash
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpires = undefined;
  user.passwordResetRequestedAt = undefined;

  await user.save();
}

async function validatePasswordResetToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return false;

  const tokenHash = sha256Hex(raw);

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select("_id");

  return !!user;
}


module.exports = {
  requestPasswordReset,
  resetPasswordWithToken,
  validatePasswordResetToken,
};
