const router = require('express').Router();
const PDFDocument = require('pdfkit');
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');

/* -------------------- helpers -------------------- */

let getUserRefByAnyId;
try {
  ({ getUserRefByAnyId } = require('../utils/idUtils'));
} catch {
  // Fallback resolver: users/{id} or users where studentId == anyId
  getUserRefByAnyId = async (anyId) => {
    if (!anyId) return null;
    const asDoc = await firestore.collection('users').doc(anyId).get();
    if (asDoc.exists) return asDoc.ref;
    const q = await firestore.collection('users').where('studentId', '==', anyId).limit(1).get();
    if (!q.empty) return q.docs[0].ref;
    return null;
  };
}

const chunk = (arr, size = 10) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const toMillis = (ts) => {
  if (!ts) return null;
  if (ts._seconds) return ts._seconds * 1000;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts === 'number') return ts;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
};

const iso = (ts) => {
  const ms = toMillis(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const firstNum = (...vals) => {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const clampPct = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, Math.round(x)));
};
const normalizePercent = ({ percent, gradedPercent, autoPercent, gradePercent, grade, score, obtained, maxPoints, points, max, maxScore, totalPoints, denominator, outOf }) => {
  // Prefer precomputed percent-like fields
  const pre = firstNum(percent, gradedPercent, autoPercent, gradePercent);
  if (pre != null) return clampPct(pre);

  const raw = firstNum(grade, score, obtained);
  const mx = firstNum(maxPoints, points, max, maxScore, totalPoints, denominator, outOf);
  if (raw != null && mx != null && mx > 0) return clampPct((raw / mx) * 100);
  if (raw != null && raw <= 1) return clampPct(raw * 100);     // fractional legacy
  if (raw != null && raw <= 100) return clampPct(raw);         // already percent
  return null;
};

