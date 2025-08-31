// backend/routes/studentDashboardRoutes.js
const router = require('express').Router();
const { firestore, admin } = require('../config/firebase');
const { asyncHandler } = require('../middleware/asyncHandler');
const { chunk, ymd, toMillis } = require('../utils/common');
const { getEnrollmentsClassIds, getCoursesForClassIds } = require('../utils/studentUtils');

/* ---------------------------------------------
   ARCHIVE-AWARE HELPERS (local to this router)
----------------------------------------------*/

/** Keep only classIds whose class doc has archived !== true (missing archived = active). */
async function filterActiveClassIds(classIds) {
  if (!Array.isArray(classIds) || !classIds.length) return [];
  const out = [];
  for (const ids of chunk(classIds, 10)) {
    const snap = await firestore.collection('classes').where('__name__', 'in', ids).get();
    snap.forEach(d => {
      const data = d.data() || {};
      if (data.archived !== true) out.push(d.id);
    });
  }
  return out;
}

/** Enrollments ➜ filter to active classIds only. */
async function getActiveEnrollmentsClassIds(userId) {
  const enrolled = await getEnrollmentsClassIds(userId);
  return filterActiveClassIds(enrolled);
}

/* ---------------------------------------------
   To-Do (assignments & quizzes due soon)
----------------------------------------------*/
router.get('/students/:userId/todo', asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const classIds  = await getActiveEnrollmentsClassIds(userId);
  if (!classIds.length) return res.json({ success: true, items: [] });

  const courses   = await getCoursesForClassIds(classIds);
  const courseIds = courses.map(c => c.id);
  const courseMap = Object.fromEntries(courses.map(c => [c.id, c.title || 'Subject']));

  const now = Date.now();
  const soonMs = now + 14 * 24 * 60 * 60 * 1000;
  const todayStr = ymd(now), tomorrowStr = ymd(now + 86400000);

  const items = [];

  // Assignments
  for (const ids of chunk(courseIds, 10)) {
    if (!ids.length) continue;
    let aSnap;
    try {
      aSnap = await firestore.collection('assignments')
        .where('courseId', 'in', ids)
        .orderBy('publishAt', 'desc')
        .limit(200).get();
    } catch {
      aSnap = await firestore.collection('assignments')
        .where('courseId', 'in', ids)
        .limit(200).get();
    }
    for (const doc of aSnap.docs) {
      const a = doc.data() || {};
      const due = toMillis(a.dueAt);
      if (!due || due < now || due > soonMs) continue;

      const mySub = await firestore.collection('assignments').doc(doc.id)
        .collection('submissions').doc(userId).get();
      if (mySub.exists) continue;

      const title = a.title || 'Assignment';
      const courseTitle = courseMap[a.courseId] || 'Subject';
      const dueStr = ymd(due);
      const tag = (dueStr === todayStr) ? 'Due Today' : (dueStr === tomorrowStr) ? 'Tomorrow' : new Date(due).toLocaleDateString();

      items.push({
        type: 'assignment',
        text: `${courseTitle}: ${title}`,
        dueAt: due,
        tag,
        tagClass: tag === 'Due Today' ? 'warning' : (tag === 'Tomorrow' ? 'primary' : 'secondary')
      });
    }
  }

  // Quizzes
  for (const ids of chunk(courseIds, 10)) {
    if (!ids.length) continue;
    let qSnap;
    try {
      qSnap = await firestore.collection('quizzes')
        .where('courseId', 'in', ids)
        .orderBy('createdAt', 'desc')
        .limit(200).get();
    } catch {
      qSnap = await firestore.collection('quizzes')
        .where('courseId', 'in', ids)
        .limit(200).get();
    }
    for (const doc of qSnap.docs) {
      const q = doc.data() || {};
      const due = toMillis(q.dueAt);
      if (!due || due < now || due > soonMs) continue;

      const title = q.title || 'Quiz';
      const courseTitle = courseMap[q.courseId] || 'Subject';
      const dueStr = ymd(due);
      const tag = (dueStr === todayStr) ? 'Due Today' : (dueStr === tomorrowStr) ? 'Tomorrow' : new Date(due).toLocaleDateString();

      items.push({
        type: 'quiz',
        text: `${courseTitle}: ${title}`,
        dueAt: due,
        tag,
        tagClass: tag === 'Due Today' ? 'warning' : (tag === 'Tomorrow' ? 'primary' : 'secondary')
      });
    }
  }

  items.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
  res.json({ success: true, items: items.slice(0, 20) });
}));

