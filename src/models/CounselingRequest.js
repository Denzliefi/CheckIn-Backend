const mongoose = require("mongoose");

/**
 * CounselingRequest
 * - ASK: message thread (student -> counselor reply)
 * - MEET: appointment request (date/time + counselor)
 *
 * Note:
 * - counselorId is stored as a string for compatibility with existing code,
 *   and should be the counselor user's _id string.
 */

const CounselingRequestSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["ASK", "MEET"], required: true },

    userId: { type: String, required: true }, // student's user _id as string

    // appointment fields
    counselorId: { type: String, default: "" }, // counselor user _id as string
    sessionType: { type: String, enum: ["Online", "In Person"], default: "" },
    reason: { type: String, default: "" },
    date: { type: String, default: "" }, // YYYY-MM-DD
    time: { type: String, default: "" }, // HH:MM
    notes: { type: String, default: "" },

    // ask fields
    studentMessage: { type: String, default: "" },
    counselorReply: { type: String, default: "" },
    replyAt: { type: Date },

    // statuses
    status: {
      type: String,
      enum: ["Pending", "Approved", "Disapproved", "Cancelled", "Completed"],
      default: "Pending",
      index: true,
    },

    threadStatus: { type: String, enum: ["Open", "Resolved", "Closed"], default: "Open" },

    // audit timestamps
    cancelledAt: { type: Date },
    approvedAt: { type: Date },
    disapprovedAt: { type: Date },
    completedAt: { type: Date },
    disapprovalNote: { type: String, default: "" },
  },
  { timestamps: true }
);

/**
 * Prevent double booking:
 * One counselor cannot have two MEET requests on same date+time in Pending/Approved.
 * We do this with a partial unique index (MongoDB supports partialFilterExpression).
 */
CounselingRequestSchema.index(
  { counselorId: 1, date: 1, time: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { type: "MEET", status: { $in: ["Pending", "Approved"] } },
  }
);

// Helpful query indexes
CounselingRequestSchema.index({ userId: 1, createdAt: -1 });
CounselingRequestSchema.index({ counselorId: 1, createdAt: -1 });

module.exports = mongoose.model("CounselingRequest", CounselingRequestSchema);
