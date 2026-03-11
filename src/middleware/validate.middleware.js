function validate(requiredFields = []) {
  return (req, res, next) => {
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
