// backend/src/routes/journal.routes.js
const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const { listEntries, upsertEntry, bulkSync, counselorThreadEntries } = require("../controllers/journal.controller");

/**
 * BASE: /api/journal
 * Auth: Bearer token (same as your current protect middleware)
 */
router.use(protect);

// Counselor-only (claimed + not anonymous): no drafts
router.get("/counselor/threads/:threadId/entries", counselorThreadEntries);

router.get("/entries", listEntries);
router.put("/entries/:dateKey", upsertEntry);
router.post("/sync", bulkSync);

module.exports = router;
