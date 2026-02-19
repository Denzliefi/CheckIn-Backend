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

function roleLower(user) {
  return String(user?.role || "").toLowerCase();
}

function isCounselor(user) {
  return roleLower(user) === "counselor";
}

function cleanText(v) {
  return String(v ?? "").trim();
}

async function getMessagesForThread(threadId, limit = 40) {
  const items = await Message.find({ threadId })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(200, Number(limit) || 40)))
    .lean();
  return items.reverse();
}

// Mask student identity for counselors until claimed by them (or anonymous)
function maskThreadForViewer(thread, viewer) {
  const vId = String(viewer?._id || "");
  const vIsCounselor = isCounselor(viewer);

  const t = { ...thread };

  // If counselor and NOT the assigned counselor -> hide student identity
  const assignedId = t.counselorId ? String(t.counselorId?._id || t.counselorId) : "";
  const isAssignedToMe = assignedId && assignedId === vId;

  if (vIsCounselor && !isAssignedToMe) {
    t.studentId = null;
  }

  // If thread is anonymous, hide identity for everyone except student (student still sees themselves by token)
  if (t.anonymous && vIsCounselor) {
    t.studentId = null;
  }

  return t;
}

function threadDto(thread, { viewer, includeMessages = false, messages = [] } = {}) {
  const t = maskThreadForViewer(thread, viewer);

  const myId = String(viewer?._id || "");

  const unreadCounts = t.unreadCounts || {};
  const unread =
    typeof unreadCounts.get === "function"
      ? unreadCounts.get(myId) || 0
      : unreadCounts?.[myId] || 0;

  return {
    _id: t._id,
    studentId: t.studentId,
    counselorId: t.counselorId,
    claimedAt: t.claimedAt || null,
    participants: t.participants || [],
    anonymous: !!t.anonymous,
    status: t.status,
    lastMessage: t.lastMessage || "",
    lastMessageAt: t.lastMessageAt || null,
    unreadCounts: t.unreadCounts || {},
    unreadForMe: unread,
    messages: includeMessages ? messages : undefined,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function canAccessThread(thread, viewer) {
  const vId = String(viewer?._id || "");
  if (!vId) return false;

  if (isCounselor(viewer)) {
    // system-wide read access for counselors
    return true;
  }

  // students can only see their own
  return String(thread.studentId?._id || thread.studentId) === vId;
}

/* -----------------------------
   Handlers
----------------------------- */

// GET /api/messages/threads?includeMessages=1&limit=40
exports.listThreads = async (req, res, next) => {
  try {
    const viewer = req.user;
    const includeMessages = String(req.query?.includeMessages || "1") === "1";
    const limit = Number(req.query?.limit || 40);

    const q = isCounselor(viewer)
      ? { status: "open" } // system-wide inbox: show all open threads
      : { studentId: viewer._id, status: "open" };

    const threads = await MessageThread.find(q)
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    const items = [];
    for (const t of threads) {
      let messages = [];
      if (includeMessages) messages = await getMessagesForThread(t._id, limit);
      items.push(threadDto(t, { viewer, includeMessages, messages }));
    }

    return res.json({ items });
  } catch (e) {
    next(e);
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

    // keep it simple: 1 open thread per student
    const existing = await MessageThread.findOne({ studentId: viewer._id, status: "open" })
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    if (existing) {
      const messages = await getMessagesForThread(existing._id, 40);
      return res.json({ item: threadDto(existing, { viewer, includeMessages: true, messages }) });
    }

    // Create unclaimed thread (counselorId = null)
    const thread = await MessageThread.create({
      studentId: viewer._id,
      counselorId: null,
      claimedAt: null,
      participants: [viewer._id],
      anonymous,
      status: "open",
      lastMessage: "",
      lastMessageAt: null,
      unreadCounts: { [String(viewer._id)]: 0 },
    });

    const populated = await MessageThread.findById(thread._id)
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    // Notify counselors that a new thread exists (system-wide inbox)
    try {
      getIO().emit("thread:created", { threadId: String(thread._id) });
      getIO().emit("thread:update", { threadId: String(thread._id) });
    } catch {}

    return res.status(201).json({ item: threadDto(populated, { viewer, includeMessages: true, messages: [] }) });
  } catch (e) {
    next(e);
  }
};

// GET /api/messages/threads/:threadId?limit=60
exports.getThread = async (req, res, next) => {
  try {
    const viewer = req.user;
    const threadId = asId(req.params.threadId);
    if (!threadId) {
      res.status(400);
      throw new Error("Invalid thread id.");
    }

    const limit = Number(req.query?.limit || 60);

    const thread = await MessageThread.findById(threadId)
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    if (!thread) {
      res.status(404);
      throw new Error("Thread not found.");
    }

    if (!canAccessThread(thread, viewer)) {
      res.status(403);
      throw new Error("Forbidden.");
    }

    const messages = await getMessagesForThread(thread._id, limit);
    return res.json({ item: threadDto(thread, { viewer, includeMessages: true, messages }) });
  } catch (e) {
    next(e);
  }
};

// POST /api/messages/threads/:threadId/messages
exports.sendMessage = async (req, res, next) => {
  try {
    const viewer = req.user;
    const threadId = asId(req.params.threadId);
    if (!threadId) {
      res.status(400);
      throw new Error("Invalid thread id.");
    }

    const text = cleanText(req.body?.text);
    if (!text) {
      res.status(400);
      throw new Error("Message is required.");
    }
    if (text.length > 2000) {
      res.status(400);
      throw new Error("Message too long.");
    }

    // Load thread
    const thread = await MessageThread.findById(threadId);
    if (!thread) {
      res.status(404);
      throw new Error("Thread not found.");
    }

    // Access rules
    if (!isCounselor(viewer) && String(thread.studentId) !== String(viewer._id)) {
      res.status(403);
      throw new Error("Forbidden.");
    }

    // Claim-on-reply for counselors (atomic)
    if (isCounselor(viewer)) {
      if (thread.counselorId && String(thread.counselorId) !== String(viewer._id)) {
        res.status(403);
        throw new Error("This chat is already claimed by another counselor.");
      }

      if (!thread.counselorId) {
        const claimed = await MessageThread.findOneAndUpdate(
          { _id: threadId, counselorId: null },
          {
            $set: { counselorId: viewer._id, claimedAt: new Date() },
            $addToSet: { participants: viewer._id },
            $setOnInsert: {},
          },
          { new: true }
        );

        if (!claimed) {
          res.status(409);
          throw new Error("Another counselor already claimed this chat.");
        }

        thread.counselorId = claimed.counselorId;
        thread.claimedAt = claimed.claimedAt;

        // Broadcast claim event
        try {
          getIO().emit("thread:claimed", { threadId: String(threadId), counselorId: String(viewer._id) });
          getIO().emit("thread:update", { threadId: String(threadId) });
        } catch {}
      }
    } else {
      // student sending: update unread for counselors (system-wide) and assigned counselor (if any)
      // no extra checks
    }

    // Save message (with optional clientId if provided)
    const clientId = req.body?.clientId ? String(req.body.clientId) : null;

    let msg;
    try {
      msg = await Message.create({
        threadId,
        senderId: viewer._id,
        clientId,
        text,
      });
    } catch (e) {
      // If clientId caused duplicate insert, fetch existing and return it (idempotent)
      if (clientId && String(e?.code) === "11000") {
        msg = await Message.findOne({ threadId, senderId: viewer._id, clientId }).lean();
      } else {
        throw e;
      }
    }

    // Update thread summary + unread counts
    thread.lastMessage = text;
    thread.lastMessageAt = msg.createdAt;

    const unread = thread.unreadCounts || new Map();

    // helper to get/set map-like
    const getCnt = (id) => {
      const k = String(id);
      if (typeof unread.get === "function") return Number(unread.get(k) || 0);
      return Number(unread[k] || 0);
    };
    const setCnt = (id, v) => {
      const k = String(id);
      if (typeof unread.set === "function") unread.set(k, v);
      else unread[k] = v;
    };

    if (isCounselor(viewer)) {
      // counselor -> student unread increments
      setCnt(thread.studentId, getCnt(thread.studentId) + 1);
      setCnt(viewer._id, 0);
    } else {
      // student -> counselor unread increments for assigned counselor only (but counselors can still see thread list)
      if (thread.counselorId) {
        setCnt(thread.counselorId, getCnt(thread.counselorId) + 1);
      }
      setCnt(viewer._id, 0);
    }

    thread.unreadCounts = unread;
    await thread.save();

    // Emit realtime: message:new and thread:update
    try {
      getIO().emit("message:new", { threadId: String(threadId), message: msg, thread: { _id: thread._id, counselorId: thread.counselorId, unreadCounts: thread.unreadCounts } });
      getIO().emit("thread:update", { threadId: String(threadId) });
    } catch {}

    return res.status(201).json({ item: msg });
  } catch (e) {
    next(e);
  }
};

// POST /api/messages/threads/:threadId/read
exports.markRead = async (req, res, next) => {
  try {
    const viewer = req.user;
    const threadId = asId(req.params.threadId);
    if (!threadId) {
      res.status(400);
      throw new Error("Invalid thread id.");
    }

    const thread = await MessageThread.findById(threadId);
    if (!thread) {
      res.status(404);
      throw new Error("Thread not found.");
    }

    if (!isCounselor(viewer) && String(thread.studentId) !== String(viewer._id)) {
      res.status(403);
      throw new Error("Forbidden.");
    }

    const unread = thread.unreadCounts || new Map();
    const key = String(viewer._id);
    if (typeof unread.set === "function") unread.set(key, 0);
    else unread[key] = 0;

    thread.unreadCounts = unread;
    await thread.save();

    try {
      getIO().emit("thread:update", { threadId: String(threadId) });
    } catch {}

    return res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};
