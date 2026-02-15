const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");

const counseling = require("../controllers/counseling.controller");

// Student endpoints
router.post("/requests/ask", protect, counseling.createAsk);
router.post("/requests/meet", protect, counseling.createMeet);
router.get("/availability", protect, counseling.getAvailability);
router.get("/requests", protect, counseling.listRequests);
router.get("/requests/:id", protect, counseling.getRequest);
router.patch("/requests/:id/cancel", protect, counseling.cancelRequest);

router.get("/counselors", protect, counseling.listCounselors);


// Admin/Counselor endpoints
router.get(
  "/admin/requests",
  protect,
  requireRole("Admin", "Counselor", "Student"),
  counseling.listRequests
);

router.patch(
  "/admin/requests/:id/thread-status",
  protect,
  requireRole("Admin", "Counselor"),
  counseling.setAskThreadStatus
);


router.patch(
  "/admin/requests/:id/approve",
  protect,
  requireRole("Admin", "Counselor", "Student"),
  counseling.approveRequest
);

router.patch(
  "/admin/requests/:id/disapprove",
  protect,
  requireRole("Admin", "Counselor", "Student"),
  counseling.disapproveRequest
);

router.patch(
  "/admin/requests/:id/complete",
  protect,
  requireRole("Admin", "Counselor", "Student"),
  counseling.completeRequest
);

router.patch(
  "/admin/requests/:id/reply",
  protect,
  requireRole("Admin", "Counselor", "Student"),
  counseling.replyToAsk
);

module.exports = router;
