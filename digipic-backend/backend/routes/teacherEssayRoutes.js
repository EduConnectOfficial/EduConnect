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

  // optional: courses where teacher listed in array
  try {
    const q2 = await firestore.collection('courses')
      .where('teachers', 'array-contains', teacherId).get();
    q2.forEach(d => ids.add(d.id));
  } catch (_) {}

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

    const snap = await q.get();
    snap.forEach(d => all.push({ id: d.id, ...d.data() }));
  }

  // newest first
  all.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  return all;
}

/** recompute summary after grading a single attempt path */
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

  // sum graded essays for this attempt
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
    const p  = (typeof a.percent === 'number') ? a.percent
            : (typeof a.autoPercent === 'number' ? a.autoPercent : 0);
    const gp = (typeof a.gradedPercent === 'number') ? a.gradedPercent : 0;
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

/* ------------ Name & Quiz title hydration helpers ------------ */

const { decryptField } = require('../utils/fieldCrypto');

function buildFullName(u = {}) {
  // Try encrypted fields first
  const f  = decryptField(u.firstNameEnc  || '') || u.firstName || '';
  const m  = decryptField(u.middleNameEnc || '') || u.middleName || '';
  const l  = decryptField(u.lastNameEnc   || '') || u.lastName || '';
  const full = [f, m, l].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();

  if (full) return full;
  if (u.fullName && u.fullName.trim()) return u.fullName.trim();
  if (u.firstName || u.lastName) return `${u.firstName || ''} ${u.lastName || ''}`.trim();
  return '';
}

function uidFromAttemptRefPath(path = '') {
  // users/{uid}/quizAttempts/{quizId}/attempts/{attemptId}
  const parts = path.split('/').filter(Boolean);
  const i = parts.indexOf('users');
  if (i >= 0 && parts[i+1]) return parts[i+1];
  return '';
}

async function getUserDocByAny({ studentDocId, studentId, email, attemptRefPath }) {
  // 1) direct users/{docId}
  if (studentDocId) {
    const snap = await firestore.collection('users').doc(studentDocId).get();
    if (snap.exists) return { id: snap.id, ...snap.data() };
  }

  // 2) users.where('studentId'=='…')
  if (studentId) {
    const q = await firestore.collection('users').where('studentId', '==', studentId).limit(1).get();
    if (!q.empty) {
      const d = q.docs[0];
      return { id: d.id, ...d.data() };
    }
  }

  // 3) users.where('email'=='…')
  if (email) {
    const q = await firestore.collection('users').where('email', '==', email).limit(1).get();
    if (!q.empty) {
      const d = q.docs[0];
      return { id: d.id, ...d.data() };
    }
  }

  // 4) users/{uid} from attemptRefPath
  const uid = uidFromAttemptRefPath(attemptRefPath || '');
  if (uid) {
    const snap = await firestore.collection('users').doc(uid).get();
    if (snap.exists) return { id: snap.id, ...snap.data() };
  }

  return null;
}

async function getDecryptedDisplayName(x) {
  // x can have: studentId (student number), userId (docId), studentEmail, attemptRefPath
  const user = await getUserDocByAny({
    studentDocId: x.userId || x.uid || null,
    studentId: x.studentId || null,
    email: x.studentEmail || x.email || null,
    attemptRefPath: x.attemptRefPath || null
  });

  const full = user ? buildFullName(user) : '';
  if (full) return full;

  // LAST RESORT: never return email; keep UI clean.
  return 'Student';
}

async function getQuizTitle(quizId) {
  if (!quizId) return '';
  try {
    const snap = await firestore.collection('quizzes').doc(String(quizId)).get();
    if (snap.exists) return snap.data()?.title || '';
  } catch {}
  return '';
}

/* ========================= Routes ========================= */

/**
 * GET /api/teacher/quiz-essays
 * Query: teacherId (required), status? (pending|graded|needs_review), page?, pageSize?
 * Returns only essays where essay.courseId belongs to the teacher.
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

    // hydrate names + quiz titles for the page slice
    const slice = all.slice(start, start + pageSize);

    const items = await Promise.all(slice.map(async x => {
      const studentName = await getDecryptedDisplayName(x);
      const quizTitle = await getQuizTitle(x.quizId);

      return {
        id: x.id,
        courseId: x.courseId || null,
        moduleId: x.moduleId || null,

        // ✅ decrypted full name only; never email
        studentName,

        // keep email in payload only if you still need it elsewhere (not for display)
        studentEmail: x.studentEmail || '',

        // quiz info
        quizId: x.quizId || '',
        quizTitle, // ✅ hydrated title

        questionTitle: x.questionTitle || `Essay #${(x.questionIndex ?? 0)+1}`,
        questionText: x.questionText || x.questionTitle || '',
        answer: x.answer || '',
        status: x.status || 'pending',
        score: x.score ?? null,
        maxScore: x.maxScore ?? 10,
        createdAt: x.createdAt || null,

        // for possible future use in UI grouping
        studentId: x.studentId || x.uid || x.userId || null,
        attemptRefPath: x.attemptRefPath || null,
      };
    }));

    res.json({ success:true, total: all.length, items });
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

    // enrich single item too (optional)
    const studentName = await getDecryptedDisplayName(x);
    const quizTitle = await getQuizTitle(x.quizId);

    res.json({ success:true, id: snap.id, ...x, studentName, quizTitle });
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

    // propagate summary
    await recomputeAttemptFromPath(prev.attemptRefPath);

    res.json({ success:true, message:'Essay graded and attempt updated.' });
  } catch (err) { next(err); }
});

module.exports = router;
