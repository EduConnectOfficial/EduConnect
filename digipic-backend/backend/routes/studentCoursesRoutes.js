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
// GET /api/students/:userId/courses?includeTeacher=true
router.get('/students/:userId/courses', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const includeTeacher = String(req.query.includeTeacher || '').toLowerCase() === 'true';

  // 1) enrolled class IDs
  const classIds = await getEnrollmentsClassIds(userId);
  if (!classIds.length) {
    return res.json({ success: true, courses: [] });
  }

  // 2) courses assigned to those classes
  let courses = await getCoursesForClassIds(classIds);

  // 3) optionally attach teacherName from uploadedBy
  if (includeTeacher) {
    const teacherIds = Array.from(new Set(courses.map(c => c.uploadedBy).filter(Boolean)));
    const teacherMap = {};

    // Prefer loading by document id (your user docs are UUIDs)
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
      } catch {}
    }));

    courses = courses.map(c => ({
      ...c,
      teacherName: c.uploadedBy ? (teacherMap[c.uploadedBy] || 'Teacher') : '—'
    }));
  }

  return res.json({ success: true, courses });
}));

module.exports = router;
