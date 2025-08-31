// backend/utils/quizUtils.js

/**
 * attemptsAllowed normalization:
 * - undefined / null / ''  -> null (treat as unlimited)
 * - '0' / 0               -> null (unlimited)
 * - positive integer       -> that integer
 * - otherwise              -> throw
 */
function normalizeAttemptsAllowed(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('attemptsAllowed must be an integer ≥ 0');
  }
  return n === 0 ? null : n;
}

module.exports = { normalizeAttemptsAllowed };