/* ============================================================
   GET /api/student/analytics?student=STUDENT_ID_OR_USERID
============================================================ */
router.get('/student/analytics', asyncHandler(async (req, res) => {
  const studentKey = String(req.query.student || '').trim();
  if (!studentKey) return res.status(400).json({ success:false, message:'student is required' });

  const userRef = await getUserRefByAnyId(studentKey);
  if (!userRef) return res.status(404).json({ success:false, message:'Student not found.' });

  const uSnap = await userRef.get();
  const u = uSnap.data() || {};
  const profile = {
    name: (u.fullName && u.fullName.trim()) ||
          `${u.firstName || ''} ${u.lastName || ''}`.trim() ||
          u.username || 'Student',
    studentId: u.studentId || uSnap.id,
  };

  /* --------------------------- Quizzes --------------------------- */
  const qaRootSnap = await userRef.collection('quizAttempts').get();
  const quizRoot = qaRootSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Hydrate quiz titles
  const quizIds = quizRoot.map(q => q.id);
  const quizTitleById = {};
  for (const ids of chunk(quizIds, 10)) {
    if (!ids.length) continue;
    const snap = await firestore.collection('quizzes').where('__name__', 'in', ids).get();
    snap.forEach(doc => {
      const q = doc.data() || {};
      quizTitleById[doc.id] = q.title || `Quiz ${doc.id.slice(0,6)}`;
    });
  }

  const perQuiz = quizRoot.map(q => {
    const best =
      (typeof q.bestGradedPercent === 'number') ? q.bestGradedPercent :
      (typeof q.bestPercent === 'number')       ? q.bestPercent :
      (q.lastScore?.percent != null ? q.lastScore.percent : null);

    return {
      quizId: q.id,
      title: quizTitleById[q.id] || `Quiz ${q.id.slice(0,6)}`,
      bestPercent: best != null ? Math.round(best) : null,
      attemptsUsed: q.attemptsUsed ?? null,
      lastSubmittedAt: q.lastSubmittedAt || q.updatedAt || q.createdAt || null,
    };
  });

  const quizPercents = perQuiz.map(x => x.bestPercent).filter(n => typeof n === 'number');
  const avgQuiz = quizPercents.length
    ? Math.round(quizPercents.reduce((a,b) => a + b, 0) / quizPercents.length)
    : 0;

  /* ------------------------ Assignments ------------------------- */
  // Read student assignment grades
  let agSnap;
  try {
    agSnap = await userRef.collection('assignmentGrades').orderBy('gradedAt','desc').get();
  } catch {
    agSnap = await userRef.collection('assignmentGrades').get();
  }

  const baseGrades = agSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

  // Find which need a maxPoints lookup
  const needMaxIds = baseGrades
    .filter(r => normalizePercent(r) == null)   // if cannot resolve from in-row fields
    .map(r => r.assignmentId || r.id)
    .filter(Boolean);

  // Build a map of assignmentId -> maxPoints from assignments collection
  const maxByAssignment = new Map();
  for (const ids of chunk(needMaxIds, 10)) {
    if (!ids.length) continue;
    const snap = await firestore.collection('assignments').where('__name__','in', ids).get();
    const found = new Set();
    snap.forEach(doc => {
      const a = doc.data() || {};
      const max = firstNum(a.maxPoints, a.points, a.totalPoints, a.max, a.maxScore);
      maxByAssignment.set(doc.id, Number.isFinite(max) ? Number(max) : null);
      found.add(doc.id);
    });
    ids.forEach(id => { if (!found.has(id)) maxByAssignment.set(id, null); });
  }

  // Normalize assignment rows
  const grades = baseGrades.map(row => {
    const assignmentId = row.assignmentId || row.id;
    const maxInline = firstNum(row.maxPoints, row.points, row.totalPoints, row.max, row.maxScore);
    const maxPoints = Number.isFinite(maxInline) ? Number(maxInline) : maxByAssignment.get(assignmentId);

    const percent = normalizePercent({
      percent: row.percent,
      gradedPercent: row.gradedPercent,
      autoPercent: row.autoPercent,
      gradePercent: row.gradePercent,
      grade: row.grade,
      score: row.score,
      obtained: row.obtained,
      maxPoints,
      points: row.points,
      max: row.max,
      maxScore: row.maxScore,
      totalPoints: row.totalPoints,
      denominator: row.denominator,
      outOf: row.outOf
    });

    // Keep a rounded raw grade if present (for reference/tooltips)
    const raw = firstNum(row.grade, row.score, row.obtained);
    return {
      assignmentId,
      assignmentTitle: row.assignmentTitle || `Assignment ${assignmentId.slice(0,6)}`,
      grade: Number.isFinite(raw) ? Number(raw) : null,     // raw points (for reference)
      maxPoints: Number.isFinite(maxPoints) ? Number(maxPoints) : null,
      percent: Number.isFinite(percent) ? Number(percent) : null,
      gradedAt: row.gradedAt || row.updatedAt || row.submittedAt || null,
    };
  });

  const asgPercents = grades.map(g => g.percent).filter(n => typeof n === 'number');
  const avgAsg = asgPercents.length
    ? Math.round(asgPercents.reduce((a,b) => a + b, 0) / asgPercents.length)
    : 0;

  /* -------------------------- Essays --------------------------- */
  const essaySnap = await firestore
    .collection('quizEssaySubmissions')
    .where('userId', '==', userRef.id)
    .orderBy('createdAt', 'desc')
    .get();

  const essayDocs = essaySnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const essayQuizIds = Array.from(new Set(essayDocs.map(e => e.quizId).filter(Boolean)));
  const essayQuizTitleById = {};
  for (const ids of chunk(essayQuizIds, 10)) {
    if (!ids.length) continue;
    const snap = await firestore.collection('quizzes').where('__name__','in', ids).get();
    snap.forEach(doc => {
      const q = doc.data() || {};
      essayQuizTitleById[doc.id] = q.title || `Quiz ${doc.id.slice(0,6)}`;
    });
  }
  const submissions = essayDocs.map(e => ({
    quizId: e.quizId || null,
    quizTitle: essayQuizTitleById[e.quizId] || null,
    questionIndex: (typeof e.questionIndex === 'number') ? e.questionIndex : null,
    status: e.status || 'pending',
    score: (typeof e.score === 'number') ? e.score : null,
    maxScore: (typeof e.maxScore === 'number') ? e.maxScore : 10,
    createdAt: e.createdAt || null
  }));

  /* -------------------------- Modules -------------------------- */
  const cmSnap = await userRef.collection('completedModules').get();
  const completed = cmSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const courseIds = Array.from(new Set(completed.map(m => m.courseId).filter(Boolean)));
  const moduleIds = Array.from(new Set(completed.map(m => m.moduleId).filter(Boolean)));

  const courseTitleById = {};
  const moduleTitleById = {};

  for (const ids of chunk(courseIds, 10)) {
    if (!ids.length) continue;
    const snap = await firestore.collection('courses').where('__name__','in', ids).get();
    snap.forEach(doc => {
      const c = doc.data() || {};
      courseTitleById[doc.id] = c.title || c.name || `Course ${doc.id.slice(0,6)}`;
    });
  }
  for (const ids of chunk(moduleIds, 10)) {
    if (!ids.length) continue;
    const snap = await firestore.collection('modules').where('__name__','in', ids).get();
    snap.forEach(doc => {
      const m = doc.data() || {};
      moduleTitleById[doc.id] = m.title || m.name || `Module ${doc.id.slice(0,6)}`;
    });
  }

  const modulesCompleted = completed.map(m => ({
    courseId: m.courseId || null,
    courseTitle: m.courseTitle || courseTitleById[m.courseId] || null,
    moduleId: m.moduleId || null,
    moduleTitle: m.moduleTitle || moduleTitleById[m.moduleId] || null,
    percent: (typeof m.percent === 'number') ? Math.round(m.percent) : null,
    completedAt: m.completedAt || null
  }));

  // Compute total modules assigned to this student (like teacher analytics student view)
  // 1) Enrollments (classIds)
  const enrollSnap = await userRef.collection('enrollments').get();
  const classIds = enrollSnap.docs.map(d => d.id);

  // 2) Courses for those classes
  const courseSet = new Set();
  for (const ids of chunk(classIds, 10)) {
    if (!ids.length) continue;
    const snap = await firestore
      .collection('courses')
      .where('assignedClasses', 'array-contains-any', ids)
      .get();
    snap.forEach(doc => courseSet.add(doc.id));
  }
  const assignedCourseIds = Array.from(courseSet);

  // 3) Count modules in those courses
  let totalModules = 0;
  for (const ids of chunk(assignedCourseIds, 10)) {
    if (!ids.length) continue;
    const snap = await firestore.collection('modules').where('courseId', 'in', ids).get();
    totalModules += snap.size;
  }

  const summary = {
    averageQuizScore: avgQuiz,
    averageAssignmentGrade: avgAsg,
    modulesCompleted: modulesCompleted.length,
    totalModules
  };

  res.json({
    success: true,
    profile,
    summary,
    quizzes: { perQuiz: perQuiz.sort((a,b) => (a.title||'').localeCompare((b.title||''))) },
    // sort assignments by gradedAt desc
    assignments: { grades: grades.sort((a,b) => (iso(b.gradedAt)||'').localeCompare(iso(a.gradedAt)||'')) },
    essays: { submissions },
    modules: { completed: modulesCompleted }
  });
}));

