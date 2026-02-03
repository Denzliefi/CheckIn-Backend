// backend/src/routes/user.routes.js
const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const { getMe } = require("../controllers/user.controller");

router.get("/me", protect, getMe);

module.exports = router;
