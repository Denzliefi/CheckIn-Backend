function splitName(fullName = "") {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] || "";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";
  return { firstName, lastName };
}

exports.getMe = async (req, res, next) => {
  try {
    const u = req.user;

    const { firstName, lastName } = splitName(u.fullName);

    res.json({
      firstName,
      lastName,
      studentNumber: u.studentNumber || "",
      email: u.email || "",
      avatarUrl: u.avatarUrl || "",
      course: u.course || "",
      campus: u.campus || "",
      accountCreation: u.createdAt,
      fullName: u.fullName || "",
      role: u.role || "",
      username: u.username || "",
    });
  } catch (err) {
    next(err);
  }
};

const User = require("../models/User.model");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

function isValidEmail(value) {
  const v = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function formatYYYYMM(d) {
  const dt = d ? new Date(d) : null;
  if (!dt || !Number.isFinite(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

exports.getStudentsForCounselor = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || "2000", 10), 1), 5000);

    const students = await User.find({ role: { $regex: /^student$/i } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("firstName lastName fullName email studentNumber course accountCreation createdAt")
      .lean();

    const items = (students || []).map((u) => {
      const created = u.accountCreation || u.createdAt;
      return {
        userId: u._id,
        firstName: u.firstName || "",
        lastName: u.lastName || "",
        fullName: u.fullName || "",
        email: u.email || "",
      avatarUrl: u.avatarUrl || "",
        studentNumber: u.studentNumber || "",
        studentId: u.studentNumber || "",
        course: u.course || "",
        createdAt: created || null,
        createdMonth: formatYYYYMM(created),
      };
    });

    res.json({ items });
  } catch (err) {
    next(err);
  }
};

exports.updateStudentForCounselor = async (req, res, next) => {
  try {
    const counselorPassword = String(req.body?.counselorPassword || "");
    if (!counselorPassword.trim()) {
      res.status(400);
      throw new Error("Counselor password is required.");
    }

    // Load counselor with password for verification
    const counselor = await User.findById(req.user?._id).select("+password");
    if (!counselor) {
      res.status(401);
      throw new Error("Not authorized.");
    }

    const ok = await counselor.comparePassword(counselorPassword);
    if (!ok) {
      res.status(403);
      throw new Error("Incorrect counselor password.");
    }

    const { userId } = req.params;

    const student = await User.findById(userId);
    if (!student) {
      res.status(404);
      throw new Error("Student not found.");
    }

    if (!/^student$/i.test(String(student.role || "Student"))) {
      res.status(400);
      throw new Error("Target user is not a student.");
    }

    const firstName = String(req.body?.firstName ?? "").trim();
    const lastName = String(req.body?.lastName ?? "").trim();
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const studentNumber = String(req.body?.studentNumber ?? "").trim();
    const course = String(req.body?.course ?? "").trim();

    if (!firstName) {
      res.status(400);
      throw new Error("First Name is required.");
    }
    if (!lastName) {
      res.status(400);
      throw new Error("Last Name is required.");
    }
    if (!email) {
      res.status(400);
      throw new Error("Email is required.");
    }
    if (!isValidEmail(email)) {
      res.status(400);
      throw new Error("Email format is invalid.");
    }
    if (!studentNumber) {
      res.status(400);
      throw new Error("Student ID is required.");
    }

    // unique email if changed
    if (email !== String(student.email || "").toLowerCase()) {
      const exists = await User.findOne({ email }).select("_id").lean();
      if (exists) {
        res.status(409);
        throw new Error("Email already exists.");
      }
    }

    // unique student number if changed
    if (studentNumber !== String(student.studentNumber || "")) {
      const exists2 = await User.findOne({ studentNumber }).select("_id").lean();
      if (exists2) {
        res.status(409);
        throw new Error("Student ID already exists.");
      }
    }

    student.firstName = firstName;
    student.lastName = lastName;
    student.fullName = `${firstName} ${lastName}`.trim();
    student.email = email;
    student.studentNumber = studentNumber;
    student.course = course;

    const saved = await student.save();

    const created = saved.accountCreation || saved.createdAt;

    return res.json({
      message: "Student updated successfully",
      item: {
        userId: saved._id,
        firstName: saved.firstName || "",
        lastName: saved.lastName || "",
        fullName: saved.fullName || "",
        email: saved.email || "",
        studentNumber: saved.studentNumber || "",
        studentId: saved.studentNumber || "",
        course: saved.course || "",
        createdAt: created || null,
        createdMonth: formatYYYYMM(created),
      },
    });
  } catch (err) {
    next(err);
  }
};


/* =========================
   PROFILE PHOTO (AVATAR)
   - 5MB max (enforced by multer)
   - images only (mime + signature check)
========================= */

function pickUploadedAvatar(req) {
  // multer.fields([{name:'avatar'},{name:'file'}]) populates req.files
  const f1 = req.files?.avatar?.[0];
  const f2 = req.files?.file?.[0];
  return f1 || f2 || req.file || null;
}

function detectImageExtensionFromBuffer(buf) {
  if (!buf || buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return "png";

  // GIF: GIF87a / GIF89a
  const head6 = buf.subarray(0, 6).toString("ascii");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "gif";

  // WEBP: "RIFF"...."WEBP"
  const riff = buf.subarray(0, 4).toString("ascii");
  const webp = buf.subarray(8, 12).toString("ascii");
  if (riff === "RIFF" && webp === "WEBP") return "webp";

  return null;
}

function safeJoinUnder(baseDir, filename) {
  const safeName = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(baseDir, safeName);
}

exports.updateMyAvatar = async (req, res, next) => {
  try {
    const file = pickUploadedAvatar(req);

    if (!file || !file.buffer) {
      res.status(400);
      throw new Error("No image uploaded. Please choose an image file.");
    }

    // Extra safety: even if multer limit changes, guard here too.
    const MAX = 5 * 1024 * 1024;
    if (file.size && file.size > MAX) {
      res.status(413);
      throw new Error("Image too large. Max allowed size is 5MB.");
    }
    if (file.buffer.length > MAX) {
      res.status(413);
      throw new Error("Image too large. Max allowed size is 5MB.");
    }

    // Verify actual bytes (prevents fake mimetype uploads)
    const ext = detectImageExtensionFromBuffer(file.buffer);
    if (!ext) {
      res.status(415);
      throw new Error("Invalid file type. Only image files (JPG, PNG, WEBP, GIF) are allowed.");
    }

    const uploadDir = path.join(__dirname, "../../uploads/avatars");
    await fs.mkdir(uploadDir, { recursive: true });

    const filename = `${req.user._id}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}.${ext}`;
    const absPath = safeJoinUnder(uploadDir, filename);

    await fs.writeFile(absPath, file.buffer);

    // Remove old local avatar file to avoid disk bloat (best-effort)
    const prev = String(req.user.avatarUrl || "");
    if (prev.startsWith("/uploads/avatars/")) {
      const prevName = path.basename(prev);
      if (prevName && prevName !== filename) {
        const prevAbs = safeJoinUnder(uploadDir, prevName);
        await fs.unlink(prevAbs).catch(() => {});
      }
    }

    req.user.avatarUrl = `/uploads/avatars/${filename}`;
    await req.user.save();

    return res.json({
      message: "Profile photo updated.",
      avatarUrl: req.user.avatarUrl,
      user: {
        id: req.user._id,
        fullName: req.user.fullName,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        email: req.user.email,
        username: req.user.username,
        studentNumber: req.user.studentNumber,
        course: req.user.course,
        campus: req.user.campus,
        role: req.user.role,
        avatarUrl: req.user.avatarUrl,
      },
    });
  } catch (err) {
    next(err);
  }
};
