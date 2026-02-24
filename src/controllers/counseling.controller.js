const CounselingRequest = require("../models/CounselingRequest");
const { DateTime } = require("luxon");
const { validateMeetRules, phNow, PH_TZ, getMinLeadMinutes, ceilToNextHour, isWeekend, isHoliday } = require("../utils/counselingValidation");
const { generateTimeSlots } = require("../utils/availability");
const User = require("../models/User.model");
const mongoose = require("mongoose");
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
    // =========================
    const { weekStart, weekEnd } = getPHWeekRange(date);

    const weekly = await CounselingRequest.findOne({
      userId,
      type: "MEET",
      date: { $gte: weekStart, $lte: weekEnd },
    })
      .select("_id status date time")
      .lean();

    if (weekly) {
      return res.status(409).json({
        code: "WEEKLY_LIMIT",
        message: "Weekly limit reached. You can only book one counseling session per week.",
        meta: { weekStart, weekEnd },
      });
    }

    // counselorId optional: if missing, auto-assign first available counselor for that slot
    let counselor = counselorId ? toObjectIdOrEmpty(counselorId) : null;

    if (!counselor) {
      const counselors = await User.find({ role: "Counselor" })
        .select("_id firstName lastName fullName")
        .sort({ fullName: 1, lastName: 1, firstName: 1 })
        .lean();

      for (const c of counselors) {
        const cId = toObjectIdOrEmpty(c._id);
        if (!cId) continue;

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
    if (doc.status !== "Pending") {
      return res.status(400).json({ code: "INVALID_STATUS", message: "Only pending requests can be cancelled." });
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
    const users = await User.find({ role: "Counselor" })
      .select("_id firstName lastName fullName role")
      .sort({ fullName: 1, lastName: 1, firstName: 1 })
      .lean();

    return res.json({
      items: users.map((u) => ({
        id: String(u._id),
        name: u.fullName || [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || "Counselor",
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

      return res.json({
        date,
        counselorId,
        workHours,
        leadMinutes: leadMin,
        earliestAllowed: earliestAllowed.toISO(),
        slots: allSlots.map((t) => {
          const gated = gateReason(t);
          if (gated) return { time: t, enabled: false, reason: gated };
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
      const available = roster.filter((c) => !bookedSet.has(c.id));

      if (available.length === 0) return { time: t, enabled: false, reason: "Booked" };

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