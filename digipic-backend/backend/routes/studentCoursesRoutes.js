// backend/routes/studentCoursesRoutes.js
const express = require('express');
const router = express.Router();

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore } = require('../config/firebase');
const { getEnrollmentsClassIds, getCoursesForClassIds } = require('../utils/studentUtils');

// small local helper (keeps this file self-contained)
const chunk = (arr, size = 10) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// === STUDENTS COURSES FOR A STUDENT'S ENROLLED CLASSES ===
// GET /api/students/:userId/courses?includeTeacher=true&archived=exclude|include|only
router.get('/students/:userId/courses', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const includeTeacher = String(req.query.includeTeacher || '').toLowerCase() === 'true';
  const archParam = String(req.query.archived || 'exclude'); // exclude | include | only

  // 1) enrolled class IDs
  const classIds = await getEnrollmentsClassIds(userId);
  if (!classIds.length) {
    return res.json({ success: true, courses: [] });
  }

  // 2) fetch class docs to know which are archived
  const classesCol = firestore.collection('classes');
  const classMeta = {}; // id -> { archived: boolean }
  for (const ids of chunk(classIds, 10)) {
    const snap = await classesCol.where('__name__', 'in', ids).get();
    snap.forEach(d => {
      const data = d.data() || {};
      classMeta[d.id] = { archived: !!data.archived };
    });
  }

  // If some classIds didn't return (deleted?), treat them as active (so student doesn't lose access
  // due to transient read errors). You can flip this to "archived: true" if you prefer strict hiding.
  classIds.forEach(id => {
    if (!classMeta[id]) classMeta[id] = { archived: false };
  });

  // 3) filter classIds by archived setting
  const filteredClassIds =
    archParam === 'only'
      ? classIds.filter(id => classMeta[id].archived === true)
      : archParam === 'include'
        ? classIds
        : classIds.filter(id => classMeta[id].archived !== true); // default: exclude archived

  if (!filteredClassIds.length) {
    return res.json({ success: true, courses: [] });
  }

  // 4) courses assigned to those (filtered) classes
  let courses = await getCoursesForClassIds(filteredClassIds);

  // (Optional) include the archived flag of the parent class on each course for UI, if using include/only
  if (archParam !== 'exclude') {
    courses = courses.map(c => ({
      ...c,
      archivedClass: classMeta[c.classId] ? !!classMeta[c.classId].archived : false
    }));
  }

  // 5) optionally attach teacherName from uploadedBy
  if (includeTeacher) {
    const teacherIds = Array.from(new Set(courses.map(c => c.uploadedBy).filter(Boolean)));
    const teacherMap = {};

    // Prefer loading by document id (user docs keyed by UUID)
    await Promise.all(teacherIds.map(async (tid) => {
      try {
        const d = await firestore.collection('users').doc(tid).get();
        if (d.exists) {
          const u = d.data() || {};
          const name = (u.fullName && u.fullName.trim())
            ? u.fullName.trim()
            : `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || 'Teacher';
          teacherMap[tid] = name;
          return;
        }
        // Fallback: if doc id != userId field, try a where query
        const q = await firestore.collection('users').where('userId', '==', tid).limit(1).get();
        if (!q.empty) {
          const u = q.docs[0].data() || {};
          const name = (u.fullName && u.fullName.trim())
            ? u.fullName.trim()
            : `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || 'Teacher';
          teacherMap[tid] = name;
        }
      } catch {
        // ignore
      }
    }));

    courses = courses.map(c => ({
      ...c,
      teacherName: c.uploadedBy ? (teacherMap[c.uploadedBy] || 'Teacher') : '—'
    }));
  }

  return res.json({ success: true, courses });
}));

module.exports = router;
