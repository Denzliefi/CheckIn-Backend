// src/services/auth.service.js
const crypto = require("crypto");
const User = require("../models/User.model");
const { sendPasswordResetEmail, sendPasswordResetOtpEmail } = require("./mailer.service");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function getTtlMinutes() {
  const v = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : 15;
}


function getOtpTtlMinutes() {
  const n = parseInt(process.env.PASSWORD_RESET_OTP_TTL_MINUTES || "10", 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

function getOtpMinIntervalSeconds() {
  const n = parseInt(process.env.PASSWORD_RESET_OTP_MIN_REQUEST_INTERVAL_SECONDS || "60", 10);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

function getOtpMaxAttempts() {
  const n = parseInt(process.env.PASSWORD_RESET_OTP_MAX_ATTEMPTS || "5", 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function generateOtp6() {
  // crypto-strong 6-digit code
  const num = crypto.randomInt(0, 1000000);
  return String(num).padStart(6, "0");
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
  }).select("+passwordResetTokenHash +passwordResetExpires +passwordResetRequestedAt +passwordResetOtpVerifiedAt +passwordResetOtpExpires +passwordResetOtpHash +passwordResetOtpRequestedAt +passwordResetOtpAttempts");

  if (!user) throw new Error("Reset link is invalid or expired.");

  
  // Require OTP verification before allowing password reset
  if (!user.passwordResetOtpVerifiedAt) {
    throw new Error("Please verify the code sent to your email before changing your password.");
  }
  if (user.passwordResetOtpExpires && user.passwordResetOtpExpires <= new Date()) {
    throw new Error("OTP expired. Please request a new code.");
  }
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



/**
 * Sends a 6-digit OTP to the email associated with a valid reset token.
 * Throttled by PASSWORD_RESET_OTP_MIN_REQUEST_INTERVAL_SECONDS.
 */
async function sendPasswordResetOtp(token) {
  const raw = String(token || "").trim();
  if (!raw) throw new Error("Reset token is required.");

  const tokenHash = sha256Hex(raw);

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select(
    "+password +passwordResetTokenHash +passwordResetExpires +passwordResetRequestedAt +passwordResetOtpHash +passwordResetOtpExpires +passwordResetOtpRequestedAt +passwordResetOtpAttempts +passwordResetOtpVerifiedAt"
  );

  if (!user) throw new Error("Reset link is invalid or expired.");

  // Google-only accounts (no password) => do nothing
  if (!user.password) throw new Error("This account uses Google sign-in. Please login with Google.");

  const minIntervalSec = getOtpMinIntervalSeconds();
  if (minIntervalSec > 0 && user.passwordResetOtpRequestedAt) {
    const diffMs = Date.now() - new Date(user.passwordResetOtpRequestedAt).getTime();
    const remaining = Math.ceil((minIntervalSec * 1000 - diffMs) / 1000);
    if (remaining > 0) {
      return { cooldownSeconds: remaining, sent: false };
    }
  }

  const otp = generateOtp6();
  const otpHash = sha256Hex(otp);
  const ttlMinutes = getOtpTtlMinutes();

  user.passwordResetOtpHash = otpHash;
  user.passwordResetOtpExpires = new Date(Date.now() + ttlMinutes * 60 * 1000);
  user.passwordResetOtpRequestedAt = new Date();
  user.passwordResetOtpAttempts = 0;
  user.passwordResetOtpVerifiedAt = undefined;

  await user.save();

  await sendPasswordResetOtpEmail({
    to: user.email,
    name: user.fullName || user.firstName || "",
    otp,
    ttlMinutes,
  });

  return { cooldownSeconds: minIntervalSec, sent: true };
}

/**
 * Verifies OTP for a valid reset token. On success, marks OTP as verified.
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
    "+passwordResetOtpHash +passwordResetOtpExpires +passwordResetOtpRequestedAt +passwordResetOtpAttempts +passwordResetOtpVerifiedAt"
  );

  if (!user) throw new Error("Reset link is invalid or expired.");

  const now = new Date();

  if (!user.passwordResetOtpHash || !user.passwordResetOtpExpires) {
    throw new Error("OTP not requested. Please request a new code.");
  }

  if (user.passwordResetOtpExpires <= now) {
    throw new Error("OTP expired. Please request a new code.");
  }

  const maxAttempts = getOtpMaxAttempts();
  const attempts = Number(user.passwordResetOtpAttempts || 0);
  if (attempts >= maxAttempts) {
    throw new Error("Too many attempts. Please request a new code.");
  }

  const candidateHash = sha256Hex(rawOtp);
  if (candidateHash !== user.passwordResetOtpHash) {
    user.passwordResetOtpAttempts = attempts + 1;
    await user.save();

    const remaining = Math.max(0, maxAttempts - (attempts + 1));
    throw new Error(remaining > 0 ? `Invalid code. ${remaining} attempt(s) left.` : "Invalid code.");
  }

  user.passwordResetOtpVerifiedAt = now;
  await user.save();
  return true;
}

/**
 * Detailed validation: returns whether token is valid AND whether OTP has been verified.
 */
async function validatePasswordResetTokenInfo(token) {
  const raw = String(token || "").trim();
  if (!raw) return { valid: false, otpVerified: false };

  const tokenHash = sha256Hex(raw);

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select("+passwordResetOtpVerifiedAt");

  if (!user) return { valid: false, otpVerified: false };

  return { valid: true, otpVerified: Boolean(user.passwordResetOtpVerifiedAt) };
}


module.exports = {
requestPasswordReset,
  resetPasswordWithToken,
  validatePasswordResetToken,
  sendPasswordResetOtp,
  verifyPasswordResetOtp,
  validatePasswordResetTokenInfo,
};