/* ---------------------------------------------
   Calendar
----------------------------------------------*/
router.get('/students/:userId/calendar', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const start = new Date(String(req.query.start));
  const end   = new Date(String(req.query.end));
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return res.status(400).json({ success: false, events: [] });
  }
  const startMs = start.getTime();
  const endMs   = end.getTime() + 86399999;

  const classIds  = await getActiveEnrollmentsClassIds(userId);
  if (!classIds.length) return res.json({ success: true, events: [] });

  const courses   = await getCoursesForClassIds(classIds);
  const courseIds = courses.map(c => c.id);
  const courseMap = Object.fromEntries(courses.map(c => [c.id, c.title || 'Subject']));

  const events = [];

  // Assignments
  for (const ids of chunk(courseIds, 10)) {
    if (!ids.length) continue;
    let aSnap;
    try {
      aSnap = await firestore.collection('assignments')
        .where('courseId', 'in', ids)
        .orderBy('publishAt', 'desc')
        .limit(200).get();
    } catch {
      aSnap = await firestore.collection('assignments')
        .where('courseId', 'in', ids)
        .limit(200).get();
    }
    for (const d of aSnap.docs) {
      const a = d.data() || {};
      const title = `${courseMap[a.courseId] || 'Subject'}: ${a.title || 'Assignment'}`;
      const pub = toMillis(a.publishAt);
      const due = toMillis(a.dueAt);
      if (pub && pub >= startMs && pub <= endMs) events.push({ date: ymd(pub), label: 'Release', title });
      if (due && due >= startMs && due <= endMs) events.push({ date: ymd(due), label: 'Due', title });
    }
  }

  // Quizzes
  for (const ids of chunk(courseIds, 10)) {
    if (!ids.length) continue;
    let qSnap;
    try {
      qSnap = await firestore.collection('quizzes')
        .where('courseId', 'in', ids)
        .orderBy('createdAt', 'desc')
        .limit(200).get();
    } catch {
      qSnap = await firestore.collection('quizzes')
        .where('courseId', 'in', ids)
        .limit(200).get();
    }
    for (const d of qSnap.docs) {
      const q = d.data() || {};
      const due = toMillis(q.dueAt);
      if (due && due >= startMs && due <= endMs) {
        const title = `${courseMap[q.courseId] || 'Subject'}: ${q.title || 'Quiz'}`;
        events.push({ date: ymd(due), label: 'Quiz', title });
      }
    }
  }

  res.json({ success: true, events });
}));

/* ---------------------------------------------
   Notifications + preferences
----------------------------------------------*/
router.get('/students/:userId/notifications', asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const userDoc = await firestore.collection('users').doc(userId).get();
  const prefs = {
    email: !!userDoc.data()?.notifyEmail,
    sms:   !!userDoc.data()?.notifySMS
  };

  const items = [];
  const now = Date.now();

  // Announcements (only for active classes)
  const classIds = await getActiveEnrollmentsClassIds(userId);
  for (const ids of chunk(classIds, 10)) {
    if (!ids.length) continue;
    let snap;
    try {
      snap = await firestore.collection('announcements')
        .where('classIds', 'array-contains-any', ids)
        .orderBy('publishAt', 'desc').limit(10).get();
    } catch {
      snap = await firestore.collection('announcements')
        .where('classIds', 'array-contains-any', ids)
        .limit(10).get();
    }
    snap.forEach(d => {
      const a = d.data() || {};
      const pub = toMillis(a.publishAt);
      const exp = toMillis(a.expiresAt);
      if (pub && pub <= now && (!exp || exp >= now)) {
        items.push({ icon: 'bi-megaphone', text: `Announcement: ${a.title || 'Update'}`, at: pub });
      }
    });
  }

  // Assignment grades
  const gSnap = await firestore.collection('users').doc(userId)
    .collection('assignmentGrades').orderBy('gradedAt', 'desc').limit(10).get();
  gSnap.forEach(d => {
    const g = d.data() || {};
    if (g.grade != null) {
      items.push({
        icon: 'bi-star-fill',
        cls: 'text-warning',
        text: `Grade posted: ${g.assignmentTitle || 'Assignment'} – ${Math.round(g.grade)}%`,
        at: toMillis(g.gradedAt) || now
      });
    }
  });

  // Quiz attempts
  const qaSnap = await firestore.collection('users').doc(userId).collection('quizAttempts').get();
  qaSnap.forEach(d => {
    const q = d.data() || {};
    if (q.lastScore?.percent != null) {
      items.push({
        icon: 'bi-patch-check',
        text: `Quiz submitted: ${Math.round(q.lastScore.percent)}%`,
        at: toMillis(q.lastSubmittedAt) || now
      });
    }
  });

  items.sort((a, b) => (b.at || 0) - (a.at || 0));
  res.json({ success: true, items: items.slice(0, 12), prefs });
}));

