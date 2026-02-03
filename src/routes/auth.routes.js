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
  getMe,
  createUser,
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
