/**
 * Counseling Request Controller
 * - Students can create MEET requests (appointments) and ASK requests (message thread).
 * - Students can only view/cancel their own requests.
 * - Counselors/Admins can list/review/approve/disapprove/complete requests.
 *
 * Notes:
 * - counselorId stores the Counselor user's _id as a string for compatibility with existing schema.
 * - "One pending appointment at a time": blocks MEET requests if the student already has a Pending/Approved MEET.
 */

const CounselingRequest = require("../models/CounselingRequest");
const User = require("../models/User.model");

const {
  isValidDateYYYYMMDD,
  isWeekend,
  isHoliday,
  validateMeetRules,
} = require("../utils/counselingValidation");

/* ------------------------ constants ------------------------ */
const STATUS = {
  PENDING: "Pending",
  APPROVED: "Approved",
  DISAPPROVED: "Disapproved",
  CANCELLED: "Cancelled",
  COMPLETED: "Completed",
};

const THREAD = {
  OPEN: "Open",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

// Align with frontend slots (hourly 08:00..16:00, lunch at 12:00)
const WORK = { start: 8 * 60, end: 17 * 60, step: 60 };
const LUNCH = "12:00";

/* ------------------------ helpers ------------------------ */
const parseIntSafe = (v) => {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

const minutesToHHMM = (mins) => {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
};

const buildSlots = () => {
  const out = [];
  for (let t = WORK.start; t < WORK.end; t += WORK.step) out.push(minutesToHHMM(t));
  return out;
};

const SLOT_LIST = buildSlots();

function isAllowedSlot(time) {
  return SLOT_LIST.includes(String(time));
}

function toLeanRequest(doc) {
  if (!doc) return null;

  return {
    id: String(doc._id),
    type: doc.type,
    status: doc.status,
    threadStatus: doc.threadStatus,

    sessionType: doc.sessionType,
    reason: doc.reason,
    date: doc.date,
    time: doc.time,

    counselorId: doc.counselorId,
    userId: doc.userId,

    studentMessage: doc.studentMessage,
    counselorReply: doc.counselorReply,
    replyAt: doc.replyAt,

    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,

    cancelledAt: doc.cancelledAt,
    approvedAt: doc.approvedAt,
    disapprovedAt: doc.disapprovedAt,
    completedAt: doc.completedAt,
  };
}

function mustBeOwner(reqDoc, reqUser) {
  return reqDoc && String(reqDoc.userId) === String(reqUser?._id);
}

async function findActiveMeetForStudent(userId) {
  return CounselingRequest.findOne({
    type: "MEET",
    userId: String(userId),
    status: { $in: [STATUS.PENDING, STATUS.APPROVED] },
  }).sort({ createdAt: -1 });
}

async function counselorExists(counselorId) {
  if (!counselorId) return false;
  const u = await User.findById(counselorId).select("_id role").lean();
  return !!u && u.role === "Counselor";
}

/* ------------------------ endpoints ------------------------ */

// GET /api/counseling/counselors
exports.listCounselors = async (req, res) => {
  const counselors = await User.find({ role: "Counselor" })
    .select("_id fullName email counselorCode specialty")
    .sort({ fullName: 1 })
    .lean();

  const items = counselors.map((c) => ({
    id: String(c._id),
    name: c.fullName || c.email || "Counselor",
    email: c.email || "",
    counselorCode: c.counselorCode || "",
    specialty: c.specialty || "",
  }));

  res.json({ ok: true, items });
};

// GET /api/counseling/availability?date=YYYY-MM-DD&counselorId=<optional>
exports.getAvailability = async (req, res) => {
  const { date, counselorId } = req.query;

  if (!isValidDateYYYYMMDD(date)) {
    return res.status(400).json({ ok: false, message: "Invalid date format (YYYY-MM-DD)." });
  }
  if (isWeekend(date)) {
    return res.status(400).json({ ok: false, message: "Counseling is not available on weekends." });
  }
  if (isHoliday(date)) {
    return res.status(400).json({ ok: false, message: "Counseling is not available on holidays." });
  }

  const slots = SLOT_LIST.filter((t) => t !== LUNCH);

  // If a counselor is specified, compute availability for that counselor only.
  if (counselorId) {
    const exists = await counselorExists(counselorId);
    if (!exists) {
      return res.status(404).json({ ok: false, message: "Counselor not found." });
    }

    const taken = await CounselingRequest.find({
      type: "MEET",
      counselorId: String(counselorId),
      date,
      time: { $in: slots },
      status: { $in: [STATUS.PENDING, STATUS.APPROVED] },
    })
      .select("time")
      .lean();

    const takenSet = new Set(taken.map((x) => String(x.time)));

    const outSlots = SLOT_LIST.map((t) => {
      if (t === LUNCH) return { time: t, enabled: false, reason: "Lunch Break", availableCounselors: [] };
      if (!slots.includes(t)) return { time: t, enabled: false, reason: "Not Available", availableCounselors: [] };
      if (takenSet.has(t)) return { time: t, enabled: false, reason: "Booked", availableCounselors: [] };
      return { time: t, enabled: true, reason: "", availableCounselors: [{ id: String(counselorId) }] };
    });

    return res.json({ ok: true, date, counselorId: String(counselorId), slots: outSlots });
  }

  // Global availability: per slot, list counselors who are free.
  const counselors = await User.find({ role: "Counselor" })
    .select("_id fullName email")
    .sort({ fullName: 1 })
    .lean();

  const counselorIds = counselors.map((c) => String(c._id));
  if (counselorIds.length === 0) {
    const outSlots = SLOT_LIST.map((t) => ({
      time: t,
      enabled: false,
      reason: "No Counselors",
      availableCounselors: [],
    }));
    return res.json({ ok: true, date, counselorId: null, slots: outSlots });
  }

  const taken = await CounselingRequest.find({
    type: "MEET",
    counselorId: { $in: counselorIds },
    date,
    time: { $in: slots },
    status: { $in: [STATUS.PENDING, STATUS.APPROVED] },
  })
    .select("counselorId time")
    .lean();

  const takenByTime = new Map(); // time => Set(counselorId)
  taken.forEach((x) => {
    const t = String(x.time);
    if (!takenByTime.has(t)) takenByTime.set(t, new Set());
    takenByTime.get(t).add(String(x.counselorId));
  });

  const outSlots = SLOT_LIST.map((t) => {
    if (t === LUNCH) return { time: t, enabled: false, reason: "Lunch Break", availableCounselors: [] };
    if (!slots.includes(t)) return { time: t, enabled: false, reason: "Not Available", availableCounselors: [] };

    const takenSet = takenByTime.get(t) || new Set();
    const avail = counselors
      .filter((c) => !takenSet.has(String(c._id)))
      .map((c) => ({ id: String(c._id), name: c.fullName || c.email || "Counselor" }));

    return {
      time: t,
      enabled: avail.length > 0,
      reason: avail.length > 0 ? "" : "Booked",
      availableCounselors: avail,
    };
  });

  return res.json({ ok: true, date, counselorId: null, slots: outSlots });
};

// POST /api/counseling/requests/ask
exports.createAskRequest = async (req, res) => {
  const userId = String(req.user._id);

  const { message } = req.body || {};
  if (!message || String(message).trim().length < 2) {
    return res.status(400).json({ ok: false, message: "Message is required." });
  }

  const doc = await CounselingRequest.create({
    type: "ASK",
    userId,
    status: STATUS.PENDING,
    threadStatus: THREAD.OPEN,
    studentMessage: String(message).trim(),
  });

  return res.status(201).json({ ok: true, request: toLeanRequest(doc) });
};

// POST /api/counseling/requests/meet
exports.createMeetRequest = async (req, res) => {
  const userId = String(req.user._id);

  // One pending appointment at a time
  const active = await findActiveMeetForStudent(userId);
  if (active) {
    return res.status(409).json({
      ok: false,
      code: "HAS_PENDING",
      message: "You already have a pending/approved appointment.",
      request: toLeanRequest(active),
    });
  }

  const { sessionType, reason, date, time, counselorId, notes } = req.body || {};

  const v = validateMeetRules({ sessionType, reason, date, time });
  if (!v.ok) return res.status(400).json({ ok: false, message: v.message });

  if (!isAllowedSlot(time) || String(time) === LUNCH) {
    return res.status(400).json({ ok: false, message: "Invalid time slot." });
  }

  // If counselorId is provided, verify it exists and is free.
  let finalCounselorId = counselorId ? String(counselorId) : null;

  if (finalCounselorId) {
    const exists = await counselorExists(finalCounselorId);
    if (!exists) return res.status(404).json({ ok: false, message: "Counselor not found." });

    const conflict = await CounselingRequest.findOne({
      type: "MEET",
      counselorId: finalCounselorId,
      date,
      time,
      status: { $in: [STATUS.PENDING, STATUS.APPROVED] },
    }).select("_id");

    if (conflict) {
      return res.status(409).json({ ok: false, code: "SLOT_TAKEN", message: "Slot already booked." });
    }
  } else {
    // Auto-assign: pick the first available counselor for that slot
    const counselors = await User.find({ role: "Counselor" }).select("_id fullName").sort({ fullName: 1 }).lean();
    const counselorIds = counselors.map((c) => String(c._id));

    if (counselorIds.length === 0) {
      return res.status(409).json({ ok: false, code: "NO_COUNSELOR_AVAILABLE", message: "No counselors available." });
    }

    const taken = await CounselingRequest.find({
      type: "MEET",
      counselorId: { $in: counselorIds },
      date,
      time,
      status: { $in: [STATUS.PENDING, STATUS.APPROVED] },
    })
      .select("counselorId")
      .lean();

    const takenSet = new Set(taken.map((x) => String(x.counselorId)));
    const pick = counselorIds.find((id) => !takenSet.has(id));

    if (!pick) {
      return res.status(409).json({ ok: false, code: "NO_COUNSELOR_AVAILABLE", message: "No counselor free for that slot." });
    }

    finalCounselorId = pick;
  }

  const doc = await CounselingRequest.create({
    type: "MEET",
    userId,
    counselorId: finalCounselorId,
    sessionType,
    reason,
    date,
    time,
    status: STATUS.PENDING,
    threadStatus: THREAD.OPEN,
    notes: notes ? String(notes) : "",
  });

  return res.status(201).json({ ok: true, request: toLeanRequest(doc) });
};

// GET /api/counseling/requests
exports.listRequests = async (req, res) => {
  const role = req.user.role;
  const userId = String(req.user._id);

  const mine = String(req.query.mine || "").toLowerCase() === "true";
  const type = req.query.type ? String(req.query.type) : null;
  const status = req.query.status ? String(req.query.status) : null;

  const q = {};

  // Students can only see their own requests
  if (role === "Student") {
    q.userId = userId;
  } else if (mine) {
    q.userId = userId;
  }

  if (type) q.type = type;
  if (status) q.status = status;

  const items = await CounselingRequest.find(q).sort({ createdAt: -1 }).lean();
  res.json({ ok: true, items: items.map(toLeanRequest) });
};

// GET /api/counseling/requests/:id
exports.getRequest = async (req, res) => {
  const role = req.user.role;
  const userId = String(req.user._id);
  const id = req.params.id;

  const doc = await CounselingRequest.findById(id).lean();
  if (!doc) return res.status(404).json({ ok: false, message: "Request not found." });

  // Students can only access their own
  if (role === "Student" && String(doc.userId) !== userId) {
    return res.status(403).json({ ok: false, message: "Not allowed." });
  }

  // Counselors/Admins: allow for now (later we can restrict to counselorId match)
  res.json({ ok: true, request: toLeanRequest(doc) });
};

// PATCH /api/counseling/requests/:id/cancel
exports.cancelRequest = async (req, res) => {
  const userId = String(req.user._id);
  const id = req.params.id;

  const doc = await CounselingRequest.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: "Request not found." });

  if (!mustBeOwner(doc, req.user)) {
    return res.status(403).json({ ok: false, message: "Not allowed." });
  }

  if (doc.type !== "MEET") {
    return res.status(400).json({ ok: false, message: "Only appointments can be cancelled here." });
  }

  if (![STATUS.PENDING, STATUS.APPROVED].includes(doc.status)) {
    return res.status(400).json({ ok: false, message: "This request cannot be cancelled." });
  }

  doc.status = STATUS.CANCELLED;
  doc.threadStatus = THREAD.CLOSED;
  doc.cancelledAt = new Date();
  await doc.save();

  res.json({ ok: true, request: toLeanRequest(doc) });
};