router.patch('/students/:userId/notification-preferences', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { email, sms } = req.body || {};
  await firestore.collection('users').doc(userId).set({
    notifyEmail: !!email,
    notifySMS: !!sms
  }, { merge: true });
  res.json({ success: true });
}));

/* ---------------------------------------------
   Library
----------------------------------------------*/
router.get('/students/:userId/library', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const q = (req.query.query || '').toString().toLowerCase();

  const classIds  = await getActiveEnrollmentsClassIds(userId);
  if (!classIds.length) return res.json({ success: true, modules: [] });

  const courses   = await getCoursesForClassIds(classIds);
  const courseIds = courses.map(c => c.id);
  const courseMap = Object.fromEntries(courses.map(c => [c.id, c.title || 'Subject']));

  const out = [];
  for (const ids of chunk(courseIds, 10)) {
    if (!ids.length) continue;
    let snap;
    try {
      snap = await firestore.collection('modules')
        .where('courseId', 'in', ids)
        .orderBy('moduleNumber', 'asc')
        .limit(200).get();
    } catch {
      snap = await firestore.collection('modules')
        .where('courseId', 'in', ids)
        .limit(200).get();
    }
    snap.forEach(d => {
      const m = d.data() || {};
      const title = m.title || (m.moduleNumber != null ? `Module ${m.moduleNumber}` : 'Module');
      if (q && !title.toLowerCase().includes(q)) return;

      let previewUrl = null, downloadUrl = null;
      if (Array.isArray(m.attachments) && m.attachments.length) {
        const a0 = m.attachments[0];
        if (a0.filePath) previewUrl = downloadUrl = a0.filePath;
        else if (a0.url) previewUrl = a0.url;
      }

      out.push({
        id: d.id,
        title,
        courseId: m.courseId,
        courseTitle: courseMap[m.courseId] || 'Subject',
        createdAt: toMillis(m.createdAt) || null,
        isNew: (Date.now() - (toMillis(m.createdAt) || 0)) < 7 * 24 * 60 * 60 * 1000,
        previewUrl,
        downloadUrl
      });
    });
  }
  res.json({ success: true, modules: out.slice(0, 100) });
}));

/* ---------------------------------------------
   Quizzes upcoming
----------------------------------------------*/
router.get('/students/:userId/quizzes-upcoming', asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const classIds  = await getActiveEnrollmentsClassIds(userId);
  if (!classIds.length) return res.json({ success: true, quizzes: [] });

  const courses   = await getCoursesForClassIds(classIds);
  const courseIds = courses.map(c => c.id);

  const now = Date.now();
  const out = [];

  for (const ids of chunk(courseIds, 10)) {
    if (!ids.length) continue;
    let snap;
    try {
      snap = await firestore.collection('quizzes')
        .where('courseId', 'in', ids)
        .orderBy('createdAt', 'desc')
        .limit(200).get();
    } catch {
      snap = await firestore.collection('quizzes')
        .where('courseId', 'in', ids)
        .limit(200).get();
    }
    snap.forEach(d => {
      const q = d.data() || {};
      const due = toMillis(q.dueAt);
      if (due && due < now) return;
      out.push({ id: d.id, title: q.title || 'Quiz', settings: q.settings || { timerEnabled: false } });
    });
  }
  res.json({ success: true, quizzes: out.slice(0, 50) });
}));

