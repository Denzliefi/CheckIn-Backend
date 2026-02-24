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
