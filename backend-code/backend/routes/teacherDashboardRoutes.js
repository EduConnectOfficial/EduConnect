// backend/routes/teacherDashboardRoutes.js
const router = require('express').Router();

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { safeDecrypt } = require('../utils/fieldCrypto'); // switched

// ---- tiny helpers (route-local) ----
const chunk = (arr, size = 10) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};
const toDateMs = (ts) => ts?.toMillis?.() ?? (typeof ts === 'number' ? ts : null);

// Hydrate/decrypt a user doc's name/email fields into plaintext fields
function hydrateUserNames(uRaw) {
  const u = uRaw || {};
  const dec = (encKey, plainKey) =>
    safeDecrypt(u[encKey] || u[plainKey] || '', u[plainKey] || '');

  const firstName  = dec('firstNameEnc',  'firstName');
  const middleName = dec('middleNameEnc', 'middleName');
  const lastName   = dec('lastNameEnc',   'lastName');
  const email      = dec('emailEnc',      'email');

  const fullNameFromParts = `${firstName} ${middleName ? middleName + ' ' : ''}${lastName}`
    .replace(/\s+/g, ' ')
    .trim();

  const fullName = (typeof u.fullName === 'string' && u.fullName.trim())
    ? u.fullName.trim()
    : (fullNameFromParts || 'Student');

  return {
    ...u,
    firstName,
    middleName,
    lastName,
    email,
    fullName,
  };
}

