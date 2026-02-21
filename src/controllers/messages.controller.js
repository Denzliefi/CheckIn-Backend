// backend/src/controllers/messages.controller.js
const mongoose = require("mongoose");
const User = require("../models/User.model");
const MessageThread = require("../models/MessageThread.model");
const Message = require("../models/Message.model");
const { getIO } = require("../config/socket");

/* -----------------------------
   Helpers
----------------------------- */
function asId(v) {
  try {
    if (!v) return null;
    return new mongoose.Types.ObjectId(String(v));
  } catch {
    return null;
  }
}

function cleanText(v) {
  return String(v ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 2000);
}

function roleLower(user) {
  return String(user?.role || "").toLowerCase();
}

function isCounselor(user) {
  return roleLower(user) === "counselor";
}

function senderRoleLabel(user) {
  const r = roleLower(user);
  if (r === "counselor") return "Counselor";
  if (r === "admin") return "Admin";
  return "Student";
}

function mapToObject(maybeMap) {
  if (!maybeMap) return {};
  if (typeof maybeMap === "object" && !("get" in maybeMap)) return maybeMap;
  const out = {};
  for (const [k, v] of maybeMap.entries()) out[String(k)] = Number(v) || 0;
  return out;
}

function getUnreadFor(thread, userId) {
  const obj = mapToObject(thread?.unreadCounts);
  return Number(obj?.[String(userId)] || 0);
}

// Mask student identity for counselors until claimed by them (or anonymous)
function maskThreadForViewer(thread, viewer) {
  const t = { ...thread };
  const vId = String(viewer?._id || "");
  const vIsCounselor = isCounselor(viewer);

  const assignedId = t.counselorId ? String(t.counselorId?._id || t.counselorId) : "";
  const isAssignedToMe = assignedId && assignedId === vId;

  if (vIsCounselor) {
    // anonymous always hides
    if (t.anonymous) {
      t.studentId = null;
    } else if (!isAssignedToMe) {
      // unclaimed or claimed by someone else -> hide
      t.studentId = null;
    }
  }

  return t;
}

function messageDto(m) {
  return {
    _id: String(m._id),
    threadId: String(m.threadId),
    senderId: String(m.senderId),
    senderRole: m.senderRole,
    text: m.text,
    createdAt: m.createdAt,
  };
}

async function getMessagesForThread(threadId, limit = 40) {
  const lim = Math.min(Math.max(Number(limit) || 40, 1), 200);
  const latest = await Message.find({ threadId })
    .sort({ createdAt: -1 })
    .limit(lim)
    .lean();

  return latest.reverse().map(messageDto);
}

function canAccessThread(thread, viewer) {
  if (!viewer?._id) return false;
  if (isCounselor(viewer)) return true; // system-wide read
  return String(thread.studentId?._id || thread.studentId) === String(viewer._id);
}

