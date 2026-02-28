// src/controllers/auth.controller.js

const jwt = require("jsonwebtoken");
const User = require("../models/User.model");

const {
  requestPasswordReset,
  resetPasswordWithToken,
  validatePasswordResetToken,
} = require("../services/auth.service");
/* =======================
   Helpers (sanitize + normalize)
======================= */

function stripDangerousChars(v) {
  return String(v ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "") // control chars
    .replace(/[<>`]/g, "") // basic XSS primitives
    .trim();
}

function sanitizeName(v, max = 50) {
  const s = stripDangerousChars(v);
  return s
    .replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'\-\s]/g, "")
    .replace(/\s{2,}/g, " ")
    .slice(0, max);
}

function sanitizeUsername(v, max = 24) {
  const s = stripDangerousChars(v).replace(/\s+/g, "");
  return s.replace(/[^A-Za-z0-9._]/g, "").slice(0, max);
}

function sanitizeEmail(v, max = 254) {
  const s = stripDangerousChars(v).replace(/\s+/g, "");
  return s.slice(0, max).toLowerCase();
}

function sanitizeStudentNumber(v) {
  const s = stripDangerousChars(v);
  const digits = s.replace(/\D/g, "").slice(0, 7);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}-${digits.slice(2)}`.slice(0, 8);
}

function sanitizeCourse(v, max = 120) {
  return stripDangerousChars(v).slice(0, max);
}

function buildFullName({ firstName, lastName, bodyFullName, email }) {
  // Prefer explicit first+last so DB is consistent (prevents username/email-prefix ending up in fullName).
  const derived = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (derived) return derived;

  // Fall back to provided fullName but keep it name-like (letters, spaces, hyphens, apostrophes).
  const cleaned = sanitizeName(bodyFullName, 120);
  if (cleaned) return cleaned;

  // Last resort: email prefix (keeps Google signups possible even with missing profile name)
  const prefix = String(email || "").split("@")[0] || "";
  return stripDangerousChars(prefix) || "User";
}


function isValidEmailFormat(email) {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(email ?? "").trim());
}

function isValidStudentNumberFormat(v) {
  return /^[0-9]{2}-[0-9]{5}$/.test(String(v ?? "").trim());
}

function signToken(id) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // This is the most common cause of random 500s on Render
    throw new Error("JWT_SECRET is missing in environment variables.");
  }
  const exp = process.env.JWT_EXPIRES_IN || "30d";
  return jwt.sign({ id }, secret, { expiresIn: exp });
}

/* =======================
   AVAILABILITY (LIVE CHECK)
   GET /api/auth/availability?username=&email=&studentNumber=
======================= */
async function checkAvailability(req, res) {
  try {
    const username = sanitizeUsername(req.query.username);
    const email = sanitizeEmail(req.query.email);
    const studentNumber = sanitizeStudentNumber(req.query.studentNumber);

    const response = {};

    if (username) {
      const existing = await User.findOne({ username: new RegExp(`^${username}$`, "i") }).select("_id");
      response.usernameAvailable = !existing;
    }
    if (email) {
      const existing = await User.findOne({ email: email.toLowerCase() }).select("_id");
      response.emailAvailable = !existing;
    }
    if (studentNumber) {
      const existing = await User.findOne({ studentNumber }).select("_id");
      response.studentNumberAvailable = !existing;
    }

    return res.json(response);
  } catch (err) {
    console.error("AVAILABILITY_ERROR:", err);
    return res.status(500).json({ message: "Availability check failed." });
  }
}

