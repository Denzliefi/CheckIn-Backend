const { DateTime } = require("luxon");

const PH_TZ = "Asia/Manila";

// Meeting/session configuration (backend source of truth)
const MEET_DURATION_MIN = 60; // ✅ 60-minute meetings
const WORK_START_MIN = 8 * 60; // 08:00
const WORK_END_MIN = 17 * 60;  // 17:00
const LAST_START_MIN = WORK_END_MIN - MEET_DURATION_MIN; // 16:00 is the last valid start for 60m
const LUNCH_START_HHMM = "12:00"; // 12:00–12:59 is lunch break (slot start blocked)

/**
 * Minimum lead time (in minutes) before a meeting can be booked.
 * - Configure in production with COUNSELING_MIN_LEAD_MINUTES
 * - Default: 120 minutes (2 hours) — professional scheduling buffer
 */
function getMinLeadMinutes() {
  const raw = process.env.COUNSELING_MIN_LEAD_MINUTES;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return 120;
}

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

function phNow() {
  return DateTime.now().setZone(PH_TZ);
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

function ceilToNextHour(dt) {
  const base = dt.set({ second: 0, millisecond: 0 });
  if (base.minute === 0) return base;
  return base.plus({ hours: 1 }).set({ minute: 0 });
}

/**
 * Validates the MEET request date/time rules.
 * ✅ Enforces:
 * - Weekdays only + not holiday
 * - Working hours (08:00–17:00) with 60-minute duration (last start 16:00)
 * - 60-minute slot grid (minutes must be :00)
 * - Lunch break slot blocked (12:00)
 * - Must not be in the past (PH time)
 * - Must meet minimum lead time (PH time), rounded to next slot boundary
 */
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

  // 60-minute meetings → only :00 starts are valid
  const [hh, mm] = time.split(":").map(Number);
  if (mm !== 0) {
    return { ok: false, code: "INVALID_INCREMENT", message: "Invalid time. Please choose a full-hour slot." };
  }

  const minutes = hh * 60 + mm;
  if (minutes < WORK_START_MIN || minutes > LAST_START_MIN) {
    return { ok: false, code: "OUTSIDE_WORK_HOURS", message: "Invalid time. Please try again." };
  }

  if (String(time) === LUNCH_START_HHMM) {
    return { ok: false, code: "LUNCH_BREAK", message: "Lunch break (12:00 PM) is not available." };
  }

  // Past / lead-time enforcement in PH time
  const now = phNow();
  const slotDt = DateTime.fromISO(`${date}T${time}`, { zone: PH_TZ });

  if (!slotDt.isValid) {
    return { ok: false, code: "INVALID_TIME", message: "Invalid time. Please try again." };
  }

  const today = now.toISODate(); // YYYY-MM-DD in PH
  if (date < today) {
    return { ok: false, code: "PAST_DATE", message: "Selected date has already passed. Please choose a future date." };
  }

  if (slotDt < now) {
    return { ok: false, code: "TIME_PASSED", message: "Selected time has already passed. Please choose a future time slot." };
  }

  const leadMin = getMinLeadMinutes();
  if (leadMin > 0) {
    const earliestAllowed = ceilToNextHour(now.plus({ minutes: leadMin }));
    if (slotDt < earliestAllowed) {
      const hours = Math.max(1, Math.ceil(leadMin / 60));
      return {
        ok: false,
        code: "TOO_SOON",
        message: `Please book at least ${hours} hour${hours > 1 ? "s" : ""} in advance.`,
        meta: { leadMinutes: leadMin },
      };
    }
  }

  return { ok: true };
}

module.exports = {
  PH_TZ,
  MEET_DURATION_MIN,
  WORK_START_MIN,
  WORK_END_MIN,
  LAST_START_MIN,
  LUNCH_START_HHMM,
  getMinLeadMinutes,
  HOLIDAYS,
  isHoliday,
  isWeekend,
  isValidDateYYYYMMDD,
  isValidTimeHHMM,
  validateMeetRules,
  phNow,
  toMinutes,
  ceilToNextHour,
};