/* ============================================================
   CSV export (combined flat list, handy for downloads)
============================================================ */
router.get('/student/analytics/csv', asyncHandler(async (req, res) => {
  const studentKey = String(req.query.student || '').trim();
  if (!studentKey) return res.status(400).json({ success:false, message:'student is required' });

  // Call our own JSON endpoint in-process
  const userReq = { ...req, url: req.url.replace('/student/analytics/csv','/student/analytics'), method:'GET' };
  const collector = { body:null, json(obj){ this.body = obj; } };

  await new Promise((resolve) =>
    router.handle(userReq, { ...collector, end: resolve }, resolve)
  );

  const data = collector.body || {};
  const rows = [];
  rows.push(['Type','Title','Date','Score','Max','Percent','Extra']);

  // quizzes
  (data.quizzes?.perQuiz || []).forEach(q => {
    rows.push([
      'Quiz',
      q.title || q.quizId,
      q.lastSubmittedAt ? new Date(toMillis(q.lastSubmittedAt)).toLocaleString() : '',
      '', '', (q.bestPercent != null ? q.bestPercent : ''), `Attempts: ${q.attemptsUsed ?? 0}`
    ]);
  });

  // assignments (now include raw + max + normalized percent)
  (data.assignments?.grades || []).forEach(a => {
    rows.push([
      'Assignment',
      a.assignmentTitle || a.assignmentId,
      a.gradedAt ? new Date(toMillis(a.gradedAt)).toLocaleString() : '',
      (a.grade != null ? a.grade : ''),
      (a.maxPoints != null ? a.maxPoints : ''),
      (a.percent != null ? a.percent : ''),
      ''
    ]);
  });

  // modules
  (data.modules?.completed || []).forEach(m => {
    rows.push([
      'Module',
      `${m.courseTitle || m.courseId || ''} • ${m.moduleTitle || m.moduleId || ''}`,
      m.completedAt ? new Date(toMillis(m.completedAt)).toLocaleString() : '',
      (m.percent != null ? m.percent : ''), 100, (m.percent != null ? m.percent : ''), ''
    ]);
  });

  // essays
  (data.essays?.submissions || []).forEach(e => {
    rows.push([
      'Essay',
      `${e.quizTitle || e.quizId || ''} • Q#${(e.questionIndex != null) ? (e.questionIndex+1) : '—'}`,
      e.createdAt ? new Date(toMillis(e.createdAt)).toLocaleString() : '',
      (e.score != null ? e.score : ''), (e.maxScore != null ? e.maxScore : ''), '', e.status || ''
    ]);
  });

  const csv = rows.map(r => r.map(v => {
    const val = String(v ?? '');
    return /[",\n]/.test(val) ? `"${val.replace(/"/g,'""')}"` : val;
  }).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="student_analytics_${studentKey}.csv"`);
  res.send(csv);
}));

/* ============================================================
   PDF export (compact report)
============================================================ */
router.get('/student/analytics/pdf', asyncHandler(async (req, res) => {
  const studentKey = String(req.query.student || '').trim();
  if (!studentKey) return res.status(400).json({ success:false, message:'student is required' });

  // Fetch same JSON in-process
  const userReq = { ...req, url: req.url.replace('/student/analytics/pdf','/student/analytics'), method:'GET' };
  const collector = { body:null, json(obj){ this.body = obj; } };
  await new Promise((resolve) =>
    router.handle(userReq, { ...collector, end: resolve }, resolve)
  );
  const data = collector.body || {};

  const studentName = data.profile?.name || 'Student';
  const studentId = data.profile?.studentId || studentKey;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="student_analytics_${studentId}.pdf"`);

  const doc = new PDFDocument({ size:'A4', margin:36 });
  doc.pipe(res);

  doc.fontSize(18).text('Student Analytics Report', { align:'left' });
  doc.moveDown(0.3).fontSize(10).fillColor('#666')
    .text(`Student: ${studentName} (${studentId})`, { align:'left' });
  doc.moveDown();

  doc.fillColor('#000').fontSize(12).text('Summary', { underline:true });
  doc.moveDown(0.3);
  doc.text(`Average Quiz: ${data.summary?.averageQuizScore ?? 0}%`);
  doc.text(`Average Assignment: ${data.summary?.averageAssignmentGrade ?? 0}%`);
  doc.text(`Modules Completed: ${data.summary?.modulesCompleted ?? 0}/${data.summary?.totalModules ?? 0}`);
  doc.moveDown();

  doc.fontSize(12).text('Quizzes (best %)', { underline:true });
  doc.fontSize(9);
  (data.quizzes?.perQuiz || []).slice(0,150).forEach(q => {
    const dt = q.lastSubmittedAt ? new Date(toMillis(q.lastSubmittedAt)).toLocaleString() : '';
    doc.text(`${q.title || q.quizId}: ${q.bestPercent ?? '—'}%  | Attempts: ${q.attemptsUsed ?? 0} | Last: ${dt}`);
  });
  doc.moveDown();

  doc.fontSize(12).text('Assignments', { underline:true });
  doc.fontSize(9);
  (data.assignments?.grades || []).slice(0,150).forEach(a => {
    const dt = a.gradedAt ? new Date(toMillis(a.gradedAt)).toLocaleString() : '';
    const extra = (a.grade != null && a.maxPoints != null) ? ` (Raw: ${a.grade}/${a.maxPoints})` : '';
    const pct = (a.percent != null) ? `${a.percent}%` : '—';
    doc.text(`${a.assignmentTitle || a.assignmentId}: ${pct}${extra} | Graded: ${dt}`);
  });
  doc.moveDown();

  doc.fontSize(12).text('Essay Submissions', { underline:true });
  doc.fontSize(9);
  (data.essays?.submissions || []).slice(0,150).forEach(e => {
    const dt = e.createdAt ? new Date(toMillis(e.createdAt)).toLocaleString() : '';
    const qn = (e.questionIndex != null) ? `Q#${e.questionIndex+1}` : 'Q#—';
    const sc = (e.score != null) ? `${e.score}/${e.maxScore ?? 10}` : '—';
    doc.text(`${e.quizTitle || e.quizId || ''} • ${qn}: ${sc} • ${e.status || 'pending'} • ${dt}`);
  });
  doc.moveDown();

  doc.fontSize(12).text('Completed Modules', { underline:true });
  doc.fontSize(9);
  (data.modules?.completed || []).slice(0,150).forEach(m => {
    const dt = m.completedAt ? new Date(toMillis(m.completedAt)).toLocaleString() : '';
    doc.text(`${m.courseTitle || m.courseId || ''} • ${m.moduleTitle || m.moduleId || ''}: ${m.percent ?? '—'}% • ${dt}`);
  });

  doc.end();
}));

module.exports = router;
