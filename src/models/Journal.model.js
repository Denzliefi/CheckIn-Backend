// backend/src/models/Journal.model.js
const mongoose = require("mongoose");

const { Schema } = mongoose;

/**
 * Daily Journal / Mood Tracker entry.
 * Keyed per-user per-day by dateKey: "YYYY-MM-DD" (local date).
 */
const PhqSchema = new Schema(
  {
    // allow nulls in array (unanswered) => Mixed
    answers: { type: [Schema.Types.Mixed], default: () => Array(9).fill(null) },
    submitted: { type: Boolean, default: false },
    score: { type: Number, default: null },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const JournalSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    dateKey: { type: String, required: true }, // "YYYY-MM-DD"
    mood: { type: String, default: "" },
    reason: { type: String, default: "" },
    notes: { type: String, default: "" },
    copingUsed: { type: [String], default: () => [] },
    daySubmitted: { type: Boolean, default: false },
    daySubmittedAt: { type: Date, default: null },
    phq: { type: PhqSchema, default: () => ({}) },

    // ms timestamp from client used for conflict resolution (newest wins)
    clientUpdatedAt: { type: Number, default: 0 },
  },
  { timestamps: true }
);

JournalSchema.index({ user: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model("Journal", JournalSchema);
