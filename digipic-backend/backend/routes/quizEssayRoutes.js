// routes/quizEssayRoutes.js
const router = require('express').Router();
const { firestore, admin } = require('../config/firebase');
const { asyncHandler } = require('../middleware/asyncHandler');

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));

/* ---------- helpers ---------- */

function attemptRefFromEssayDoc(x) {
  // Preferred: attemptRefPath saved when the student submitted
  if (x.attemptRefPath) return firestore.doc(x.attemptRefPath);

  // Fallback path: users/{userId}/quizAttempts/{quizId}/attempts/{attemptId}
  if (x.userId && x.quizId && x.attemptId) {
    return firestore
      .collection('users').doc(String(x.userId))
      .collection('quizAttempts').doc(String(x.quizId))
      .collection('attempts').doc(String(x.attemptId));
  }
  return null;
}

async function recomputeAttemptCascade(attemptRef) {
  if (!attemptRef) return;

  const attemptSnap = await attemptRef.get();
  if (!attemptSnap.exists) return;

  const attempt = attemptSnap.data() || {};
  const attemptsCol = attemptRef.parent;              // .../attempts
  const attemptRoot = attemptsCol.parent;             // users/{uid}/quizAttempts/{quizId}
  const quizId = attemptRoot.id;
  const userRef = attemptRoot.parent.parent;          // users/{uid}

  // Sum graded essays for this attempt
  const essaysSnap = await firestore
    .collection('quizEssaySubmissions')
    .where('attemptRefPath', '==', attemptRef.path)
    .get();

  let gradedScore = 0;
  let gradedTotal = 0;
  essaysSnap.forEach(doc => {
    const e = doc.data() || {};
    if (e.status === 'graded' && typeof e.score === 'number') {
      gradedScore += e.score || 0;
      gradedTotal += (typeof e.maxScore === 'number' ? e.maxScore : 10);
    }
  });

  const autoScore   = Number(attempt.autoScore || 0);
  const autoTotal   = Number(attempt.autoTotal || 0);
  const autoPercent = autoTotal ? clampPct((autoScore / autoTotal) * 100) : 0;

  const gradedPercent   = gradedTotal ? clampPct((gradedScore / gradedTotal) * 100) : 0;
  const combinedScore   = autoScore + gradedScore;
  const combinedTotal   = autoTotal + gradedTotal;
  const combinedPercent = combinedTotal ? clampPct((combinedScore / combinedTotal) * 100) : 0;

  // Update attempt
  await attemptRef.set({
    autoPercent,
    gradedScore, gradedTotal, gradedPercent,
    percent: combinedPercent,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // Recompute parent summary (bestPercent / bestGradedPercent / lastScore)
  const all = await attemptsCol.get();
  let attemptsUsed = 0;
  let bestPercent = 0;
  let bestGradedPercent = 0;

  all.forEach(d => {
    attemptsUsed++;
    const a = d.data() || {};
    const p  = typeof a.percent === 'number'
      ? a.percent
      : (typeof a.autoPercent === 'number' ? a.autoPercent : 0);
    const gp = typeof a.gradedPercent === 'number' ? a.gradedPercent : 0;
    if (p  > bestPercent)       bestPercent       = p;
    if (gp > bestGradedPercent) bestGradedPercent = gp;
  });

  await attemptRoot.set({
    quizId,
    attemptsUsed,
    lastScore: { score: combinedScore, total: combinedTotal, percent: combinedPercent },
    bestPercent,
    bestGradedPercent,
    lastSubmittedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // Recompute user's overall average (best from each quiz)
  const qaSnap = await userRef.collection('quizAttempts').get();
  const bests = [];
  qaSnap.forEach(doc => {
    const d = doc.data() || {};
    if (typeof d.bestGradedPercent === 'number') bests.push(d.bestGradedPercent);
    else if (typeof d.bestPercent === 'number')  bests.push(d.bestPercent);
    else if (d.lastScore?.percent != null)       bests.push(d.lastScore.percent);
  });
  const averageQuizScore = bests.length
    ? clampPct(bests.reduce((a,b)=>a+b,0) / bests.length)
    : 0;

  await userRef.set({ averageQuizScore }, { merge: true });
}

/* ---------- list ---------- */
// GET /api/teacher/quiz-essays?status=&page=&pageSize=
router.get('/quiz-essays', asyncHandler(async (req, res) => {
  const { status = '', page = '1', pageSize = '20' } = req.query;
  const p  = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));

  let q = firestore.collection('quizEssaySubmissions').orderBy('createdAt', 'desc');
  if (status) q = q.where('status', '==', status);

  // simple offset page
  const snapAll = await q.get();
  const total = snapAll.size;
  const start = (p - 1) * ps;
  const end   = start + ps;
  const docs  = snapAll.docs.slice(start, end);

  const items = docs.map(d => {
    const x = d.data();
    return {
      id: d.id,
      quizId: x.quizId,
      courseId: x.courseId,
      moduleId: x.moduleId,
      attemptId: x.attemptId,
      userId: x.userId,
      studentName: x.studentName || x.studentEmail || 'Student',
      questionIndex: x.questionIndex,
      questionTitle: x.questionTitle || `Essay #${(x.questionIndex ?? 0) + 1}`,
      questionText: x.questionText || '',
      answer: x.answer || '',
      status: x.status || 'pending',
      score: x.score ?? null,
      maxScore: x.maxScore ?? 10,
      createdAt: x.createdAt || null,
    };
  });

  res.json({ success: true, total, items });
}));

/* ---------- read one ---------- */
// GET /api/teacher/quiz-essays/:id
router.get('/quiz-essays/:id', asyncHandler(async (req, res) => {
  const doc = await firestore.collection('quizEssaySubmissions').doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ success:false, message:'Not found' });

  const x = doc.data();
  res.json({
    success: true,
    id: doc.id,
    quizId: x.quizId,
    courseId: x.courseId,
    moduleId: x.moduleId,
    attemptId: x.attemptId,
    userId: x.userId,
    studentName: x.studentName || x.studentEmail || 'Student',
    questionIndex: x.questionIndex,
    questionText: x.questionText || '',
    studentAnswer: x.answer || '',
    score: x.score ?? null,
    maxScore: x.maxScore ?? 10,
    feedback: x.feedback || '',
    status: x.status || 'pending',
    createdAt: x.createdAt || null,
    attemptRefPath: x.attemptRefPath || null,
  });
}));

/* ---------- grade (and cascade updates) ---------- */
// POST /api/teacher/quiz-essays/:id/grade
router.post('/quiz-essays/:id/grade', asyncHandler(async (req, res) => {
  const { score, maxScore, feedback = '', status = 'graded' } = req.body || {};
  const s = Number(score), m = Number(maxScore);

  if (!Number.isFinite(s) || s < 0)  return res.status(400).json({ success:false, message:'Invalid score' });
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ success:false, message:'Invalid maxScore' });
  if (!['graded','needs_review'].includes(String(status))) {
    return res.status(400).json({ success:false, message:'Invalid status' });
  }

  const ref = firestore.collection('quizEssaySubmissions').doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ success:false, message:'Not found' });

  const before = doc.data() || {};

  // Save the grade
  await ref.set({
    score: s,
    maxScore: m,
    feedback: String(feedback || ''),
    status: String(status || 'graded'),
    gradedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Cascade recompute → attempt → parent quizAttempts → user average
  const attemptRef = attemptRefFromEssayDoc(before);
  await recomputeAttemptCascade(attemptRef);

  res.json({ success: true, message: 'Essay graded; quiz attempt updated.' });
}));

module.exports = router;
