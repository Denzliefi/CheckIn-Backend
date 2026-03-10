const express = require("express");
const router = express.Router();

// ======================
// Middleware
// ======================
const { validate } = require("../middleware/validate.middleware");
const { protect } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");

function createIpRateLimiter({ windowMs, max, message }) {
  const hits = new Map();

  return function ipRateLimiter(req, res, next) {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)[0];
    const key = forwarded || req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();

    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ message, retryAfterSeconds });
    }

    entry.count += 1;
    hits.set(key, entry);
    return next();
  };
}

const loginLimiter = createIpRateLimiter({
  windowMs: 60 * 1000,
  max: 8,
  message: "Too many login attempts. Please wait a minute and try again.",
});

const forgotPasswordLimiter = createIpRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: "Too many reset requests. Please wait before trying again.",
});

const loginOtpLimiter = createIpRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: "Too many OTP attempts. Please wait before trying again.",
});

// ======================
// Controllers
// ======================
const {
  register,
  login,
  googleAuth,
  checkAvailability,
  getMe,
  createUser,
  verifyLoginOtpCode,
  resendLoginOtpCode,
  forgotPassword,
  resetPassword,
  validateResetPasswordToken,
  sendResetPasswordOtp,
  verifyResetPasswordOtp,
} = require("../controllers/auth.controller");

/**
 * BASE: /api/auth
 */

/**
 * @route   POST /api/auth/register
 * @desc    Register new user (Student by default)
 * @access  Public
 */
router.post(
  "/register",
  validate(["fullName", "email", "username", "studentNumber", "password"]),
  register
);

/**
 * @route   POST /api/auth/login
 * @desc    Login user (email OR username + password)
 * @access  Public
 */
router.post(
  "/login",
  loginLimiter,
  validate(["emailOrUsername", "password"]),
  login
);

/**
 * @route   POST /api/auth/google
 * @desc    Google sign-in / sign-up
 * @access  Public
 */
router.post("/google", loginLimiter, googleAuth);

/**
 * @route   POST /api/auth/login/verify-otp
 * @desc    Verify login OTP and issue the real JWT/session
 * @access  Public
 */
router.post(
  "/login/verify-otp",
  loginOtpLimiter,
  validate(["pendingToken", "otp"]),
  verifyLoginOtpCode
);

/**
 * @route   POST /api/auth/login/resend-otp
 * @desc    Resend login OTP for the current pending login
 * @access  Public
 */
router.post(
  "/login/resend-otp",
  loginOtpLimiter,
  validate(["pendingToken"]),
  resendLoginOtpCode
);

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Request password reset (email/password accounts only)
 * @access  Public
 */
router.post("/forgot-password", forgotPasswordLimiter, validate(["email"]), forgotPassword);

/**
 * @route   POST /api/auth/reset-password
 * @desc    Reset password using token from email
 * @access  Public
 */
router.post("/reset-password", validate(["token", "password"]), resetPassword);

/**
 * @route   GET /api/auth/reset-password/validate?token=...
 * @desc    Validate reset token (used/expired links show proper UI)
 * @access  Public
 */
router.get("/reset-password/validate", validateResetPasswordToken);

/**
 * @route   POST /api/auth/reset-password/send-otp
 * @desc    Send one-time code for reset flow (requires valid reset token)
 * @access  Public
 */
router.post(
  "/reset-password/send-otp",
  forgotPasswordLimiter,
  validate(["token"]),
  sendResetPasswordOtp
);

/**
 * @route   POST /api/auth/reset-password/verify-otp
 * @desc    Verify one-time code for reset flow
 * @access  Public
 */
router.post(
  "/reset-password/verify-otp",
  loginOtpLimiter,
  validate(["token", "otp"]),
  verifyResetPasswordOtp
);

/**
 * @route   GET /api/auth/availability
 * @desc    Check if email/username/studentNumber is available (for inline, live validation)
 * @access  Public
 */
router.get("/availability", checkAvailability);

/**
 * @route   GET /api/auth/me
 * @desc    Get current logged-in user
 * @access  Private (Admin | Consultant | Student)
 */
router.get("/me", protect, getMe);

/**
 * @route   POST /api/auth/create-user
 * @desc    Admin creates Consultant or Admin
 * @access  Admin only
 */
router.post(
  "/create-user",
  protect,
  requireRole("Admin"),
  validate(["fullName", "email", "role", "username", "studentNumber"]),
  createUser
);

module.exports = router;
