// backend/src/controllers/messages.controller.js
const mongoose = require("mongoose");

const User = require("../models/User.model");
const MessageThread = require("../models/MessageThread.model");
const Message = require("../models/Message.model");

const { getIO } = require("../config/socket");

/* -----------------------------
   Helpers
----------------------------- */
function cleanText(v) {
  return String(v ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 2000);
}

function mapToObject(maybeMap) {
  if (!maybeMap) return {};
  // if it's already a plain object
  if (typeof maybeMap === "object" && !("get" in maybeMap)) return maybeMap;

  const out = {};
  for (const [k, v] of maybeMap.entries()) out[String(k)] = Number(v) || 0;
  return out;
}

function asId(v) {
  try {
    return new mongoose.Types.ObjectId(String(v));
  } catch {
    return null;
  }
}

function isParticipant(thread, userId) {
  const uid = String(userId);
  return (
    String(thread?.studentId?._id || thread?.studentId) === uid ||
    String(thread?.counselorId?._id || thread?.counselorId) === uid ||
    (thread?.participants || []).some((p) => String(p) === uid)
  );
}

function otherParticipantId(thread, userId) {
  const uid = String(userId);
  const s = String(thread.studentId?._id || thread.studentId);
  const c = String(thread.counselorId?._id || thread.counselorId);
  return uid === s ? c : s;
}

