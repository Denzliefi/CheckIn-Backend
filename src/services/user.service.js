import User from "../models/User.model.js";

export async function getMyProfileService(userId) {
  const user = await User.findById(userId)
    .select("firstName lastName studentNumber email campus course createdAt role")
    .lean();

  if (!user) {
    const e = new Error("User not found");
    e.statusCode = 404;
    throw e;
  }

  // Normalize shape for frontend
  return {
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    studentNumber: user.studentNumber ?? "",
    email: user.email ?? "",
    campus: user.campus ?? "",
    course: user.course ?? "",
    accountCreation: user.createdAt ?? null,
    role: user.role ?? "",
  };
}
