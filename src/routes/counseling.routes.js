const express = require("express");
const router = express.Router();

const counseling = require("../controllers/counseling.controller");

// ✅ FIX: destructure named exports so you get functions (not objects)
const { protect } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");

/**
 * Public (authenticated) helpers
 */
router.get("/counselors", protect, counseling.listCounselors);
router.get("/availability", protect, counseling.getAvailability);

/**
 * Student endpoints
 */
router.get("/requests", protect, counseling.listRequests);
router.get("/requests/:id", protect, counseling.getRequest);

router.post("/requests/ask", protect, requireRole("Student"), counseling.createAskRequest);
router.post("/requests/meet", protect, requireRole("Student"), counseling.createMeetRequest);

router.patch("/requests/:id/cancel", protect, requireRole("Student"), counseling.cancelRequest);

/**
 * Counselor/Admin actions (for counselor dashboard later)
 */
router.patch(
  "/admin/requests/:id/approve",
  protect,
  requireRole("Counselor", "Admin"),
  counseling.approveRequest
);
router.patch(
  "/admin/requests/:id/disapprove",
  protect,
  requireRole("Counselor", "Admin"),
  counseling.disapproveRequest
);
router.patch(
  "/admin/requests/:id/complete",
  protect,
  requireRole("Counselor", "Admin"),
  counseling.completeRequest
);

router.patch(
  "/admin/requests/:id/reply",
  protect,
  requireRole("Counselor", "Admin"),
  counseling.replyToAsk
);
router.patch(
  "/admin/requests/:id/thread-status",
  protect,
  requireRole("Counselor", "Admin"),
  counseling.setAskThreadStatus
);

module.exports = router;
