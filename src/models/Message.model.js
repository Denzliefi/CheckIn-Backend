// backend/src/models/Message.model.js
const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: "MessageThread", required: true, index: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // ✅ store role so UIs can render reliably after refresh
    senderRole: { type: String, enum: ["Student", "Counselor", "Admin"], required: true },

    // ✅ optional id from client to dedupe retries
    clientId: { type: String, default: null },

    text: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

MessageSchema.index({ threadId: 1, createdAt: 1 });

// ✅ If clientId is provided, enforce idempotency per sender/thread
MessageSchema.index({ threadId: 1, senderId: 1, clientId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Message", MessageSchema);
