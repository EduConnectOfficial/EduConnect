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
//     &archived=exclude|include|only            // applies to CLASS archived state (kept from your original code)
//     &courseArchived=exclude|include|only      // NEW: applies to COURSE archived state (default exclude)
router.get('/students/:userId/courses', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const includeTeacher = String(req.query.includeTeacher || '').toLowerCase() === 'true';

  // Class-level archive filter (backward-compatible with your existing param)
  const classArchParam = String(req.query.archived || 'exclude'); // exclude | include | only

  // NEW: Course-level archive filter (defaults to exclude to hide archived courses from students)
  const courseArchParam = String(req.query.courseArchived || 'exclude'); // exclude | include | only

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

  // If some classIds didn't return (deleted?), treat them as active (lenient default)
  classIds.forEach(id => {
    if (!classMeta[id]) classMeta[id] = { archived: false };
  });

  // 3) filter classIds by archived setting
  const filteredClassIds =
    classArchParam === 'only'
      ? classIds.filter(id => classMeta[id].archived === true)
      : classArchParam === 'include'
        ? classIds
        : classIds.filter(id => classMeta[id].archived !== true); // default: exclude archived

  if (!filteredClassIds.length) {
    return res.json({ success: true, courses: [] });
  }

  // 4) courses assigned to those (filtered) classes
  let courses = await getCoursesForClassIds(filteredClassIds);
  // Expect each course to have at least: id (courseId), uploadedBy, maybe classId
  // We need to ensure there is an 'archived' boolean on the course object.

  // Enrich with 'archived' if missing
  const needArchived = courses.some(c => typeof c.archived === 'undefined');
  if (needArchived && courses.length) {
    const courseIds = Array.from(new Set(courses.map(c => c.id || c.courseId).filter(Boolean)));
    for (const ids of chunk(courseIds, 10)) {
      const snap = await firestore.collection('courses').where('__name__', 'in', ids).get();
      const archMap = {};
      snap.forEach(doc => { archMap[doc.id] = !!(doc.data() || {}).archived; });
      courses = courses.map(c => {
        const cid = c.id || c.courseId;
        return typeof c.archived === 'undefined'
          ? { ...c, archived: archMap[cid] === true }
          : c;
      });
    }
  }

  // 4b) filter courses by courseArchived param
  courses =
    courseArchParam === 'only'
      ? courses.filter(c => c.archived === true)
      : courseArchParam === 'include'
        ? courses
        : courses.filter(c => c.archived !== true); // default: exclude archived

  // (Optional) include the archived flag of the parent class on each course for UI, if using include/only
  if (classArchParam !== 'exclude') {
    courses = courses.map(c => ({
      ...c,
      archivedClass: c.classId ? !!(classMeta[c.classId] && classMeta[c.classId].archived) : false
    }));
  }

  // 5) optionally attach teacherName from uploadedBy
  if (includeTeacher && courses.length) {
    const teacherIds = Array.from(new Set(courses.map(c => c.uploadedBy).filter(Boolean)));
    const teacherMap = {};

    await Promise.all(teacherIds.map(async (tid) => {
      try {
        // Prefer direct doc lookup
        const d = await firestore.collection('users').doc(tid).get();
        if (d.exists) {
          const u = d.data() || {};
          const name = (u.fullName && u.fullName.trim())
            ? u.fullName.trim()
            : `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || 'Teacher';
          teacherMap[tid] = name;
          return;
        }
        // Fallback: where query on userId field (if some docs keyed differently)
        const q = await firestore.collection('users').where('userId', '==', tid).limit(1).get();
        if (!q.empty) {
          const u = q.docs[0].data() || {};
          const name = (u.fullName && u.fullName.trim())
            ? u.fullName.trim()
            : `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || 'Teacher';
          teacherMap[tid] = name;
        }
      } catch {
        // ignore individual failures, keep going
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
