console.log("SERVER FILE:", __filename);
console.log("CWD:", process.cwd());

// ✅ Load env FIRST (before anything that may use process.env)
const dotenv = require("dotenv");
dotenv.config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const connectDB = require("./src/config/db");
const { initSocket, getAllowedOrigins } = require("./src/config/socket");

const authRoutes = require("./src/routes/auth.routes");
const counselingRoutes = require("./src/routes/counseling.routes");
const userRoutes = require("./src/routes/user.routes");
const journalRoutes = require("./src/routes/journal.routes");
const assessmentRoutes = require("./src/routes/assessment.routes");
const messagesRoutes = require("./src/routes/messages.routes");

const { notFound, errorHandler } = require("./src/middleware/errormiddleware");

const app = express();

/* ======================
   MIDDLEWARE
====================== */
const allowedOrigins = (getAllowedOrigins() || []).filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: false, // keep false if using Bearer token auth only
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // optional but helpful
app.use(morgan("dev"));

/* ======================
   ROUTES
====================== */
app.get("/", (req, res) => res.json({ ok: true, message: "API running" }));

app.use("/api/auth", authRoutes);
app.use("/api/counseling", counselingRoutes);
app.use("/api/users", userRoutes);
app.use("/api/journal", journalRoutes);
app.use("/api/assessments", assessmentRoutes);
app.use("/api/messages", messagesRoutes);

/* ======================
   ERROR MIDDLEWARE (LAST)
====================== */
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

console.log("ABOUT TO LISTEN ON PORT:", PORT);

// ✅ Create HTTP server for Socket.IO
const httpServer = http.createServer(app);

// ✅ Initialize Socket.IO
initSocket(httpServer);

// ✅ Start only after DB connects
(async () => {
  try {
    await connectDB();

    const server = httpServer.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });

    server.on("error", (err) => {
      console.error("❌ LISTEN ERROR:", err);
    });
  } catch (err) {
    console.error("❌ DB CONNECT ERROR:", err);
    process.exit(1);
  }
})();
