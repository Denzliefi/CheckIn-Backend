// backend/src/config/socket.js
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const User = require("../models/User.model");
const MessageThread = require("../models/MessageThread.model");

let ioInstance = null;

function getAllowedOrigins() {
  const raw =
    process.env.CLIENT_URLS ||
    process.env.CLIENT_URL ||
    "https://checkinauabc.vercel.app,http://localhost:3000";

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function authSocket(socket, next) {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      (socket.handshake.headers?.authorization || "").replace(/^Bearer\s+/i, "");

    if (!token) return next(new Error("NO_TOKEN"));

    const secret = process.env.JWT_SECRET;
    if (!secret) return next(new Error("JWT_SECRET_MISSING"));

    const decoded = jwt.verify(token, secret);
    const userId = decoded?.id;
    if (!userId) return next(new Error("BAD_TOKEN"));

    const user = await User.findById(userId).select("_id role fullName");
    if (!user) return next(new Error("USER_NOT_FOUND"));

    socket.user = { id: String(user._id), role: user.role, fullName: user.fullName };
    return next();
  } catch (err) {
    return next(new Error("AUTH_FAILED"));
  }
}

function initSocket(httpServer) {
  if (ioInstance) return ioInstance;

  const origins = getAllowedOrigins();

  ioInstance = new Server(httpServer, {
    cors: {
      origin: origins,
      methods: ["GET", "POST"],
      credentials: false,
    },
    // Render/production friendly
    transports: ["websocket", "polling"],
  });

  ioInstance.use(authSocket);

  ioInstance.on("connection", async (socket) => {
    const userId = socket.user?.id;
    if (!userId) return;

    // personal room (we'll emit to this for personalized payloads)
    socket.join(`user:${userId}`);

    // auto-join all thread rooms for this user
    try {
      const threads = await MessageThread.find({ participants: userId }).select("_id").lean();
      for (const t of threads) socket.join(`thread:${t._id}`);
    } catch (e) {
      // ignore
    }

    socket.on("thread:join", async ({ threadId } = {}) => {
      try {
        if (!threadId) return;
        const t = await MessageThread.findById(threadId).select("participants").lean();
        const ok = t?.participants?.some((p) => String(p) === String(userId));
        if (!ok) return;
        socket.join(`thread:${threadId}`);
      } catch {
        // ignore
      }
    });
  });

  return ioInstance;
}

function getIO() {
  if (!ioInstance) throw new Error("Socket.io not initialized");
  return ioInstance;
}

module.exports = { initSocket, getIO, getAllowedOrigins };
