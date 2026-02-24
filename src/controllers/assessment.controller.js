// backend/src/controllers/assessment.controller.js

const Assessment = require("../models/Assessment.model");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// PHQ-9 score -> severity (matches your UI labels)
function computeSeverity(score) {
  if (score <= 4) return "Minimal";
  if (score <= 9) return "Mild";
  if (score <= 14) return "Moderate";
  if (score <= 19) return "Moderately High";
  return "High";
}

function toSafeIntArray(v) {
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => (typeof x === "string" ? Number(x) : x));
  if (out.some((n) => !Number.isInteger(n))) return null;
  return out;
}

exports.submitPhq9 = async (req, res, next) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      res.status(401);
      throw new Error("Not authorized");
    }

    const answers = toSafeIntArray(req.body?.answers);
    if (!answers || answers.length !== 9) {
      res.status(400);
      throw new Error("answers must be an array of 9 integers (0..3)");
    }

    const invalid = answers.some((n) => n < 0 || n > 3);
    if (invalid) {
      res.status(400);
      throw new Error("Each answer must be an integer between 0 and 3");
    }

    // Enforce 7-day lock per user
    const latest = await Assessment.findOne({ user: userId, type: "PHQ9" }).sort({ createdAt: -1 });
    if (latest) {
      const lastMs = new Date(latest.createdAt).getTime();
      const nextAllowedMs = lastMs + WEEK_MS;

      if (Date.now() < nextAllowedMs) {
        res.status(429);
        return res.json({
          message: "PHQ-9 can only be submitted once every 7 days.",
          lastSubmittedAt: latest.createdAt,
          nextAllowedAt: new Date(nextAllowedMs),
        });
      }
    }

    const score = answers.reduce((sum, n) => sum + n, 0);
    const severity = computeSeverity(score);

    const created = await Assessment.create({
      user: userId,
      type: "PHQ9",
      answers,
      score,
      severity,
      clientSubmittedAt: req.body?.clientSubmittedAt ? new Date(req.body.clientSubmittedAt) : undefined,
    });

    return res.status(201).json({
      message: "PHQ-9 submitted successfully",
      item: created,
    });
  } catch (err) {
    next(err);
  }
};

exports.getMyPhq9 = async (req, res, next) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      res.status(401);
      throw new Error("Not authorized");
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 200);

    const items = await Assessment.find({ user: userId, type: "PHQ9" })
      .sort({ createdAt: -1 })
      .limit(limit);

    return res.json({
      latest: items[0] || null,
      items,
    });
  } catch (err) {
    next(err);
  }
};

// Counselor/Admin: list students with latest PHQ-9
exports.getPhq9Students = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || "800", 10), 1), 2000);

    // Fetch recent, then keep the latest per student
    const recent = await Assessment.find({ type: "PHQ9" })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("user", "fullName email studentNumber course campus role");

    const seen = new Set();
    const items = [];

    for (const a of recent) {
      const u = a.user;
      if (!u?._id) continue;

      const id = String(u._id);
      if (seen.has(id)) continue;
      seen.add(id);

      items.push({
        userId: u._id,
        fullName: u.fullName,
        email: u.email,
        studentNumber: u.studentNumber,
        course: u.course,
        campus: u.campus,
        lastSubmittedAt: a.createdAt,
        score: a.score,
        severity: a.severity,
        assessmentId: a._id,
      });
    }

    return res.json({ items });
  } catch (err) {
    next(err);
  }
};

// Counselor/Admin: full PHQ-9 history for one student (includes answers)
exports.getPhq9Student = async (req, res, next) => {
  try {
    const { userId } = req.params;

    const limit = Math.min(Math.max(parseInt(req.query.limit || "200", 10), 1), 500);

    const items = await Assessment.find({ user: userId, type: "PHQ9" })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("user", "fullName email studentNumber course campus");

    return res.json({ items });
  } catch (err) {
    next(err);
  }
};

/**
 * Counselor/Admin: PHQ-9 submissions on a specific date (YYYY-MM-DD).
 * Returns rows shaped like /phq9/students so the counselor Calendar view can render them.
 */
exports.getPhq9ByDate = async (req, res, next) => {
  try {
    const dateStr = String(req.query.date || "").trim();
    if (!dateStr) {
      res.status(400);
      throw new Error('Query param "date" is required (YYYY-MM-DD).');
    }

    // Force UTC midnight for date-only input
    const start = new Date(`${dateStr}T00:00:00.000Z`);
    if (!Number.isFinite(start.getTime())) {
      res.status(400);
      throw new Error('Invalid "date". Use YYYY-MM-DD.');
    }
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const limit = Math.min(Math.max(parseInt(req.query.limit || "2000", 10), 1), 5000);

    const found = await Assessment.find({
      type: "PHQ9",
      createdAt: { $gte: start, $lt: end },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("user", "fullName email studentNumber course campus role");

    // Keep latest per student (defensive)
    const seen = new Set();
    const items = [];

    for (const a of found) {
      const u = a.user;
      if (!u?._id) continue;

      const id = String(u._id);
      if (seen.has(id)) continue;
      seen.add(id);

      items.push({
        userId: u._id,
        fullName: u.fullName,
        email: u.email,
        studentNumber: u.studentNumber,
        course: u.course,
        campus: u.campus,
        lastSubmittedAt: a.createdAt,
        score: a.score,
        severity: a.severity,
        assessmentId: a._id,
      });
    }

    return res.json({ items });
  } catch (err) {
    next(err);
  }
};

