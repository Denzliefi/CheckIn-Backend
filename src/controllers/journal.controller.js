// backend/src/controllers/journal.controller.js
const mongoose = require("mongoose");
const Journal = require("../models/Journal.model");
const MessageThread = require("../models/MessageThread.model");

/**
 * Validate "YYYY-MM-DD"
 */
function isValidDateKey(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim());
}

function cleanStr(v, max = 2000) {
  return String(v ?? "").slice(0, max);
}

function cleanCopingUsed(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of v) {
    const s = String(raw ?? "").trim().slice(0, 60);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 24) break; // safety cap
  }
  return out;
}

/**
 * GET /api/journal/entries?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=400
 * Returns entries for the logged-in user.
 */
exports.listEntries = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const limitRaw = Number(req.query.limit || 400);

    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.floor(limitRaw))) : 400;

    const q = { user: userId };

    if (from || to) {
      q.dateKey = {};
      if (from && isValidDateKey(from)) q.dateKey.$gte = from;
      if (to && isValidDateKey(to)) q.dateKey.$lte = to;
      // if invalid, ignore instead of failing
      if (Object.keys(q.dateKey).length === 0) delete q.dateKey;
    }

    const entries = await Journal.find(q).sort({ dateKey: 1 }).limit(limit).lean();

    res.json({ entries });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/journal/entries/:dateKey
 * Upserts a single day's entry for the logged-in user.
 *
 * Body:
 * { mood, reason, notes, daySubmitted, clientUpdatedAt }
 */
exports.upsertEntry = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const dateKey = String(req.params.dateKey || "").trim();

    if (!isValidDateKey(dateKey)) {
      res.status(400);
      throw new Error("Invalid dateKey. Expected YYYY-MM-DD.");
    }

    const body = req.body || {};

    const incoming = {
      mood: cleanStr(body.mood, 120).trim(),
      reason: cleanStr(body.reason, 200).trim(),
      notes: cleanStr(body.notes, 8000),
      daySubmitted: body.daySubmitted === true,
      clientUpdatedAt: Number(body.clientUpdatedAt || Date.now()) || Date.now(),
      copingUsed: cleanCopingUsed(body.copingUsed),
    };

    const existing = await Journal.findOne({ user: userId, dateKey });

    // If we already have a newer clientUpdatedAt, ignore stale update
    if (existing && incoming.clientUpdatedAt < (existing.clientUpdatedAt || 0)) {
      return res.json({ entry: existing });
    }

    // If the day is already submitted/locked, we do NOT allow overwriting mood/reason/notes.
    // (Your UI already prevents edits; this is the server-side safety net.)
    if (existing && existing.daySubmitted) {
      // Allow re-submitting (idempotent) but do not change content
      if (incoming.daySubmitted && !existing.daySubmittedAt) {
        existing.daySubmittedAt = new Date();
      }
      existing.clientUpdatedAt = Math.max(existing.clientUpdatedAt || 0, incoming.clientUpdatedAt);
      await existing.save();
      return res.json({ entry: existing });
    }

    // Create new or update existing
    const update = {
      mood: incoming.mood,
      reason: incoming.reason,
      notes: incoming.notes,
      copingUsed: incoming.copingUsed,
      clientUpdatedAt: incoming.clientUpdatedAt,
    };

    // Manual save (finalize the day)
    if (incoming.daySubmitted) {
      update.daySubmitted = true;
      update.daySubmittedAt = new Date();
    }

    const opts = { new: true, upsert: true, setDefaultsOnInsert: true };

    const entry = await Journal.findOneAndUpdate({ user: userId, dateKey }, { $set: update }, opts);

    // Ensure daySubmittedAt persists if already set
    if (incoming.daySubmitted && !entry.daySubmittedAt) {
      entry.daySubmittedAt = new Date();
      await entry.save();
    }

    res.status(existing ? 200 : 201).json({ entry });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/journal/sync
 * Bulk upsert from client cache (migration / safety).
 * Body: { entries: [{ dateKey, mood, reason, notes, daySubmitted, clientUpdatedAt }] }
 */