/* ------------------------ counselor/admin actions ------------------------ */

// PATCH /api/counseling/admin/requests/:id/approve
exports.approveRequest = async (req, res) => {
  const id = req.params.id;

  const doc = await CounselingRequest.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: "Request not found." });

  if (doc.type !== "MEET") return res.status(400).json({ ok: false, message: "Only MEET requests can be approved." });
  if (doc.status !== STATUS.PENDING) return res.status(400).json({ ok: false, message: "Only Pending requests can be approved." });

  // safety: prevent double-booking even at approval time
  const conflict = await CounselingRequest.findOne({
    _id: { $ne: doc._id },
    type: "MEET",
    counselorId: doc.counselorId,
    date: doc.date,
    time: doc.time,
    status: { $in: [STATUS.PENDING, STATUS.APPROVED] },
  }).select("_id");

  if (conflict) {
    return res.status(409).json({ ok: false, message: "Slot already booked." });
  }

  doc.status = STATUS.APPROVED;
  doc.approvedAt = new Date();
  await doc.save();

  res.json({ ok: true, request: toLeanRequest(doc) });
};

// PATCH /api/counseling/admin/requests/:id/disapprove
exports.disapproveRequest = async (req, res) => {
  const id = req.params.id;
  const { note } = req.body || {};

  const doc = await CounselingRequest.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: "Request not found." });

  if (doc.status !== STATUS.PENDING) return res.status(400).json({ ok: false, message: "Only Pending requests can be disapproved." });

  doc.status = STATUS.DISAPPROVED;
  doc.threadStatus = THREAD.CLOSED;
  doc.disapprovedAt = new Date();
  doc.disapprovalNote = note ? String(note) : "";
  await doc.save();

  res.json({ ok: true, request: toLeanRequest(doc) });
};

