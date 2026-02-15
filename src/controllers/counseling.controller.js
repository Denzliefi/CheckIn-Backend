const CounselingRequest = require("../models/CounselingRequest");
const { validateMeetRules } = require("../utils/counselingValidation");
const User = require("../models/User.model");

/**
 * Student: Create ASK
 * POST /api/counseling/requests/ask
 */
exports.createAsk = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { topic, message, anonymous = true } = req.body || {};

    if (!topic || !message) {
      return res
        .status(400)
        .json({ code: "MISSING_FIELDS", message: "Please fill in all required fields." });
    }

    const doc = await CounselingRequest.create({
      userId,
      type: "ASK",
      status: "Pending",
      topic: String(topic).trim(),
      message: String(message).trim(),
      anonymous: !!anonymous,
    });

    return res.status(201).json(formatRequest(doc));
  } catch (err) {
    console.error("createAsk error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Student: Create MEET
 * POST /api/counseling/requests/meet
 */
exports.createMeet = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { sessionType, reason, date, time, counselorId, notes } = req.body || {};

    if (!sessionType || !reason || !date || !time) {
      return res
        .status(400)
        .json({ code: "MISSING_FIELDS", message: "Please fill in all required fields." });
    }

    const rule = validateMeetRules({ date, time });
    if (!rule.ok) {
      return res.status(400).json({ code: rule.code, message: rule.message });
    }

    const counselor = counselorId ? String(counselorId).trim() : "";
    if (!counselor) {
      return res.status(400).json({ code: "MISSING_COUNSELOR", message: "Please select a counselor." });
    }

    // Prevent multiple active MEET requests per student (Pending/Approved).
    const active = await CounselingRequest.findOne({
      userId,
      type: "MEET",
      status: { $in: ["Pending", "Approved"] },
    }).lean();

    if (active) {
      return res.status(409).json({
        code: "ACTIVE_MEET_EXISTS",
        message: "You already have an active appointment request.",
      });
    }

    // Slot conflict check (Pending/Approved MEET)
    const conflict = await CounselingRequest.findOne({
      type: "MEET",
      counselorId: counselor,
      date,
      time,
      status: { $in: ["Pending", "Approved"] },
    }).lean();

    if (conflict) {
      return res.status(409).json({ code: "SLOT_TAKEN", message: "Time slot already booked." });
    }

    const doc = await CounselingRequest.create({
      userId,
      type: "MEET",
      status: "Pending",
      sessionType: String(sessionType).trim(),
      reason: String(reason).trim(),
      date: String(date).trim(),
      time: String(time).trim(),
      counselorId: counselor,
      notes: notes ? String(notes).trim() : "",
    });

    return res.status(201).json(formatRequest(doc));
  } catch (err) {
    console.error("createMeet error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Student: List my requests
 * GET /api/counseling/requests
 *
 * Notes:
 * - Students are ALWAYS scoped to their own requests, regardless of query params.
 */
exports.listRequests = async (req, res) => {
  try {
    const status = req.query.status;
    const type = req.query.type;
    const past = String(req.query.past || "") === "true";

    const q = {};

    const role = String(req.user?.role || "Student");
    if (role === "Student") q.userId = req.user?.id;

    if (status) q.status = status;
    if (type) q.type = type;

    if (past) {
      q.type = "MEET";
      q.status = { $in: ["Completed"] };
    }

    const items = await CounselingRequest.find(q).sort({ createdAt: -1 }).lean();

    return res.json({ items: items.map(formatRequestLean) });
  } catch (err) {
    console.error("listRequests error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Student: Get request details
 * GET /api/counseling/requests/:id
 */
exports.getRequest = async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await CounselingRequest.findById(id).lean();

    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    const role = req.user?.role;
    const isPrivileged = role === "Admin" || role === "Counselor" || role === "Consultant";
    if (!isPrivileged && String(doc.userId) !== String(req.user?.id)) {
      return res.status(403).json({ message: "Forbidden." });
    }

    return res.json(formatRequestLean(doc));
  } catch (err) {
    console.error("getRequest error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Student: Cancel pending request
 * PATCH /api/counseling/requests/:id/cancel
 */
exports.cancelRequest = async (req, res) => {
  try {
    const id = req.params.id;

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (String(doc.userId) !== String(req.user?.id)) {
      return res.status(403).json({ message: "Forbidden." });
    }
    if (doc.status !== "Pending") {
      return res.status(400).json({
        code: "INVALID_STATUS",
        message: "Only pending requests can be cancelled.",
      });
    }

    doc.status = "Cancelled";
    await doc.save();

    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("cancelRequest error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Admin/Counselor: Approve
 * PATCH /api/counseling/admin/requests/:id/approve
 */
exports.approveRequest = async (req, res) => {
  try {
    const id = req.params.id;
    const { meetingLink, location } = req.body || {};

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.status !== "Pending") {
      return res.status(400).json({
        code: "INVALID_STATUS",
        message: "Only pending requests can be approved.",
      });
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

/**
 * Admin/Counselor: Disapprove
 * PATCH /api/counseling/admin/requests/:id/disapprove
 */
exports.disapproveRequest = async (req, res) => {
  try {
    const id = req.params.id;
    const { reason } = req.body || {};

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.status !== "Pending") {
      return res.status(400).json({
        code: "INVALID_STATUS",
        message: "Only pending requests can be disapproved.",
      });
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

/**
 * Admin/Counselor: Complete MEET
 * PATCH /api/counseling/admin/requests/:id/complete
 */
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

/**
 * Admin/Counselor: Reply to ASK
 * PATCH /api/counseling/admin/requests/:id/reply
 */
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

const THREAD_STATUS_ALLOWED = new Set([
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

/**
 * Admin/Counselor: Set ASK thread status
 * PATCH /api/counseling/admin/requests/:id/thread-status
 *
 * Accepts either { threadStatus: "..." } or { status: "..." }.
 */
exports.setAskThreadStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const incoming = req.body?.threadStatus ?? req.body?.status;
    const threadStatus = incoming ? String(incoming).trim() : "";

    if (!threadStatus || !THREAD_STATUS_ALLOWED.has(threadStatus)) {
      return res.status(400).json({
        code: "INVALID_THREAD_STATUS",
        message: "Invalid threadStatus.",
      });
    }

    const role = req.user?.role;
    const isPrivileged = role === "Admin" || role === "Counselor" || role === "Consultant";
    if (!isPrivileged) return res.status(403).json({ message: "Forbidden." });

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.type !== "ASK") {
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: "Only ASK requests can have thread statuses.",
      });
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

/**
 * List counselors (for booking)
 * GET /api/counseling/counselors
 */
exports.listCounselors = async (req, res) => {
  try {
    const users = await User.find({ role: "Counselor" })
      .select("fullName counselorCode specialty")
      .sort({ fullName: 1 })
      .lean();

    const items = users.map((u) => ({
      id: u._id,
      fullName: u.fullName,
      counselorCode: u.counselorCode || `C-${String(u._id).slice(-4).toUpperCase()}`,
      specialty: Array.isArray(u.specialty) ? u.specialty : [],
    }));

    return res.json({ items });
  } catch (err) {
    console.error("listCounselors error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Get counselor availability for a date
 * GET /api/counseling/availability?date=YYYY-MM-DD&counselorId=C-101(optional)
 */
exports.getAvailability = async (req, res) => {
  try {
    const date = String(req.query.date || "").trim();
    const counselorId = req.query.counselorId ? String(req.query.counselorId).trim() : "";

    if (!date) {
      return res.status(400).json({ code: "MISSING_DATE", message: "date is required (YYYY-MM-DD)." });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ code: "INVALID_DATE", message: "Invalid date format. Use YYYY-MM-DD." });
    }

    const d = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ code: "INVALID_DATE", message: "Invalid date." });
    }

    const day = d.getUTCDay();
    if (day === 0 || day === 6) {
      return res.status(400).json({ code: "INVALID_DATE", message: "Weekends are not allowed." });
    }

    const workHours = { start: "08:00", end: "17:00", stepMin: 30 };
    const allSlots = generateSlots(workHours.start, workHours.end, workHours.stepMin);

    if (counselorId) {
      const booked = await CounselingRequest.find({
        type: "MEET",
        counselorId,
        date,
        status: { $in: ["Pending", "Approved"] },
      })
        .select("time")
        .lean();

      const bookedTimes = new Set(booked.map((b) => b.time));

      return res.json({
        date,
        counselorId,
        workHours,
        slots: allSlots.map((t) => (bookedTimes.has(t) ? { time: t, enabled: false, reason: "Booked" } : { time: t, enabled: true })),
      });
    }

    const counselors = await User.find({
      role: "Counselor",
      counselorCode: { $exists: true, $ne: "" },
    })
      .select("fullName counselorCode")
      .lean();

    if (counselors.length === 0) {
      return res.json({
        date,
        counselorId: null,
        workHours,
        slots: allSlots.map((t) => ({ time: t, enabled: false, reason: "No counselors available" })),
      });
    }

    const bookings = await CounselingRequest.find({
      type: "MEET",
      date,
      status: { $in: ["Pending", "Approved"] },
    })
      .select("time counselorId")
      .lean();

    const bookedMap = new Map();
    for (const b of bookings) {
      const t = b.time;
      const cId = String(b.counselorId || "");
      if (!bookedMap.has(t)) bookedMap.set(t, new Set());
      bookedMap.get(t).add(cId);
    }

    const roster = counselors.map((c) => ({ id: c.counselorCode, name: c.fullName }));

    const slots = allSlots.map((t) => {
      const bookedSet = bookedMap.get(t) || new Set();
      const available = roster.filter((c) => !bookedSet.has(c.id));
      if (available.length === 0) return { time: t, enabled: false, reason: "Booked" };
      return { time: t, enabled: true, availableCounselors: available };
    });

    return res.json({ date, counselorId: null, workHours, slots });
  } catch (err) {
    console.error("getAvailability error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

// ---------- local helpers for availability ----------
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

function toHHMM(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function generateSlots(startHHMM, endHHMM, stepMin) {
  const start = toMinutes(startHHMM);
  const end = toMinutes(endHHMM);
  const slots = [];
  for (let t = start; t <= end; t += stepMin) slots.push(toHHMM(t));
  return slots;
}

// ---------- response helpers ----------
function formatRequest(doc) {
  const o = doc?.toObject ? doc.toObject() : doc;
  return formatRequestLean(o);
}

function formatRequestLean(o) {
  return {
    id: o?._id,
    userId: o?.userId,
    type: o?.type,
    status: o?.status,
    createdAt: o?.createdAt,
    updatedAt: o?.updatedAt,

    topic: o?.topic,
    message: o?.message,
    anonymous: o?.anonymous,
    counselorReply: o?.counselorReply,
    repliedAt: o?.repliedAt,

    sessionType: o?.sessionType,
    reason: o?.reason,
    date: o?.date,
    time: o?.time,
    counselorId: o?.counselorId,
    notes: o?.notes,

    approvedBy: o?.approvedBy,
    disapprovalReason: o?.disapprovalReason,
    meetingLink: o?.meetingLink,
    location: o?.location,
    completedAt: o?.completedAt,

    threadStatus: o?.threadStatus,
    threadStatusUpdatedAt: o?.threadStatusUpdatedAt,
    threadStatusUpdatedBy: o?.threadStatusUpdatedBy,
  };
}
