console.log("SERVER FILE:", __filename);
console.log("CWD:", process.cwd());

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const morgan = require("morgan");

const connectDB = require("./src/config/db");

const authRoutes = require("./src/routes/auth.routes");
const counselingRoutes = require("./src/routes/counseling.routes");
const userRoutes = require("./src/routes/user.routes");
const journalRoutes = require("./src/routes/journal.routes");

const { notFound, errorHandler } = require("./src/middleware/errormiddleware");

dotenv.config();

const app = express();

/* ======================
   MIDDLEWARE
====================== */
app.use(
  cors({
    origin: ["https://checkinauabc.vercel.app", "http://localhost:3000"],
    credentials: false, // Bearer token auth (no cookies)
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);
app.use(express.json());
app.use(morgan("dev"));

/* ======================
   DB
====================== */
connectDB();

/* ======================
   ROUTES
====================== */
app.get("/", (req, res) => res.json({ ok: true, message: "API running" }));

app.use("/api/auth", authRoutes);
app.use("/api/counseling", counselingRoutes);
app.use("/api/users", userRoutes);
app.use("/api/journal", journalRoutes); // ✅ journal MUST be mounted before notFound

/* ======================
   ERROR MIDDLEWARE (LAST)
====================== */
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

console.log("ABOUT TO LISTEN ON PORT:", PORT);

const server = app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

server.on("error", (err) => {
  console.error("❌ LISTEN ERROR:", err);
});