/* ---------------------------------------------
   Open assignments for quick submit
----------------------------------------------*/
router.get('/students/:userId/assignments-open', asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const classIds  = await getActiveEnrollmentsClassIds(userId);
  if (!classIds.length) return res.json({ success: true, assignments: [] });

  const courses   = await getCoursesForClassIds(classIds);
  const courseIds = courses.map(c => c.id);
  const courseMap = Object.fromEntries(courses.map(c => [c.id, c.title || 'Subject']));
  const now = Date.now();
  const out = [];

  for (const ids of chunk(courseIds, 10)) {
    if (!ids.length) continue;
    let snap;
    try {
      snap = await firestore.collection('assignments')
        .where('courseId', 'in', ids)
        .orderBy('publishAt', 'desc')
        .limit(200).get();
    } catch {
      snap = await firestore.collection('assignments')
        .where('courseId', 'in', ids)
        .limit(200).get();
    }
    for (const d of snap.docs) {
      const a = d.data() || {};
      const due = toMillis(a.dueAt);
      if (due && due < now) continue;

      const sub = await firestore.collection('assignments').doc(d.id)
        .collection('submissions').doc(userId).get();
      if (sub.exists) continue;

      out.push({ id: d.id, title: a.title || 'Assignment', courseTitle: courseMap[a.courseId] || 'Subject' });
    }
  }
  res.json({ success: true, assignments: out.slice(0, 50) });
}));

/* ---------------------------------------------
   Recent feedback
----------------------------------------------*/
router.get('/students/:userId/recent-feedback', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const snap = await firestore.collection('users').doc(userId)
    .collection('assignmentGrades').orderBy('gradedAt', 'desc').limit(5).get();
  const items = snap.docs.map(d => {
    const x = d.data() || {};
    return { title: x.assignmentTitle || 'Assignment', feedback: x.feedback || '' };
  });
  res.json({ success: true, items });
}));

/* ---------------------------------------------
   Grades feed
----------------------------------------------*/
router.get('/students/:userId/grades', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const days = Math.max(1, parseInt(req.query.days || '30', 10));
  const subjectFilter = (req.query.subject || 'All').toString().toLowerCase();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const classIds  = await getActiveEnrollmentsClassIds(userId);
  if (!classIds.length) return res.json({ success: true, items: [], subjects: [] });

  const courses   = await getCoursesForClassIds(classIds);
  const courseMap = Object.fromEntries(courses.map(c => [c.id, c.title || 'Subject']));

  const items = [];

  // Assignment grades
  try {
    const gSnap = await firestore.collection('users').doc(userId)
      .collection('assignmentGrades').orderBy('gradedAt', 'desc').limit(300).get();
    gSnap.forEach(d => {
      const g = d.data() || {};
      const at = toMillis(g.gradedAt) || toMillis(g.dueAt) || Date.now();
      if (at < cutoff) return;
      const subject = courseMap[g.courseId] || 'Subject';
      if (subjectFilter !== 'all' && subject.toLowerCase() !== subjectFilter) return;
      if (typeof g.grade === 'number') {
        items.push({ date: new Date(at).toISOString(), subject, activity: g.assignmentTitle || 'Assignment', score: Math.round(g.grade) });
      }
    });
  } catch {}

  // Quiz attempts
  try {
    const qaSnap = await firestore.collection('users').doc(userId).collection('quizAttempts').get();
    qaSnap.forEach(d => {
      const q = d.data() || {};
      const at = toMillis(q.lastSubmittedAt) || 0;
      if (!at || at < cutoff) return;
      const subject = courseMap[q.courseId] || 'Subject';
      if (subjectFilter !== 'all' && subject.toLowerCase() !== subjectFilter) return;
      const pct = q.lastScore?.percent ?? q.bestPercent ?? null;
      if (pct != null) {
        items.push({ date: new Date(at).toISOString(), subject, activity: 'Quiz', score: Math.round(pct) });
      }
    });
  } catch {}

  const subjects = Array.from(new Set(Object.values(courseMap)));
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ success: true, items: items.slice(0, 200), subjects });
}));

module.exports = router;
