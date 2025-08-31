// routes/teacherDashboardRoutes.js
const router = require('express').Router();
const { firestore, admin } = require('../config/firebase');

const roundPct = (n) => Math.max(0, Math.min(100, Math.round(n)));

/* ========================= Utilities ========================= */

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (ts._seconds) return ts._seconds * 1000;
  if (ts.seconds) return ts.seconds * 1000;
  const d = new Date(ts);
  return isNaN(d) ? 0 : d.getTime();
}

async function getTeacherCourseIds(teacherId) {
  const ids = new Set();

  // courses uploaded/owned by this teacher
  const q1 = await firestore.collection('courses')
    .where('uploadedBy', '==', teacherId).get();
  q1.forEach(d => ids.add(d.id));

  // courses where teacher is listed in an array (if you use it)
  try {
    const q2 = await firestore.collection('courses')
      .where('teachers', 'array-contains', teacherId).get();
    q2.forEach(d => ids.add(d.id));
  } catch (_) { /* field may not exist; ignore */ }

  return Array.from(ids);
}

async function fetchEssaysByCourseIds(courseIds, status) {
  if (!courseIds.length) return [];
  const chunk = (arr, size) => arr.reduce((a, _, i) => (i % size ? a : [...a, arr.slice(i, i + size)]), []);
  const chunks = chunk(courseIds, 10); // Firestore 'in' limit

  const all = [];
  for (const batch of chunks) {
    let q = firestore.collection('quizEssaySubmissions')
      .where('courseId', 'in', batch);

    if (status) q = q.where('status', '==', status);

    // no orderBy ⇒ sort in memory to avoid composite index
    const snap = await q.get();
    snap.forEach(d => all.push({ id: d.id, ...d.data() }));
  }

  // sort newest first by createdAt
  all.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  return all;
}

