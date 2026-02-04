  const bcrypt = require("bcryptjs");
  const jwt = require("jsonwebtoken");
  const User = require("../models/User.model");

  // Helper: sign JWT (include role for RBAC)
  function signToken(user) {
    return jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );
  }

  // Helper: safe user payload
  function userPayload(user) {
    return {
      id: user._id,
      fullName: user.fullName,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      username: user.username,
      studentNumber: user.studentNumber,
      campus: user.campus,
      course: user.course,
      role: user.role,
      authProvider: user.authProvider,
    };
  }

  // POST /api/auth/register  (Public) -> force Student
  async function register(req, res, next) {
    try {
      const { fullName, email, username, studentNumber, password, firstName, lastName, campus, course} = req.body;

      // Basic validation
      const computedFullName = fullName || [String(firstName||'').trim(), String(lastName||'').trim()].filter(Boolean).join(' ').trim();

      if (!computedFullName || !email || !username || !studentNumber || !password) {
        res.status(400);
        throw new Error("Missing required fields");
      }
      if (String(password).length < 6) {
        res.status(400);
        throw new Error("Password must be at least 6 characters");
      }

      // Check duplicates
      const emailLower = String(email).toLowerCase();

      // Use computedFullName when first/last are provided
      const finalFullName = computedFullName || fullName;

      const existingEmail = await User.findOne({ email: emailLower });
      if (existingEmail) {
        res.status(409);
        throw new Error("Email already exists");
      }

      const existingUsername = await User.findOne({ username });
      if (existingUsername) {
        res.status(409);
        throw new Error("Username already exists");
      }

      const existingStudent = await User.findOne({ studentNumber });
      if (existingStudent) {
        res.status(409);
        throw new Error("Student number already exists");
      }

      // Hash password
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      // Create user (force Student role)
      const user = await User.create({
        fullName: finalFullName,
        firstName: firstName ? String(firstName).trim() : undefined,
        lastName: lastName ? String(lastName).trim() : undefined,
        campus: campus ? String(campus).trim() : undefined,
        course: course ? String(course).trim() : undefined,
        email: emailLower,
        username,
        studentNumber,
        passwordHash,
        authProvider: "local",
        role: "Student",
      });

      const token = signToken(user);

      res.status(201).json({
        message: "Registered successfully",
        token,
        user: userPayload(user),
      });
    } catch (err) {
      next(err);
    }
  }

  // POST /api/auth/login
  // NOTE: expects { emailOrUsername, password }
  async function login(req, res, next) {
    try {
      const { emailOrUsername, password } = req.body;

      if (!emailOrUsername || !password) {
        res.status(400);
        throw new Error("Missing credentials");
      }

      const query =
        String(emailOrUsername).includes("@")
          ? { email: String(emailOrUsername).toLowerCase() }
          : { username: emailOrUsername };

      const user = await User.findOne(query);

      if (!user) {
        res.status(401);
        throw new Error("Invalid credentials");
      }

      const ok = await user.matchPassword(password);
      if (!ok) {
        res.status(401);
        throw new Error("Invalid credentials");
      }

      const token = signToken(user);

      res.json({
        message: "Logged in successfully",
        token,
        user: userPayload(user),
      });
    } catch (err) {
      next(err);
    }
  }

  

  // GET /api/auth/me  (Private)
  function getMe(req, res) {
    // protect middleware sets req.user from DB
    res.json(userPayload(req.user));
  }

  // POST /api/auth/create-user (Admin only via route middleware)
  // Allows admin to create Consultant/Admin/Student accounts
  async function createUser(req, res, next) {
    try {
      const { fullName, email, username, studentNumber, password, role } = req.body;

      if (!fullName || !email || !username || !role) {
        res.status(400);
        throw new Error("Missing required fields");
      }

      const allowed = ["Admin", "Consultant", "Student"];
      if (!allowed.includes(role)) {
        res.status(400);
        throw new Error("Invalid role");
      }

      const emailLower = String(email).toLowerCase();

      // Use computedFullName when first/last are provided
      const finalFullName = computedFullName || fullName;

      const existingEmail = await User.findOne({ email: emailLower });
      if (existingEmail) {
        res.status(409);
        throw new Error("Email already exists");
      }

      const existingUsername = await User.findOne({ username });
      if (existingUsername) {
        res.status(409);
        throw new Error("Username already exists");
      }

      // If you still require studentNumber in schema, use placeholder for non-students
      const finalStudentNumber =
        studentNumber ||
        (role === "Student" ? null : `${role.toUpperCase().slice(0, 4)}-${Date.now()}`);

      // If password provided, hash it; otherwise create google/local later
      let passwordHash;
      if (password) {
        if (String(password).length < 6) {
          res.status(400);
          throw new Error("Password must be at least 6 characters");
        }
        const salt = await bcrypt.genSalt(10);
        passwordHash = await bcrypt.hash(password, salt);
      }

      const user = await User.create({
        fullName,
        email: emailLower,
        username,
        studentNumber: finalStudentNumber,
        passwordHash,
        authProvider: passwordHash ? "local" : "local",
        role,
      });

      res.status(201).json({
        message: "User created",
        user: userPayload(user),
      });
    } catch (err) {
      next(err);
    }
  }

  // POST /api/auth/google
  async function googleAuth(req, res, next) {
    try {
      const {
        googleId,
        email,
        fullName,
        firstName,
        lastName,
        username,
        studentNumber,
        course,
        campus,
      } = req.body;

      if (!googleId || !email) {
        res.status(400);
        throw new Error("Missing Google credentials");
      }

      const emailLower = String(email).toLowerCase().trim();

      // Try find by googleId first, then by email (if user previously registered local)
      let user =
        (await User.findOne({ googleId })) ||
        (await User.findOne({ email: emailLower }));

      // Helper: detect placeholders created by old logic
      const isPlaceholderStudentNumber = (v) =>
        typeof v === "string" && v.toUpperCase().startsWith("GOOGLE-");

      const isPlaceholderUsername = (u, emailLower) => {
        if (!u || typeof u !== "string") return false;
        const base = (emailLower.split("@")[0] || "user")
          .replace(/[^a-z0-9_]/gi, "")
          .toLowerCase();
        // old format: base_#### (4 digits)
        return new RegExp(`^${base}_[0-9]{4}$`).test(u);
      };

      // Normalize incoming fields (optional for login page, required for signup page)
      const inFirst = (firstName || "").toString().trim();
      const inLast = (lastName || "").toString().trim();
      const inUser = (username || "").toString().trim();
      const inStud = (studentNumber || "").toString().trim();
      const inCourse = (course || "").toString().trim();
      const inCampus = (campus || "").toString().trim();

      // If user exists:
      if (user) {
        // Attach googleId if needed
        if (!user.googleId) {
          user.googleId = googleId;
          user.authProvider = "google";
        }

        // If the client sent profile fields (Signup page), sync them.
        // Only update username/studentNumber if the current values are placeholders (or empty)
        const wantsSync = Boolean(inFirst || inLast || inUser || inStud || inCourse || inCampus);

        if (wantsSync) {
          // Validate if provided
          if (inUser && inUser.length < 6) {
            res.status(400);
            throw new Error("Username must be at least 6 characters");
          }
          if (inStud) {
            const studentNumberRegex = /^[0-9]{2}-[0-9]{5}$/;
            if (!studentNumberRegex.test(inStud)) {
              res.status(400);
              throw new Error("Invalid student number format");
            }
          }

          // Uniqueness checks if changing to non-placeholder
          if (inUser && (user.username !== inUser) && (isPlaceholderUsername(user.username, emailLower) || !user.username)) {
            const existingUsername = await User.findOne({ username: inUser, _id: { $ne: user._id } });
            if (existingUsername) {
              res.status(409);
              throw new Error("Username already exists");
            }
            user.username = inUser;
          }

          if (inStud && (user.studentNumber !== inStud) && (isPlaceholderStudentNumber(user.studentNumber) || !user.studentNumber)) {
            const existingStud = await User.findOne({ studentNumber: inStud, _id: { $ne: user._id } });
            if (existingStud) {
              res.status(409);
              throw new Error("Student number already exists");
            }
            user.studentNumber = inStud;
          }

          if (inFirst && !user.firstName) user.firstName = inFirst;
          if (inLast && !user.lastName) user.lastName = inLast;

          if (inCourse && !user.course) user.course = inCourse;
          if (inCampus && !user.campus) user.campus = inCampus;

          // If we now have first + last, ensure fullName is consistent
          const finalFullName =
            [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
            user.fullName ||
            fullName ||
            "Google User";

          user.fullName = finalFullName;

          await user.save();
        } else {
          // no sync requested: still ensure provider/id is saved
          await user.save();
        }

        const token = signToken(user);
        return res.json({
          message: "Google login successful",
          token,
          user: userPayload(user),
        });
      }

      // If user does NOT exist: we require signup fields (Signup page)
      // Without these, we cannot create a user (schema requires username/studentNumber).
      if (!inFirst || !inLast || !inUser || !inStud || !inCourse) {
        res.status(400);
        throw new Error("Please complete signup details before using Google sign up.");
      }

      if (inUser.length < 6) {
        res.status(400);
        throw new Error("Username must be at least 6 characters");
      }

      const studentNumberRegex = /^[0-9]{2}-[0-9]{5}$/;
      if (!studentNumberRegex.test(inStud)) {
        res.status(400);
        throw new Error("Invalid student number format");
      }

      // Check duplicates
      const existingEmail = await User.findOne({ email: emailLower });
      if (existingEmail) {
        res.status(409);
        throw new Error("Email already exists");
      }

      const existingUsername = await User.findOne({ username: inUser });
      if (existingUsername) {
        res.status(409);
        throw new Error("Username already exists");
      }

      const existingStud = await User.findOne({ studentNumber: inStud });
      if (existingStud) {
        res.status(409);
        throw new Error("Student number already exists");
      }

      const finalFullName =
        [inFirst, inLast].filter(Boolean).join(" ").trim() ||
        (fullName || "").toString().trim() ||
        "Google User";

      user = await User.create({
        fullName: finalFullName,
        firstName: inFirst,
        lastName: inLast,
        email: emailLower,
        username: inUser,
        studentNumber: inStud,
        campus: inCampus || undefined,
        course: inCourse || undefined,
        googleId,
        authProvider: "google",
        role: "Student",
      });

      const token = signToken(user);

      res.json({
        message: "Google signup successful",
        token,
        user: userPayload(user),
      });
    } catch (err) {
      next(err);
    }
  }


  module.exports = { register, login, getMe, createUser, googleAuth };

  