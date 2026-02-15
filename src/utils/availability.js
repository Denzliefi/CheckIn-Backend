// src/utils/availability.js
// Generates time slots between start and end (HH:MM) inclusive start, exclusive end, with step in minutes.
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}
function toHHMM(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function generateTimeSlots(startHHMM, endHHMM, stepMin = 30) {
  const start = toMinutes(startHHMM);
  const end = toMinutes(endHHMM);
  const slots = [];
  for (let t = start; t <= end; t += stepMin) {
    slots.push(toHHMM(t));
  }
  return slots;
}

module.exports = { generateTimeSlots };
