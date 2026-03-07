const mongoose = require("mongoose");

const AvailabilityBlockSchema = new mongoose.Schema(
  {
    counselorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // Groups multiple per-day docs into one counselor submission (multi-day / multi-date).
    groupId: { type: String, default: "", index: true },

    // Stored as UTC Dates, but interpreted in Asia/Manila when generating availability.
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true, index: true },

    // Admin approves a cancellation request by setting status to "Cancelled".
    status: { type: String, enum: ["Approved", "Pending", "Rejected", "Cancelled"], default: "Approved", index: true },
    type: { type: String, enum: ["Leave", "Unavailable", "Event"], default: "Unavailable" },

    note: { type: String, default: "" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdByRole: { type: String, default: "" },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },

    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, default: "" },

    // =========================
    // Cancellation workflow (Counselor → Admin approves/rejects)
    // =========================
    cancelRequestedAt: { type: Date },
    cancelRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    cancelReason: { type: String, default: "" },

    cancelApprovedAt: { type: Date },
    cancelApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    cancelRejectedAt: { type: Date },
    cancelRejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    cancelRejectionReason: { type: String, default: "" },
  },
  { timestamps: true }
);

// Avoid callback-style "next" here to prevent "next is not a function" edge cases.
AvailabilityBlockSchema.pre("validate", function () {
  if (this.startAt && this.endAt) {
    const s = new Date(this.startAt).getTime();
    const e = new Date(this.endAt).getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && s >= e) {
      this.invalidate("endAt", "endAt must be after startAt");
    }
  }
});

// Prevent exact duplicates (same counselor + same exact start/end + same status)
AvailabilityBlockSchema.index({ counselorId: 1, startAt: 1, endAt: 1, status: 1 }, { unique: false });

module.exports = mongoose.model("AvailabilityBlock", AvailabilityBlockSchema);
