// src/utils/availability.js
function generateSlots(start, end, duration = 30) {
  const slots = [];
  let current = start;
  const endTime = end;

  while (current + duration <= endTime) {
    slots.push({
      start: current,
      end: current + duration,
    });
    current += duration;
  }

  return slots;
}

module.exports = { generateSlots };