/** Recompute a single attempt (and its parent summary + user's average) */
async function recomputeAttemptFromPath(attemptRefPath) {
  if (!attemptRefPath) return;

  const attemptRef = firestore.doc(attemptRefPath);
  const attemptSnap = await attemptRef.get();
  if (!attemptSnap.exists) return;

  const attemptData = attemptSnap.data() || {};
  const attemptsCol = attemptRef.parent;               // .../attempts
  const attemptRoot = attemptsCol.parent;              // users/{uid}/quizAttempts/{quizId}
  const quizId = attemptRoot.id;
  const userRef = attemptRoot.parent.parent;           // users/{uid}

  // sum graded essays
  const essaysSnap = await firestore
    .collection('quizEssaySubmissions')
    .where('attemptRefPath', '==', attemptRef.path)
    .get();

  let gradedScore = 0, gradedTotal = 0;
  essaysSnap.forEach(d => {
    const e = d.data() || {};
    if (e.status === 'graded' && typeof e.score === 'number') {
      gradedScore += e.score || 0;
      gradedTotal += (typeof e.maxScore === 'number' ? e.maxScore : 10);
    }
  });

  const autoScore   = Number(attemptData.autoScore   || 0);
  const autoTotal   = Number(attemptData.autoTotal   || 0);
  const autoPercent = autoTotal ? roundPct((autoScore/autoTotal)*100) : 0;
  const gradedPercent = gradedTotal ? roundPct((gradedScore/gradedTotal)*100) : 0;

  const combinedScore   = autoScore + gradedScore;
  const combinedTotal   = autoTotal + gradedTotal;
  const combinedPercent = combinedTotal ? roundPct((combinedScore/combinedTotal)*100) : 0;

  // update attempt
  await attemptRef.set({
    autoPercent,
    gradedScore,
    gradedTotal,
    gradedPercent,
    percent: combinedPercent,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // update parent summary
  const all = await attemptsCol.get();
  let attemptsUsed = 0;
  let bestPercent = 0;
  let bestGradedPercent = 0;
  all.forEach(doc => {
    attemptsUsed++;
    const a = doc.data() || {};
    const p  = typeof a.percent        === 'number' ? a.percent
             : (typeof a.autoPercent   === 'number' ? a.autoPercent : 0);
    const gp = typeof a.gradedPercent  === 'number' ? a.gradedPercent : 0;
    if (p  > bestPercent)       bestPercent       = p;
    if (gp > bestGradedPercent) bestGradedPercent = gp;
  });

  await attemptRoot.set({
    quizId,
    attemptsUsed,
    lastScore: { score: combinedScore, total: combinedTotal, percent: combinedPercent },
    bestPercent,
    bestGradedPercent,
    lastSubmittedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // recompute user average
  const qaSnap = await userRef.collection('quizAttempts').get();
  const bests = [];
  qaSnap.forEach(doc => {
    const d = doc.data() || {};
    if (typeof d.bestGradedPercent === 'number') bests.push(d.bestGradedPercent);
    else if (typeof d.bestPercent === 'number')  bests.push(d.bestPercent);
    else if (d.lastScore?.percent != null)       bests.push(d.lastScore.percent);
  });
  const averageQuizScore = bests.length ? roundPct(bests.reduce((a,b)=>a+b,0)/bests.length) : 0;
  await userRef.set({ averageQuizScore }, { merge: true });
}

/* ========================= Routes ========================= */

/**
 * GET /api/teacher/quiz-essays
 * Query: teacherId (required), status? (pending|graded|needs_review), page?, pageSize?
 * Returns only essays where essay.courseId belongs to teacher.
 */
router.get('/quiz-essays', async (req, res, next) => {
  try {
    const teacherId = String(req.query.teacherId || '').trim();
    if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

    const status = (req.query.status || '').toLowerCase();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize || '20', 10)));

    const teacherCourseIds = await getTeacherCourseIds(teacherId);
    if (!teacherCourseIds.length) {
      return res.json({ success:true, total:0, items:[] });
    }

    const all = await fetchEssaysByCourseIds(teacherCourseIds, status);

    // paginate in memory
    const start = (page - 1) * pageSize;
    const pageItems = all.slice(start, start + pageSize).map(x => ({
      id: x.id,
      courseId: x.courseId || null,
      moduleId: x.moduleId || null,
      studentName: x.studentName || x.studentEmail || 'Student',
      studentEmail: x.studentEmail || '',
      questionTitle: x.questionTitle || `Essay #${(x.questionIndex ?? 0)+1}`,
      questionText: x.questionText || x.questionTitle || '',
      answer: x.answer || '',
      status: x.status || 'pending',
      score: x.score ?? null,
      maxScore: x.maxScore ?? 10,
      createdAt: x.createdAt || null
    }));

    res.json({ success:true, total: all.length, items: pageItems });
  } catch (err) { next(err); }
});

/**
 * GET /api/teacher/quiz-essays/:id
 * Query: teacherId (required)
 * Returns the doc only if it belongs to the teacher's courses.
 */
router.get('/quiz-essays/:id', async (req, res, next) => {
  try {
    const teacherId = String(req.query.teacherId || '').trim();
    if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

    const ref = firestore.collection('quizEssaySubmissions').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success:false, message:'Submission not found.' });

    const x = snap.data() || {};
    const teacherCourseIds = await getTeacherCourseIds(teacherId);
    if (!x.courseId || !teacherCourseIds.includes(x.courseId)) {
      return res.status(403).json({ success:false, message:'Not authorized for this submission.' });
    }

    res.json({ success:true, id: snap.id, ...x });
  } catch (err) { next(err); }
});

/**
 * POST /api/teacher/quiz-essays/:id/grade
 * Body: { score, maxScore, feedback?, status? ("graded"|"needs_review") }
 * Query: teacherId (required)
 * Only allows grading if essay is in teacher's courses.
 */
router.post('/quiz-essays/:id/grade', async (req, res, next) => {
  try {
    const teacherId = String(req.query.teacherId || '').trim();
    if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

    const { id } = req.params;
    const { score, maxScore, feedback = '', status = 'graded' } = req.body || {};
    if (typeof score !== 'number' || score < 0) {
      return res.status(400).json({ success:false, message:'Score must be a non-negative number.' });
    }
    if (typeof maxScore !== 'number' || maxScore <= 0) {
      return res.status(400).json({ success:false, message:'maxScore must be a positive number.' });
    }
    if (!['graded','needs_review'].includes(String(status))) {
      return res.status(400).json({ success:false, message:'Invalid status.' });
    }

    const subRef = firestore.collection('quizEssaySubmissions').doc(id);
    const snap = await subRef.get();
    if (!snap.exists) return res.status(404).json({ success:false, message:'Submission not found.' });

    const prev = snap.data() || {};

    // ownership check
    const teacherCourseIds = await getTeacherCourseIds(teacherId);
    if (!prev.courseId || !teacherCourseIds.includes(prev.courseId)) {
      return res.status(403).json({ success:false, message:'Not authorized to grade this submission.' });
    }

    await subRef.set({
      score, maxScore, feedback, status,
      gradedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // propagate
    await recomputeAttemptFromPath(prev.attemptRefPath);

    res.json({ success:true, message:'Essay graded and attempt updated.' });
  } catch (err) { next(err); }
});

module.exports = router;
