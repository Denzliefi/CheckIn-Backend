const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const UserSchema = new mongoose.Schema(
  {
    firstName: { type: String, trim: true, maxlength: 50 },
    lastName: { type: String, trim: true, maxlength: 50 },

    fullName: { type: String, required: true, trim: true, maxlength: 120 },

    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },

    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 6,
      maxlength: 24,
    },

    studentNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 32, // allow GOOGLE-xxxx fallback
    },

    course: { type: String, trim: true, maxlength: 120 },
    campus: { type: String, trim: true, maxlength: 80 },

    // Profile photo (served from /uploads/... or external URL)
    avatarUrl: { type: String, trim: true, maxlength: 2048, default: "" },

    googleId: { type: String, trim: true, index: true, sparse: true },

    password: { type: String, select: false }, // optional for Google accounts

    // Optional counselor profile fields (used when role === "Counselor")
    counselorCode: { type: String, trim: true, maxlength: 32, index: true, sparse: true },
    specialty: [{ type: String, trim: true, maxlength: 80 }],

    role: { type: String, default: "Student" },
    accountCreation: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ✅ Promise-style hook (no next). Fixes: "next is not a function"
UserSchema.pre("save", async function () {
  // If password not changed, do nothing
  if (!this.isModified("password")) return;

  // If password is empty/undefined (Google accounts), skip hashing
  if (!this.password) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

UserSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", UserSchema);
