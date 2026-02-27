const mongoose = require("mongoose");

const CounselingRequestSchema = new mongoose.Schema(
  {
    // student who created it
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    type: { type: String, enum: ["ASK", "MEET"], required: true },

    // ✅ EXISTING request workflow status (DO NOT TOUCH)
    status: {
      type: String,
      enum: ["Pending", "Approved", "Rescheduled", "Disapproved", "Cancelled", "Completed"],
      default: "Pending",
      index: true,
    },

    // ✅ Counselor thread lifecycle status (ASK only)
    threadStatus: {
      type: String,
      enum: [
        "NEW",
        "UNDER_REVIEW",
        "APPOINTMENT_REQUIRED",
        "SCHEDULED",
        "IN_SESSION",
        "WAITING_ON_STUDENT",
        "FOLLOW_UP_REQUIRED",
        "COMPLETED",
        "CLOSED",
        "URGENT",
        "CRISIS",
      ],
      default: "NEW",
      index: true,
    },

    threadStatusUpdatedAt: { type: Date },
    threadStatusUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // ASK fields
    topic: { type: String, trim: true },
    message: { type: String, trim: true },
    anonymous: { type: Boolean, default: true },
    counselorReply: { type: String, trim: true },
    repliedAt: { type: Date },

    // MEET fields
    sessionType: { type: String, enum: ["Online", "In-person"] },
    reason: { type: String, trim: true },
    date: { type: String }, // YYYY-MM-DD (PH date)
    time: { type: String }, // HH:MM (24h)

    // ✅ Counselor is a real user (role: Counselor)
    counselorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    notes: { type: String, trim: true },

    // ✅ for same-day cancellation blocking logic
    cancelledAt: { type: Date },




    // ✅ who initiated the cancellation (used for weekly cancellation allotment)
    cancelledBy: { type: String, enum: ["Student", "Counselor", "Admin"], default: "Student" },

// ✅ reschedule tracking (MEET)
rescheduledAt: { type: Date },
rescheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
rescheduledFrom: {
  date: { type: String }, // YYYY-MM-DD
  time: { type: String }, // HH:MM
  sessionType: { type: String, enum: ["Online", "In-person"] },
},
rescheduleNote: { type: String, trim: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    disapprovalReason: { type: String, trim: true },

    meetingLink: { type: String, trim: true },
    location: { type: String, trim: true },

    completedAt: { type: Date },
  },
  { timestamps: true }
);

// Prevent double-booking by counselor/date/time for MEET when pending/approved
CounselingRequestSchema.index(
  { counselorId: 1, date: 1, time: 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: "MEET",
      status: { $in: ["Pending", "Approved", "Rescheduled"] },
    },
  }
);

module.exports = mongoose.model("CounselingRequest", CounselingRequestSchema);
