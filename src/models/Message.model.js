// backend/src/models/Message.model.js
const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    threadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MessageThread",
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
  },
  { timestamps: true }
);

MessageSchema.index({ threadId: 1, createdAt: -1 });

module.exports = mongoose.model("Message", MessageSchema);
