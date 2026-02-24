// backend/src/routes/assessment.routes.js

const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");

const assessmentController = require("../controllers/assessment.controller");

// Student
router.post("/phq9", protect, assessmentController.submitPhq9);
router.get("/phq9/me", protect, assessmentController.getMyPhq9);

// Counselor/Admin
router.get(
  "/phq9/students",
  protect,
  requireRole("Counselor", "Admin"),
  assessmentController.getPhq9Students
);

router.get(
  "/phq9/student/:userId",
  protect,
  requireRole("Counselor", "Admin"),
  assessmentController.getPhq9Student
);


// Calendar: submissions by date (Counselor/Admin)
router.get(
  "/phq9/by-date",
  protect,
  requireRole("Counselor", "Admin"),
  assessmentController.getPhq9ByDate
);

module.exports = router;
