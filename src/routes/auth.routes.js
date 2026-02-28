const express = require("express");
const router = express.Router();

// ======================
// Middleware
// ======================
const { validate } = require("../middleware/validate.middleware");
const { protect } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");

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
  forgotPassword,
  resetPassword,
  validateResetPasswordToken,
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
  validate(["emailOrUsername", "password"]),
  login
);

/**
 * @route   POST /api/auth/google
 * @desc    Google sign-in / sign-up
 * @access  Public
 */
router.post("/google", googleAuth);

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Request password reset (email/password accounts only)
 * @access  Public
 */
router.post("/forgot-password", validate(["email"]), forgotPassword);

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
