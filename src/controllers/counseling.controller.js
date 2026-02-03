const CounselingRequest = require("../models/CounselingRequest");
const { validateMeetRules } = require("../utils/counselingValidation");
const User = require("../models/User.model");
/**
 * Student: Create ASK
 * POST /api/counseling/requests/ask
 */
exports.createAsk = async (req, res) => {
  try {
    const userId = req.user?.id; // protect middleware should set req.user
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
      return res.status(400).json({ code: "MISSING_FIELDS", message: "Please fill in all required fields." });
    }

    const rule = validateMeetRules({ date, time });
    if (!rule.ok) {
      return res.status(400).json({ code: rule.code, message: rule.message });
    }

    // optional: require counselorId for now; or auto assign later
    const counselor = counselorId ? String(counselorId).trim() : null;
    if (!counselor) {
      return res.status(400).json({ code: "MISSING_COUNSELOR", message: "Please select a counselor." });
    }

    // slot conflict check (Pending/Approved MEET)
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

/**
 * Student: List my requests
 * GET /api/counseling/requests?mine=true&status=&type=&past=true
 */
exports.listRequests = async (req, res) => {
  try {
    const mine = String(req.query.mine || "") === "true";
    const status = req.query.status;
    const type = req.query.type;
    const past = String(req.query.past || "") === "true";

    const q = {};

    if (mine) q.userId = req.user?.id;
    if (status) q.status = status;
    if (type) q.type = type;

    // Past Meetings filter: MEET where Completed OR date/time already passed
    // Minimal version: just Completed; you can enhance later.
    if (past) {
      q.type = "MEET";
      q.status = { $in: ["Completed"] };
    }

    const items = await CounselingRequest.find(q)
      .sort({ createdAt: -1 })
      .lean();

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

    // student can only view own; counselor/admin can view all (keep simple now)
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
 * Student: Cancel pending request (optional)
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
      return res.status(400).json({ code: "INVALID_STATUS", message: "Only pending requests can be cancelled." });
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
      return res.status(400).json({ code: "INVALID_STATUS", message: "Only pending requests can be approved." });
    }

    // If MEET, allow attaching meetingLink/location
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

    // optional: treat reply as approval
    if (doc.status === "Pending") doc.status = "Approved";

    await doc.save();

    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("replyToAsk error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Admin/Counselor: Set ASK thread status (NEW, UNDER_REVIEW, ...)
 * PATCH /api/counseling/admin/requests/:id/thread-status
 */
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
      return res.status(400).json({
        code: "INVALID_THREAD_STATUS",
        message: "Invalid threadStatus.",
      });
    }

    const doc = await CounselingRequest.findById(id);
    if (!doc) {
      return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });
    }

    if (doc.type !== "ASK") {
      return res.status(400).json({
        code: "INVALID_TYPE",
        message: "Only ASK requests can have thread statuses.",
      });
    }

    // Role check (match your roles)
    const role = req.user?.role;
    const isPrivileged = role === "Admin" || role === "Counselor" || role === "Consultant";
    if (!isPrivileged) {
      return res.status(403).json({ message: "Forbidden." });
    }

    // Optional: restrict internal statuses
    // if ((threadStatus === "URGENT" || threadStatus === "CRISIS") && role !== "Counselor") {
    //   return res.status(403).json({ message: "Only Counselor can set URGENT/CRISIS." });
    // }

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
    const users = await User.find({
      role: "Counselor",
      counselorCode: { $exists: true, $ne: "" },
    })
      .select("_id fullName counselorCode specialty role")
      .sort({ fullName: 1 })
      .lean();

    return res.json({
      items: users.map((u) => ({
        id: u.counselorCode, // ✅ "C-101"
        name: u.fullName,
        specialty: u.specialty || [],
        role: u.role,
      })),
    });
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

    // Weekend check (stable for YYYY-MM-DD)
    const d = new Date(date + "T00:00:00.000Z");
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ code: "INVALID_DATE", message: "Invalid date." });
    }
    const day = d.getUTCDay(); // 0 Sun ... 6 Sat
    if (day === 0 || day === 6) {
      return res.status(400).json({ code: "INVALID_DATE", message: "Weekends are not allowed." });
    }

    const workHours = { start: "08:00", end: "17:00", stepMin: 30 };
    const allSlots = generateSlots(workHours.start, workHours.end, workHours.stepMin);

    // ✅ If counselorId is provided, compute for that counselor only (based on bookings)
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
        slots: allSlots.map((t) => {
          if (bookedTimes.has(t)) return { time: t, enabled: false, reason: "Booked" };
          return { time: t, enabled: true };
        }),
      });
    }

    // ✅ No counselorId provided: "any counselor" availability
    // Load counselor roster from Users (must have counselorCode)
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

    // Load bookings for the date (any counselor)
    const bookings = await CounselingRequest.find({
      type: "MEET",
      date,
      status: { $in: ["Pending", "Approved"] },
    })
      .select("time counselorId")
      .lean();

    // Map: time -> set(booked counselorIds)
    const bookedMap = new Map();
    for (const b of bookings) {
      const t = b.time;
      const cId = String(b.counselorId || "");
      if (!bookedMap.has(t)) bookedMap.set(t, new Set());
      bookedMap.get(t).add(cId);
    }

    const roster = counselors.map((c) => ({
      id: c.counselorCode, // must match CounselingRequest.counselorId
      name: c.fullName,
    }));

    const slots = allSlots.map((t) => {
      const bookedSet = bookedMap.get(t) || new Set();
      const available = roster.filter((c) => !bookedSet.has(c.id));

      if (available.length === 0) return { time: t, enabled: false, reason: "Booked" };

      return {
        time: t,
        enabled: true,
        availableCounselors: available, // useful for frontend auto-pick
      };
    });

    return res.json({ date, counselorId: null, workHours, slots });
  } catch (err) {
    console.error("getAvailability error:", err);
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

exports.setAskThreadStatus = async (req, res) => {
  try {
    const { id } = req.params; // request id
    const { status } = req.body || {};

    if (!status || !THREAD_STATUS_ALLOWED.has(String(status))) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ message: "Request not found" });

    // Only ASK requests have threadStatus
    if (doc.type !== "ASK") {
      return res.status(400).json({ message: "threadStatus can only be set for ASK requests" });
    }

    doc.threadStatus = String(status);
    doc.threadStatusUpdatedAt = new Date();
    doc.threadStatusUpdatedBy = req.user?.id;

    await doc.save();

    return res.json({
      ok: true,
      id: doc._id,
      threadStatus: doc.threadStatus,
      threadStatusUpdatedAt: doc.threadStatusUpdatedAt,
      threadStatusUpdatedBy: doc.threadStatusUpdatedBy,
    });
  } catch (err) {
    console.error("setAskThreadStatus error:", err);
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
  for (let t = start; t <= end; t += stepMin) {
    slots.push(toHHMM(t));
  }
  return slots;
}


// ---------- helpers ----------
function formatRequest(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return formatRequestLean(o);
}

function formatRequestLean(o) {
  return {
    id: o._id,
    userId: o.userId,
    type: o.type,
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,

    topic: o.topic,
    message: o.message,
    anonymous: o.anonymous,
    counselorReply: o.counselorReply,
    repliedAt: o.repliedAt,

    sessionType: o.sessionType,
    reason: o.reason,
    date: o.date,
    time: o.time,
    counselorId: o.counselorId,
    notes: o.notes,

    approvedBy: o.approvedBy,
    disapprovalReason: o.disapprovalReason,
    meetingLink: o.meetingLink,
    location: o.location,
    completedAt: o.completedAt,
  };
}

