// backend/src/app.js
const express = require("express");
const cors = require("cors");

// routes
const authRoutes = require("./routes/auth.routes"); // you probably already have this
const userRoutes = require("./routes/user.routes");

const app = express();

/* =========================
   MIDDLEWARES
========================= */
app.use(cors());
app.use(express.json()); // so req.body works

/* =========================
   ROUTES
========================= */
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);

/* =========================
   FALLBACK
========================= */
app.use((req, res) => {
  res.status(404).json({ message: `Not Found - ${req.originalUrl}` });
});

module.exports = app;
