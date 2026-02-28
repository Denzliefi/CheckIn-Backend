// backend/src/routes/user.routes.js
const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const { avatarUpload } = require("../middleware/upload.middleware");
const { requireRole } = require("../middleware/role.middleware");
const { getMe, updateMyAvatar, updateMyCounselorAvatar, getStudentsForCounselor, updateStudentForCounselor } = require("../controllers/user.controller");

router.get("/me", protect, getMe);

// Profile photo upload (multipart/form-data: avatar or file)
router.put("/me/avatar", protect, avatarUpload, updateMyAvatar);
router.post("/me/avatar", protect, avatarUpload, updateMyAvatar);


// Counselor-only profile photo upload (used by Counselor Dashboard Account Settings)
router.put("/me/counselor/avatar", protect, requireRole("Counselor"), avatarUpload, updateMyCounselorAvatar);
router.post("/me/counselor/avatar", protect, requireRole("Counselor"), avatarUpload, updateMyCounselorAvatar);
router.get("/students", protect, requireRole("Counselor", "Admin"), getStudentsForCounselor);
router.patch("/students/:userId", protect, requireRole("Counselor", "Admin"), updateStudentForCounselor);

module.exports = router;
