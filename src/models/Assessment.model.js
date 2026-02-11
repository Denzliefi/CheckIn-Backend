const mongoose = require("mongoose");

const ALLOWED_SEVERITY = ["Minimal", "Mild", "Moderate", "Moderately High", "High"];

const AssessmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Future-proofing if you add more assessments later
    type: {
      type: String,
      required: true,
      default: "PHQ9",
      index: true,
    },

    // PHQ-9 answers: 9 items, each 0..3
    answers: {
      type: [Number],
      required: true,
      validate: {
        validator: (arr) =>
          Array.isArray(arr) &&
          arr.length === 9 &&
          arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 3),
        message: "answers must be an array of 9 integers (0..3)",
      },
    },

    score: {
      type: Number,
      required: true,
      min: 0,
      max: 27,
      index: true,
    },

    severity: {
      type: String,
      required: true,
      enum: ALLOWED_SEVERITY,
      index: true,
    },

    // Optional client timestamp (helps when offline; server still uses createdAt for lock)
    clientSubmittedAt: { type: Date },
  },
  { timestamps: true }
);

AssessmentSchema.index({ user: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model("Assessment", AssessmentSchema);
