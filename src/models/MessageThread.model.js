// backend/src/models/MessageThread.model.js
const mongoose = require("mongoose");

const MessageThreadSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // ✅ NULL until a counselor claims the thread (claim-on-reply)
    counselorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },

    claimedAt: { type: Date, default: null },

    // fast "is participant" queries + socket auto-join
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],

    // If true: counselor should not see the student's identity in the UI (even when claimed)
    anonymous: { type: Boolean, default: false },

    // ✅ Thread-level identity mode + lock (prevents switching mid-conversation)
    identityMode: { type: String, enum: ["student", "anonymous"], default: "student" },
    identityLocked: { type: Boolean, default: false },
    identityLockedAt: { type: Date, default: null },

    status: { type: String, enum: ["open", "closed"], default: "open", index: true },

    // ✅ Thread closure metadata
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    lastMessage: { type: String, default: "" },
    lastMessageAt: { type: Date, default: null },

    // per-user unread counter (key = userId string)
    unreadCounts: { type: Map, of: Number, default: {} },

    // ✅ used when thread is unclaimed (system-wide counselor inbox unread)
    unassignedUnread: { type: Number, default: 0 },
  },
  { timestamps: true }
);

MessageThreadSchema.pre("save", function () {
  const s = String(this.studentId || "");
  const c = this.counselorId ? String(this.counselorId) : "";
  const existing = new Set((this.participants || []).map((x) => String(x)));

  if (s && !existing.has(s)) this.participants.push(this.studentId);
  if (c && !existing.has(c)) this.participants.push(this.counselorId);
});

// One open thread per student (simple UX)
MessageThreadSchema.index({ studentId: 1, status: 1 });

module.exports = mongoose.model("MessageThread", MessageThreadSchema);
