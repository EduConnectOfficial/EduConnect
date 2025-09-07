// backend/utils/timeUtils.js
const { admin } = require('../config/firebase');

/**
 * Accepts a number (ms), ISO string, Date, or null/''.
 * Returns Firestore Timestamp or null.
 */
function parseDueAtToTimestamp(v) {
  if (v === null || v === undefined || v === '') return null;

  if (v instanceof Date && !isNaN(v.getTime())) {
    return admin.firestore.Timestamp.fromDate(v);
  }
  if (typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : admin.firestore.Timestamp.fromDate(d);
  }
  // strings (ISO or parseable)
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(d);
}

/** Convenience: string/number -> Timestamp | null (same as above). */
function toTimestampOrNull(v) {
  return parseDueAtToTimestamp(v);
}

module.exports = { parseDueAtToTimestamp, toTimestampOrNull };
