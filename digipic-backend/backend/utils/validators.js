// ==== utils/validators.js ==== //
function normalizeAttemptsAllowed(v) {
  if (v === null || v === undefined || v === '') return null; // unlimited
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error('attemptsAllowed must be an integer ≥ 0');
  return n === 0 ? null : n;
}

const isValidSchoolYear = (sy) =>
  typeof sy === 'string' &&
  /^\d{4}-\d{4}$/.test(sy) &&
  parseInt(sy.slice(5), 10) - parseInt(sy.slice(0, 4), 10) === 1;

const isValidSemester = (s) => s === '1st Semester' || s === '2nd Semester';

module.exports = { normalizeAttemptsAllowed, isValidSchoolYear, isValidSemester };
