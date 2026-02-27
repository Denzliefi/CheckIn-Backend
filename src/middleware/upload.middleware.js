// backend/src/middleware/upload.middleware.js
const multer = require("multer");

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Strict allowlist (frontend uses accept=image/* but backend must enforce too)
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (!file?.mimetype || !ALLOWED_MIME.has(file.mimetype)) {
      const err = new Error("Invalid file type. Only image files are allowed.");
      err.code = "INVALID_FILE_TYPE";
      return cb(err, false);
    }
    cb(null, true);
  },
});

// ✅ Accept either 'avatar' or legacy 'file' key from the frontend
function avatarUpload(req, res, next) {
  upload.fields([
    { name: "avatar", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ])(req, res, (err) => {
    if (!err) return next();

    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        message: "Image too large. Max allowed size is 5MB.",
      });
    }

    if (err.code === "INVALID_FILE_TYPE") {
      return res.status(415).json({
        message: "Invalid file type. Only image files are allowed.",
      });
    }

    return res.status(400).json({
      message: err?.message || "Invalid upload.",
    });
  });
}

module.exports = {
  avatarUpload,
  MAX_FILE_SIZE,
  ALLOWED_MIME,
};
