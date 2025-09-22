// backend/routes/studentCoursesRoutes.js
const express = require('express');
const router = express.Router();

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore } = require('../config/firebase');
const { getEnrollmentsClassIds, getCoursesForClassIds } = require('../utils/studentUtils');
const { safeDecrypt } = require('../utils/fieldCrypto'); // ✅ use safeDecrypt

/* ----------------------- helpers ----------------------- */
const chunk = (arr, size = 10) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

function tsToMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds != null) {
    return ts._seconds * 1000 + (ts._nanoseconds ? Math.floor(ts._nanoseconds / 1e6) : 0);
  }
  if (ts.seconds != null) {
    return ts.seconds * 1000 + (ts.nanoseconds ? Math.floor(ts.nanoseconds / 1e6) : 0);
  }
  const n = Number(ts);
  if (!Number.isNaN(n)) {
    // if seconds (10 digits), convert
    return n < 1e12 ? n * 1000 : n;
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function isPublished(course, nowMs) {
  // treat missing publishAt as "publish immediately"
  const publishMs = course && course.publishAt ? tsToMillis(course.publishAt) : 0;
  return !publishMs || publishMs <= nowMs;
}

function decryptNames(u = {}) {
  const first  = safeDecrypt(u.firstNameEnc  || '', '');
  const middle = safeDecrypt(u.middleNameEnc || '', '');
  const last   = safeDecrypt(u.lastNameEnc   || '', '');
  const full = [first, middle, last].map(s => String(s || '').trim()).filter(Boolean).join(' ').trim();
  return { firstName: first, middleName: middle, lastName: last, fullName: full || (u.username || 'Teacher') };
}

/* 
  === STUDENT COURSES ===

  GET /api/students/:userId/courses
    ?includeTeacher=true
    ?archived=exclude|include|only            // filters by CLASS archived
    ?courseArchived=exclude|include|only      // filters by COURSE archived (default exclude)
    ?visibility=student                       // when set, hide scheduled courses
    ?onlyPublished=true                       // same as visibility=student
    ?scheduled=include                        // override: INCLUDE future-scheduled (for debugging)
*/
router.get('/students/:userId/courses', asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const includeTeacher = String(req.query.includeTeacher || '').toLowerCase() === 'true';

  // Class-level archive filter (backward-compatible)
  const classArchParam = String(req.query.archived || 'exclude').toLowerCase(); // exclude | include | only

  // Course-level archive filter (defaults to exclude)
  const courseArchParam = String(req.query.courseArchived || 'exclude').toLowerCase(); // exclude | include | only

  // Scheduling visibility flags
  const visibility = String(req.query.visibility || '').toLowerCase();
  const onlyPublished = String(req.query.onlyPublished || '').toLowerCase() === 'true' || visibility === 'student';
  const includeScheduled = String(req.query.scheduled || '').toLowerCase() === 'include';

  // 1) enrolled class IDs
  const classIds = await getEnrollmentsClassIds(userId);
  if (!classIds.length) return res.json({ success: true, courses: [] });

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
  // lenient default
  classIds.forEach(id => { if (!classMeta[id]) classMeta[id] = { archived: false }; });

  // 3) filter classIds by archived setting
  const filteredClassIds =
    classArchParam === 'only'
      ? classIds.filter(id => classMeta[id].archived === true)
      : classArchParam === 'include'
        ? classIds
        : classIds.filter(id => classMeta[id].archived !== true); // default: exclude archived

  if (!filteredClassIds.length) return res.json({ success: true, courses: [] });

  // 4) courses assigned to those (filtered) classes
  let courses = await getCoursesForClassIds(filteredClassIds);

  // Ensure each course has an 'archived' boolean + keep publishAt for visibility test
  const needArchived = courses.some(c => typeof c.archived === 'undefined');
  if (needArchived && courses.length) {
    const courseIds = Array.from(new Set(courses.map(c => c.id || c.courseId).filter(Boolean)));
    for (const ids of chunk(courseIds, 10)) {
      const snap = await firestore.collection('courses').where('__name__', 'in', ids).get();
      const map = {};
      snap.forEach(doc => { const d = doc.data() || {}; map[doc.id] = { archived: !!d.archived, publishAt: d.publishAt || null, createdAt: d.createdAt || null }; });
      courses = courses.map(c => {
        const cid = c.id || c.courseId;
        const patch = map[cid] || {};
        return {
          ...c,
          archived: typeof c.archived === 'undefined' ? !!patch.archived : !!c.archived,
          publishAt: c.publishAt != null ? c.publishAt : (patch.publishAt || null),
          createdAt: c.createdAt != null ? c.createdAt : (patch.createdAt || null),
        };
      });
    }
  }

  // 4a) filter courses by courseArchived param
  courses =
    courseArchParam === 'only'
      ? courses.filter(c => c.archived === true)
      : courseArchParam === 'include'
        ? courses
        : courses.filter(c => c.archived !== true); // default exclude archived

  // 4b) filter scheduled (student visibility) unless explicitly included
  if (onlyPublished && !includeScheduled) {
    const nowMs = Date.now(); // UTC; publishAt is stored as Firestore Timestamp in UTC
    courses = courses.filter(c => isPublished(c, nowMs));
  }

  // Optionally include archived flag of parent class (handy UI hint when archived=include/only)
  if (classArchParam !== 'exclude') {
    courses = courses.map(c => ({
      ...c,
      archivedClass: c.classId ? !!(classMeta[c.classId] && classMeta[c.classId].archived) : false
    }));
  }

  // 5) attach teacherName from uploadedBy (DECRYPTED)
  if (includeTeacher && courses.length) {
    const teacherIds = Array.from(new Set(courses.map(c => c.uploadedBy).filter(Boolean)));
    const teacherMap = {};
    await Promise.all(teacherIds.map(async (tid) => {
      try {
        const d = await firestore.collection('users').doc(tid).get();
        if (d.exists) {
          teacherMap[tid] = decryptNames(d.data() || {}).fullName;
          return;
        }
        const q = await firestore.collection('users').where('userId', '==', tid).limit(1).get();
        if (!q.empty) teacherMap[tid] = decryptNames(q.docs[0].data() || {}).fullName;
      } catch { /* ignore */ }
    }));
    courses = courses.map(c => ({ ...c, teacherName: c.uploadedBy ? (teacherMap[c.uploadedBy] || 'Teacher') : '—' }));
  }

  return res.json({ success: true, courses });
}));

module.exports = router;
