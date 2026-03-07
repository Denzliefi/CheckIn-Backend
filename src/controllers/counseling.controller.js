const CounselingRequest = require("../models/CounselingRequest");
const { DateTime } = require("luxon");
const { validateMeetRules, phNow, PH_TZ, getMinLeadMinutes, ceilToNextHour, isWeekend, isHoliday } = require("../utils/counselingValidation");
const { generateTimeSlots } = require("../utils/availability");
const User = require("../models/User.model");
const AvailabilityBlock = require("../models/AvailabilityBlock.model");
const mongoose = require("mongoose");

// ---------------- Availability blocks + booking window ----------------
function getBookingWindowDays() {
  const n = parseInt(process.env.MEET_BOOKING_WINDOW_DAYS || "30", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 1), 180) : 30;
}

function phDayBounds(dateISO) {
  const start = DateTime.fromISO(dateISO, { zone: PH_TZ }).startOf("day");
  const end = start.plus({ days: 1 });
  return { start, end };
}

function slotInterval(dateISO, time24, stepMin = 60) {
  const start = DateTime.fromISO(`${dateISO}T${time24}`, { zone: PH_TZ });
  const end = start.plus({ minutes: stepMin });
  return { start, end };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  // [aStart, aEnd) overlaps [bStart, bEnd)
  return aStart < bEnd && aEnd > bStart;
}

async function loadApprovedBlocksForDate({ dateISO, counselorIds }) {
  if (!dateISO) return [];
  const ids = (Array.isArray(counselorIds) ? counselorIds : []).filter(Boolean);
  if (!ids.length) return [];

  const { start, end } = phDayBounds(dateISO);
  return AvailabilityBlock.find({
    counselorId: { $in: ids },
    status: "Approved",
    startAt: { $lt: end.toJSDate() },
    endAt: { $gt: start.toJSDate() },
  })
    .select("counselorId startAt endAt type note")
    .lean();
}

function blockReason(block) {
  const t = String(block?.type || "Unavailable");
  if (t === "Leave") return "Counselor on leave";
  if (t === "Event") return "Counselor has an event";
  return "Counselor unavailable";
}