// PATCH /api/counseling/admin/requests/:id/complete
exports.completeRequest = async (req, res) => {
  const id = req.params.id;

  const doc = await CounselingRequest.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: "Request not found." });

  if (doc.type !== "MEET") return res.status(400).json({ ok: false, message: "Only MEET requests can be completed." });
  if (![STATUS.APPROVED, STATUS.PENDING].includes(doc.status)) {
    return res.status(400).json({ ok: false, message: "Only Approved/Pending requests can be completed." });
  }

  doc.status = STATUS.COMPLETED;
  doc.threadStatus = THREAD.CLOSED;
  doc.completedAt = new Date();
  await doc.save();

  res.json({ ok: true, request: toLeanRequest(doc) });
};

// PATCH /api/counseling/admin/requests/:id/reply  (for ASK threads)
exports.replyToAsk = async (req, res) => {
  const id = req.params.id;
  const { reply, threadStatus } = req.body || {};

  if (!reply || String(reply).trim().length < 1) {
    return res.status(400).json({ ok: false, message: "Reply is required." });
  }

  const doc = await CounselingRequest.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: "Request not found." });

  if (doc.type !== "ASK") return res.status(400).json({ ok: false, message: "Only ASK threads can be replied to." });

  doc.counselorReply = String(reply).trim();
  doc.replyAt = new Date();

  if (threadStatus && [THREAD.OPEN, THREAD.RESOLVED, THREAD.CLOSED].includes(threadStatus)) {
    doc.threadStatus = threadStatus;
  }

  await doc.save();
  res.json({ ok: true, request: toLeanRequest(doc) });
};

// PATCH /api/counseling/admin/requests/:id/thread-status
exports.setAskThreadStatus = async (req, res) => {
  const id = req.params.id;
  const { threadStatus } = req.body || {};

  if (!threadStatus || ![THREAD.OPEN, THREAD.RESOLVED, THREAD.CLOSED].includes(threadStatus)) {
    return res.status(400).json({ ok: false, message: "Invalid thread status." });
  }

  const doc = await CounselingRequest.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: "Request not found." });

  if (doc.type !== "ASK") return res.status(400).json({ ok: false, message: "Only ASK threads can be updated." });

  doc.threadStatus = threadStatus;
  await doc.save();

  res.json({ ok: true, request: toLeanRequest(doc) });
};
