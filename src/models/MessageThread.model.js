// backend/src/models/MessageThread.model.js
const mongoose = require("mongoose");

const MessageThreadSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // NULL until a counselor claims the thread
    counselorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },

    claimedAt: { type: Date, default: null },

    // fast "is participant" queries
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],

    // If true: counselor should not see the student's identity in the UI (even when claimed)
    anonymous: { type: Boolean, default: false },

    status: { type: String, enum: ["open", "closed"], default: "open", index: true },

    lastMessage: { type: String, default: "" },
    lastMessageAt: { type: Date, default: null },

    // per-user unread counter (key = userId string)
    unreadCounts: { type: Map, of: Number, default: {} },
  },
  { timestamps: true }
);

// One open thread per student (simple UX)
MessageThreadSchema.index({ studentId: 1, status: 1 });

module.exports = mongoose.model("MessageThread", MessageThreadSchema);
