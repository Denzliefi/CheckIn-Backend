const mongoose = require("mongoose");
const { DateTime } = require("luxon");

const CounselingRequest = require("../models/CounselingRequest");
const User = require("../models/User.model");
const { validateMeetRules, PH_TZ } = require("../utils/counselingValidation");
const { generateTimeSlots } = require("../utils/availability");

/* =========================
   HELPERS
========================= */
function formatRequestLean(doc) {
  if (!doc) return null;
  const id = String(doc._id || doc.id || "");

  const counselorName =
    doc.counselorName ||
    (doc.counselorId && doc.counselorId.fullName) ||
    (doc.counselorId && doc.counselorId.firstName
      ? `${doc.counselorId.firstName} ${doc.counselorId.lastName || ""}`.trim()
      : "");

  return {
    id,
    _id: id,
    userId: doc.userId,
    type: doc.type,
    status: doc.status,
    threadStatus: doc.threadStatus,
    topic: doc.topic,
    message: doc.message,
    anonymous: !!doc.anonymous,
    counselorReply: doc.counselorReply,
    repliedAt: doc.repliedAt,

    sessionType: doc.sessionType,
    reason: doc.reason,
    date: doc.date,
    time: doc.time,
    counselorId: doc.counselorId?._id ? String(doc.counselorId._id) : (doc.counselorId ? String(doc.counselorId) : ""),
    counselorName: counselorName || "",
    notes: doc.notes,

    approvedBy: doc.approvedBy,
    disapprovalReason: doc.disapprovalReason,
    meetingLink: doc.meetingLink,
    location: doc.location,

    completedAt: doc.completedAt,
    cancelledAt: doc.cancelledAt,

    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function formatRequest(doc) {
  if (!doc) return null;
  return formatRequestLean(doc.toObject ? doc.toObject({ virtuals: false }) : doc);
}

function phDateOf(jsDate) {
  if (!jsDate) return null;
  const dt = DateTime.fromJSDate(jsDate, { zone: PH_TZ });
  if (!dt.isValid) return null;
  return dt.toISODate(); // YYYY-MM-DD
}

/**
 * If a meeting was cancelled on the same calendar date as the meeting date,
 * we keep the slot blocked (prevents last-minute cancellations freeing the slot).
 */
function isSameDayCancellation(doc) {
  if (!doc || doc.status !== "Cancelled") return false;
  if (!doc.cancelledAt || !doc.date) return false;

  const cancelledDate = phDateOf(new Date(doc.cancelledAt));
  return cancelledDate === doc.date;
}

function buildSlotConflictQuery({ counselorId, date, time }) {
  return {
    type: "MEET",
    counselorId,
    date,
    time,
    $or: [
      { status: { $in: ["Pending", "Approved"] } },
      // Same-day cancelled keeps slot blocked
      { status: "Cancelled", cancelledAt: { $exists: true } },
    ],
  };
}

/**
 * Enforce: only 1 active (Pending/Approved) MEET per week per student.
 */
async function enforceOneActiveMeetPerWeek({ userId, date }) {
  const dt = DateTime.fromISO(date, { zone: PH_TZ });
  if (!dt.isValid) return { ok: true };

  const weekStart = dt.startOf("week"); // Luxon default: Monday as start (ISO)
  const weekEnd = dt.endOf("week");

  const start = weekStart.toISODate();
  const end = weekEnd.toISODate();

  const existing = await CounselingRequest.findOne({
    userId,
    type: "MEET",
    status: { $in: ["Pending", "Approved"] },
    date: { $gte: start, $lte: end },
  })
    .select("_id date time status")
    .lean();

  if (existing) {
    return {
      ok: false,
      code: "ONE_ACTIVE_MEET_PER_WEEK",
      message: "You can only have 1 pending/approved counseling session per week.",
    };
  }

  return { ok: true };
}

/* =========================
   STUDENT: ASK
========================= */
exports.createAsk = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { topic, message, anonymous = true } = req.body || {};

    if (!topic || !message) {
      return res.status(400).json({ code: "MISSING_FIELDS", message: "Please fill in all required fields." });
    }

    const doc = await CounselingRequest.create({
      userId,
      type: "ASK",
      status: "Pending",
      topic: String(topic).trim(),
      message: String(message).trim(),
      anonymous: !!anonymous,
      threadStatus: "NEW",
    });

    return res.status(201).json(formatRequest(doc));
  } catch (err) {
    console.error("createAsk error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/* =========================
   STUDENT: MEET
========================= */
exports.createMeet = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { sessionType, reason, date, time, counselorId, notes } = req.body || {};

    if (!sessionType || !reason || !date || !time || !counselorId) {
      return res.status(400).json({ code: "MISSING_FIELDS", message: "Please fill in all required fields." });
    }

    const rule = validateMeetRules({ date, time });
    if (!rule.ok) {
      return res.status(400).json({ code: rule.code, message: rule.message });
    }

    const oneWeek = await enforceOneActiveMeetPerWeek({ userId, date });
    if (!oneWeek.ok) {
      return res.status(409).json({ code: oneWeek.code, message: oneWeek.message });
    }

    const counselor = String(counselorId).trim();
    if (!mongoose.isValidObjectId(counselor)) {
      return res.status(400).json({ code: "INVALID_COUNSELOR", message: "Invalid counselorId." });
    }

    const counselorExists = await User.exists({ _id: counselor, role: "Counselor" });
    if (!counselorExists) {
      return res.status(404).json({ code: "COUNSELOR_NOT_FOUND", message: "Selected counselor not found." });
    }

    // conflict check, also blocks same-day cancellations
    const conflictDocs = await CounselingRequest.find({
      type: "MEET",
      counselorId: counselor,
      date,
      time,
      status: { $in: ["Pending", "Approved", "Cancelled"] },
    })
      .select("status cancelledAt date")
      .lean();

    const taken =
      conflictDocs.some((d) => d.status === "Pending" || d.status === "Approved") ||
      conflictDocs.some((d) => isSameDayCancellation(d));

    if (taken) {
      return res.status(409).json({ code: "SLOT_TAKEN", message: "Time slot already booked." });
    }

    const doc = await CounselingRequest.create({
      userId,
      type: "MEET",
      status: "Pending",
      sessionType,
      reason: String(reason).trim(),
      date,
      time,
      counselorId: counselor,
      notes: notes ? String(notes).trim() : "",
    });

    return res.status(201).json(formatRequest(doc));
  } catch (err) {
    console.error("createMeet error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/* =========================
   STUDENT: LIST MY REQUESTS (default)
========================= */
exports.listRequests = async (req, res) => {
  try {
    const status = req.query.status;
    const type = req.query.type;

    const role = String(req.user?.role || "");
    const isPrivileged = role === "Admin" || role === "Counselor" || role === "Consultant";

    const q = {};

    // Students: ONLY own
    if (!isPrivileged) q.userId = req.user?.id;

    // Counselors: by default see assigned to them (their user _id)
    if (role === "Counselor") q.counselorId = req.user?.id;

    if (status) q.status = status;
    if (type) q.type = type;

    const items = await CounselingRequest.find(q)
      .sort({ createdAt: -1 })
      .populate({ path: "counselorId", select: "firstName lastName fullName role" })
      .lean();

    return res.json({ items: items.map(formatRequestLean) });
  } catch (err) {
    console.error("listRequests error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

exports.getRequest = async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await CounselingRequest.findById(id)
      .populate({ path: "counselorId", select: "firstName lastName fullName role" })
      .lean();

    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    const role = String(req.user?.role || "");
    const isPrivileged = role === "Admin" || role === "Counselor" || role === "Consultant";

    if (!isPrivileged && String(doc.userId) !== String(req.user?.id)) {
      return res.status(403).json({ message: "Forbidden." });
    }

    if (role === "Counselor" && String(doc.counselorId?._id || doc.counselorId) !== String(req.user?.id)) {
      return res.status(403).json({ message: "Forbidden." });
    }

    return res.json(formatRequestLean(doc));
  } catch (err) {
    console.error("getRequest error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

exports.cancelRequest = async (req, res) => {
  try {
    const id = req.params.id;

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (String(doc.userId) !== String(req.user?.id)) {
      return res.status(403).json({ message: "Forbidden." });
    }

    if (doc.status !== "Pending" && doc.status !== "Approved") {
      return res.status(400).json({ code: "INVALID_STATUS", message: "Only pending/approved requests can be cancelled." });
    }

    doc.status = "Cancelled";
    doc.cancelledAt = new Date();
    await doc.save();

    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("cancelRequest error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/* =========================
   COUNSELOR LIST (for booking)
========================= */
exports.listCounselors = async (req, res) => {
  try {
    const users = await User.find({ role: "Counselor" })
      .select("_id firstName lastName fullName role")
      .sort({ fullName: 1, lastName: 1, firstName: 1 })
      .lean();

    return res.json({
      items: users.map((u) => ({
        id: String(u._id),
        name: u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Counselor",
      })),
    });
  } catch (err) {
    console.error("listCounselors error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/* =========================
   AVAILABILITY
   GET /api/counseling/availability?date=YYYY-MM-DD&counselorId=<userId>
========================= */
exports.getAvailability = async (req, res) => {
  try {
    const date = String(req.query.date || "").trim();
    const counselorId = String(req.query.counselorId || "").trim();

    if (!date) {
      return res.status(400).json({ code: "MISSING_DATE", message: "date is required (YYYY-MM-DD)." });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ code: "INVALID_DATE", message: "Invalid date format. Use YYYY-MM-DD." });
    }

    const rule = validateMeetRules({ date, time: "08:00" }); // validate date/weekend/holiday
    if (!rule.ok && rule.code === "INVALID_DATE") {
      return res.status(400).json({ code: rule.code, message: rule.message });
    }

    if (!counselorId || !mongoose.isValidObjectId(counselorId)) {
      return res.status(400).json({ code: "INVALID_COUNSELOR", message: "counselorId is required." });
    }

    const counselorExists = await User.exists({ _id: counselorId, role: "Counselor" });
    if (!counselorExists) {
      return res.status(404).json({ code: "COUNSELOR_NOT_FOUND", message: "Selected counselor not found." });
    }

    const workHours = { start: "08:00", end: "17:00", stepMin: 30 };
    const allSlots = generateTimeSlots(workHours.start, workHours.end, workHours.stepMin);

    const bookings = await CounselingRequest.find({
      type: "MEET",
      counselorId,
      date,
      status: { $in: ["Pending", "Approved", "Cancelled"] },
    })
      .select("time status cancelledAt date")
      .lean();

    const blocked = new Set();
    for (const b of bookings) {
      if (b.status === "Pending" || b.status === "Approved") blocked.add(b.time);
      else if (isSameDayCancellation(b)) blocked.add(b.time);
    }

    return res.json({
      date,
      counselorId,
      workHours,
      slots: allSlots.map((t) => (blocked.has(t) ? { time: t, enabled: false, reason: "Booked" } : { time: t, enabled: true })),
    });
  } catch (err) {
    console.error("getAvailability error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/* =========================
   ADMIN / COUNSELOR ACTIONS
   (kept from your existing workflow)
========================= */
exports.approveRequest = async (req, res) => {
  try {
    const id = req.params.id;
    const { meetingLink, location } = req.body || {};

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.status !== "Pending") {
      return res.status(400).json({ code: "INVALID_STATUS", message: "Only pending requests can be approved." });
    }

    if (doc.type === "MEET") {
      if (doc.sessionType === "Online" && meetingLink) doc.meetingLink = String(meetingLink).trim();
      if (doc.sessionType === "In-person" && location) doc.location = String(location).trim();
    }

    doc.status = "Approved";
    doc.approvedBy = req.user?.id;
    await doc.save();

    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("approveRequest error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

exports.disapproveRequest = async (req, res) => {
  try {
    const id = req.params.id;
    const { reason } = req.body || {};

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.status !== "Pending") {
      return res.status(400).json({ code: "INVALID_STATUS", message: "Only pending requests can be disapproved." });
    }

    doc.status = "Disapproved";
    doc.disapprovalReason = reason ? String(reason).trim() : "Disapproved.";
    await doc.save();

    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("disapproveRequest error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

exports.completeRequest = async (req, res) => {
  try {
    const id = req.params.id;

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.type !== "MEET") {
      return res.status(400).json({ code: "INVALID_TYPE", message: "Only MEET requests can be completed." });
    }

    doc.status = "Completed";
    doc.completedAt = new Date();
    await doc.save();

    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("completeRequest error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

exports.replyToAsk = async (req, res) => {
  try {
    const id = req.params.id;
    const { reply } = req.body || {};

    if (!reply) {
      return res.status(400).json({ code: "MISSING_REPLY", message: "Reply is required." });
    }

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.type !== "ASK") {
      return res.status(400).json({ code: "INVALID_TYPE", message: "Only ASK requests can be replied to." });
    }

    doc.counselorReply = String(reply).trim();
    doc.repliedAt = new Date();

    if (doc.status === "Pending") doc.status = "Approved";

    await doc.save();

    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("replyToAsk error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

exports.setAskThreadStatus = async (req, res) => {
  try {
    const id = req.params.id;
    const { threadStatus } = req.body || {};

    const ALLOWED = new Set([
      "NEW",
      "UNDER_REVIEW",
      "APPOINTMENT_REQUIRED",
      "SCHEDULED",
      "IN_SESSION",
      "WAITING_ON_STUDENT",
      "FOLLOW_UP_REQUIRED",
      "COMPLETED",
      "CLOSED",
      "URGENT",
      "CRISIS",
    ]);

    if (!threadStatus || !ALLOWED.has(threadStatus)) {
      return res.status(400).json({ code: "INVALID_THREAD_STATUS", message: "Invalid threadStatus." });
    }

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.type !== "ASK") {
      return res.status(400).json({ code: "INVALID_TYPE", message: "Only ASK requests can have thread statuses." });
    }

    doc.threadStatus = threadStatus;
    doc.threadStatusUpdatedAt = new Date();
    doc.threadStatusUpdatedBy = req.user?.id;

    await doc.save();
    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("setAskThreadStatus error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};