function threadDto(thread, { viewer, includeMessages = false, messages = [] } = {}) {
  const t = viewer ? maskThreadForViewer(thread, viewer) : { ...thread };
  const myId = String(viewer?._id || "");

  const unreadCountsObj = mapToObject(t.unreadCounts);
  const isUnclaimed = !t.counselorId;

  // counselor inbox unread: use unassignedUnread when unclaimed
  const unreadForMe = isCounselor(viewer)
    ? (isUnclaimed ? Number(t.unassignedUnread || 0) : Number(unreadCountsObj?.[myId] || 0))
    : Number(unreadCountsObj?.[myId] || 0);

  return {
    _id: String(t._id),
    studentId: t.studentId,
    counselorId: t.counselorId,
    claimedAt: t.claimedAt || null,
    participants: (t.participants || []).map(String),
    anonymous: !!t.anonymous,
    identityMode: String(t.identityMode || (t.anonymous ? "anonymous" : "student")),
    identityLocked: !!t.identityLocked,
    identityLockedAt: t.identityLockedAt || null,
    status: t.status,
    closedAt: t.closedAt || null,
    closedBy: t.closedBy || null,
    lastMessage: t.lastMessage || "",
    lastMessageAt: t.lastMessageAt || t.updatedAt,
    unreadCounts: unreadCountsObj,
    unassignedUnread: Number(t.unassignedUnread || 0),
    unreadForMe,
    messages: includeMessages ? messages : undefined,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/* -----------------------------
   Controllers
----------------------------- */

// GET /api/messages/threads?includeMessages=1&limit=40
exports.listThreads = async (req, res, next) => {
  try {
    const viewer = req.user;
    const includeMessages = String(req.query.includeMessages ?? "1") !== "0";
    const limit = Number(req.query.limit || 40);

    const q = isCounselor(viewer)
      ? { status: { $in: ["open", "closed"] } } // ✅ counselors see open + closed
      : { studentId: viewer._id, status: "open" };

    const threads = await MessageThread.find(q)
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    const out = [];
    for (const t of threads) {
      const msgs = includeMessages ? await getMessagesForThread(t._id, limit) : [];
      out.push(threadDto(t, { viewer, includeMessages, messages: msgs }));
    }

    res.json({ items: out });
  } catch (err) {
    next(err);
  }
};

// POST /api/messages/threads/ensure  (student creates 1 open thread)
exports.ensureThread = async (req, res, next) => {
  try {
    const viewer = req.user;

    if (isCounselor(viewer)) {
      res.status(403);
      throw new Error("Counselors cannot create threads.");
    }

    const anonymous = !!req.body?.anonymous;

    const existing = await MessageThread.findOne({ studentId: viewer._id, status: "open" })
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    if (existing) {
  const msgs = await getMessagesForThread(existing._id, 60);

  // ✅ Allow changing identity mode ONLY before it is locked (before first sent message)
  if (!existing.identityLocked && typeof req.body?.anonymous === "boolean" && existing.anonymous !== anonymous) {
    await MessageThread.findByIdAndUpdate(
      existing._id,
      { $set: { anonymous, identityMode: anonymous ? "anonymous" : "student" } },
      { new: false }
    );

    const refreshed = await MessageThread.findById(existing._id)
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    return res.json({ item: threadDto(refreshed, { viewer, includeMessages: true, messages: msgs }) });
  }

  return res.json({ item: threadDto(existing, { viewer, includeMessages: true, messages: msgs }) });
}

    const created = await MessageThread.create({
      studentId: viewer._id,
      counselorId: null,
      claimedAt: null,
      participants: [viewer._id],
      anonymous,
      identityMode: anonymous ? "anonymous" : "student",
      status: "open",
      lastMessage: "",
      lastMessageAt: null,
      unreadCounts: { [String(viewer._id)]: 0 },
      unassignedUnread: 0,
    });

    const populated = await MessageThread.findById(created._id)
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    // ✅ notify counselors system-wide (metadata only)
    try {
      const io = getIO();
      io.to("role:counselor").emit("thread:created", { threadId: String(created._id) });
      io.to("role:counselor").emit("thread:update", { threadId: String(created._id) });
    } catch {}

    return res.status(201).json({ item: threadDto(populated, { viewer, includeMessages: true, messages: [] }) });
  } catch (err) {
    next(err);
  }
};

// GET /api/messages/threads/:threadId?limit=60
exports.getThread = async (req, res, next) => {
  try {
    const viewer = req.user;
    const threadId = asId(req.params.threadId);
    if (!threadId) {
      res.status(400);
      throw new Error("Invalid thread id");
    }

    const thread = await MessageThread.findById(threadId)
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    if (!thread) {
      res.status(404);
      throw new Error("Thread not found");
    }

    if (!canAccessThread(thread, viewer)) {
      res.status(403);
      throw new Error("Forbidden");
    }

    const messages = await getMessagesForThread(threadId, Number(req.query.limit || 60));
    res.json({ item: threadDto(thread, { viewer, includeMessages: true, messages }) });
  } catch (err) {
    next(err);
  }
};

// POST /api/messages/threads/:threadId/messages
exports.sendMessage = async (req, res, next) => {
  try {
    const viewer = req.user;
    const threadId = asId(req.params.threadId);
    if (!threadId) {
      res.status(400);
      throw new Error("Invalid thread id");
    }

    const text = cleanText(req.body?.text);
    if (!text) {
      res.status(400);
      throw new Error("Message text is required.");
    }

    const clientId = req.body?.clientId ? String(req.body.clientId) : null;

    // Load thread (non-lean; we may update)
    let thread = await MessageThread.findById(threadId);
    if (!thread) {
      res.status(404);
      throw new Error("Thread not found.");
    }
    if (String(thread.status) === "closed") {
      res.status(400);
      throw new Error("This conversation is closed.");
    }

    const viewerId = String(viewer._id);

    // Access rules
    if (!isCounselor(viewer)) {
      if (String(thread.studentId) !== viewerId) {
        res.status(403);
        throw new Error("Forbidden");
      }
    }


/* -----------------------------
   Identity lock (student only)
   - Student chooses identity (student/anonymous) BEFORE sending first message
   - On first student message, identity is LOCKED and cannot change later
----------------------------- */
if (!isCounselor(viewer)) {
  const requestedMode = String(req.body?.senderMode || "").toLowerCase();
  const wantsAnonymous = requestedMode === "anonymous";

  if (thread.identityLocked) {
    const currentAnon = !!thread.anonymous;
    if (requestedMode && currentAnon !== wantsAnonymous) {
      res.status(409);
      throw new Error("Identity is locked for this conversation. You can’t switch identity after sending a message.");
    }
  } else {
    // Lock on first student message
    thread.anonymous = wantsAnonymous ? true : false;
    thread.identityMode = wantsAnonymous ? "anonymous" : "student";
    thread.identityLocked = true;
    thread.identityLockedAt = new Date();
    await thread.save();
  }
}

    // Claim-on-reply for counselors (atomic)
    let claimedNow = false;
    if (isCounselor(viewer)) {
      if (thread.counselorId && String(thread.counselorId) !== viewerId) {
        res.status(403);
        throw new Error("This conversation is already claimed by another counselor (read-only).");
      }

      if (!thread.counselorId) {
        const claimed = await MessageThread.findOneAndUpdate(
          { _id: threadId, counselorId: null, status: "open" },
          {
            $set: { counselorId: viewer._id, claimedAt: new Date(), unassignedUnread: 0 },
            $addToSet: { participants: viewer._id },
            $setOnInsert: {},
          },
          { new: true }
        );

        if (!claimed) {
          res.status(409);
          throw new Error("This conversation is already claimed by another counselor (read-only).");
        }

        thread = claimed;
        claimedNow = true;
      } else {
        // ensure counselor is in participants for socket auto-join later
        await MessageThread.findByIdAndUpdate(threadId, { $addToSet: { participants: viewer._id } }, { new: false });
      }
    }

    // Save message (idempotent if clientId provided)
    const senderRole = senderRoleLabel(viewer);

    let msgDoc;
    try {
      msgDoc = await Message.create({
        threadId,
        senderId: viewer._id,
        senderRole,
        clientId,
        text,
      });
    } catch (e) {
      if (clientId && String(e?.code) === "11000") {
        msgDoc = await Message.findOne({ threadId, senderId: viewer._id, clientId }).lean();
      } else {
        throw e;
      }
    }

    const createdAt = msgDoc.createdAt || new Date();

    // Thread summary + unread counts
    const setOps = {
      lastMessage: text,
      lastMessageAt: createdAt,
      [`unreadCounts.${viewerId}`]: 0,
    };
    const incOps = {};

    const studentId = String(thread.studentId);
    const counselorId = thread.counselorId ? String(thread.counselorId) : null;

    if (isCounselor(viewer)) {
      // counselor -> student
      incOps[`unreadCounts.${studentId}`] = 1;
    } else {
      // student -> counselor (if assigned)
      if (counselorId) incOps[`unreadCounts.${counselorId}`] = 1;
      else incOps["unassignedUnread"] = 1; // ✅ system-wide counselor unread
    }

    const updatedThread = await MessageThread.findByIdAndUpdate(
      threadId,
      { $set: setOps, $inc: incOps },
      { new: true }
    ).lean();

    const payloadThread = updatedThread
      ? {
          _id: String(updatedThread._id),
          counselorId: updatedThread.counselorId ? String(updatedThread.counselorId) : null,
          unreadCounts: mapToObject(updatedThread.unreadCounts),
          unassignedUnread: Number(updatedThread.unassignedUnread || 0),
        }
      : { _id: String(threadId) };

    // Emit realtime
    try {
      const io = getIO();
      const tid = String(threadId);

      // only people who are supposed to receive the message
      io.to(`thread:${tid}`).emit("message:new", {
        threadId: tid,
        message: messageDto(msgDoc),
        thread: payloadThread,
      });

      io.to(`user:${studentId}`).emit("message:new", {
        threadId: tid,
        message: messageDto(msgDoc),
        thread: payloadThread,
      });

      if (updatedThread?.counselorId) {
        io.to(`user:${String(updatedThread.counselorId)}`).emit("message:new", {
          threadId: tid,
          message: messageDto(msgDoc),
          thread: payloadThread,
        });
      }

      // System-wide counselor metadata updates (no message body)
      io.to("role:counselor").emit("thread:update", { threadId: tid });

      if (claimedNow) {
        io.to("role:counselor").emit("thread:claimed", { threadId: tid, counselorId: viewerId });
      } else {
        // still useful to ping list
        io.to("role:counselor").emit("thread:update", { threadId: tid });
      }
    } catch {}

    return res.status(201).json({ item: messageDto(msgDoc) });
  } catch (err) {
    next(err);
  }
};

// POST /api/messages/threads/:threadId/read
exports.markRead = async (req, res, next) => {
  try {
    const viewer = req.user;
    const threadId = asId(req.params.threadId);
    if (!threadId) {
      res.status(400);
      throw new Error("Invalid thread id");
    }

    const thread = await MessageThread.findById(threadId).select("studentId counselorId status").lean();
    if (!thread) {
      res.status(404);
      throw new Error("Thread not found.");
    }
    if (String(thread.status) === "closed") {
      return res.json({ ok: true });
    }

    // students can only mark their own thread
    if (!isCounselor(viewer)) {
      if (String(thread.studentId) !== String(viewer._id)) {
        res.status(403);
        throw new Error("Forbidden");
      }
    }

    const userId = String(viewer._id);
    const setKey = `unreadCounts.${userId}`;

    await MessageThread.findByIdAndUpdate(threadId, { $set: { [setKey]: 0 } }, { new: false });

    try {
      const io = getIO();
      const tid = String(threadId);
      io.to(`user:${userId}`).emit("thread:read", { threadId: tid, userId });
      io.to(`thread:${tid}`).emit("thread:read", { threadId: tid, userId });
      io.to("role:counselor").emit("thread:update", { threadId: tid });
    } catch {}

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};


// POST /api/messages/threads/:threadId/close
// - Student can close their own thread
// - Counselor can close only if they are the assigned counselor
exports.closeThread = async (req, res, next) => {
  try {
    const viewer = req.user;
    const threadId = asId(req.params.threadId);
    if (!threadId) {
      res.status(400);
      throw new Error("Invalid thread id");
    }

    const thread = await MessageThread.findById(threadId).select("studentId counselorId status").lean();
    if (!thread) {
      res.status(404);
      throw new Error("Thread not found");
    }

    if (!isCounselor(viewer)) {
      if (String(thread.studentId) !== String(viewer._id)) {
        res.status(403);
        throw new Error("Forbidden");
      }
    } else {
      if (!thread.counselorId) {
        res.status(403);
        throw new Error("Unclaimed conversations can only be closed by the student.");
      }
      if (String(thread.counselorId) !== String(viewer._id)) {
        res.status(403);
        throw new Error("Forbidden");
      }
    }

    if (String(thread.status) === "closed") {
      return res.json({ ok: true, status: "closed" });
    }

    const studentId = String(thread.studentId);
    const counselorId = thread.counselorId ? String(thread.counselorId) : null;

    const setOps = {
      status: "closed",
      closedAt: new Date(),
      closedBy: viewer._id,
      unassignedUnread: 0,
      [`unreadCounts.${studentId}`]: 0,
    };
    if (counselorId) setOps[`unreadCounts.${counselorId}`] = 0;

    await MessageThread.findByIdAndUpdate(threadId, { $set: setOps }, { new: false });

    try {
      const io = getIO();
      const tid = String(threadId);
      const payload = { threadId: tid, status: "closed" };

      io.to(`thread:${tid}`).emit("thread:closed", payload);
      io.to(`user:${studentId}`).emit("thread:closed", payload);
      if (counselorId) io.to(`user:${counselorId}`).emit("thread:closed", payload);

      io.to("role:counselor").emit("thread:update", { threadId: tid });
    } catch {}

    return res.json({ ok: true, status: "closed" });
  } catch (err) {
    next(err);
  }
};
