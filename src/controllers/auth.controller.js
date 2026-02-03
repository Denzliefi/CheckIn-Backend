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
      email: user.email,
      username: user.username,
      studentNumber: user.studentNumber,
      role: user.role,
      authProvider: user.authProvider,
    };
  }

  // POST /api/auth/register  (Public) -> force Student
  async function register(req, res, next) {
    try {
      const { fullName, email, username, studentNumber, password } = req.body;

      // Basic validation
      if (!fullName || !email || !username || !studentNumber || !password) {
        res.status(400);
        throw new Error("Missing required fields");
      }
      if (String(password).length < 6) {
        res.status(400);
        throw new Error("Password must be at least 6 characters");
      }

      // Check duplicates
      const emailLower = String(email).toLowerCase();

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
        fullName,
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
      const { googleId, email, fullName } = req.body;

      if (!googleId || !email) {
        res.status(400);
        throw new Error("Missing Google credentials");
      }

      const emailLower = String(email).toLowerCase();

      // Try find by googleId first, then by email (if user previously registered local)
      let user =
        (await User.findOne({ googleId })) ||
        (await User.findOne({ email: emailLower }));

      // If existing local user, attach googleId + provider
      if (user && !user.googleId) {
        user.googleId = googleId;
        user.authProvider = "google";
        await user.save();
      }

      // If no user, create in MongoDB
      if (!user) {
        // Create a safe username fallback (because your schema requires username/studentNumber)
        const baseUsername =
          (emailLower.split("@")[0] || "user").replace(/[^a-z0-9_]/gi, "").toLowerCase();

        const uniqueUsername = `${baseUsername}_${Math.floor(1000 + Math.random() * 9000)}`;

        user = await User.create({
          fullName: fullName || "Google User",
          email: emailLower,
          username: uniqueUsername,
          // your schema requires studentNumber; we need a placeholder unless you change schema
          studentNumber: `GOOGLE-${Date.now()}`,
          googleId,
          authProvider: "google",
          role: "Student",
        });
      }

      const token = signToken(user);

      res.json({
        message: "Google login successful",
        token,
        user: userPayload(user),
      });
    } catch (err) {
      next(err);
    }
  }

  
  module.exports = { register, login, getMe, createUser, googleAuth };

  