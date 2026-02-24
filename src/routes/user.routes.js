// backend/src/routes/user.routes.js
const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");
const { getMe, getStudentsForCounselor, updateStudentForCounselor } = require("../controllers/user.controller");

router.get("/me", protect, getMe);

router.get("/students", protect, requireRole("Counselor", "Admin"), getStudentsForCounselor);
router.patch("/students/:userId", protect, requireRole("Counselor", "Admin"), updateStudentForCounselor);

module.exports = router;
