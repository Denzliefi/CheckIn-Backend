console.log("✅ LOADED validate.middleware.js from:", __filename);

function validate(requiredFields = []) {
  return (req, res, next) => {
    console.log("✅ validate called. req.body is:", req.body);

    const body = req.body ?? {};
    const errors = [];

    requiredFields.forEach((field) => {
      const value = body[field];
      if (value === undefined || value === null || String(value).trim() === "") {
        errors.push(`${field} is required`);
      }
    });

    if (errors.length > 0) {
      return res.status(400).json({ message: "Validation error", errors });
    }

    next();
  };
}

module.exports = { validate };
