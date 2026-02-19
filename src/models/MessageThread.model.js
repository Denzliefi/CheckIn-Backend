// backend/src/models/MessageThread.model.js
const mongoose = require("mongoose");

const MessageThreadSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    counselorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // fast "is participant" queries
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],

    // If true: counselor should not see the student's identity in the UI
    anonymous: { type: Boolean, default: false },

    status: { type: String, enum: ["open", "closed"], default: "open", index: true },

    lastMessage: { type: String, default: "" },
    lastMessageAt: { type: Date, default: null },

    // per-user unread counter (key = userId string)
    unreadCounts: { type: Map, of: Number, default: {} },
  },
  { timestamps: true }
);

MessageThreadSchema.pre("save", function () {
  const s = String(this.studentId || "");
  const c = String(this.counselorId || "");
  const existing = new Set((this.participants || []).map((x) => String(x)));
  if (s && !existing.has(s)) this.participants.push(this.studentId);
  if (c && !existing.has(c)) this.participants.push(this.counselorId);
});

MessageThreadSchema.index({ studentId: 1, counselorId: 1, status: 1 });

module.exports = mongoose.model("MessageThread", MessageThreadSchema);
