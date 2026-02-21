// backend/src/routes/messages.routes.js
const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const controller = require("../controllers/messages.controller");

// Threads
router.get("/threads", protect, controller.listThreads);
router.post("/threads/ensure", protect, controller.ensureThread);
router.get("/threads/:threadId", protect, controller.getThread);

// Messages
router.post("/threads/:threadId/messages", protect, controller.sendMessage);

// Read
router.post("/threads/:threadId/read", protect, controller.markRead);

// Close
router.post("/threads/:threadId/close", protect, controller.closeThread);

module.exports = router;