/* =======================
   REGISTER (LOCAL)
======================= */
async function register(req, res) {
  try {
    const firstName = sanitizeName(req.body.firstName);
    const lastName = sanitizeName(req.body.lastName);
    const fullName =
      stripDangerousChars(req.body.fullName) || [firstName, lastName].filter(Boolean).join(" ");
    const email = sanitizeEmail(req.body.email);
    const username = sanitizeUsername(req.body.username);
    const studentNumber = sanitizeStudentNumber(req.body.studentNumber);
    const course = sanitizeCourse(req.body.course);
    const password = String(req.body.password ?? "");

    if (!firstName || !lastName || !fullName || !email || !username || !studentNumber || !password) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    if (!isValidEmailFormat(email)) {
      return res.status(400).json({ message: "Invalid email." });
    }

    if (username.length < 6) {
      return res.status(400).json({ message: "Username must be at least 6 characters." });
    }

    if (!isValidStudentNumberFormat(studentNumber)) {
      return res.status(400).json({ message: "Invalid student number." });
    }

    const emailExists = await User.findOne({ email }).select("_id");
    if (emailExists) return res.status(409).json({ message: "Email already exists." });

    const usernameExists = await User.findOne({ username: new RegExp(`^${username}$`, "i") }).select("_id");
    if (usernameExists) return res.status(409).json({ message: "Username already exists." });

    const studentExists = await User.findOne({ studentNumber }).select("_id");
    if (studentExists) return res.status(409).json({ message: "Student number already exists." });

    const user = await User.create({
      firstName,
      lastName,
      fullName,
      email,
      username,
      studentNumber,
      course,
      password,
    });

    const token = signToken(user._id);

    return res.status(201).json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        email: user.email,
        username: user.username,
        studentNumber: user.studentNumber,
        course: user.course,
        role: user.role,
        avatarUrl: user.avatarUrl || "",
      },
    });
  } catch (err) {
    console.error("REGISTER_ERROR:", err);
    return res.status(500).json({ message: "Signup failed." });
  }
}

/* =======================
   LOGIN (LOCAL)
======================= */
async function login(req, res) {
  try {
    const emailOrUsername = stripDangerousChars(req.body.emailOrUsername);
    const password = String(req.body.password ?? "");

    if (!emailOrUsername || !password) {
      return res.status(400).json({ message: "Email/Username and password are required." });
    }

    const user = await User.findOne({
      $or: [
        { email: emailOrUsername.toLowerCase() },
        { username: new RegExp(`^${emailOrUsername}$`, "i") },
      ],
    }).select("+password");

    if (!user) return res.status(401).json({ message: "Invalid credentials." });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials." });

    const token = signToken(user._id);

    return res.json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        email: user.email,
        username: user.username,
        studentNumber: user.studentNumber,
        course: user.course,
        role: user.role,
        avatarUrl: user.avatarUrl || "",
      },
    });
  } catch (err) {
    console.error("LOGIN_ERROR:", err);
    return res.status(500).json({ message: "Login failed." });
  }
}

/* =======================
   GET ME
======================= */
async function getMe(req, res) {
  try {
    const user = await User.findById(req.user.id).select("-password");
    return res.json(user);
  } catch (err) {
    console.error("GETME_ERROR:", err);
    return res.status(500).json({ message: "Failed to load user." });
  }
}

/* =======================
   ADMIN CREATE USER (OPTIONAL)
======================= */
async function createUser(req, res) {
  try {
    const fullName = stripDangerousChars(req.body.fullName);
    const email = sanitizeEmail(req.body.email);
    const username = sanitizeUsername(req.body.username);
    const studentNumber = sanitizeStudentNumber(req.body.studentNumber);
    const password = String(req.body.password ?? "");
    const course = sanitizeCourse(req.body.course);
    const campus = stripDangerousChars(req.body.campus);

    if (!fullName || !email || !username || !studentNumber || !password) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    const emailExists = await User.findOne({ email }).select("_id");
    if (emailExists) return res.status(409).json({ message: "Email already exists." });

    const usernameExists = await User.findOne({ username: new RegExp(`^${username}$`, "i") }).select("_id");
    if (usernameExists) return res.status(409).json({ message: "Username already exists." });

    const studentExists = await User.findOne({ studentNumber }).select("_id");
    if (studentExists) return res.status(409).json({ message: "Student number already exists." });

    const user = await User.create({
      fullName,
      email,
      username,
      studentNumber,
      course,
      campus,
      password,
    });

    return res.status(201).json({
      id: user._id,
      fullName: user.fullName,
      email: user.email,
      username: user.username,
      studentNumber: user.studentNumber,
      course: user.course,
      campus: user.campus,
      role: user.role,
      avatarUrl: user.avatarUrl || "",
    });
  } catch (err) {
    console.error("ADMIN_CREATEUSER_ERROR:", err);
    return res.status(500).json({ message: "Create user failed." });
  }
}

