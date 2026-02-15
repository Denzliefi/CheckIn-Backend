// src/utils/availability.js

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function toHHMM(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Generate time slots in HH:MM format (e.g. 08:00, 08:30, ...)
 * @param {string} startHHMM inclusive
 * @param {string} endHHMM exclusive-ish (last slot start < end)
 * @param {number} stepMin 30 by default
 */
function generateTimeSlots(startHHMM = "08:00", endHHMM = "17:00", stepMin = 30) {
  const start = toMinutes(startHHMM);
  const end = toMinutes(endHHMM);
  if (start == null || end == null) return [];

  const out = [];
  for (let t = start; t <= end; t += stepMin) {
    // If you consider 17:00 invalid start, set < end instead of <=
    out.push(toHHMM(t));
  }
  return out;
}

// Backward-compat: your old generateSlots used numeric minutes.
// Keep it so nothing else breaks.
function generateSlots(start, end, duration = 30) {
  const slots = [];
  let current = start;
  const endTime = end;
  while (current + duration <= endTime) {
    slots.push({ start: current, end: current + duration });
    current += duration;
  }
  return slots;
}

module.exports = { generateTimeSlots, generateSlots };
