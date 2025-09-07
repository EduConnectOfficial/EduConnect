// backend/utils/studentUtils.js
const { firestore } = require('../config/firebase');

const chunk = (arr, size = 10) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

async function getEnrollmentsClassIds(userId) {
  const snap = await firestore.collection('users').doc(userId).collection('enrollments').get();
  return snap.docs.map(d => d.id);
}

async function getCoursesForClassIds(classIds) {
  if (!Array.isArray(classIds) || classIds.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const ids of chunk(classIds, 10)) {
    const snap = await firestore
      .collection('courses')
      .where('assignedClasses', 'array-contains-any', ids)
      .get();
    snap.forEach(doc => {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        const x = doc.data() || {};
        out.push({
          id: doc.id,
          title: x.title || 'Subject',
          description: x.description || '',
          category: x.category || null,
          assignedClasses: Array.isArray(x.assignedClasses) ? x.assignedClasses : [],
          uploadedBy: x.uploadedBy || null,
          createdAt: x.createdAt || null,
          courseNumber: x.courseNumber ?? null
        });
      }
    });
  }
  return out;
}

/**
 * Map class roster IDs (typically the `studentId` like "S-YYYY-xxxxx") to user document IDs.
 * If an id already matches a user doc id, it will be returned as-is.
 */
async function mapRosterIdsToUserIds(rosterIds) {
  const out = [];
  if (!Array.isArray(rosterIds) || !rosterIds.length) return out;

  // First try direct doc lookups (userId)
  const toQuery = [];
  await Promise.all(rosterIds.map(async rid => {
    try {
      const d = await firestore.collection('users').doc(rid).get();
      if (d.exists) {
        out.push(rid);
      } else {
        toQuery.push(rid);
      }
    } catch {
      toQuery.push(rid);
    }
  }));

  // Then map remaining via studentId field (chunked by 10)
  for (const ids of chunk(toQuery, 10)) {
    const snap = await firestore.collection('users').where('studentId', 'in', ids).get();
    const found = new Set();
    snap.forEach(doc => {
      out.push(doc.id);
      found.add(doc.data()?.studentId);
    });
    // If any not found via studentId, keep original rid (best effort)
    ids.forEach(rid => { if (!found.has(rid)) out.push(rid); });
  }

  // de-dupe
  return Array.from(new Set(out));
}

module.exports = {
  chunk,
  getEnrollmentsClassIds,
  getCoursesForClassIds,
  mapRosterIdsToUserIds,
};