/* =======================
   GOOGLE AUTH (SIGNUP/LOGIN)
======================= */
async function googleAuth(req, res) {
  try {
    const intentRaw = stripDangerousChars(req.body.intent);
    const intent = (intentRaw || "login").toLowerCase();

    const googleId = stripDangerousChars(req.body.googleId);
    const email = sanitizeEmail(req.body.email);
    const firstName = sanitizeName(req.body.firstName);
    const lastName = sanitizeName(req.body.lastName);
    const fullName = buildFullName({ firstName, lastName, bodyFullName: req.body.fullName, email });
    const usernameInput = sanitizeUsername(req.body.username);
    const studentNumberInput = sanitizeStudentNumber(req.body.studentNumber);
    const course = sanitizeCourse(req.body.course);

    if (!email) return res.status(400).json({ message: "Google email is required." });

    let user = null;
    if (googleId) user = await User.findOne({ googleId }).select("-password");
    if (!user) user = await User.findOne({ email }).select("-password");

    if (user && intent === "signup") {
      return res.status(409).json({
        code: "ACCOUNT_EXISTS",
        message: "Account already exists. Please log in.",
      });
    }

    if (!user && intent === "login") {
      return res.status(404).json({
        code: "ACCOUNT_NOT_FOUND",
        message: "No account found for this Google email. Please sign up.",
      });
    }

    const genUsername = async () => {
      const base =
        (email.split("@")[0] || "user").replace(/[^A-Za-z0-9._]/g, "").slice(0, 18) || "user";
      let candidate = base;
      let i = 0;
      while (await User.findOne({ username: new RegExp(`^${candidate}$`, "i") }).select("_id")) {
        i += 1;
        candidate = `${base}_${Math.floor(100 + Math.random() * 900)}`.slice(0, 24);
        if (i > 15) break;
      }
      return candidate;
    };

    const genStudentNumber = async () => {
      let candidate = `GOOGLE-${Date.now()}`;
      let i = 0;
      while (await User.findOne({ studentNumber: candidate }).select("_id")) {
        i += 1;
        candidate = `GOOGLE-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
        if (i > 10) break;
      }
      return candidate;
    };

    if (user) {
      const updates = {};

      if (googleId && !user.googleId) updates.googleId = googleId;
      if (firstName && (!user.firstName || user.firstName !== firstName)) updates.firstName = firstName;
      if (lastName && (!user.lastName || user.lastName !== lastName)) updates.lastName = lastName;
      if (fullName && (!user.fullName || user.fullName !== fullName)) updates.fullName = fullName;
      if (course && (!user.course || user.course !== course)) updates.course = course;

      if (usernameInput && usernameInput.length >= 6) {
        const exists = await User.findOne({ username: new RegExp(`^${usernameInput}$`, "i") }).select("_id");
        if (exists && String(exists._id) !== String(user._id)) {
          return res.status(409).json({ message: "Username already exists." });
        }
        updates.username = usernameInput;
      }

      if (studentNumberInput && isValidStudentNumberFormat(studentNumberInput)) {
        const exists = await User.findOne({ studentNumber: studentNumberInput }).select("_id");
        if (exists && String(exists._id) !== String(user._id)) {
          return res.status(409).json({ message: "Student number already exists." });
        }
        updates.studentNumber = studentNumberInput;
      }

      if (Object.keys(updates).length) {
        user = await User.findByIdAndUpdate(user._id, updates, { new: true }).select("-password");
      }

      const token = signToken(user._id);
      return res.json({
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: user.fullName,
          email: user.email,
          username: user.username,
          studentNumber: user.studentNumber,
          course: user.course,
          role: user.role,
          avatarUrl: user.avatarUrl || "",
        },
      });
    }

    let username = usernameInput;
    if (!username || username.length < 6) username = await genUsername();

    let studentNumber = studentNumberInput;
    if (!studentNumber || !isValidStudentNumberFormat(studentNumber)) studentNumber = await genStudentNumber();

    const emailExists = await User.findOne({ email }).select("_id");
    if (emailExists) return res.status(409).json({ message: "Email already exists." });

    const usernameExists = await User.findOne({ username: new RegExp(`^${username}$`, "i") }).select("_id");
    if (usernameExists) return res.status(409).json({ message: "Username already exists." });

    const studentExists = await User.findOne({ studentNumber }).select("_id");
    if (studentExists) return res.status(409).json({ message: "Student number already exists." });

    const newUser = await User.create({
      googleId: googleId || undefined,
      firstName,
      lastName,
      fullName,
      email,
      username,
      studentNumber,
      course,
    });

    const token = signToken(newUser._id);

    return res.status(201).json({
      token,
      user: {
        id: newUser._id,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        fullName: newUser.fullName,
        email: newUser.email,
        username: newUser.username,
        studentNumber: newUser.studentNumber,
        course: newUser.course,
        role: newUser.role,
        avatarUrl: newUser.avatarUrl || "",
      },
    });
  } catch (err) {
    console.error("GOOGLE_AUTH_ERROR:", err);
    return res.status(500).json({ message: "Google auth failed." });
  }
}

/* =======================
   FORGOT PASSWORD
   POST /api/auth/forgot-password
   Body: { email }
   NOTE: Always returns a generic success message to avoid account enumeration.
======================= */
async function forgotPassword(req, res) {
  try {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    if (!email) return res.status(400).json({ message: "Email is required." });

    // Service handles: local-only accounts, rate limiting, token generation, email sending
    await requestPasswordReset(email);

    return res.json({
      message:
        "If an account exists for that email, we sent a password reset link. Please check your inbox.",
    });
  } catch (err) {
    console.error("FORGOT_PASSWORD_ERROR:", err);
    // Still return generic message (do not leak existence or internal errors)
    return res.json({
      message:
        "If an account exists for that email, we sent a password reset link. Please check your inbox.",
    });
  }
}

/* =======================
   RESET PASSWORD
   POST /api/auth/reset-password
   Body: { token, password }
======================= */
async function resetPassword(req, res) {
  try {
    const token = String(req.body.token ?? "").trim();
    const password = String(req.body.password ?? "");

    if (!token || !password) {
      return res.status(400).json({ message: "Token and new password are required." });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters." });
    }

    await resetPasswordWithToken({ token, newPassword: password });

    return res.json({ message: "Password updated successfully. You can now login." });
  } catch (err) {
    console.error("RESET_PASSWORD_ERROR:", err);
    return res.status(400).json({ message: err.message || "Reset link is invalid or expired." });
  }
}

/* =======================
   VALIDATE RESET TOKEN
   GET /api/auth/reset-password/validate?token=...
   Response: { valid: boolean, message?: string }
======================= */
async function validateResetPasswordToken(req, res) {
  try {
    const token = String(req.query.token ?? "").trim();

    if (!token) {
      return res.json({
        valid: false,
        message: "Expired! Reset link is missing or invalid. Please request a new one.",
      });
    }

    const ok = await validatePasswordResetToken(token);

    if (ok) return res.json({ valid: true });

    return res.json({
      valid: false,
      message: "Expired! Reset link is invalid or has already been used. Please request a new one.",
    });
  } catch (err) {
    console.error("VALIDATE_RESET_TOKEN_ERROR:", err);
    return res.json({
      valid: false,
      message: "Expired! Reset link is invalid or expired. Please request a new one.",
    });
  }
}


module.exports = {
  register,
  login,
  getMe,
  createUser,
  googleAuth,
  checkAvailability,
  forgotPassword,
  resetPassword,
  validateResetPasswordToken,

};