function messageDto(m) {
  return {
    _id: String(m._id),
    threadId: String(m.threadId),
    senderId: String(m.senderId),
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

  // return ascending for UI rendering
  return latest.reverse().map(messageDto);
}

function threadDto(t, { includeMessages = true, messages = [] } = {}) {
  return {
    _id: String(t._id),
    studentId: t.studentId,
    counselorId: t.counselorId,
    participants: (t.participants || []).map(String),
    anonymous: !!t.anonymous,
    status: t.status,
    lastMessage: t.lastMessage || "",
    lastMessageAt: t.lastMessageAt || t.updatedAt,
    unreadCounts: mapToObject(t.unreadCounts),
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
    const includeMessages = String(req.query.includeMessages ?? "1") !== "0";
    const limit = Number(req.query.limit || 40);

    const userId = req.user._id;

    const threads = await MessageThread.find({ participants: userId })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    const out = [];
    for (const t of threads) {
      const messages = includeMessages ? await getMessagesForThread(t._id, limit) : [];
      out.push(threadDto(t, { includeMessages, messages }));
    }

    res.json({ items: out });
  } catch (err) {
    next(err);
  }
};

// POST /api/messages/threads/ensure  { anonymous?: boolean, counselorId?: string, studentId?: string }
// - Student: ensures they have an open thread; auto-assign counselor if not provided.
// - Counselor: requires studentId to ensure (used rarely)
exports.ensureThread = async (req, res, next) => {
  try {
    const meId = req.user._id;
    const role = String(req.user.role || "");

    const anonymous = !!req.body?.anonymous;

    // Student flow
    if (role.toLowerCase() === "student") {
      // keep it simple: 1 open thread per student
      const existing = await MessageThread.findOne({ studentId: meId, status: "open" })
        .populate("studentId", "fullName email studentNumber role campus")
        .populate("counselorId", "fullName email counselorCode role campus")
        .lean();

      if (existing) {
        const messages = await getMessagesForThread(existing._id, 40);
        return res.json({ item: threadDto(existing, { includeMessages: true, messages }) });
      }

      // Choose counselor
      const requestedCounselorId = asId(req.body?.counselorId);
      let counselorId = requestedCounselorId;

      if (counselorId) {
        const c = await User.findById(counselorId).select("_id role").lean();
        if (!c || String(c.role || "").toLowerCase() !== "counselor") counselorId = null;
      }

      if (!counselorId) {
        const counselors = await User.find({ role: "Counselor" }).select("_id").lean();
        if (!counselors.length) {
          res.status(404);
          throw new Error("No counselor accounts found.");
        }

        const counselorIds = counselors.map((c) => c._id);

        // Pick least-loaded counselor (open threads)
        const loads = await MessageThread.aggregate([
          { $match: { status: "open", counselorId: { $in: counselorIds } } },
          { $group: { _id: "$counselorId", c: { $sum: 1 } } },
        ]);

        const loadMap = new Map(loads.map((x) => [String(x._id), x.c]));
        let best = counselorIds[0];
        let bestCount = loadMap.get(String(best)) ?? 0;

        for (const cid of counselorIds) {
          const cnt = loadMap.get(String(cid)) ?? 0;
          if (cnt < bestCount) {
            best = cid;
            bestCount = cnt;
          }
        }
        counselorId = best;
      }

      const thread = await MessageThread.create({
        studentId: meId,
        counselorId,
        participants: [meId, counselorId],
        anonymous,
        status: "open",
        lastMessage: "",
        lastMessageAt: null,
        unreadCounts: { [String(meId)]: 0, [String(counselorId)]: 0 },
      });

      const populated = await MessageThread.findById(thread._id)
        .populate("studentId", "fullName email studentNumber role campus")
        .populate("counselorId", "fullName email counselorCode role campus")
        .lean();

      const messages = await getMessagesForThread(populated._id, 40);

      // Join rooms for currently connected sockets (optional convenience)
      try {
        const io = getIO();
        io.to(`user:${String(meId)}`).emit("thread:created", { item: threadDto(populated, { includeMessages: true, messages }) });
        io.to(`user:${String(counselorId)}`).emit("thread:created", { item: threadDto(populated, { includeMessages: true, messages }) });
      } catch {}

      return res.status(201).json({ item: threadDto(populated, { includeMessages: true, messages }) });
    }

    // Counselor flow: ensure thread with a given student
    if (role.toLowerCase() === "counselor") {
      const studentId = asId(req.body?.studentId);
      if (!studentId) {
        res.status(400);
        throw new Error("studentId is required for counselors.");
      }

      const existing = await MessageThread.findOne({
        studentId,
        counselorId: meId,
        status: "open",
      })
        .populate("studentId", "fullName email studentNumber role campus")
        .populate("counselorId", "fullName email counselorCode role campus")
        .lean();

      if (existing) {
        const messages = await getMessagesForThread(existing._id, 40);
        return res.json({ item: threadDto(existing, { includeMessages: true, messages }) });
      }

      const thread = await MessageThread.create({
        studentId,
        counselorId: meId,
        participants: [studentId, meId],
        anonymous,
        status: "open",
        unreadCounts: { [String(studentId)]: 0, [String(meId)]: 0 },
      });

      const populated = await MessageThread.findById(thread._id)
        .populate("studentId", "fullName email studentNumber role campus")
        .populate("counselorId", "fullName email counselorCode role campus")
        .lean();

      const messages = await getMessagesForThread(populated._id, 40);
      return res.status(201).json({ item: threadDto(populated, { includeMessages: true, messages }) });
    }

    res.status(403);
    throw new Error("Only Students and Counselors can use messaging.");
  } catch (err) {
    next(err);
  }
};

// GET /api/messages/threads/:threadId
exports.getThread = async (req, res, next) => {
  try {
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

    if (!isParticipant(thread, req.user._id)) {
      res.status(403);
      throw new Error("Forbidden");
    }

    const messages = await getMessagesForThread(threadId, Number(req.query.limit || 60));

    res.json({ item: threadDto(thread, { includeMessages: true, messages }) });
  } catch (err) {
    next(err);
  }
};

// POST /api/messages/threads/:threadId/messages  { text }
exports.sendMessage = async (req, res, next) => {
  try {
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

    const thread = await MessageThread.findById(threadId)
      .select("studentId counselorId participants status")
      .lean();

    if (!thread) {
      res.status(404);
      throw new Error("Thread not found.");
    }
    if (String(thread.status) === "closed") {
      res.status(400);
      throw new Error("This conversation is closed.");
    }
    if (!isParticipant(thread, req.user._id)) {
      res.status(403);
      throw new Error("Forbidden");
    }

    const senderId = req.user._id;
    const receiverId = otherParticipantId(thread, senderId);

    const msg = await Message.create({ threadId, senderId, text });

    // update thread summary + unread counts
    const now = new Date();
    const incKey = `unreadCounts.${receiverId}`;
    const setKey = `unreadCounts.${String(senderId)}`;

    await MessageThread.findByIdAndUpdate(
      threadId,
      {
        $set: {
          lastMessage: text,
          lastMessageAt: now,
          [setKey]: 0,
        },
        $inc: { [incKey]: 1 },
      },
      { new: false }
    );

    // Refetch updated thread for clients (keeps UI consistent)
    const updated = await MessageThread.findById(threadId)
      .populate("studentId", "fullName email studentNumber role campus")
      .populate("counselorId", "fullName email counselorCode role campus")
      .lean();

    const payloadThread = threadDto(updated, { includeMessages: false });

    // broadcast to both sides (personal rooms)
    try {
      const io = getIO();
      io.to(`user:${String(senderId)}`).emit("message:new", {
        threadId: String(threadId),
        message: messageDto(msg),
        thread: payloadThread,
      });
      io.to(`user:${String(receiverId)}`).emit("message:new", {
        threadId: String(threadId),
        message: messageDto(msg),
        thread: payloadThread,
      });
      // also thread room
      io.to(`thread:${String(threadId)}`).emit("thread:update", payloadThread);
    } catch (e) {
      // sockets not required for REST success
    }

    res.status(201).json({ item: messageDto(msg), thread: payloadThread });
  } catch (err) {
    next(err);
  }
};

// POST /api/messages/threads/:threadId/read
exports.markRead = async (req, res, next) => {
  try {
    const threadId = asId(req.params.threadId);
    if (!threadId) {
      res.status(400);
      throw new Error("Invalid thread id");
    }

    const thread = await MessageThread.findById(threadId).select("participants").lean();
    if (!thread) {
      res.status(404);
      throw new Error("Thread not found.");
    }
    if (!isParticipant(thread, req.user._id)) {
      res.status(403);
      throw new Error("Forbidden");
    }

    const userId = String(req.user._id);
    const setKey = `unreadCounts.${userId}`;

    await MessageThread.findByIdAndUpdate(threadId, { $set: { [setKey]: 0 } }, { new: false });

    try {
      const io = getIO();
      io.to(`user:${userId}`).emit("thread:read", { threadId: String(threadId) });
      io.to(`thread:${String(threadId)}`).emit("thread:read", { threadId: String(threadId), userId });
    } catch {}

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};
