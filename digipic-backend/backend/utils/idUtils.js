// backend/utils/idUtils.js
const { firestore, admin } = require('../config/firebase');

/**
 * Generate a sequential, per-role, per-year ID using a Firestore counter.
 * Formats:
 *   - Students: S-YYYY-00001
 *   - Teachers: T-YYYY-00001
 *   - Others:   U-YYYY-00001
 *
 * Uses a transaction for concurrency safety.
 * @param {'student'|'teacher'|'user'|string} role
 * @returns {Promise<string>} e.g. "S-2025-00001"
 */
async function generateRoleId(role = 'user') {
  const now = new Date();
  const year = now.getFullYear();

  const prefix =
    role === 'student' ? 'S' :
    role === 'teacher' ? 'T' :
    'U';

  const counterRef = firestore.collection('counters').doc(`${role}-${year}`);

  const id = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    let seq = 0;

    if (snap.exists && typeof snap.data().seq === 'number') {
      seq = snap.data().seq;
    }

    seq += 1;

    tx.set(
      counterRef,
      {
        seq,
        prefix,
        year,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
  });

  return id;
}

/**
 * Resolve a user's Firestore DocumentReference from *any* identifier:
 * - Firestore user document id
 * - userId field (if you mirror it)
 * - studentId field (e.g., S-YYYY-xxxxx)
 * - teacherId field (e.g., T-YYYY-xxxxx)
 * - email (fallback if it looks like an email)
 *
 * @param {string} anyId
 * @returns {Promise<import('@google-cloud/firestore').DocumentReference|null>}
 */
async function getUserRefByAnyId(anyId) {
  if (!anyId) return null;
  const id = String(anyId).trim();
  const users = firestore.collection('users');

  // 1) Direct document id
  try {
    const direct = await users.doc(id).get();
    if (direct.exists) return direct.ref;
  } catch {}

  // 2) userId field
  try {
    const byUserId = await users.where('userId', '==', id).limit(1).get();
    if (!byUserId.empty) return byUserId.docs[0].ref;
  } catch {}

  // 3) studentId field
  try {
    const byStudent = await users.where('studentId', '==', id).limit(1).get();
    if (!byStudent.empty) return byStudent.docs[0].ref;
  } catch {}

  // 4) teacherId field
  try {
    const byTeacher = await users.where('teacherId', '==', id).limit(1).get();
    if (!byTeacher.empty) return byTeacher.docs[0].ref;
  } catch {}

  // 5) email (only if it looks like an email)
  if (id.includes('@')) {
    try {
      const byEmail = await users.where('email', '==', id).limit(1).get();
      if (!byEmail.empty) return byEmail.docs[0].ref;
    } catch {}
  }

  return null;
}

/**
 * Map a list of roster identifiers (usually studentId like S-YYYY-xxxxx,
 * sometimes teacherId or even direct doc ids) to user document IDs.
 *
 * @param {string[]} rosterIds
 * @returns {Promise<string[]>} array of Firestore doc ids
 */
async function mapRosterIdsToUserIds(rosterIds = []) {
  const users = firestore.collection('users');
  const out = new Set();

  const chunk = (arr, size = 10) => {
    const res = [];
    for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
    return res;
  };

  // (A) Try treating some roster ids as actual user doc ids (cheap check)
  for (const id of rosterIds.slice(0, 30)) {
    try {
      const snap = await users.doc(id).get();
      if (snap.exists) out.add(snap.id);
    } catch {}
  }

  // (B) Query by studentId in chunks
  for (const group of chunk(rosterIds, 10)) {
    try {
      const q = await users.where('studentId', 'in', group).get();
      q.forEach(d => out.add(d.id));
    } catch {}
  }

  // (C) Query by teacherId in chunks (if any of your rosters can include them)
  for (const group of chunk(rosterIds, 10)) {
    try {
      const q = await users.where('teacherId', 'in', group).get();
      q.forEach(d => out.add(d.id));
    } catch {}
  }

  return Array.from(out);
}

module.exports = {
  generateRoleId,
  getUserRefByAnyId,
  mapRosterIdsToUserIds,
};
