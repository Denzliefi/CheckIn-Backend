// backend/src/controllers/user.controller.js
// NOTE: This is a drop-in replacement for your existing controller.

function splitName(fullName = "") {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] || "";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";
  return { firstName, lastName };
}

exports.getMe = async (req, res, next) => {
  try {
    const u = req.user;

    // Prefer stored fields; fallback to splitting fullName
    const fromFull = splitName(u.fullName);
    const firstName = String(u.firstName || fromFull.firstName || "").trim();
    const lastName = String(u.lastName || fromFull.lastName || "").trim();
    const fullName = String(u.fullName || [firstName, lastName].filter(Boolean).join(" ")).trim();

    res.json({
      firstName,
      lastName,
      studentNumber: u.studentNumber || "",
      email: u.email || "",
      avatarUrl: u.avatarUrl || "",
      course: u.course || "",
      campus: u.campus || "",
      accountCreation: u.accountCreation || u.createdAt,
      fullName: fullName || "",
      role: u.role || "",
      username: u.username || "",
      status: String(u.status || "active").toLowerCase(),
    });
  } catch (err) {
    next(err);
  }
};

const User = require("../models/User.model");
const CounselingRequest = require("../models/CounselingRequest");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

function isValidEmail(value) {
  const v = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function isCounselorRole(role) {
  return /^counselor$/i.test(String(role || ""));
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

    // tolerate small data inconsistencies like trailing spaces
    const students = await User.find({ role: { $regex: /^student\s*$/i } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("firstName lastName fullName email avatarUrl studentNumber course campus status accountCreation createdAt updatedAt")
      .lean();

    const items = (students || []).map((u) => {
      const created = u.accountCreation || u.createdAt;

      const fromFull = splitName(u.fullName);
      const firstName = String(u.firstName || fromFull.firstName || "").trim();
      const lastName = String(u.lastName || fromFull.lastName || "").trim();
      const fullName = String(u.fullName || [firstName, lastName].filter(Boolean).join(" ")).trim();

      return {
        userId: u._id,
        firstName,
        lastName,
        fullName: fullName || "",
        email: u.email || "",
        avatarUrl: u.avatarUrl || "",
        studentNumber: u.studentNumber || "",
        studentId: u.studentNumber || "",
        course: u.course || "",
        campus: u.campus || "",
        status: String(u.status || "active").toLowerCase(),
        updatedAt: u.updatedAt || null,
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

    if (!/^student\s*$/i.test(String(student.role || "Student"))) {
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
        campus: saved.campus || "",
        status: String(saved.status || "active").toLowerCase(),
        updatedAt: saved.updatedAt || null,
        createdAt: created || null,
        createdMonth: formatYYYYMM(created),
      },
    });
  } catch (err) {
    next(err);
  }


};

/* =========================
   ADMIN: STUDENT STATUS (LIFECYCLE)
   PATCH /api/users/students/:userId/status
   PATCH /api/users/students/status/bulk
========================= */

const ALLOWED_STUDENT_STATUSES = new Set(["pending", "active", "terminated"]);

exports.updateStudentStatusAdmin = async (req, res, next) => {
  try {
    const adminPassword = String(req.body?.adminPassword || "").trim();
    const nextStatus = String(req.body?.status || "").trim().toLowerCase();

    if (!adminPassword) {
      res.status(400);
      throw new Error("Admin password is required.");
    }
    if (!ALLOWED_STUDENT_STATUSES.has(nextStatus)) {
      res.status(400);
      throw new Error("Invalid status. Use pending, active, or terminated.");
    }

    // Verify admin password
    const admin = await User.findById(req.user?._id).select("+password");
    if (!admin) {
      res.status(401);
      throw new Error("Not authorized.");
    }
    const ok = await admin.comparePassword(adminPassword);
    if (!ok) {
      res.status(403);
      throw new Error("Incorrect admin password.");
    }

    const { userId } = req.params;
    const student = await User.findById(userId);
    if (!student) {
      res.status(404);
      throw new Error("Student not found.");
    }
    if (!/^student\s*$/i.test(String(student.role || ""))) {
      res.status(400);
      throw new Error("Target user is not a student.");
    }

    student.status = nextStatus;
    await student.save();

    return res.json({
      id: String(student._id),
      status: String(student.status || "active").toLowerCase(),
      updatedAt: (student.updatedAt ? new Date(student.updatedAt).toISOString() : new Date().toISOString()),
    });
  } catch (err) {
    next(err);
  }
};

exports.bulkUpdateStudentStatusAdmin = async (req, res, next) => {
  try {
    const adminPassword = String(req.body?.adminPassword || "").trim();
    const nextStatus = String(req.body?.status || "").trim().toLowerCase();
    const userIdsRaw = Array.isArray(req.body?.userIds)
      ? req.body.userIds
      : Array.isArray(req.body?.studentIds)
        ? req.body.studentIds
        : Array.isArray(req.body?.ids)
          ? req.body.ids
          : [];

    const userIds = [...new Set(userIdsRaw.map((x) => String(x)).filter(Boolean))];

    if (!adminPassword) {
      res.status(400);
      throw new Error("Admin password is required.");
    }
    if (!ALLOWED_STUDENT_STATUSES.has(nextStatus)) {
      res.status(400);
      throw new Error("Invalid status. Use pending, active, or terminated.");
    }
    if (!userIds.length) {
      res.status(400);
      throw new Error("No students selected.");
    }

    const admin = await User.findById(req.user?._id).select("+password");
    if (!admin) {
      res.status(401);
      throw new Error("Not authorized.");
    }
    const ok = await admin.comparePassword(adminPassword);
    if (!ok) {
      res.status(403);
      throw new Error("Incorrect admin password.");
    }

    const updatedAt = new Date();

    await User.updateMany(
      { _id: { $in: userIds }, role: { $regex: /^student\s*$/i } },
      { $set: { status: nextStatus, updatedAt } }
    );

    return res.json({
      items: userIds.map((id) => ({
        id: String(id),
        status: nextStatus,
        updatedAt: updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
};

/* =========================
   ADMIN: COUNSELOR MANAGEMENT
   - Limit: 5 counselors
   - Create counselor with: fullName, email, counselorId, password
   - Stores counselorId in counselorCode (existing schema field)
========================= */

function cmStrip(v) {
  return String(v ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[<>`]/g, "")
    .trim();
}

function cmSanitizeFullName(v, max = 80) {
  const s = cmStrip(v)
    .replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'\-\s]/g, "")
    .replace(/\s{2,}/g, " ");
  return s.slice(0, max).trim();
}

function cmSanitizeEmail(v, max = 120) {
  return cmStrip(v).replace(/\s+/g, "").slice(0, max).toLowerCase();
}

function cmSanitizeCounselorId(v, max = 20) {
  return cmStrip(v).replace(/\s+/g, "").slice(0, max).toUpperCase();
}

function cmIsValidCounselorId(v) {
  // Expected pattern: C-0001 (>=4 digits)
  return /^C-\d{4,}$/.test(String(v || "").trim().toUpperCase());
}

function cmEscapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function cmGenerateUniqueUsername(seed) {
  let base = cmStrip(seed)
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9._]/g, "")
    .slice(0, 18);

  if (base.length < 6) base = (base + "counselor").slice(0, 18);

  // Ensure within [6..24] by adding suffix
  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : String(Math.floor(Math.random() * 9000) + 1000);
    const candidate = (base + suffix).slice(0, 24);

    // case-insensitive uniqueness check
    const exists = await User.findOne({
      username: new RegExp(`^${cmEscapeRegex(candidate)}$`, "i"),
    })
      .select("_id")
      .lean();

    if (!exists) return candidate;
  }

  // last resort
  return `counselor_${Date.now()}`.slice(0, 24);
}

async function cmGenerateUniqueStudentNumber(seed) {
  const base = cmStrip(seed).slice(0, 24);
  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : `-${Math.floor(Math.random() * 9000) + 1000}`;
    const candidate = (base + suffix).slice(0, 32);
    const exists = await User.findOne({ studentNumber: candidate }).select("_id").lean();
    if (!exists) return candidate;
  }
  return (`COUNSELOR-${Date.now()}`).slice(0, 32);
}

exports.getCounselorsAdmin = async (req, res, next) => {
  try {
    const items = await User.find({ role: { $regex: /^counselor\s*$/i } })
      .sort({ createdAt: -1 })
      .limit(50)
      .select("fullName email counselorCode createdAt")
      .lean();

    return res.json({
      items: (items || []).map((u) => ({
        _id: u._id,
        fullName: u.fullName || "",
        email: u.email || "",
        counselorId: u.counselorCode || "",
        counselorCode: u.counselorCode || "",
        createdAt: u.createdAt || null,
      })),
    });
  } catch (err) {
    next(err);
  }
};

exports.createCounselorAdmin = async (req, res, next) => {
  try {
    const count = await User.countDocuments({ role: { $regex: /^counselor\s*$/i } });
    if (count >= 5) {
      res.status(409);
      throw new Error("Counselor limit reached (5).");
    }

    const fullName = cmSanitizeFullName(req.body?.fullName);
    const email = cmSanitizeEmail(req.body?.email);
    const counselorId = cmSanitizeCounselorId(req.body?.counselorId);
    const password = String(req.body?.password ?? "")
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim()
      .slice(0, 72);

    if (!fullName) {
      res.status(400);
      throw new Error("Counselor name is required.");
    }
    if (!email || !isValidEmail(email)) {
      res.status(400);
      throw new Error("Valid counselor email is required.");
    }
    if (!counselorId) {
      res.status(400);
      throw new Error("Counselor ID is required.");
    }
    if (!cmIsValidCounselorId(counselorId)) {
      res.status(400);
      throw new Error("Counselor ID format is invalid. Use C-0001 format.");
    }
    if (!password) {
      res.status(400);
      throw new Error("Password is required.");
    }
    if (password.length < 8) {
      res.status(400);
      throw new Error("Password must be at least 8 characters.");
    }

    // Uniqueness checks with friendly errors
    const emailExists = await User.findOne({ email }).select("_id").lean();
    if (emailExists) {
      res.status(409);
      throw new Error("Email already exists.");
    }

    const cidRegex = new RegExp(`^${cmEscapeRegex(counselorId)}$`, "i");
    const idExists = await User.findOne({ counselorCode: cidRegex }).select("_id").lean();
    if (idExists) {
      res.status(409);
      throw new Error("Counselor ID already exists.");
    }

    // Generate required fields for this schema
    const usernameSeed = String(email || "").split("@")[0] || "counselor";
    const username = await cmGenerateUniqueUsername(usernameSeed);
    const studentNumber = await cmGenerateUniqueStudentNumber(`COUNSELOR-${counselorId}`);

    const counselor = await User.create({
      fullName,
      email,
      username,
      studentNumber,
      password,
      role: "Counselor",
      counselorCode: counselorId,
    });

    return res.status(201).json({
      item: {
        _id: counselor._id,
        fullName: counselor.fullName || "",
        email: counselor.email || "",
        counselorId: counselor.counselorCode || "",
        counselorCode: counselor.counselorCode || "",
        createdAt: counselor.createdAt || null,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.deleteCounselorAdmin = async (req, res, next) => {
  try {
    const adminPassword = String(req.body?.adminPassword || "").trim();
    if (!adminPassword) {
      res.status(400);
      throw new Error("Admin password is required.");
    }

    const admin = await User.findById(req.user?._id).select("+password");
    if (!admin) {
      res.status(401);
      throw new Error("Not authorized.");
    }
    if (!admin.password) {
      res.status(400);
      throw new Error("Admin account has no password set.");
    }

    const ok = await admin.comparePassword(adminPassword);
    if (!ok) {
      res.status(403);
      throw new Error("Incorrect admin password.");
    }

    const { counselorUserId } = req.params;
    const counselor = await User.findById(counselorUserId);
    if (!counselor) {
      res.status(404);
      throw new Error("Counselor not found.");
    }
    if (!/^counselor\s*$/i.test(String(counselor.role || ""))) {
      res.status(400);
      throw new Error("Target user is not a counselor.");
    }

    await User.deleteOne({ _id: counselor._id });

    return res.json({ message: "Counselor deleted." });
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

/**
 * Counselor-only avatar upload wrapper
 * - Use this for Counselor Dashboard Account Settings.
 * - Students should use the generic /api/users/me/avatar endpoint (if enabled in your UI).
 */
exports.updateMyCounselorAvatar = async (req, res, next) => {
  try {
    if (!isCounselorRole(req.user?.role)) {
      return res.status(403).json({ message: "Only counselors can update a profile photo here." });
    }
    return exports.updateMyAvatar(req, res, next);
  } catch (err) {
    next(err);
  }
};


/* =========================
   ADMIN: ANALYTICS (AssignmentsReassignment)
   GET /api/users/admin/analytics
   - Student lifecycle counts: pending / active / terminated
   - Active students: status === "active"
   - Counselors: role === "counselor" (case-insensitive), plus active counselors
   - Requests status counts from CounselingRequest: pending / approved / cancelled / disapproved
   - Students by course: count + percentage
========================= */
exports.getAdminAnalytics = async (req, res, next) => {
  try {
    const studentRole = { role: { $regex: /^student\s*$/i } };
    const counselorRole = { role: { $regex: /^counselor\s*$/i } };

    const [
      studentsPending,
      studentsActive,
      studentsTerminated,
      studentsTotal,
      counselorsTotal,
      counselorsActive,
      courseAgg,
      requestAgg,
    ] = await Promise.all([
      User.countDocuments({ ...studentRole, status: "pending" }),
      User.countDocuments({ ...studentRole, status: "active" }),
      User.countDocuments({ ...studentRole, status: "terminated" }),
      User.countDocuments(studentRole),
      User.countDocuments(counselorRole),
      User.countDocuments({ ...counselorRole, status: "active" }),
      User.aggregate([
        { $match: studentRole },
        {
          $project: {
            course: {
              $trim: {
                input: { $ifNull: ["$course", ""] },
              },
            },
          },
        },
        {
          $addFields: {
            course: {
              $cond: [{ $eq: ["$course", ""] }, "Unknown", "$course"],
            },
          },
        },
        { $group: { _id: "$course", count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
      ]),
      CounselingRequest.aggregate([
        {
          $project: {
            statusLower: { $toLower: { $ifNull: ["$status", ""] } },
          },
        },
        { $group: { _id: "$statusLower", count: { $sum: 1 } } },
      ]),
    ]);

    const byStatus = new Map((requestAgg || []).map((x) => [String(x._id || ""), Number(x.count || 0)]));

    const requestsPending = byStatus.get("pending") || 0;
    const requestsApproved = byStatus.get("approved") || 0;
    const requestsCancelled = byStatus.get("cancelled") || 0;
    const requestsDisapproved = byStatus.get("disapproved") || 0;

    const requestsTotal = requestsPending + requestsApproved + requestsCancelled + requestsDisapproved;

    const denom = Math.max(1, Number(studentsTotal || 0));
    const studentsByCourse = (courseAgg || []).map((c) => {
      const course = String(c._id || "Unknown").trim() || "Unknown";
      const count = Math.max(0, Number(c.count || 0));
      const percentage = Math.round((count / denom) * 1000) / 10; // 1 decimal place
      return { key: course, course, count, percentage };
    });

    // Return both:
    // - A "clean" structure for future use
    // - UI-friendly keys already expected by AssignmentsReassignment.js (no UI changes required)
    return res.json({
      students: {
        pending: studentsPending,
        active: studentsActive,
        terminated: studentsTerminated,
        total: studentsTotal,
      },
      activeStudents: studentsActive,
      counselors: counselorsTotal,
      counselorsActive,

      requests: {
        pending: requestsPending,
        approved: requestsApproved,
        cancelled: requestsCancelled,
        disapproved: requestsDisapproved,
        total: requestsTotal,
      },

      studentsByCourse,

      // ✅ UI keys (AssignmentsReassignment / AdminOverviewAnalytics)
      studentsTotal,
      studentsActive,
      counselorsTotal,
      requestsPending,
      requestsApproved,
      requestsCancelled,
      requestsDone: requestsDisapproved, // UI label is "Disapproved"
      requestsDisapproved,
      requestsNoShows: 0,
    });
  } catch (err) {
    next(err);
  }
};

