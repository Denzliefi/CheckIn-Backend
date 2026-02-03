const { DateTime } = require("luxon");

const PH_TZ = "Asia/Manila";

// You can move this to DB later; keep it simple now
const HOLIDAYS = new Set([
  "2026-01-01",
  // add more…
]);

function isHoliday(phDateYYYYMMDD) {
  return HOLIDAYS.has(phDateYYYYMMDD);
}

function isWeekend(phDateYYYYMMDD) {
  const dt = DateTime.fromISO(phDateYYYYMMDD, { zone: PH_TZ });
  // 6 = Saturday, 7 = Sunday in Luxon
  return dt.weekday === 6 || dt.weekday === 7;
}

function isValidDateYYYYMMDD(s) {
  if (typeof s !== "string") return false;
  const dt = DateTime.fromISO(s, { zone: PH_TZ });
  return dt.isValid && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidTimeHHMM(s) {
  if (typeof s !== "string") return false;
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(s);
}

function validateMeetRules({ date, time }) {
  if (!isValidDateYYYYMMDD(date)) {
    return { ok: false, code: "INVALID_DATE", message: "Invalid date. Please try again." };
  }
  if (!isValidTimeHHMM(time)) {
    return { ok: false, code: "INVALID_TIME", message: "Invalid time. Please try again." };
  }

  if (isWeekend(date)) {
    return { ok: false, code: "INVALID_DATE", message: "Invalid date. Please try again." };
  }
  if (isHoliday(date)) {
    return { ok: false, code: "INVALID_DATE", message: "Invalid date. Please try again." };
  }

  // Working hours 08:00–17:00, 30-min increments
  const [hh, mm] = time.split(":").map(Number);

  const minutes = hh * 60 + mm;
  const start = 8 * 60;   // 08:00
  const end = 17 * 60;    // 17:00 (last valid start time should be <= 16:30 if meeting is 30m)
  if (minutes < start || minutes > end) {
    return { ok: false, code: "OUTSIDE_WORK_HOURS", message: "Invalid time. Please try again." };
  }
  if (mm !== 0 && mm !== 30) {
    return { ok: false, code: "INVALID_INCREMENT", message: "Invalid time. Please try again." };
  }

  return { ok: true };
}

function phNow() {
  return DateTime.now().setZone(PH_TZ);
}

module.exports = {
  PH_TZ,
  HOLIDAYS,
  isHoliday,
  isWeekend,
  isValidDateYYYYMMDD,
  isValidTimeHHMM,
  validateMeetRules,
  phNow,
};
