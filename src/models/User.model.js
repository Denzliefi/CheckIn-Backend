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
      maxlength: 32, // allow GOOGLE-xxxx fallback; still validated in controller
    },

    course: { type: String, trim: true, maxlength: 120 },
    campus: { type: String, trim: true, maxlength: 80 },

    googleId: { type: String, trim: true, index: true, sparse: true },

    password: { type: String, select: false }, // optional for Google accounts

    role: { type: String, default: "Student" },
    accountCreation: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  // If password is empty/undefined (Google accounts), skip hashing
  if (!this.password) return next();

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", UserSchema);
