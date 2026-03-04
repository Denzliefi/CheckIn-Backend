// backend/src/routes/user.routes.js
const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const { avatarUpload } = require("../middleware/upload.middleware");
const { requireRole } = require("../middleware/role.middleware");
const { validate } = require("../middleware/validate.middleware");

const {
  getMe,
  updateMyAvatar,
  updateMyCounselorAvatar,
  getStudentsForCounselor,
  updateStudentForCounselor,
  updateStudentStatusAdmin,
  bulkUpdateStudentStatusAdmin,
  getCounselorsAdmin,
  createCounselorAdmin,
  deleteCounselorAdmin,
  getAdminAnalytics,
} = require("../controllers/user.controller");

router.get("/me", protect, getMe);

// Profile photo upload (multipart/form-data: avatar or file)
router.put("/me/avatar", protect, avatarUpload, updateMyAvatar);
router.post("/me/avatar", protect, avatarUpload, updateMyAvatar);

// Counselor-only profile photo upload (used by Counselor Dashboard Account Settings)
router.put("/me/counselor/avatar", protect, requireRole("Counselor"), avatarUpload, updateMyCounselorAvatar);
router.post("/me/counselor/avatar", protect, requireRole("Counselor"), avatarUpload, updateMyCounselorAvatar);

// Students list/edit (Counselor + Admin)
router.get("/students", protect, requireRole("Counselor", "Admin"), getStudentsForCounselor);
router.patch("/students/:userId", protect, requireRole("Counselor", "Admin"), updateStudentForCounselor);
// Admin: Student lifecycle status (Pending/Active/Terminated)
router.patch(
  "/students/:userId/status",
  protect,
  requireRole("Admin"),
  validate(["adminPassword", "status"]),
  updateStudentStatusAdmin
);

router.patch(
  "/students/status/bulk",
  protect,
  requireRole("Admin"),
  validate(["adminPassword", "status"]),
  bulkUpdateStudentStatusAdmin
);


// ✅ Admin analytics (AssignmentsReassignment)
router.get("/admin/analytics", protect, requireRole("Admin"), getAdminAnalytics);


// Counselor management (Admin)
router.get("/counselors", protect, requireRole("Admin"), getCounselorsAdmin);
router.post(
  "/counselors",
  protect,
  requireRole("Admin"),
  validate(["fullName", "email", "counselorId", "password"]),
  createCounselorAdmin
);
router.delete(
  "/counselors/:counselorUserId",
  protect,
  requireRole("Admin"),
  validate(["adminPassword"]),
  deleteCounselorAdmin
);

module.exports = router;