const safeName = (u) =>
  (u?.fullName && u.fullName.trim())
    ? u.fullName.trim()
    : `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || u?.username || 'Student';

const fmtDate = (ms) => (ms ? new Date(ms).toISOString().slice(0,10) : '—');

// ==== TEACHER DASHBOARD STATS ====
// GET /api/teacher/dashboard-stats?teacherId=...
router.get('/dashboard-stats', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  if (!teacherId) {
    return res.status(400).json({ success: false, message: 'Missing teacherId query parameter.' });
  }

  // 1) TEACHER CLASSES
  const classesSnap = await firestore
    .collection('classes')
    .where('teacherId', '==', teacherId)
    .orderBy('createdAt', 'desc')
    .get();

  const classes = classesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const classIds = classes.map(c => c.id);

  const rosterByClass = {};
  let totalStudents = 0;

  await Promise.all(classes.map(async c => {
    const countField = typeof c.students === 'number' ? c.students : null;
    const rosterSnap = await firestore.collection('classes').doc(c.id).collection('roster').get();
    const roster = rosterSnap.docs.map(r => ({ id: r.id, ...(r.data() || {}) }));
    rosterByClass[c.id] = roster.map(r => r.id);
    totalStudents += (countField != null ? countField : roster.length);
  }));

  const allRosterStudentIds = Array.from(new Set(Object.values(rosterByClass).flat()));

  // map roster studentId -> user doc {docId, data} (hydrated/decrypted)
  const studentIdToUserDoc = {};
  for (const ids of chunk(allRosterStudentIds, 10)) {
    if (ids.length === 0) continue;
    const snap = await firestore.collection('users').where('studentId', 'in', ids).get();
    snap.forEach(doc => {
      const raw = doc.data();
      if (raw?.studentId) {
        const hydrated = hydrateUserNames(raw);
        studentIdToUserDoc[raw.studentId] = { docId: doc.id, data: hydrated };
      }
    });
  }

  // 2) TEACHER COURSES
  const coursesSnap = await firestore
    .collection('courses')
    .where('uploadedBy', '==', teacherId)
    .get();

  const courses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const courseIds = courses.map(c => c.id);
  const courseById = Object.fromEntries(courses.map(c => [c.id, c]));

  // 3) MODULES + QUIZZES
  let modulesPublished = 0;
  for (const ids of chunk(courseIds, 10)) {
    if (ids.length === 0) continue;
    const mSnap = await firestore.collection('modules').where('courseId', 'in', ids).get();
    modulesPublished += mSnap.size;
  }

  let quizzesCreated = 0;
  const quizzes = [];
  for (const ids of chunk(courseIds, 10)) {
    if (ids.length === 0) continue;
    const qSnap = await firestore.collection('quizzes').where('courseId', 'in', ids).get();
    quizzesCreated += qSnap.size;
    qSnap.forEach(doc => quizzes.push({ id: doc.id, ...doc.data() }));
  }

  // 4) ASSIGNMENTS
  const assignments = [];
  const seenAssign = new Set();

  const aByTeacher = await firestore.collection('assignments').where('teacherId', '==', teacherId).get();
  aByTeacher.forEach(d => { if (!seenAssign.has(d.id)) { seenAssign.add(d.id); assignments.push({ id: d.id, ...d.data() }); } });

  const aByCreated = await firestore.collection('assignments').where('createdBy', '==', teacherId).get();
  aByCreated.forEach(d => { if (!seenAssign.has(d.id)) { seenAssign.add(d.id); assignments.push({ id: d.id, ...d.data() }); } });

  // 5) PENDING & RECENT SUBMISSIONS
  let pendingSubmissions = 0;
  const recentSubs = [];
  const userCache = new Map();

  const getUserDataByAnyId = async (anyId) => {
    if (!anyId) return null;
    if (userCache.has(anyId)) return userCache.get(anyId);

    // Try direct users/{docId}
    let snap = await firestore.collection('users').doc(anyId).get();
    if (snap.exists) {
      const raw = { id: snap.id, ...snap.data() };
      const hydrated = hydrateUserNames(raw);
      userCache.set(anyId, hydrated);
      if (hydrated.studentId) userCache.set(hydrated.studentId, hydrated);
      return hydrated;
    }

    // Try by studentId
    const q = await firestore.collection('users').where('studentId', '==', anyId).limit(1).get();
    if (!q.empty) {
      const d = q.docs[0];
      const raw = { id: d.id, ...d.data() };
      const hydrated = hydrateUserNames(raw);
      userCache.set(anyId, hydrated);
      if (hydrated.studentId) userCache.set(hydrated.studentId, hydrated);
      return hydrated;
    }

    userCache.set(anyId, null);
    return null;
  };

  for (const a of assignments) {
    const subSnap = await firestore.collection('assignments').doc(a.id)
      .collection('submissions').orderBy('submittedAt', 'desc').get();
    subSnap.forEach(s => {
      const data = s.data() || {};
      if (!data.graded) pendingSubmissions += 1;
      recentSubs.push({
        assignmentId: a.id,
        courseId: a.courseId || null,
        moduleId: a.moduleId || null,
        title: a.title || 'Assignment',
        studentKey: data.studentId,
        submittedAt: toDateMs(data.submittedAt) || 0,
        graded: !!data.graded
      });
    });
  }

  recentSubs.sort((x, y) => (y.submittedAt || 0) - (x.submittedAt || 0));
  const recentSubmissions = [];
  for (const item of recentSubs.slice(0, 6)) {
    const u = await getUserDataByAnyId(item.studentKey);
    let className = '—';
    if (item.courseId && courseById[item.courseId]?.assignedClasses?.length) {
      const cls = courseById[item.courseId].assignedClasses
        .map(id => classes.find(c => c.id === id))
        .filter(Boolean)[0];
      if (cls) className = cls.name || `${cls.gradeLevel || ''} ${cls.section || ''}`.trim() || 'Class';
    }
    recentSubmissions.push({
      studentName: u ? safeName(u) : 'Student',
      className,
      title: item.title,
      submittedAt: new Date(item.submittedAt || Date.now()).toISOString().replace('T',' ').slice(0,16),
      status: item.graded ? 'graded' : 'ungraded',
      assignmentId: item.assignmentId,
      courseId: item.courseId
    });
  }

  // 6) CLASS OVERVIEW
  const assignsByCourse = {};
  assignments.forEach(a => {
    const cid = a.courseId || '_';
    (assignsByCourse[cid] ||= []).push(a);
  });

  const quizzesByCourse = {};
  quizzes.forEach(q => {
    const cid = q.courseId || '_';
    (quizzesByCourse[cid] ||= []).push(q);
  });

  const allUserDocs = Object.values(studentIdToUserDoc).map(x => x.data);
  const scoreBuckets = [0,0,0,0,0];
  const pushBucket = (pct) => {
    if (pct == null || Number.isNaN(pct)) return;
    const n = Math.max(0, Math.min(100, Math.round(pct)));
    if (n < 60) scoreBuckets[0]++; else
    if (n < 70) scoreBuckets[1]++; else
    if (n < 80) scoreBuckets[2]++; else
    if (n < 90) scoreBuckets[3]++; else scoreBuckets[4]++;
  };
  allUserDocs.forEach(u => {
    if (typeof u?.averageQuizScore === 'number') pushBucket(u.averageQuizScore);
    else if (typeof u?.averageAssignmentGrade === 'number') pushBucket(u.averageAssignmentGrade);
  });

  const classesOverview = [];
  for (const c of classes) {
    const rosterIds = rosterByClass[c.id] || [];
    const courseIdsForClass = courses
      .filter(co => Array.isArray(co.assignedClasses) && co.assignedClasses.includes(c.id))
      .map(co => co.id);

    // avg grade
    let sum = 0, cnt = 0;
    for (const sid of rosterIds) {
      const u = studentIdToUserDoc[sid]?.data;
      const g = (typeof u?.averageQuizScore === 'number')
        ? u.averageQuizScore
        : (typeof u?.averageAssignmentGrade === 'number' ? u.averageAssignmentGrade : null);
      if (typeof g === 'number') { sum += g; cnt += 1; }
    }
    const avgGrade = cnt ? Math.round(sum / cnt) : 0;

    // completion %
    let completed = 0;
    for (const sid of rosterIds) {
      const userDocId = studentIdToUserDoc[sid]?.docId;
      if (!userDocId || !courseIdsForClass.length) continue;
      let hasAny = false;
      for (const ids of chunk(courseIdsForClass, 10)) {
        if (ids.length === 0) continue;
        const cmSnap = await firestore
          .collection('users').doc(userDocId)
          .collection('completedModules')
          .where('courseId', 'in', ids)
          .limit(1)
          .get();
        if (!cmSnap.empty) { hasAny = true; break; }
      }
      if (hasAny) completed += 1;
    }
    const completionRate = (rosterIds.length ? Math.round((completed / rosterIds.length) * 100) : 0);

    // next due
    const nowMs = Date.now();
    const upcoming = [];
    courseIdsForClass.forEach(cid => {
      (assignsByCourse[cid] || []).forEach(a => {
        const due = toDateMs(a.dueAt);
        if (due && due >= nowMs) upcoming.push({ due, label: `Assignment: ${a.title || 'Untitled'}` });
      });
      (quizzesByCourse[cid] || []).forEach(q => {
        const due = toDateMs(q.dueAt);
        if (due && due >= nowMs) upcoming.push({ due, label: `Quiz: ${q.title || 'Quiz'}` });
      });
    });
    upcoming.sort((x, y) => x.due - y.due);
    const nextDue = upcoming.length ? `${fmtDate(upcoming[0].due)} – ${upcoming[0].label}` : '—';

    classesOverview.push({
      id: c.id,
      name: c.name || `${c.gradeLevel || ''}${c.section ? '-' + c.section : ''}`.trim() || 'Class',
      studentCount: typeof c.students === 'number' ? c.students : rosterIds.length,
      avgGrade,
      completionRate,
      nextDue
    });
  }

  // 7) UPCOMING SCHEDULE (top 6)
  const nowMs = Date.now();
  const schedulePool = [];
  assignments.forEach(a => {
    const due = toDateMs(a.dueAt);
    if (due && due >= nowMs) schedulePool.push({ date: fmtDate(due), title: `Assignment: ${a.title || 'Untitled'}`, due });
  });
  quizzes.forEach(q => {
    const due = toDateMs(q.dueAt);
    if (due && due >= nowMs) schedulePool.push({ date: fmtDate(due), title: `Quiz: ${q.title || 'Quiz'}`, due });
  });
  schedulePool.sort((x, y) => x.due - y.due);
  const schedule = schedulePool.slice(0, 6).map(x => ({ date: x.date, title: x.title }));

  // 8) ANNOUNCEMENTS (latest 5)
  const annSnap = await firestore
    .collection('announcements')
    .where('teacherId', '==', teacherId)
    .orderBy('publishAt', 'desc')
    .limit(5)
    .get();

  const announcements = [];
  for (const d of annSnap.docs) {
    const a = d.data() || {};
    let className = 'All Classes';
    if (Array.isArray(a.classIds) && a.classIds.length === 1) {
      try {
        const c = await firestore.collection('classes').doc(a.classIds[0]).get();
        if (c.exists) className = c.data().name || className;
      } catch {}
    } else if (Array.isArray(a.classIds) && a.classIds.length > 1) {
      className = 'Multiple Classes';
    }
    announcements.push({
      title: a.title || 'Announcement',
      className,
      publishedAt: fmtDate(toDateMs(a.publishAt))
    });
  }

  // 9) CHART DATA
  const chartsData = {
    gradeDistribution: {
      labels: ['0-59','60-69','70-79','80-89','90-100'],
      datasets: [{ label: 'Students', data: scoreBuckets }]
    },
    completionRate: {
      labels: classesOverview.map(c => c.name),
      datasets: [{ label: '% Completion', data: classesOverview.map(c => c.completionRate) }]
    },
    timeOnTask: await (async () => {
      const out = { labels: [], datasets: [{ label: 'Avg mins', data: [] }] };
      const topCourses = [...(Object.entries(quizzesByCourse))]
        .sort((a, b) => (b[1]?.length || 0) - (a[1]?.length || 0))
        .slice(0, 3)
        .map(([cid]) => cid);

      for (const cid of topCourses) {
        const quizIds = (quizzesByCourse[cid] || []).map(q => q.id);
        if (!quizIds.length) continue;

        let sumSec = 0, cnt = 0;
        const relevantClassIds = (courseById[cid]?.assignedClasses || []).filter(id => classIds.includes(id));
        const rosterIdsForCourse = Array.from(new Set(relevantClassIds.flatMap(k => rosterByClass[k] || [])));
        const userDocIds = rosterIdsForCourse
          .map(sid => studentIdToUserDoc[sid]?.docId)
          .filter(Boolean);

        for (const uid of userDocIds.slice(0, 25)) {
          for (const qid of quizIds) {
            const attemptsSnap = await firestore
              .collection('users').doc(uid)
              .collection('quizAttempts').doc(qid)
              .collection('attempts')
              .get();
            attemptsSnap.forEach(at => {
              const t = at.data()?.timeTakenSeconds;
              if (typeof t === 'number' && t > 0) { sumSec += t; cnt += 1; }
            });
          }
        }

        const avgMin = cnt ? Math.round((sumSec / cnt) / 60) : 0;
        out.labels.push(courseById[cid]?.title || 'Course');
        out.datasets[0].data.push(avgMin);
      }
      return out;
    })()
  };

  // 10) SUMMARY
  const stats = {
    totalClasses: classes.length,
    totalStudents,
    modulesPublished,
    quizzesCreated,
    pendingSubmissions
  };

  res.json({
    success: true,
    stats,
    classes: classesOverview,
    submissions: recentSubmissions,
    chartsData,
    schedule,
    announcements
  });
}));

module.exports = router;