exports.bulkSync = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const list = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (!list.length) return res.json({ synced: 0 });

    // Hard cap to avoid abuse
    const capped = list.slice(0, 500);

    let synced = 0;

    for (const raw of capped) {
      const dateKey = String(raw?.dateKey || "").trim();
      if (!isValidDateKey(dateKey)) continue;

      const incoming = {
        mood: cleanStr(raw?.mood, 120).trim(),
        reason: cleanStr(raw?.reason, 200).trim(),
        notes: cleanStr(raw?.notes, 8000),
        daySubmitted: raw?.daySubmitted === true,
        clientUpdatedAt: Number(raw?.clientUpdatedAt || 0) || 0,
        copingUsed: cleanCopingUsed(raw?.copingUsed),
      };

      const existing = await Journal.findOne({ user: userId, dateKey });

      // Skip if server is newer
      if (existing && incoming.clientUpdatedAt && incoming.clientUpdatedAt < (existing.clientUpdatedAt || 0)) {
        continue;
      }

      // If server is locked, do not overwrite.
      if (existing && existing.daySubmitted) {
        continue;
      }

      const update = {
        mood: incoming.mood,
        reason: incoming.reason,
        notes: incoming.notes,
        copingUsed: incoming.copingUsed,
        clientUpdatedAt: incoming.clientUpdatedAt || Date.now(),
      };

      if (incoming.daySubmitted) {
        update.daySubmitted = true;
        update.daySubmittedAt = new Date();
      }

      await Journal.findOneAndUpdate(
        { user: userId, dateKey },
        { $set: update, $setOnInsert: { user: userId, dateKey } },
        { upsert: true, new: false }
      );

      synced += 1;
    }

    res.json({ synced });
  } catch (err) {
    next(err);
  }
};


/**
 * GET /api/journal/counselor/threads/:threadId/entries?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=400
 * Counselor-only:
 * - must be the assigned counselor for the thread (claim-on-reply)
 * - thread must NOT be anonymous
 * - returns only daySubmitted=true entries (no drafts)
 */
exports.counselorThreadEntries = async (req, res, next) => {
  try {
    const viewer = req.user;

    // ✅ role gate (do NOT trust client UI)
    const role = String(viewer?.role || "").toLowerCase();
    if (role !== "counselor" && role !== "admin") {
      res.status(403);
      throw new Error("Forbidden");
    }

    const threadIdRaw = String(req.params.threadId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(threadIdRaw)) {
      res.status(400);
      throw new Error("Invalid thread id");
    }

    const thread = await MessageThread.findById(threadIdRaw)
      .select("studentId counselorId anonymous identityMode status")
      .lean();

    if (!thread) {
      res.status(404);
      throw new Error("Thread not found");
    }

    // ✅ must be claimed by THIS counselor (identity is hidden until claimed)
    const assignedId = thread.counselorId ? String(thread.counselorId) : "";
    if (!assignedId || assignedId !== String(viewer._id)) {
      res.status(403);
      throw new Error("Forbidden");
    }

    // ✅ anonymous threads never expose mood tracker data
    const isAnon = !!thread.anonymous || String(thread.identityMode || "").toLowerCase() === "anonymous";
    if (isAnon) {
      res.status(403);
      throw new Error("Mood Tracker is not available for anonymous students");
    }

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const limitRaw = Number(req.query.limit || 400);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.floor(limitRaw))) : 400;

    const q = { user: thread.studentId, daySubmitted: true };

    if (from || to) {
      q.dateKey = {};
      if (from && isValidDateKey(from)) q.dateKey.$gte = from;
      if (to && isValidDateKey(to)) q.dateKey.$lte = to;
      if (Object.keys(q.dateKey).length === 0) delete q.dateKey;
    }

    const entries = await Journal.find(q).sort({ dateKey: 1 }).limit(limit).lean();

    return res.json({ entries });
  } catch (err) {
    next(err);
  }
};

