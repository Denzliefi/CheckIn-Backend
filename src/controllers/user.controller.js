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