function normalizeDateInput(dateValue) {
  const raw = String(dateValue || "").trim();
  if (!raw) return "";
  // ISO already
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // Some mobile browsers may provide MM/DD/YYYY
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const mm = String(mdy[1]).padStart(2, "0");
    const dd = String(mdy[2]).padStart(2, "0");
    const yyyy = mdy[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  return raw;
}


function buildBlockFromBody({ counselorId, date, allDay, startTime, endTime, type, note }, actor) {
  const dateISO = normalizeDateInput(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, code: "INVALID_DATE", message: "Invalid date format. Use YYYY-MM-DD." };

  const stepMin = 60;
  const st = String(startTime || "00:00").trim();
  const et = String(endTime || (allDay ? "00:00" : "23:59")).trim();

  const start = allDay ? DateTime.fromISO(dateISO, { zone: PH_TZ }).startOf("day") : DateTime.fromISO(`${dateISO}T${st}`, { zone: PH_TZ });
  const end = allDay ? start.plus({ days: 1 }) : DateTime.fromISO(`${dateISO}T${et}`, { zone: PH_TZ });

  if (!start.isValid || !end.isValid) return { ok: false, code: "INVALID_TIME", message: "Invalid start/end time." };
  if (end <= start) return { ok: false, code: "INVALID_RANGE", message: "End time must be after start time." };

  return {
    ok: true,
    doc: {
      counselorId,
      startAt: start.toJSDate(),
      endAt: end.toJSDate(),
      status: actor?.status || "Approved",
      type: type ? String(type) : "Unavailable",
      note: note ? String(note).trim() : "",
      createdBy: actor?.id,
      createdByRole: actor?.role || "",
      approvedBy: actor?.approvedBy,
      approvedAt: actor?.approvedAt,
    },
  };
}

// ---------------------------------------------------------------------
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

    const allowedSessionTypes = new Set(["Online", "In-person"]);
    if (!allowedSessionTypes.has(String(sessionType))) {
      return res.status(400).json({ code: "INVALID_SESSION_TYPE", message: "Please select a valid session type." });
    }

    const rule = validateMeetRules({ date, time });
    if (!rule.ok) {
      return res.status(400).json({ code: rule.code, message: rule.message });
    }

    // Booking window (backend source of truth)
    const maxDays = getBookingWindowDays();
    const today = phNow().toISODate();
    const latest = DateTime.fromISO(today, { zone: PH_TZ }).plus({ days: maxDays }).toISODate();
    if (date < today || date > latest) {
      return res.status(400).json({ code: "DATE_OUT_OF_RANGE", message: `Please choose a date within the next ${maxDays} days.` });
    }

    // =========================
    // A) One active/pending request at a time
    // =========================
    // Block if there is any MEET with Pending OR Approved (not completed yet)
    const active = await CounselingRequest.findOne({
      userId,
      type: "MEET",
      status: { $in: ["Pending", "Approved", "Rescheduled"] },
      $or: [{ completedAt: { $exists: false } }, { completedAt: null }],
    })
      .select("_id status date time")
      .lean();

    if (active) {
      return res.status(409).json({
        code: "HAS_ACTIVE_REQUEST",
        message: "You already have an active request. Please wait until it is approved/disapproved (or completed) before booking again.",
      });
    }

    // =========================
    // B) One booking per week (Mon–Sun, Asia/Manila) based on the SESSION date
    //
    // Option B:
    // - A non-cancelled MEET inside the week blocks booking
    // - Cancelled MEETs do NOT block booking until the student cancels 3× in that week
    // =========================
    const { weekStart, weekEnd } = getPHWeekRange(date);

    const weekDocs = await CounselingRequest.find({
      userId,
      type: "MEET",
      date: { $gte: weekStart, $lte: weekEnd },
    })
      .select("status cancelledBy")
      .lean();

    const blockingStatuses = new Set(["Pending", "Approved", "Rescheduled", "Completed"]); // Disapproved does NOT block weekly booking
    const hasBlocking = weekDocs.some((d) => blockingStatuses.has(String(d?.status || "")));

    // Count only student-initiated cancellations (legacy docs without cancelledBy count as Student)
    const studentCancelCount = weekDocs.filter((d) => {
      const st = String(d?.status || "");
      if (st !== "Cancelled") return false;
      const by = String(d?.cancelledBy || "Student");
      return by === "Student";
    }).length;

    if (hasBlocking || studentCancelCount >= 3) {
      return res.status(409).json({
        code: "WEEKLY_LIMIT",
        message: "Weekly limit reached. You can only book one counseling session per week.",
        meta: { weekStart, weekEnd, cancellationsUsed: studentCancelCount },
      });
    }

// counselorId optional: if missing, auto-assign first available counselor for that slot
    let counselor = counselorId ? toObjectIdOrEmpty(counselorId) : null;

    if (!counselor) {
      const counselors = await User.find({ role: "Counselor" })
        .select("_id firstName lastName fullName")
        .sort({ fullName: 1, lastName: 1, firstName: 1 })
        .lean();

      // Availability blocks (Leave/Unavailable) are checked server-side (source of truth).
      const counselorIdsForBlocks = counselors.map((c) => toObjectIdOrEmpty(c._id)).filter(Boolean);
      const blocksForDate = await loadApprovedBlocksForDate({ dateISO: date, counselorIds: counselorIdsForBlocks });
      const { start: slotStart, end: slotEnd } = slotInterval(date, time, 60);


      for (const c of counselors) {
        const cId = toObjectIdOrEmpty(c._id);
        if (!cId) continue;

        // Skip counselors who are blocked (leave/unavailable) for this slot.
        const isBlocked = blocksForDate.some((b) => {
          if (String(b.counselorId) !== String(cId)) return false;
          const bStart = DateTime.fromJSDate(b.startAt, { zone: PH_TZ });
          const bEnd = DateTime.fromJSDate(b.endAt, { zone: PH_TZ });
          return overlaps(bStart, bEnd, slotStart, slotEnd);
        });
        if (isBlocked) continue;


        const conflict = await CounselingRequest.findOne({
          type: "MEET",
          counselorId: cId,
          date,
          time,
          status: { $in: ["Pending", "Approved", "Rescheduled"] },
        })
          .select("_id")
          .lean();

        if (!conflict) {
          counselor = cId;
          break;
        }
      }

      if (!counselor) {
        return res.status(409).json({
          code: "NO_COUNSELOR_AVAILABLE",
          message: "No counselors available for the selected date/time.",
        });
      }
    }

    // Counselor leave/unavailability block check (Approved blocks)
    try {
      const { start: slotStart2, end: slotEnd2 } = slotInterval(date, time, 60);
      const blocked = await AvailabilityBlock.findOne({
        counselorId: counselor,
        status: "Approved",
        startAt: { $lt: slotEnd2.toJSDate() },
        endAt: { $gt: slotStart2.toJSDate() },
      })
        .select("type")
        .lean();

      if (blocked) {
        return res.status(409).json({
          code: "COUNSELOR_UNAVAILABLE",
          message: "Counselor is unavailable for the selected date/time.",
        });
      }
    } catch (e) {
      console.warn("block check failed:", e?.message || e);
    }

    // Slot conflict check (Pending/Approved)
    const conflict = await CounselingRequest.findOne({
      type: "MEET",
      counselorId: counselor,
      date,
      time,
      status: { $in: ["Pending", "Approved", "Rescheduled"] },
    })
      .select("_id")
      .lean();

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
    // Handle duplicate key from unique index (double booking race)
    if (err && (err.code === 11000 || err.name === "MongoServerError")) {
      return res.status(409).json({ code: "SLOT_TAKEN", message: "Time slot already booked." });
    }
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
    const sessionType = req.query.sessionType;
    const past = String(req.query.past || "") === "true";

    const q = {};


    const role = String(req.user?.role || "");
    const counselorObjectId = toObjectIdOrEmpty(req.user?._id || req.user?.id);
    const isPrivileged = role === "Admin" || role === "Counselor" || role === "Consultant";

    // ✅ Default scoping: Students can ONLY see their own requests (even if mine=false)
    if (!isPrivileged) {
      q.userId = req.user?.id;
    } else if (role === "Counselor" && counselorObjectId) {
      // ✅ Counselors (later dashboard) should only see requests assigned to them by default
      // You can expand this later for admin views.
      q.counselorId = counselorObjectId;
    }

    if (mine) q.userId = req.user?.id;
    if (status) q.status = status;
    if (type) q.type = type;
    if (sessionType) q.sessionType = sessionType;

    // Past Meetings filter: MEET where Completed OR date/time already passed
    // Minimal version: just Completed; you can enhance later.
    if (past) {
      q.type = "MEET";
      q.status = { $in: ["Completed"] };
    }

    let query = CounselingRequest.find(q).sort({ createdAt: -1 });

// ✅ For counselor/admin views, populate student + counselor for dashboard UI
if (isPrivileged) {
  query = query
    .populate("userId", "firstName lastName fullName email studentNumber course campus role")
    .populate("counselorId", "firstName lastName fullName email campus role");
}

const items = await query.lean();

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

    const status = String(doc.status || "");

    // Option B cancel rules:
    // - Pending: allowed anytime
    // - Approved/Rescheduled: allowed only if >= 24 hours before the session start (PH time)
    // - otherwise: not allowed
    const allowIf = new Set(["Pending", "Approved", "Rescheduled"]);
    if (!allowIf.has(status)) {
      return res.status(400).json({ code: "INVALID_STATUS", message: "This request cannot be cancelled." });
    }

    if ((status === "Approved" || status === "Rescheduled") && doc.type === "MEET") {
      const now = phNow();
      const slotDt = DateTime.fromISO(`${doc.date}T${doc.time}`, { zone: PH_TZ });
      if (!slotDt.isValid) {
        return res.status(400).json({ code: "INVALID_TIME", message: "Invalid schedule on this request." });
      }

      const cutoff = now.plus({ hours: 24 });
      if (slotDt < cutoff) {
        return res.status(400).json({
          code: "CANCEL_TOO_LATE",
          message: "Too late to cancel. Please contact the counselor.",
        });
      }
    }

    doc.status = "Cancelled";
    doc.cancelledAt = new Date();
    doc.cancelledBy = "Student";
    await doc.save();

    // Optional: if disapproval is due to counselor unavailability, you can block the slot/day
    // so students cannot repeatedly book the same unavailable schedule.
    if (doc.type === "MEET" && doc.counselorId && (blockDay || blockSlot)) {
      try {
        const dateISO = String(doc.date || "").trim();
        const time24 = String(doc.time || "").trim();
        const allDay = !!blockDay;
        const startTime = allDay ? "00:00" : time24;
        const endTime = allDay ? "00:00" : DateTime.fromISO(`${dateISO}T${time24}`, { zone: PH_TZ }).plus({ minutes: 60 }).toFormat("HH:mm");
        const built = buildBlockFromBody(
          {
            counselorId: doc.counselorId,
            date: dateISO,
            allDay,
            startTime,
            endTime,
            type: blockType || "Unavailable",
            note: reason ? String(reason).trim() : "",
          },
          { id: req.user?.id, role: String(req.user?.role || ""), status: "Approved", approvedBy: req.user?.id, approvedAt: new Date() }
        );
        if (built.ok) {
          await AvailabilityBlock.create(built.doc);
        }
      } catch (e) {
        console.warn("auto-block on disapprove failed:", e?.message || e);
      }
    }

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

    // Optional: if disapproval is due to counselor unavailability, you can block the slot/day
    // so students cannot repeatedly book the same unavailable schedule.
    if (doc.type === "MEET" && doc.counselorId && (blockDay || blockSlot)) {
      try {
        const dateISO = String(doc.date || "").trim();
        const time24 = String(doc.time || "").trim();
        const allDay = !!blockDay;
        const startTime = allDay ? "00:00" : time24;
        const endTime = allDay ? "00:00" : DateTime.fromISO(`${dateISO}T${time24}`, { zone: PH_TZ }).plus({ minutes: 60 }).toFormat("HH:mm");
        const built = buildBlockFromBody(
          {
            counselorId: doc.counselorId,
            date: dateISO,
            allDay,
            startTime,
            endTime,
            type: blockType || "Unavailable",
            note: reason ? String(reason).trim() : "",
          },
          { id: req.user?.id, role: String(req.user?.role || ""), status: "Approved", approvedBy: req.user?.id, approvedAt: new Date() }
        );
        if (built.ok) {
          await AvailabilityBlock.create(built.doc);
        }
      } catch (e) {
        console.warn("auto-block on disapprove failed:", e?.message || e);
      }
    }

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
    const { reason, blockDay = false, blockSlot = false, blockType } = req.body || {};

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.status !== "Pending") {
      return res.status(400).json({ code: "INVALID_STATUS", message: "Only pending requests can be disapproved." });
    }

    doc.status = "Disapproved";
    doc.disapprovalReason = reason ? String(reason).trim() : "Disapproved.";
    await doc.save();

    // Optional: if disapproval is due to counselor unavailability, you can block the slot/day
    // so students cannot repeatedly book the same unavailable schedule.
    if (doc.type === "MEET" && doc.counselorId && (blockDay || blockSlot)) {
      try {
        const dateISO = String(doc.date || "").trim();
        const time24 = String(doc.time || "").trim();
        const allDay = !!blockDay;
        const startTime = allDay ? "00:00" : time24;
        const endTime = allDay ? "00:00" : DateTime.fromISO(`${dateISO}T${time24}`, { zone: PH_TZ }).plus({ minutes: 60 }).toFormat("HH:mm");
        const built = buildBlockFromBody(
          {
            counselorId: doc.counselorId,
            date: dateISO,
            allDay,
            startTime,
            endTime,
            type: blockType || "Unavailable",
            note: reason ? String(reason).trim() : "",
          },
          { id: req.user?.id, role: String(req.user?.role || ""), status: "Approved", approvedBy: req.user?.id, approvedAt: new Date() }
        );
        if (built.ok) {
          await AvailabilityBlock.create(built.doc);
        }
      } catch (e) {
        console.warn("auto-block on disapprove failed:", e?.message || e);
      }
    }

    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("disapproveRequest error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};


/**
 * Admin/Counselor: Reschedule MEET
 * PATCH /api/counseling/admin/requests/:id/reschedule
 * Body: { date: "YYYY-MM-DD", time: "HH:MM", sessionType: "Online"|"In-person", note? }
 */
exports.rescheduleMeetRequest = async (req, res) => {
  try {
    const id = req.params.id;
    const { date, time, sessionType, note } = req.body || {};

    if (!date || !time) {
      return res.status(400).json({ code: "MISSING_FIELDS", message: "date and time are required." });
    }

    const allowedSessionTypes = new Set(["Online", "In-person"]);
    const nextSessionType = sessionType ? String(sessionType).trim() : "";
    if (nextSessionType && !allowedSessionTypes.has(nextSessionType)) {
      return res.status(400).json({ code: "INVALID_SESSION_TYPE", message: "Please select a valid session type." });
    }

    const rule = validateMeetRules({ date: String(date).trim(), time: String(time).trim() });
    if (!rule.ok) {
      return res.status(400).json({ code: rule.code, message: rule.message });
    }

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.type !== "MEET") {
      return res.status(400).json({ code: "INVALID_TYPE", message: "Only MEET requests can be rescheduled." });
    }

    // Terminal states cannot be rescheduled
    if (["Cancelled", "Disapproved", "Completed"].includes(String(doc.status || ""))) {
      return res.status(400).json({ code: "INVALID_STATUS", message: "This request cannot be rescheduled." });
    }

    // Extra safety: counselors can only reschedule requests assigned to them (admins can do all)
    const role = String(req.user?.role || "");
    const actorId = toObjectIdOrEmpty(req.user?._id || req.user?.id);
    if (role === "Counselor" && actorId && doc.counselorId && String(doc.counselorId) !== String(actorId)) {
      return res.status(403).json({ message: "Forbidden." });
    }

    const counselorId = doc.counselorId;

    // Slot conflict check (Pending/Approved/Rescheduled)
    const conflict = await CounselingRequest.findOne({
      _id: { $ne: doc._id },
      type: "MEET",
      counselorId,
      date: String(date).trim(),
      time: String(time).trim(),
      status: { $in: ["Pending", "Approved", "Rescheduled"] },
    })
      .select("_id")
      .lean();

    if (conflict) {
      return res.status(409).json({ code: "SLOT_TAKEN", message: "Time slot already booked." });
    }

    // Track previous schedule
    doc.rescheduledFrom = {
      date: doc.date,
      time: doc.time,
      sessionType: doc.sessionType,
    };
    doc.rescheduledAt = new Date();
    doc.rescheduledBy = req.user?.id;
    doc.rescheduleNote = note ? String(note).trim() : doc.rescheduleNote;

    // Apply new schedule
    doc.date = String(date).trim();
    doc.time = String(time).trim();
    if (nextSessionType) doc.sessionType = nextSessionType;

    // If session type changed, keep fields consistent
    if (doc.sessionType === "Online") {
      doc.location = "";
    } else if (doc.sessionType === "In-person") {
      doc.meetingLink = "";
    }

    doc.status = "Rescheduled";

    await doc.save();

    // Optional: if disapproval is due to counselor unavailability, you can block the slot/day
    // so students cannot repeatedly book the same unavailable schedule.
    if (doc.type === "MEET" && doc.counselorId && (blockDay || blockSlot)) {
      try {
        const dateISO = String(doc.date || "").trim();
        const time24 = String(doc.time || "").trim();
        const allDay = !!blockDay;
        const startTime = allDay ? "00:00" : time24;
        const endTime = allDay ? "00:00" : DateTime.fromISO(`${dateISO}T${time24}`, { zone: PH_TZ }).plus({ minutes: 60 }).toFormat("HH:mm");
        const built = buildBlockFromBody(
          {
            counselorId: doc.counselorId,
            date: dateISO,
            allDay,
            startTime,
            endTime,
            type: blockType || "Unavailable",
            note: reason ? String(reason).trim() : "",
          },
          { id: req.user?.id, role: String(req.user?.role || ""), status: "Approved", approvedBy: req.user?.id, approvedAt: new Date() }
        );
        if (built.ok) {
          await AvailabilityBlock.create(built.doc);
        }
      } catch (e) {
        console.warn("auto-block on disapprove failed:", e?.message || e);
      }
    }

    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("rescheduleMeetRequest error:", err);
    // Handle duplicate key from unique index (double booking race)
    if (err && (err.code === 11000 || err.name === "MongoServerError")) {
      return res.status(409).json({ code: "SLOT_TAKEN", message: "Time slot already booked." });
    }
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Admin/Counselor: Set meeting link / location for a MEET request
 * PATCH /api/counseling/admin/requests/:id/meeting-details
 * Body: { meetingLink?, location? }
 */
exports.setMeetingDetails = async (req, res) => {
  try {
    const id = req.params.id;
    const { meetingLink, location } = req.body || {};

    const doc = await CounselingRequest.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Request not found." });

    if (doc.type !== "MEET") {
      return res.status(400).json({ code: "INVALID_TYPE", message: "Only MEET requests can be updated." });
    }

    if (!["Approved", "Rescheduled"].includes(String(doc.status || ""))) {
      return res.status(400).json({ code: "INVALID_STATUS", message: "Meeting details can only be set for approved/rescheduled sessions." });
    }

    // Extra safety: counselors can only update requests assigned to them (admins can do all)
    const role = String(req.user?.role || "");
    const actorId = toObjectIdOrEmpty(req.user?._id || req.user?.id);
    if (role === "Counselor" && actorId && doc.counselorId && String(doc.counselorId) !== String(actorId)) {
      return res.status(403).json({ message: "Forbidden." });
    }

    if (doc.sessionType === "Online") {
      const link = meetingLink != null ? String(meetingLink).trim() : "";
      doc.meetingLink = link;
      doc.location = "";
    } else if (doc.sessionType === "In-person") {
      const loc = location != null ? String(location).trim() : "";
      doc.location = loc;
      doc.meetingLink = "";
    }

    await doc.save();

    // Optional: if disapproval is due to counselor unavailability, you can block the slot/day
    // so students cannot repeatedly book the same unavailable schedule.
    if (doc.type === "MEET" && doc.counselorId && (blockDay || blockSlot)) {
      try {
        const dateISO = String(doc.date || "").trim();
        const time24 = String(doc.time || "").trim();
        const allDay = !!blockDay;
        const startTime = allDay ? "00:00" : time24;
        const endTime = allDay ? "00:00" : DateTime.fromISO(`${dateISO}T${time24}`, { zone: PH_TZ }).plus({ minutes: 60 }).toFormat("HH:mm");
        const built = buildBlockFromBody(
          {
            counselorId: doc.counselorId,
            date: dateISO,
            allDay,
            startTime,
            endTime,
            type: blockType || "Unavailable",
            note: reason ? String(reason).trim() : "",
          },
          { id: req.user?.id, role: String(req.user?.role || ""), status: "Approved", approvedBy: req.user?.id, approvedAt: new Date() }
        );
        if (built.ok) {
          await AvailabilityBlock.create(built.doc);
        }
      } catch (e) {
        console.warn("auto-block on disapprove failed:", e?.message || e);
      }
    }

    return res.json(formatRequest(doc));
  } catch (err) {
    console.error("setMeetingDetails error:", err);
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

    // Optional: if disapproval is due to counselor unavailability, you can block the slot/day
    // so students cannot repeatedly book the same unavailable schedule.
    if (doc.type === "MEET" && doc.counselorId && (blockDay || blockSlot)) {
      try {
        const dateISO = String(doc.date || "").trim();
        const time24 = String(doc.time || "").trim();
        const allDay = !!blockDay;
        const startTime = allDay ? "00:00" : time24;
        const endTime = allDay ? "00:00" : DateTime.fromISO(`${dateISO}T${time24}`, { zone: PH_TZ }).plus({ minutes: 60 }).toFormat("HH:mm");
        const built = buildBlockFromBody(
          {
            counselorId: doc.counselorId,
            date: dateISO,
            allDay,
            startTime,
            endTime,
            type: blockType || "Unavailable",
            note: reason ? String(reason).trim() : "",
          },
          { id: req.user?.id, role: String(req.user?.role || ""), status: "Approved", approvedBy: req.user?.id, approvedAt: new Date() }
        );
        if (built.ok) {
          await AvailabilityBlock.create(built.doc);
        }
      } catch (e) {
        console.warn("auto-block on disapprove failed:", e?.message || e);
      }
    }

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

    // Optional: if disapproval is due to counselor unavailability, you can block the slot/day
    // so students cannot repeatedly book the same unavailable schedule.
    if (doc.type === "MEET" && doc.counselorId && (blockDay || blockSlot)) {
      try {
        const dateISO = String(doc.date || "").trim();
        const time24 = String(doc.time || "").trim();
        const allDay = !!blockDay;
        const startTime = allDay ? "00:00" : time24;
        const endTime = allDay ? "00:00" : DateTime.fromISO(`${dateISO}T${time24}`, { zone: PH_TZ }).plus({ minutes: 60 }).toFormat("HH:mm");
        const built = buildBlockFromBody(
          {
            counselorId: doc.counselorId,
            date: dateISO,
            allDay,
            startTime,
            endTime,
            type: blockType || "Unavailable",
            note: reason ? String(reason).trim() : "",
          },
          { id: req.user?.id, role: String(req.user?.role || ""), status: "Approved", approvedBy: req.user?.id, approvedAt: new Date() }
        );
        if (built.ok) {
          await AvailabilityBlock.create(built.doc);
        }
      } catch (e) {
        console.warn("auto-block on disapprove failed:", e?.message || e);
      }
    }

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

    // Optional: if disapproval is due to counselor unavailability, you can block the slot/day
    // so students cannot repeatedly book the same unavailable schedule.
    if (doc.type === "MEET" && doc.counselorId && (blockDay || blockSlot)) {
      try {
        const dateISO = String(doc.date || "").trim();
        const time24 = String(doc.time || "").trim();
        const allDay = !!blockDay;
        const startTime = allDay ? "00:00" : time24;
        const endTime = allDay ? "00:00" : DateTime.fromISO(`${dateISO}T${time24}`, { zone: PH_TZ }).plus({ minutes: 60 }).toFormat("HH:mm");
        const built = buildBlockFromBody(
          {
            counselorId: doc.counselorId,
            date: dateISO,
            allDay,
            startTime,
            endTime,
            type: blockType || "Unavailable",
            note: reason ? String(reason).trim() : "",
          },
          { id: req.user?.id, role: String(req.user?.role || ""), status: "Approved", approvedBy: req.user?.id, approvedAt: new Date() }
        );
        if (built.ok) {
          await AvailabilityBlock.create(built.doc);
        }
      } catch (e) {
        console.warn("auto-block on disapprove failed:", e?.message || e);
      }
    }

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
    // NOTE: This endpoint is used by the student booking UI to populate the counselor dropdown.
    // It should NOT depend on date/time availability. Availability is fetched separately.
    const counselors = await User.find({ role: "Counselor" })
      .select("_id firstName lastName fullName role counselorCode")
      .sort({ fullName: 1, lastName: 1, firstName: 1 })
      .lean();

    return res.json({
      items: (counselors || []).map((u) => ({
        id: String(u._id),
        name:
          (u.fullName && String(u.fullName).trim()) ||
          [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
          "Counselor",
        role: u.role,
        counselorCode: u.counselorCode || "",
        counselorId: u.counselorCode || "",
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

    // Validate date value + block weekends/holidays (PH calendar)
    const test = DateTime.fromISO(date, { zone: PH_TZ });
    if (!test.isValid) {
      return res.status(400).json({ code: "INVALID_DATE", message: "Invalid date." });
    }
    if (isWeekend(date)) {
      return res.status(400).json({ code: "INVALID_DATE", message: "Weekends are not allowed." });
    }
    if (isHoliday(date)) {
      return res.status(400).json({ code: "INVALID_DATE", message: "Holiday is not allowed." });
    }

    // Booking window (backend source of truth)
    const maxDays = getBookingWindowDays();
    const today = phNow().toISODate();
    const latest = DateTime.fromISO(today, { zone: PH_TZ }).plus({ days: maxDays }).toISODate();
    if (date < today || date > latest) {
      return res.status(400).json({ code: "DATE_OUT_OF_RANGE", message: `Please choose a date within the next ${maxDays} days.` });
    }

    // Work hours (backend source of truth)
    const workHours = { start: "08:00", end: "17:00", stepMin: 60 }; // ✅ 60-minute slots
    const allSlots = generateSlots(workHours.start, workHours.end, workHours.stepMin);

    // Professional scheduling rule:
    // - Past times are not bookable
    // - Minimum lead time is enforced (rounded to next hour boundary)
    const now = phNow();
    const leadMin = getMinLeadMinutes();
    const earliestAllowed = leadMin > 0 ? ceilToNextHour(now.plus({ minutes: leadMin })) : now;

    const gateReason = (t) => {
      // Lunch rule
      if (t === "12:00") return "Lunch break";

      const slotDt = DateTime.fromISO(`${date}T${t}`, { zone: PH_TZ });
      if (!slotDt.isValid) return "Invalid time";

      if (slotDt < now) return "Time passed";
      if (leadMin > 0 && slotDt < earliestAllowed) return `Too soon (earliest ${earliestAllowed.toFormat("MMM d, h:mm a")})`;

      return "";
    };

    // Same-day cancellation rule:
    // - Pending/Approved always block
    // - Cancelled blocks ONLY if cancelledAt is on the SAME (PH) calendar day as the session date
    const toPHDate = (dt) => {
      try {
        return new Date(dt).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // YYYY-MM-DD
      } catch {
        return "";
      }
    };
    const blocksSlot = (doc) => {
      const status = String(doc.status || "");
      if (status === "Pending" || status === "Approved" || status === "Rescheduled") return true;
      if (status === "Cancelled") {
        const cancelledPh = doc.cancelledAt ? toPHDate(doc.cancelledAt) : "";
        return cancelledPh === date;
      }
      return false;
    };

    // ✅ If counselorId is provided, compute for that counselor only (based on bookings)
    if (counselorId) {
      const counselorObj = toObjectIdOrEmpty(counselorId);
      if (!counselorObj) {
        return res.status(400).json({ code: "INVALID_COUNSELOR", message: "Invalid counselorId." });
      }

      const rows = await CounselingRequest.find({
        type: "MEET",
        counselorId: counselorObj,
        date,
        status: { $in: ["Pending", "Approved", "Rescheduled", "Cancelled"] },
      })
        .select("time status cancelledAt")
        .lean();

      const bookedTimes = new Set(rows.filter(blocksSlot).map((b) => b.time));

      // Load approved blocks (leave/unavailable) for this counselor and date
      const blocksForCounselor = await loadApprovedBlocksForDate({ dateISO: date, counselorIds: [counselorObj] });
      const blockedTimeReason = new Map();
      for (const t of allSlots) {
        const { start: s, end: e } = slotInterval(date, t, workHours.stepMin);
        const hit = blocksForCounselor.find((b) => {
          const bStart = DateTime.fromJSDate(b.startAt, { zone: PH_TZ });
          const bEnd = DateTime.fromJSDate(b.endAt, { zone: PH_TZ });
          return overlaps(bStart, bEnd, s, e);
        });
        if (hit) blockedTimeReason.set(t, blockReason(hit));
      }

      return res.json({
        date,
        counselorId,
        workHours,
        leadMinutes: leadMin,
        earliestAllowed: earliestAllowed.toISO(),
        slots: allSlots.map((t) => {
          const gated = gateReason(t);
          if (gated) return { time: t, enabled: false, reason: gated };
          const bReason = blockedTimeReason.get(t);
          if (bReason) return { time: t, enabled: false, reason: bReason };
          if (bookedTimes.has(t)) return { time: t, enabled: false, reason: "Booked" };
          return { time: t, enabled: true };
        }),
      });
    }

    // ✅ No counselorId provided: "any counselor" availability
    // Counselors are stored in Users (role: Counselor)
    const counselors = await User.find({ role: "Counselor" })
      .select("_id firstName lastName fullName")
      .lean();

    if (counselors.length === 0) {
      return res.json({
        date,
        counselorId: null,
        workHours,
        leadMinutes: leadMin,
        earliestAllowed: earliestAllowed.toISO(),
        slots: allSlots.map((t) => {
          const gated = gateReason(t);
          if (gated) return { time: t, enabled: false, reason: gated };
          return { time: t, enabled: false, reason: "No counselors available" };
        }),
      });
    }

    // Load approved blocks (leave/unavailable) for the date (any counselor)
    const counselorIdsAll = counselors.map((c) => toObjectIdOrEmpty(c._id)).filter(Boolean);
    const blocksForAll = await loadApprovedBlocksForDate({ dateISO: date, counselorIds: counselorIdsAll });

    // Load bookings for the date (any counselor)
    const bookings = await CounselingRequest.find({
      type: "MEET",
      date,
      status: { $in: ["Pending", "Approved", "Rescheduled", "Cancelled"] },
    })
      .select("time counselorId status cancelledAt")
      .lean();

    // Map: time -> set(booked counselorIds)
    const bookedMap = new Map();

    // Map: time -> set(blocked counselorIds)
    const blockedMap = new Map();
    for (const b of blocksForAll) {
      const cId = String(b.counselorId || "");
      if (!cId) continue;
      for (const t of allSlots) {
        const { start: s, end: e } = slotInterval(date, t, workHours.stepMin);
        const bStart = DateTime.fromJSDate(b.startAt, { zone: PH_TZ });
        const bEnd = DateTime.fromJSDate(b.endAt, { zone: PH_TZ });
        if (!overlaps(bStart, bEnd, s, e)) continue;
        if (!blockedMap.has(t)) blockedMap.set(t, new Set());
        blockedMap.get(t).add(cId);
      }
    }

    for (const b of bookings) {
      if (!blocksSlot(b)) continue;
      const t = b.time;
      const cId = String(b.counselorId || "");
      if (!bookedMap.has(t)) bookedMap.set(t, new Set());
      bookedMap.get(t).add(cId);
    }

    const roster = counselors.map((c) => ({
      id: String(c._id),
      name: c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || "Counselor",
    }));

    const slots = allSlots.map((t) => {
      const gated = gateReason(t);
      if (gated) return { time: t, enabled: false, reason: gated };

      const bookedSet = bookedMap.get(t) || new Set();
      const blockedSet = blockedMap.get(t) || new Set();
      const available = roster.filter((c) => !bookedSet.has(c.id) && !blockedSet.has(c.id));

      if (available.length === 0) return { time: t, enabled: false, reason: "No counselors available" };

      return {
        time: t,
        enabled: true,
        availableCounselors: available,
      };
    });

    return res.json({ date, counselorId: null, workHours, leadMinutes: leadMin, earliestAllowed: earliestAllowed.toISO(), slots });
  } catch (err) {
    console.error("getAvailability error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

// ---------- shared helpers ----------
function toObjectIdOrEmpty(value) {
  try {
    if (!value) return null;
    const s = String(value).trim();
    if (!s) return null;
    return new mongoose.Types.ObjectId(s);
  } catch {
    return null;
  }
}

// Calendar-week range (Mon–Sun) in Asia/Manila, using the SESSION date (YYYY-MM-DD)
function getPHWeekRange(yyyyMmDd) {
  // Build a date pinned to Asia/Manila midnight (+08:00)
  const d = new Date(`${yyyyMmDd}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return { weekStart: yyyyMmDd, weekEnd: yyyyMmDd };

  // In JS: Sunday=0 ... Saturday=6
  const dow = d.getUTCDay(); // because we pinned the offset above, UTC day equals PH day
  const diffToMon = (dow + 6) % 7; // 0 if Mon, 6 if Sun

  const monday = new Date(d);
  monday.setUTCDate(monday.getUTCDate() - diffToMon);

  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);

  const toPH = (dt) => dt.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // YYYY-MM-DD
  return { weekStart: toPH(monday), weekEnd: toPH(sunday) };
}

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
  for (let t = start; t < end; t += stepMin) {
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

    cancelledAt: o.cancelledAt,
    cancelledBy: o.cancelledBy,
    rescheduledAt: o.rescheduledAt,
    rescheduledBy: o.rescheduledBy,
    rescheduledFrom: o.rescheduledFrom,
    rescheduleNote: o.rescheduleNote,

    approvedBy: o.approvedBy,
    disapprovalReason: o.disapprovalReason,
    meetingLink: o.meetingLink,
    location: o.location,
    completedAt: o.completedAt,
  };
}

// ----


// ===================== Leave/Unavailability helpers (grouped requests) =====================
function getCounselorLeaveMaxDays() {
  const raw = process.env.COUNSELOR_LEAVE_MAX_DAYS || "5";
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(Math.max(n, 1), 30);
}

function makeAvailabilityGroupId() {
  // Use an ObjectId-like string for easy debugging and uniqueness.
  return new mongoose.Types.ObjectId().toString();
}

function phDayBoundsNow() {
  const start = phNow().startOf("day");
  const end = start.plus({ days: 1 });
  return { start, end };
}

function enumeratePHDateRange(startISO, endISO) {
  const s = DateTime.fromISO(String(startISO || ""), { zone: PH_TZ }).startOf("day");
  const e = DateTime.fromISO(String(endISO || ""), { zone: PH_TZ }).startOf("day");
  if (!s.isValid || !e.isValid) return [];
  if (e < s) return [];
  const out = [];
  let cur = s;
  let guard = 0;
  while (cur <= e && guard < 370) {
    out.push(cur.toISODate()); // YYYY-MM-DD
    cur = cur.plus({ days: 1 });
    guard += 1;
  }
  return out;
}

function normalizeLeaveRequestDates(body) {
  const b = body || {};
  const arr = Array.isArray(b.dates) ? b.dates : [];
  if (arr.length) {
    return arr.map(normalizeDateInput).filter(Boolean);
  }

  const startDate = b.startDate ? normalizeDateInput(b.startDate) : "";
  const endDate = b.endDate ? normalizeDateInput(b.endDate) : "";
  if (startDate && endDate) {
    return enumeratePHDateRange(startDate, endDate);
  }

  const date = b.date ? normalizeDateInput(b.date) : "";
  return date ? [date] : [];
}

function pickGroupStatus(docs) {
  const s = new Set((docs || []).map((d) => String(d?.status || "")));
  if (s.has("Cancelled")) return "Cancelled";
  if (s.has("Rejected")) return "Rejected";
  if (s.has("Pending")) return "Pending";
  if (s.has("Approved")) return "Approved";
  return String(docs?.[0]?.status || "Pending");
}

function minDate(values) {
  let best = null;
  for (const v of values) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (!Number.isFinite(t)) continue;
    if (!best || t < best.getTime()) best = new Date(t);
  }
  return best;
}

function maxDate(values) {
  let best = null;
  for (const v of values) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (!Number.isFinite(t)) continue;
    if (!best || t > best.getTime()) best = new Date(t);
  }
  return best;
}

/**
 * Group per-day block docs into a single "request" item (date range / multi-date),
 * while keeping per-day docs in the DB for accurate slot blocking.
 *
 * The representative _id stays an ObjectId so existing endpoints still work:
 * - /blocks/:id/cancel-request
 * - /admin/blocks/:id/approve|reject|cancel/approve|cancel/reject
 */
function groupAvailabilityBlocksForResponse(items) {
  const list = Array.isArray(items) ? items : [];
  const buckets = new Map();

  for (const b of list) {
    const gid = String(b?.groupId || "").trim();
    const key = gid || String(b?._id || b?.id || "");
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(b);
  }

  const grouped = [];

  for (const [key, docs] of buckets.entries()) {
    if (!docs.length) continue;

    const byStart = docs.slice().sort((a, b) => new Date(a?.startAt || 0) - new Date(b?.startAt || 0));
    const rep = byStart[0];

    const startAt = minDate(byStart.map((d) => d?.startAt));
    const endAt = maxDate(byStart.map((d) => d?.endAt));

    const createdAt = maxDate(byStart.map((d) => d?.createdAt)) || rep?.createdAt;
    const updatedAt = maxDate(byStart.map((d) => d?.updatedAt)) || rep?.updatedAt;

    const status = pickGroupStatus(byStart);

    const cancelRequestedAt = maxDate(byStart.map((d) => d?.cancelRequestedAt));
    const cancelApprovedAt = maxDate(byStart.map((d) => d?.cancelApprovedAt));
    const cancelRejectedAt = maxDate(byStart.map((d) => d?.cancelRejectedAt));

    // Merge into a single response item.
    grouped.push({
      ...rep,
      startAt: startAt || rep?.startAt,
      endAt: endAt || rep?.endAt,
      status,
      createdAt,
      updatedAt,
      daysCount: byStart.length,
      groupId: String(rep?.groupId || "").trim(),
      cancelRequestedAt: cancelRequestedAt || rep?.cancelRequestedAt || null,
      cancelApprovedAt: cancelApprovedAt || rep?.cancelApprovedAt || null,
      cancelRejectedAt: cancelRejectedAt || rep?.cancelRejectedAt || null,
    });
  }

  // Sort newest-first (use createdAt first; fallback to startAt).
  grouped.sort((a, b) => {
    const A = new Date(a?.createdAt || a?.startAt || 0).getTime();
    const B = new Date(b?.createdAt || b?.startAt || 0).getTime();
    return B - A;
  });

  return grouped;
}


// ===================== Availability Blocks API =====================

// ---- grouping helpers (for multi-day submissions) ----
function minDate(arr) {
  const xs = (Array.isArray(arr) ? arr : []).filter(Boolean).map((d) => new Date(d).getTime()).filter(Number.isFinite);
  if (!xs.length) return null;
  return new Date(Math.min(...xs));
}

function maxDate(arr) {
  const xs = (Array.isArray(arr) ? arr : []).filter(Boolean).map((d) => new Date(d).getTime()).filter(Number.isFinite);
  if (!xs.length) return null;
  return new Date(Math.max(...xs));
}

function pickGroupStatus(docs) {
  const list = Array.isArray(docs) ? docs : [];
  const statuses = new Set(list.map((d) => String(d?.status || "")));

  // Cancellation approved by admin becomes the final state.
  if (statuses.has("Cancelled")) return "Cancelled";
  if (statuses.has("Pending")) return "Pending";
  if (statuses.has("Rejected")) return "Rejected";
  return "Approved";
}

/**
 * Group per-day docs into a single "request" item for UI.
 *
 * If groupId exists, we bucket by groupId; otherwise we bucket by _id.
 * The representative _id stays an ObjectId so existing endpoints still work:
 * - /blocks/:id/cancel-request
 * - /admin/blocks/:id/approve|reject|cancel/approve|cancel/reject
 */
function groupAvailabilityBlocksForResponse(items) {
  const list = Array.isArray(items) ? items : [];
  const buckets = new Map();

  for (const b of list) {
    const gid = String(b?.groupId || "").trim();
    const key = gid || String(b?._id || b?.id || "");
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(b);
  }

  const grouped = [];

  for (const [key, docs] of buckets.entries()) {
    if (!docs.length) continue;

    const byStart = docs.slice().sort((a, b) => new Date(a?.startAt || 0) - new Date(b?.startAt || 0));
    const rep = byStart[0];

    const startAt = minDate(byStart.map((d) => d?.startAt)) || rep?.startAt;
    const endAt = maxDate(byStart.map((d) => d?.endAt)) || rep?.endAt;

    const createdAt = maxDate(byStart.map((d) => d?.createdAt)) || rep?.createdAt;
    const updatedAt = maxDate(byStart.map((d) => d?.updatedAt)) || rep?.updatedAt;

    const status = pickGroupStatus(byStart);

    const cancelRequestedAt = maxDate(byStart.map((d) => d?.cancelRequestedAt));
    const cancelApprovedAt = maxDate(byStart.map((d) => d?.cancelApprovedAt));
    const cancelRejectedAt = maxDate(byStart.map((d) => d?.cancelRejectedAt));

    grouped.push({
      ...rep,
      startAt,
      endAt,
      status,
      createdAt,
      updatedAt,
      daysCount: byStart.length,
      groupId: String(rep?.groupId || "").trim(),
      cancelRequestedAt: cancelRequestedAt || rep?.cancelRequestedAt || null,
      cancelApprovedAt: cancelApprovedAt || rep?.cancelApprovedAt || null,
      cancelRejectedAt: cancelRejectedAt || rep?.cancelRejectedAt || null,
    });
  }

  // Newest first
  grouped.sort((a, b) => {
    const A = new Date(a?.createdAt || a?.startAt || 0).getTime();
    const B = new Date(b?.createdAt || b?.startAt || 0).getTime();
    return B - A;
  });

  return grouped;
}

function makeAvailabilityGroupId() {
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function phDayBoundsNow() {
  const now = phNow();
  const start = now.startOf("day");
  const end = start.plus({ days: 1 });
  return { start, end };
}

function getCounselorLeaveMaxDays() {
  const raw =
    process.env.COUNSELOR_LEAVE_MAX_WEEKDAYS ||
    process.env.LEAVE_MAX_DAYS ||
    process.env.AVAILABILITY_MAX_DAYS ||
    "5";
  const n = parseInt(String(raw), 10);
  if (Number.isFinite(n) && n >= 1 && n <= 31) return n;
  return 5;
}

/**
 * Supports any of these payload shapes:
 * - { date: "YYYY-MM-DD" }
 * - { dates: ["YYYY-MM-DD", ...] }
 * - { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" } (inclusive)
 */
function normalizeLeaveRequestDates(body) {
  const b = body || {};
  if (Array.isArray(b.dates)) return b.dates;

  const start = b.startDate || b.start || "";
  const end = b.endDate || b.end || "";
  if (start && end) {
    const s = DateTime.fromISO(normalizeDateInput(start), { zone: PH_TZ });
    const e = DateTime.fromISO(normalizeDateInput(end), { zone: PH_TZ });
    if (!s.isValid || !e.isValid) return [];
    const forward = e >= s;
    const days = [];
    const maxSpan = 45; // safety cap
    for (let i = 0; i <= maxSpan; i++) {
      const d = (forward ? s.plus({ days: i }) : s.minus({ days: i })).toISODate();
      days.push(d);
      if (d === e.toISODate()) break;
    }
    return days;
  }

  if (b.date) return [b.date];
  return [];
}

/**
 * Admin: List blocks (Approved/Pending/Rejected/Cancelled)
 * GET /api/counseling/admin/blocks?counselorId=&status=&cancelRequested=true
 */
exports.listAdminAvailabilityBlocks = async (req, res) => {
  try {
    const counselorId = req.query.counselorId ? toObjectIdOrEmpty(req.query.counselorId) : null;
    const status = req.query.status ? String(req.query.status).trim() : "";
    const cancelRequested = String(req.query.cancelRequested || "") === "true";

    const q = {};
    if (counselorId) q.counselorId = counselorId;

    // UX rules:
    // - "Cancelled" tab = only blocks with status Cancelled (admin-approved cancellation)
    // - Cancellation requests should show under "Pending" (even if underlying block is Approved)
    // - Cancellation requests should NOT show under "Approved" or "Cancelled"
    if (cancelRequested) {
      q.cancelRequestedAt = { $exists: true, $ne: null };
      q.status = { $ne: "Cancelled" };
    } else if (status) {
      if (status === "Pending") {
        q.$or = [
          { status: "Pending" },
          { cancelRequestedAt: { $exists: true, $ne: null }, status: { $ne: "Cancelled" } },
        ];
      } else {
        q.status = status;
        if (status !== "Cancelled") {
          q.cancelRequestedAt = null; // matches null OR not present
        }
      }
    }

    const raw = await AvailabilityBlock.find(q).sort({ createdAt: -1 }).limit(1000).lean();
    const items = groupAvailabilityBlocksForResponse(raw);
    return res.json({ items });
  } catch (err) {
    console.error("listAdminAvailabilityBlocks error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Admin: Create an APPROVED block
 * POST /api/counseling/admin/blocks
 * Body: { counselorId, date, allDay?, startTime?, endTime?, type?, note? }
 */
exports.createAdminAvailabilityBlock = async (req, res) => {
  try {
    const { counselorId, date, allDay, startTime, endTime, type, note } = req.body || {};
    const counselorObj = toObjectIdOrEmpty(counselorId);
    if (!counselorObj) return res.status(400).json({ code: "INVALID_COUNSELOR", message: "Invalid counselorId." });

    const built = buildBlockFromBody(
      { counselorId: counselorObj, date, allDay: !!allDay, startTime, endTime, type, note },
      { id: String(req.user?._id || req.user?.id), role: String(req.user?.role || ""), status: "Approved" }
    );
    if (!built.ok) return res.status(400).json({ code: built.code, message: built.message });

    const doc = await AvailabilityBlock.create(built.doc);
    return res.status(201).json(doc);
  } catch (err) {
    console.error("createAdminAvailabilityBlock error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Admin: Delete a block (removes a whole group if applicable)
 * DELETE /api/counseling/admin/blocks/:id
 */
exports.deleteAdminAvailabilityBlock = async (req, res) => {
  try {
    const id = toObjectIdOrEmpty(req.params.id);
    if (!id) return res.status(400).json({ code: "INVALID_ID", message: "Invalid id." });

    const doc = await AvailabilityBlock.findById(id).lean();
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Block not found." });

    const gid = String(doc?.groupId || "").trim();
    const q = gid ? { groupId: gid } : { _id: doc._id };

    await AvailabilityBlock.deleteMany(q);
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteAdminAvailabilityBlock error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Admin: Approve a counselor-requested block (approves whole group if applicable)
 * PATCH /api/counseling/admin/blocks/:id/approve
 */
exports.approveAvailabilityBlockRequest = async (req, res) => {
  try {
    const id = toObjectIdOrEmpty(req.params.id);
    if (!id) return res.status(400).json({ code: "INVALID_ID", message: "Invalid id." });

    const doc = await AvailabilityBlock.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Block not found." });

    const gid = String(doc?.groupId || "").trim();
    const q = gid ? { groupId: gid } : { _id: doc._id };

    await AvailabilityBlock.updateMany(q, {
      $set: {
        status: "Approved",
        approvedBy: req.user?.id,
        approvedAt: new Date(),
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: "",
      },
    });

    const fresh = await AvailabilityBlock.findById(doc._id).lean();
    return res.json(fresh);
  } catch (err) {
    console.error("approveAvailabilityBlockRequest error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Admin: Reject a counselor-requested block (rejects whole group if applicable)
 * PATCH /api/counseling/admin/blocks/:id/reject
 * Body: { reason? }
 */
exports.rejectAvailabilityBlockRequest = async (req, res) => {
  try {
    const id = toObjectIdOrEmpty(req.params.id);
    if (!id) return res.status(400).json({ code: "INVALID_ID", message: "Invalid id." });

    const doc = await AvailabilityBlock.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Block not found." });

    const gid = String(doc?.groupId || "").trim();
    const q = gid ? { groupId: gid } : { _id: doc._id };

    await AvailabilityBlock.updateMany(q, {
      $set: {
        status: "Rejected",
        rejectedBy: req.user?.id,
        rejectedAt: new Date(),
        rejectionReason: req.body?.reason ? String(req.body.reason).trim() : doc.rejectionReason || "Rejected.",
        approvedBy: null,
        approvedAt: null,
        // Clear any pending cancellation request if admin rejects the original request.
        cancelRequestedAt: null,
        cancelRequestedBy: null,
      },
    });

    const fresh = await AvailabilityBlock.findById(doc._id).lean();
    return res.json(fresh);
  } catch (err) {
    console.error("rejectAvailabilityBlockRequest error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Counselor: List my blocks (grouped for UI)
 * GET /api/counseling/blocks/mine
 */
exports.listMyAvailabilityBlocks = async (req, res) => {
  try {
    const me = toObjectIdOrEmpty(req.user?._id || req.user?.id);
    if (!me) return res.status(401).json({ message: "Unauthorized" });

    const raw = await AvailabilityBlock.find({ counselorId: me }).sort({ createdAt: -1 }).limit(800).lean();
    const items = groupAvailabilityBlocksForResponse(raw);
    return res.json({ items });
  } catch (err) {
    console.error("listMyAvailabilityBlocks error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Counselor: Request leave/unavailability (PENDING)
 * POST /api/counseling/blocks/request
 * Body: { date | dates[] | startDate/endDate, allDay?, startTime?, endTime?, type?, note? }
 */
exports.requestAvailabilityBlock = async (req, res) => {
  try {
    const me = toObjectIdOrEmpty(req.user?._id || req.user?.id);
    if (!me) return res.status(401).json({ message: "Unauthorized" });

    const role = String(req.user?.role || "");
    if (role !== "Counselor") {
      return res.status(403).json({ message: "Forbidden." });
    }

    const maxDays = getCounselorLeaveMaxDays();

    // One submission per PH calendar day (counselor-created docs)
    const { start: dayStart, end: dayEnd } = phDayBoundsNow();
    const already = await AvailabilityBlock.findOne({
      counselorId: me,
      createdBy: me,
      createdAt: { $gte: dayStart.toJSDate(), $lt: dayEnd.toJSDate() },
    })
      .select("_id")
      .lean();

    if (already) {
      return res.status(409).json({
        code: "DAILY_LIMIT",
        message: "You can only submit one leave/unavailability request per day.",
      });
    }

    const { allDay, startTime, endTime, type, note } = req.body || {};

    const datesAll = normalizeLeaveRequestDates(req.body);

    // Validate date formats and validity
    const validDates = datesAll
      .map((d) => normalizeDateInput(d))
      .map((d) => String(d || "").trim())
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .filter((d) => DateTime.fromISO(d, { zone: PH_TZ }).isValid);

    if (!validDates.length) {
      return res.status(400).json({ code: "MISSING_DATE", message: "Please choose a valid date." });
    }

    // Separate weekdays vs weekends (weekends are skipped)
    const weekdays = [];
    const weekendsSkipped = [];
    for (const d of validDates) {
      if (isWeekend(d)) weekendsSkipped.push(d);
      else weekdays.push(d);
    }

    if (!weekdays.length) {
      return res.status(400).json({ code: "NO_WEEKDAYS", message: "Weekends are skipped. Please include at least one weekday." });
    }

    if (weekdays.length > maxDays) {
      return res.status(400).json({
        code: "MAX_DAYS",
        message: `You can only request up to ${maxDays} weekday(s) per submission.`,
        meta: { maxDays },
      });
    }

    const cleanNote = String(note || "").trim();
    if (weekdays.length >= 3 && !cleanNote) {
      return res.status(400).json({ code: "NOTE_REQUIRED", message: "Please provide a note/reason when requesting 3 or more days." });
    }

    // Build per-day docs and group them for UI
    const groupId = weekdays.length > 1 ? makeAvailabilityGroupId() : "";

    const actor = {
      id: String(req.user?._id || req.user?.id || me),
      role: String(req.user?.role || ""),
      status: "Pending",
    };

    const docs = [];
    for (const d of weekdays) {
      const built = buildBlockFromBody(
        { counselorId: me, date: d, allDay: !!allDay, startTime, endTime, type, note: cleanNote },
        actor
      );
      if (!built.ok) return res.status(400).json({ code: built.code, message: built.message });

      if (groupId) built.doc.groupId = groupId;
      docs.push(built.doc);
    }

    const created = await AvailabilityBlock.insertMany(docs, { ordered: true });
    const grouped = groupAvailabilityBlocksForResponse(created.map((d) => (d.toObject ? d.toObject() : d)));

    return res.status(201).json({
      items: created,
      item: grouped[0] || null,
      meta: {
        groupId: groupId || null,
        weekdaysCount: weekdays.length,
        weekendsSkipped,
        maxDays,
      },
    });
  } catch (err) {
    console.error("requestAvailabilityBlock error:", err);

    if (err?.name === "ValidationError" || err?.name === "CastError") {
      const msg = process.env.NODE_ENV === "production" ? "Invalid request." : err?.message || "Invalid request.";
      return res.status(400).json({ message: msg });
    }

    const msg = process.env.NODE_ENV === "production" ? "Server error." : err?.message || "Server error.";
    return res.status(500).json({ message: msg });
  }
};

/**
 * Counselor: Request cancellation of a block (goes to Admin for approval)
 * PATCH /api/counseling/blocks/:id/cancel-request
 * Body: { reason? }
 */
exports.requestCancelAvailabilityBlock = async (req, res) => {
  try {
    const me = toObjectIdOrEmpty(req.user?._id || req.user?.id);
    if (!me) return res.status(401).json({ message: "Unauthorized" });

    const id = toObjectIdOrEmpty(req.params.id);
    if (!id) return res.status(400).json({ code: "INVALID_ID", message: "Invalid id." });

    const doc = await AvailabilityBlock.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Block not found." });

    if (String(doc.counselorId) !== String(me)) {
      return res.status(403).json({ message: "Forbidden." });
    }

    const status = String(doc.status || "");
    if (status === "Cancelled") {
      return res.status(400).json({ code: "ALREADY_CANCELLED", message: "This block is already cancelled." });
    }

    // Only allow cancellation requests for blocks that are still meaningful.
    if (!["Pending", "Approved"].includes(status)) {
      return res.status(400).json({ code: "INVALID_STATUS", message: "Only pending/approved blocks can be cancelled." });
    }

    // Don’t allow re-requesting after a decision.
    if (doc.cancelApprovedAt || doc.cancelRejectedAt) {
      return res.status(400).json({ code: "CANCEL_DECIDED", message: "This cancellation request has already been decided." });
    }

    if (doc.cancelRequestedAt) {
      return res.status(400).json({ code: "ALREADY_REQUESTED", message: "Cancellation already requested for this block." });
    }

    const gid = String(doc?.groupId || "").trim();
    const q = gid ? { groupId: gid } : { _id: doc._id };

    await AvailabilityBlock.updateMany(q, {
      $set: {
        cancelRequestedAt: new Date(),
        cancelRequestedBy: me,
        cancelReason: req.body?.reason ? String(req.body.reason).trim() : doc.cancelReason,
        // reset stale UI-only fields
        cancelRejectionReason: "",
      },
    });

    const fresh = await AvailabilityBlock.findById(doc._id).lean();
    return res.json(fresh);
  } catch (err) {
    console.error("requestCancelAvailabilityBlock error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Admin: Approve cancellation request
 * PATCH /api/counseling/admin/blocks/:id/cancel/approve
 */
exports.approveCancelAvailabilityBlock = async (req, res) => {
  try {
    const id = toObjectIdOrEmpty(req.params.id);
    if (!id) return res.status(400).json({ code: "INVALID_ID", message: "Invalid id." });

    const doc = await AvailabilityBlock.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Block not found." });

    if (String(doc.status || "") === "Cancelled") {
      return res.status(400).json({ code: "ALREADY_CANCELLED", message: "This block is already cancelled." });
    }

    if (!doc.cancelRequestedAt) {
      return res.status(400).json({ code: "NO_CANCEL_REQUEST", message: "No cancellation request on this block." });
    }

    const gid = String(doc?.groupId || "").trim();
    const q = gid ? { groupId: gid } : { _id: doc._id };

    await AvailabilityBlock.updateMany(q, {
      $set: {
        status: "Cancelled",
        cancelApprovedAt: new Date(),
        cancelApprovedBy: req.user?.id,
        cancelRejectedAt: null,
        cancelRejectedBy: null,
        cancelRejectionReason: "",
      },
      $unset: {
        cancelRequestedAt: "",
        cancelRequestedBy: "",
      },
    });

    const fresh = await AvailabilityBlock.findById(doc._id).lean();
    return res.json(fresh);
  } catch (err) {
    console.error("approveCancelAvailabilityBlock error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

/**
 * Admin: Reject cancellation request
 * PATCH /api/counseling/admin/blocks/:id/cancel/reject
 * Body: { reason? }
 */
exports.rejectCancelAvailabilityBlock = async (req, res) => {
  try {
    const id = toObjectIdOrEmpty(req.params.id);
    if (!id) return res.status(400).json({ code: "INVALID_ID", message: "Invalid id." });

    const doc = await AvailabilityBlock.findById(id);
    if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Block not found." });

    if (String(doc.status || "") === "Cancelled") {
      return res.status(400).json({ code: "ALREADY_CANCELLED", message: "This block is already cancelled." });
    }

    if (!doc.cancelRequestedAt) {
      return res.status(400).json({ code: "NO_CANCEL_REQUEST", message: "No cancellation request on this block." });
    }

    const gid = String(doc?.groupId || "").trim();
    const q = gid ? { groupId: gid } : { _id: doc._id };

    await AvailabilityBlock.updateMany(q, {
      $set: {
        cancelRejectedAt: new Date(),
        cancelRejectedBy: req.user?.id,
        cancelRejectionReason: req.body?.reason ? String(req.body.reason).trim() : doc.cancelRejectionReason || "Rejected.",
      },
      $unset: {
        cancelRequestedAt: "",
        cancelRequestedBy: "",
      },
    });

    const fresh = await AvailabilityBlock.findById(doc._id).lean();
    return res.json(fresh);
  } catch (err) {
    console.error("rejectCancelAvailabilityBlock error:", err);
    return res.status(500).json({ message: "Server error." });
  }
};

