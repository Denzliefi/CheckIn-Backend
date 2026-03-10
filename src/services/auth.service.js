// src/services/auth.service.js
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/User.model");
const {
  sendPasswordResetEmail,
  sendPasswordResetOtpEmail,
  sendLoginOtpEmail,
} = require("./mailer.service");

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

function getLoginOtpTtlMinutes() {
  const v = Number(process.env.LOGIN_OTP_TTL_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

function getLoginOtpMinIntervalSeconds() {
  const v = Number(process.env.LOGIN_OTP_MIN_REQUEST_INTERVAL_SECONDS);
  return Number.isFinite(v) && v >= 0 ? v : 60;
}

function getLoginOtpMaxAttempts() {
  const v = Number(process.env.LOGIN_OTP_MAX_ATTEMPTS);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

function getLoginPendingTokenTtlMinutes() {
  const v = Number(process.env.LOGIN_PENDING_TOKEN_TTL_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : 10;
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

function clearLoginOtpState(user) {
  user.loginOtpHash = undefined;
  user.loginOtpExpires = undefined;
  user.loginOtpRequestedAt = undefined;
  user.loginOtpAttempts = 0;
  user.loginOtpPendingId = undefined;
  user.loginOtpMethod = undefined;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) {
    throw new Error("JWT_SECRET is missing in environment variables.");
  }
  return secret;
}

function signPendingLoginToken({ userId, pendingId, method }) {
  const secret = getJwtSecret();
  const ttlMinutes = getLoginPendingTokenTtlMinutes();
  return jwt.sign(
    {
      id: String(userId),
      sid: String(pendingId),
      type: "login_pending",
      method: String(method || "password"),
    },
    secret,
    { expiresIn: `${ttlMinutes}m` }
  );
}

function verifyPendingLoginToken(rawToken) {
  const token = String(rawToken || "").trim();
  if (!token) throw new Error("Pending login token is required.");

  let decoded;
  try {
    decoded = jwt.verify(token, getJwtSecret());
  } catch (_) {
    throw new Error("Pending login session is invalid or expired. Please log in again.");
  }

  if (!decoded || decoded.type !== "login_pending" || !decoded.id || !decoded.sid) {
    throw new Error("Pending login session is invalid or expired. Please log in again.");
  }

  return {
    userId: String(decoded.id),
    pendingId: String(decoded.sid),
    method: String(decoded.method || "password"),
  };
}

async function issueLoginOtpChallenge(user, method = "password") {
  const ttlMinutes = getLoginOtpTtlMinutes();
  const minIntervalSec = getLoginOtpMinIntervalSeconds();
  const now = Date.now();

  const hasActiveChallenge = Boolean(
    user.loginOtpPendingId && user.loginOtpExpires && new Date(user.loginOtpExpires).getTime() > now
  );

  if (hasActiveChallenge && minIntervalSec > 0 && user.loginOtpRequestedAt) {
    const diffMs = now - new Date(user.loginOtpRequestedAt).getTime();
    const remaining = Math.ceil((minIntervalSec * 1000 - diffMs) / 1000);
    if (remaining > 0) {
      return {
        otpRequired: true,
        pendingToken: signPendingLoginToken({
          userId: user._id,
          pendingId: user.loginOtpPendingId,
          method: user.loginOtpMethod || method,
        }),
        resendIn: remaining,
        expiresIn: Math.max(1, Math.ceil((new Date(user.loginOtpExpires).getTime() - now) / 1000)),
        sent: false,
        email: user.email,
      };
    }
  }

  const otp = generateOtp6();
  const pendingId = crypto.randomBytes(16).toString("hex");

  user.loginOtpHash = sha256Hex(otp);
  user.loginOtpExpires = new Date(now + ttlMinutes * 60 * 1000);
  user.loginOtpRequestedAt = new Date(now);
  user.loginOtpAttempts = 0;
  user.loginOtpPendingId = pendingId;
  user.loginOtpMethod = String(method || "password");

  await user.save();

  await sendLoginOtpEmail({
    to: user.email,
    name: user.fullName || user.firstName || "",
    otp,
    ttlMinutes,
  });

  return {
    otpRequired: true,
    pendingToken: signPendingLoginToken({ userId: user._id, pendingId, method }),
    resendIn: minIntervalSec,
    expiresIn: ttlMinutes * 60,
    sent: true,
    email: user.email,
  };
}

async function resendLoginOtp(pendingToken) {
  const { userId, pendingId } = verifyPendingLoginToken(pendingToken);

  const user = await User.findById(userId).select(
    "+loginOtpHash +loginOtpExpires +loginOtpRequestedAt +loginOtpAttempts +loginOtpPendingId +loginOtpMethod"
  );

  if (!user || !user.loginOtpPendingId || String(user.loginOtpPendingId) !== String(pendingId)) {
    throw new Error("Pending login session is invalid or expired. Please log in again.");
  }

  const now = Date.now();
  if (!user.loginOtpExpires || new Date(user.loginOtpExpires).getTime() <= now) {
    clearLoginOtpState(user);
    await user.save();
    throw new Error("OTP expired. Please log in again to request a new code.");
  }

  const minIntervalSec = getLoginOtpMinIntervalSeconds();
  if (minIntervalSec > 0 && user.loginOtpRequestedAt) {
    const diffMs = now - new Date(user.loginOtpRequestedAt).getTime();
    const remaining = Math.ceil((minIntervalSec * 1000 - diffMs) / 1000);
    if (remaining > 0) {
      return { sent: false, cooldownSeconds: remaining };
    }
  }

  const otp = generateOtp6();
  const ttlMinutes = getLoginOtpTtlMinutes();

  user.loginOtpHash = sha256Hex(otp);
  user.loginOtpExpires = new Date(now + ttlMinutes * 60 * 1000);
  user.loginOtpRequestedAt = new Date(now);
  user.loginOtpAttempts = 0;

  await user.save();

  await sendLoginOtpEmail({
    to: user.email,
    name: user.fullName || user.firstName || "",
    otp,
    ttlMinutes,
  });

  return { sent: true, cooldownSeconds: minIntervalSec, expiresIn: ttlMinutes * 60 };
}

async function verifyLoginOtp({ pendingToken, otp }) {
  const { userId, pendingId } = verifyPendingLoginToken(pendingToken);
  const rawOtp = String(otp || "").trim();

  if (!/^[0-9]{6}$/.test(rawOtp)) throw new Error("OTP must be a 6-digit code.");

  const user = await User.findById(userId).select(
    "+loginOtpHash +loginOtpExpires +loginOtpRequestedAt +loginOtpAttempts +loginOtpPendingId +loginOtpMethod"
  );

  if (!user || !user.loginOtpPendingId || String(user.loginOtpPendingId) !== String(pendingId)) {
    throw new Error("Pending login session is invalid or expired. Please log in again.");
  }

  if (!user.loginOtpHash || !user.loginOtpExpires) {
    throw new Error("OTP not requested. Please log in again.");
  }

  const now = new Date();
  if (user.loginOtpExpires <= now) {
    clearLoginOtpState(user);
    await user.save();
    throw new Error("OTP expired. Please log in again to request a new code.");
  }

  const maxAttempts = getLoginOtpMaxAttempts();
  const attempts = Number(user.loginOtpAttempts || 0);
  if (attempts >= maxAttempts) {
    clearLoginOtpState(user);
    await user.save();
    throw new Error("Too many incorrect attempts. Please log in again.");
  }

  if (sha256Hex(rawOtp) !== user.loginOtpHash) {
    user.loginOtpAttempts = attempts + 1;
    await user.save();
    throw new Error("Invalid code. Please try again.");
  }

  clearLoginOtpState(user);
  await user.save();

  return user;
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
  }).select("+passwordResetOtpVerifiedAt +passwordResetOtpExpires");

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
  issueLoginOtpChallenge,
  resendLoginOtp,
  verifyLoginOtp,
};
