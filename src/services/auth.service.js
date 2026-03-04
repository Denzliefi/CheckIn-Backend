// src/services/auth.service.js
const crypto = require("crypto");
const User = require("../models/User.model");
const { sendPasswordResetEmail, sendPasswordResetOtpEmail } = require("./mailer.service");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function getTokenTtlMinutes() {
  const v = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : 15;
}

function getMinIntervalSeconds() {
  const v = Number(process.env.PASSWORD_RESET_MIN_REQUEST_INTERVAL_SECONDS);
  return Number.isFinite(v) && v >= 0 ? v : 60;
}

function getOtpTtlMinutes() {
  const v = Number(process.env.PASSWORD_RESET_OTP_TTL_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : 10;
}

function getOtpMinIntervalSeconds() {
  const v = Number(process.env.PASSWORD_RESET_OTP_MIN_REQUEST_INTERVAL_SECONDS);
  return Number.isFinite(v) && v >= 0 ? v : 60;
}

function getOtpMaxAttempts() {
  const v = Number(process.env.PASSWORD_RESET_OTP_MAX_ATTEMPTS);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

function generateOtp6() {
  const num = crypto.randomInt(0, 1000000);
  return String(num).padStart(6, "0");
}

function clearOtpState(user) {
  user.passwordResetOtpHash = undefined;
  user.passwordResetOtpExpires = undefined;
  user.passwordResetOtpRequestedAt = undefined;
  user.passwordResetOtpVerifiedAt = undefined;
  user.passwordResetOtpAttempts = 0;
}

function clearResetTokenState(user) {
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpires = undefined;
  user.passwordResetRequestedAt = undefined;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Request a password reset.
 * - Controller returns generic message always.
 * - Only creates tokens for local accounts (has password).
 * - IMPORTANT FIX: clears OTP state whenever a new reset link is generated.
 */
async function requestPasswordReset(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return;

  const user = await User.findOne({ email: normalizedEmail }).select(
    "+password +passwordResetTokenHash +passwordResetExpires +passwordResetRequestedAt +passwordResetOtpHash +passwordResetOtpExpires +passwordResetOtpRequestedAt +passwordResetOtpVerifiedAt +passwordResetOtpAttempts"
  );

  if (!user) return;
  if (!user.password) return; // Google-only

  // throttle (per user)
  const minIntervalSec = getMinIntervalSeconds();
  if (minIntervalSec > 0 && user.passwordResetRequestedAt) {
    const diffMs = Date.now() - new Date(user.passwordResetRequestedAt).getTime();
    if (diffMs < minIntervalSec * 1000) return;
  }

  // Generate new token
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(rawToken);

  const ttlMinutes = getTokenTtlMinutes();
  user.passwordResetTokenHash = tokenHash;
  user.passwordResetExpires = new Date(Date.now() + ttlMinutes * 60 * 1000);
  user.passwordResetRequestedAt = new Date();

  // ✅ Critical: clear OTP state when creating a new reset link
  clearOtpState(user);

  await user.save();

  const clientUrl = String(process.env.CLIENT_URL || "").replace(/\/+$/, "");
  const resetUrl = `${clientUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;

  try {
    await sendPasswordResetEmail({
      to: user.email,
      name: user.fullName || user.firstName || "",
      resetUrl,
      ttlMinutes,
    });
  } catch (err) {
    console.error("MAIL_SEND_ERROR:", err);
  }
}

/**
 * Validate a reset token and return whether OTP is already verified (and still fresh).
 */
async function validatePasswordResetToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return { valid: false, otpVerified: false };

  const tokenHash = sha256Hex(raw);

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select(
    "+passwordResetOtpVerifiedAt +passwordResetOtpExpires"
  );

  if (!user) return { valid: false, otpVerified: false };

  const now = new Date();
  const otpVerified = Boolean(
    user.passwordResetOtpVerifiedAt && user.passwordResetOtpExpires && user.passwordResetOtpExpires > now
  );

  return { valid: true, otpVerified };
}

/**
 * Send (or resend) OTP for a valid reset token.
 * - Throttled by PASSWORD_RESET_OTP_MIN_REQUEST_INTERVAL_SECONDS.
 * - Resets otpVerifiedAt + attempts every time a new code is generated.
 */
async function sendPasswordResetOtp(token) {
  const raw = String(token || "").trim();
  if (!raw) throw new Error("Reset token is required.");

  const tokenHash = sha256Hex(raw);

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select(
    "+password +passwordResetOtpHash +passwordResetOtpExpires +passwordResetOtpRequestedAt +passwordResetOtpAttempts +passwordResetOtpVerifiedAt"
  );

  if (!user) throw new Error("Reset link is invalid or expired.");
  if (!user.password) throw new Error("This account uses Google sign-in. Please login with Google.");

  // throttle OTP requests
  const minIntervalSec = getOtpMinIntervalSeconds();
  if (minIntervalSec > 0 && user.passwordResetOtpRequestedAt) {
    const diffMs = Date.now() - new Date(user.passwordResetOtpRequestedAt).getTime();
    const remaining = Math.ceil((minIntervalSec * 1000 - diffMs) / 1000);
    if (remaining > 0) {
      return { sent: false, cooldownSeconds: remaining };
    }
  }

  const otp = generateOtp6();
  const otpHash = sha256Hex(otp);
  const ttlMinutes = getOtpTtlMinutes();

  user.passwordResetOtpHash = otpHash;
  user.passwordResetOtpExpires = new Date(Date.now() + ttlMinutes * 60 * 1000);
  user.passwordResetOtpRequestedAt = new Date();

  // ✅ Critical: if resending, force re-verify and reset attempts
  user.passwordResetOtpVerifiedAt = undefined;
  user.passwordResetOtpAttempts = 0;

  await user.save();

  await sendPasswordResetOtpEmail({
    to: user.email,
    name: user.fullName || user.firstName || "",
    otp,
    ttlMinutes,
  });

  return { sent: true, cooldownSeconds: minIntervalSec };
}

/**
 * Verify OTP for a valid reset token.
 */
async function verifyPasswordResetOtp({ token, otp }) {
  const rawToken = String(token || "").trim();
  const rawOtp = String(otp || "").trim();

  if (!rawToken) throw new Error("Reset token is required.");
  if (!/^[0-9]{6}$/.test(rawOtp)) throw new Error("OTP must be a 6-digit code.");

  const tokenHash = sha256Hex(rawToken);

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select(
    "+passwordResetOtpHash +passwordResetOtpExpires +passwordResetOtpAttempts +passwordResetOtpVerifiedAt"
  );

  if (!user) throw new Error("Reset link is invalid or expired.");

  if (!user.passwordResetOtpHash || !user.passwordResetOtpExpires) {
    throw new Error("OTP not requested. Please request a new code.");
  }

  const now = new Date();
  if (user.passwordResetOtpExpires <= now) {
    throw new Error("OTP expired. Please request a new code.");
  }

  const maxAttempts = getOtpMaxAttempts();
  const attempts = Number(user.passwordResetOtpAttempts || 0);
  if (attempts >= maxAttempts) {
    // lock out this code
    clearOtpState(user);
    await user.save();
    throw new Error("Too many incorrect attempts. Please request a new code.");
  }

  const otpHash = sha256Hex(rawOtp);
  if (otpHash !== user.passwordResetOtpHash) {
    user.passwordResetOtpAttempts = attempts + 1;
    await user.save();
    throw new Error("Invalid code. Please try again.");
  }

  user.passwordResetOtpVerifiedAt = new Date();
  // keep hash/expiry for freshness check during reset
  await user.save();

  return { verified: true };
}

/**
 * Reset password using token from email.
 * Requires OTP verified and not expired.
 * ✅ Fix: clears BOTH reset token + OTP state after success.
 */
async function resetPasswordWithToken({ token, newPassword }) {
  const raw = String(token || "").trim();
  const nextPass = String(newPassword || "");

  if (!raw) throw new Error("Reset token is required.");
  if (nextPass.length < 8) throw new Error("Password must be at least 8 characters.");

  const tokenHash = sha256Hex(raw);

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select(
    "+passwordResetTokenHash +passwordResetExpires +passwordResetRequestedAt +passwordResetOtpVerifiedAt +passwordResetOtpExpires"
  );

  if (!user) throw new Error("Reset link is invalid or expired.");

  // Require OTP
  if (!user.passwordResetOtpVerifiedAt) {
    throw new Error("Please verify the code sent to your email before changing your password.");
  }

  if (!user.passwordResetOtpExpires || user.passwordResetOtpExpires <= new Date()) {
    throw new Error("OTP expired. Please request a new code.");
  }

  user.password = nextPass; // pre-save hook will hash

  // clear all reset state
  clearResetTokenState(user);
  clearOtpState(user);

  await user.save();
}

module.exports = {
  requestPasswordReset,
  validatePasswordResetToken,
  // Backward-compatible alias
  validatePasswordResetTokenInfo: validatePasswordResetToken,
  sendPasswordResetOtp,
  verifyPasswordResetOtp,
  resetPasswordWithToken,
};
