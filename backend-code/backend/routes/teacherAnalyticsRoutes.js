// backend/routes/teacherAnalyticsRoutes.js
const router = require('express').Router();
const { firestore, admin } = require('../config/firebase');
const PDFDocument = require('pdfkit');
const { asyncHandler } = require('../middleware/asyncHandler');

// Import from utils (single source)
const {
  buildTeacherAnalytics,             // legacy
  buildTeacherQuizAnalytics,         // new quizzes
  buildTeacherAssignmentAnalytics,   // new assignments
} = require('../utils/analyticsUtils');

// Decrypt helper for user docs
const { safeDecrypt } = require('../utils/fieldCrypto'); // ⬅️ switched to safeDecrypt
const { getUserRefByAnyId } = require('../utils/idUtils');

function decryptNamesFromUser(u = {}) {
  return {
    firstName:  safeDecrypt(u.firstNameEnc  || '', ''),
    middleName: safeDecrypt(u.middleNameEnc || '', ''),
    lastName:   safeDecrypt(u.lastNameEnc   || '', ''),
  };
}
function fullNameFromUser(u = {}) {
  const names = decryptNamesFromUser(u);
  const full = [names.firstName, names.middleName, names.lastName]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (full) return full;
  if (u.fullName && String(u.fullName).trim()) return String(u.fullName).trim();
  if (u.firstName || u.lastName) return `${u.firstName||''} ${u.lastName||''}`.trim();
  return 'Student';
}

// Prefer the school-facing Student ID over UID
function getStudentIdFromUser(u = {}, fallbackId = '') {
  const candidates = [
    u.studentId, u.studentID,
    u.schoolId, u.schoolID,
    u.sid, u.idNumber, u.studentNumber,
  ]
    .map(v => (v == null ? '' : String(v).trim()))
    .filter(Boolean);
  return candidates[0] || String(fallbackId || '').trim();
}

// tiny helpers
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

// (Optional) sanity log
console.log('[analytics fns]', {
  legacy: !!buildTeacherAnalytics,
  quiz: !!buildTeacherQuizAnalytics,
  assignment: !!buildTeacherAssignmentAnalytics,
});

/* ========= QUIZ ANALYTICS (Teacher Aggregate) ========= */

// JSON
router.get('/quiz-analytics', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });

  const data = await buildTeacherQuizAnalytics({ teacherId, classId });

  // Enrich with decrypted names and display Student ID
  if (Array.isArray(data.progress)) {
    for (const s of data.progress) {
      if (!s.studentId) continue;
      try {
        const userRef = await getUserRefByAnyId(s.studentId);
        if (!userRef) continue;
        const userSnap = await userRef.get();
        const user = userSnap.data() || {};

        const names = decryptNamesFromUser(user);
        const fullName = [names.firstName, names.middleName, names.lastName]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        if (fullName) s.name = fullName;

        // IMPORTANT: replace internal ID with display Student ID
        s.studentId = getStudentIdFromUser(user, userRef.id);
      } catch {}
    }
  }
  return res.json(data);
}));

/* ========= QUIZ ANALYTICS: CSV ========= */
router.get('/quiz-analytics/csv', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });

  const { summary, progress } = await buildTeacherQuizAnalytics({ teacherId, classId });

  const rows = [];

  // optional summary block at top
  rows.push(['Summary']);
  rows.push(['Total Quizzes', summary.totalQuizzes]);
  rows.push(['Average Quiz Score (%)', summary.averageQuizScore]);
  rows.push(['Pass Rate (%)', summary.passRate]);
  rows.push(['Modules Completed', `${summary.modulesCompleted}/${summary.totalModules}`]);
  rows.push(['Modules Completed (%)', summary.modulesCompletedPct]);
  rows.push([]); // blank line

  // detail table
  rows.push([
    'Class','Student','Student ID',
    'Avg Quiz Score (%)','Quizzes Taken','Total Quizzes',
    'On-time (%)','Modules Completed','Total Modules','Status'
  ]);

  (progress || []).forEach(s => rows.push([
    s.className || '',
    s.name || '',
    s.studentId || '', // Already replaced in JSON route
    (s.avgQuizScore ?? '') + '',
    (s.quizzesTaken ?? '') + '',
    (s.totalQuizzes ?? '') + '',
    (s.onTimePct ?? '') + '',
    (s.modulesCompleted ?? '') + '',
    (s.totalModules ?? '') + '',
    s.status || '',
  ]));

  const csv = rows.map(r => r.map(v => {
    const val = String(v ?? '');
    return /[",\n]/.test(val) ? `"${val.replace(/"/g,'""')}"` : val;
  }).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="quiz_analytics_${teacherId}${classId ? '_' + classId : ''}.csv"`);
  return res.send(csv);
}));

/* ========= QUIZ ANALYTICS: PDF ========= */
router.get('/quiz-analytics/pdf', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });

  const { summary, progress, byQuiz } = await buildTeacherQuizAnalytics({ teacherId, classId });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="quiz_analytics_${teacherId}${classId ? '_' + classId : ''}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(res);

  doc.fontSize(18).text('Quiz Analytics Report', { align: 'left' });
  doc.moveDown(0.3).fontSize(10).fillColor('#666')
    .text(`Teacher: ${teacherId}${classId ? ' | Class: ' + classId : ''}`, { align: 'left' });
  doc.moveDown();

  doc.fillColor('#000').fontSize(12).text('Summary', { underline: true });
  doc.moveDown(0.3);
  doc.text(`Total Quizzes: ${summary.totalQuizzes}`);
  doc.text(`Average Quiz Score: ${summary.averageQuizScore}%`);
  doc.text(`Pass Rate: ${summary.passRate}%`);
  doc.text(`Modules Completed: ${summary.modulesCompleted}/${summary.totalModules} (${summary.modulesCompletedPct}%)`);
  doc.moveDown();

  doc.fontSize(12).text('By Quiz', { underline: true });
  doc.fontSize(10);
  (byQuiz.labels || []).forEach((label, i) => {
    const avg = byQuiz.avgScores?.[i] ?? 0;
    const att = byQuiz.attempts?.[i] ?? 0;
    doc.text(`${label}: Avg ${avg}% | Attempts: ${att}`);
  });
  doc.moveDown();

  doc.fontSize(12).text('Student Progress', { underline: true });
  doc.moveDown(0.2);
  doc.fontSize(9).text('Class | Student | ID | Avg% | Taken/Total | On-time% | Modules | Status');
  doc.moveDown(0.2).moveTo(doc.x, doc.y).lineTo(559, doc.y).stroke();

  (progress || []).slice(0, 150).forEach(s => {
    const qt = `${s.quizzesTaken ?? 0}/${s.totalQuizzes ?? 0}`;
    const mods = `${s.modulesCompleted ?? 0}/${s.totalModules ?? 0}`;
    doc.text(`${s.className} | ${s.name} | ${s.studentId} | ${s.avgQuizScore}% | ${qt} | ${s.onTimePct ?? 0}% | ${mods} | ${s.status}`);
  });

  doc.end();
}));

/* ========= ASSIGNMENT ANALYTICS (Teacher Aggregate) ========= */

// CSV (summary + details; keep one canonical version)
router.get('/assignment-analytics/csv', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

  const { summary, progress } = await buildTeacherAssignmentAnalytics({ teacherId, classId });

  const rows = [];

  // optional summary block
  rows.push(['Summary']);
  rows.push(['Total Assignments', summary.totalAssignments]);
  rows.push(['Average Assignment Score (%)', summary.averageAssignmentScore]);
  rows.push(['On-time Submission Rate (%)', summary.onTimeRate]);
  rows.push(['Modules Completed', `${summary.modulesCompleted}/${summary.totalModules}`]);
  rows.push(['Modules Completed (%)', summary.modulesCompletedPct]);
  rows.push([]);

  // detail table (fixed headers)
  rows.push([
    'Class','Student','Student ID',
    'Avg Assignment Score (%)','Assignments Submitted','Total Assignments',
    'On-time (%)','Modules Completed','Total Modules','Status'
  ]);

  (progress || []).forEach(s => rows.push([
    s.className || '',
    s.name || '',
    s.studentId || '',
    (s.avgAssignmentScore ?? '') + '',
    (s.assignmentsSubmitted ?? '') + '',
    (s.totalAssignments ?? '') + '',
    (s.onTimePct ?? '') + '',
    (s.modulesCompleted ?? '') + '',
    (s.totalModules ?? '') + '',
    s.status || '',
  ]));

  const csv = rows.map(r => r.map(v => {
    const val = String(v ?? '');
    return /[",\n]/.test(val) ? `"${val.replace(/"/g,'""')}"` : val;
  }).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="assignment_analytics_${teacherId}${classId ? '_' + classId : ''}.csv"`);
  return res.send(csv);
}));

// PDF
router.get('/assignment-analytics/pdf', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

  const { summary, progress, byAssignment } = await buildTeacherAssignmentAnalytics({ teacherId, classId });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="assignment_analytics_${teacherId}${classId ? '_' + classId : ''}.pdf"`);

  const doc = new PDFDocument({ size:'A4', margin: 36 });
  doc.pipe(res);

  doc.fontSize(18).text('Assignment Analytics Report', { align:'left' });
  doc.moveDown(0.3).fontSize(10).fillColor('#666').text(`Teacher: ${teacherId}${classId ? ' | Class: ' + classId : ''}`, { align:'left' });
  doc.moveDown();

  doc.fillColor('#000').fontSize(12).text('Summary', { underline:true });
  doc.moveDown(0.3);
  doc.text(`Total Assignments: ${summary.totalAssignments}`);
  doc.text(`Average Assignment Score: ${summary.averageAssignmentScore}%`);
  doc.text(`On-time Submission Rate: ${summary.onTimeRate}%`);
  doc.text(`Modules Completed: ${summary.modulesCompleted}/${summary.totalModules} (${summary.modulesCompletedPct}%)`);
  doc.moveDown();

  doc.fontSize(12).text('By Assignment', { underline:true });
  doc.fontSize(10);
  (byAssignment.labels || []).forEach((label, i) => {
    const avg = byAssignment.avgScores?.[i] ?? 0;
    const subs = byAssignment.submissions?.[i] ?? 0;
    doc.text(`${label}: Avg ${avg}% | Submissions: ${subs}`);
  });
  doc.moveDown();

  doc.fontSize(12).text('Student Progress', { underline:true });
  doc.moveDown(0.2);
  doc.fontSize(9).text('Class | Student | ID | Avg% | Submitted/Total | On-time% | Modules | Status');
  doc.moveDown(0.2).moveTo(doc.x, doc.y).lineTo(559, doc.y).stroke();

  (progress || []).slice(0, 150).forEach(s => {
    const st = `${s.assignmentsSubmitted ?? 0}/${s.totalAssignments ?? 0}`;
    const mods = `${s.modulesCompleted ?? 0}/${s.totalModules ?? 0}`;
    doc.text(`${s.className} | ${s.name} | ${s.studentId} | ${s.avgAssignmentScore}% | ${st} | ${s.onTimePct ?? 0}% | ${mods} | ${s.status}`);
  });

  doc.end();
}));

/* ========= LEGACY (kept) ========= */

router.get('/analytics', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });

  const data = await buildTeacherAnalytics({ teacherId, classId });
  return res.json({
    success: true,
    gradeDistribution: data.charts.gradeDistribution,
    completionRate: data.charts.completionRate,
    atRisk: data.students,
    summary: data.summary,
  });
}));

router.get('/analytics/csv', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });

  const { students } = await buildTeacherAnalytics({ teacherId, classId });

  const rows = [];
  rows.push(['Student','Student ID','Avg Score','Modules Completed','Modules Total','Time on Task (min)','Status']);
  (students || []).forEach(s => rows.push([
    s.name,
    s.studentId,
    `${s.avgScore}`,
    `${s.modulesCompleted}`,
    `${s.modulesTotal}`,
    `${s.timeOnTaskMin}`,
    s.status
  ]));

  const csv = rows.map(r => r.map(v => {
    const val = String(v ?? '');
    return /[",\n]/.test(val) ? `"${val.replace(/"/g,'""')}"` : val;
  }).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="teacher_analytics_${teacherId}.csv"`);
  return res.send(csv);
}));

router.get('/analytics/pdf', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });

  const { summary, students, charts } = await buildTeacherAnalytics({ teacherId, classId });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="teacher_analytics_${teacherId}.pdf"`);

  const doc = new PDFDocument({ size:'A4', margin: 36 });
  doc.pipe(res);

  doc.fontSize(18).text('Analytics & Reporting', { align:'left' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#666').text(`Teacher: ${teacherId}`, { align:'left' });
  doc.moveDown();

  doc.fillColor('#000').fontSize(12).text('Summary', { underline:true });
  doc.moveDown(0.3);
  doc.text(`Average Score: ${summary.avgScore}%`);
  doc.text(`Overall Completion: ${summary.overallCompletion}%`);
  doc.text(`Total Students: ${summary.totalStudents}`);
  doc.moveDown();

  const gd = charts.gradeDistribution;
  doc.fontSize(12).text('Grade Distribution', { underline:true });
  doc.fontSize(10);
  gd.labels.forEach((label, i) => {
    doc.text(`${label}: ${gd.datasets[0].data[i]}`);
  });
  doc.moveDown();

  doc.fontSize(12).text('Student Progress', { underline:true });
  doc.moveDown(0.2);
  doc.fontSize(9).text('Student | ID | Avg | Done/Total | Time (min) | Status');
  doc.moveDown(0.2).moveTo(doc.x, doc.y).lineTo(559, doc.y).stroke();

  (students || []).slice(0, 150).forEach(s => {
    doc.text(`${s.name} | ${s.studentId} | ${s.avgScore}% | ${s.modulesCompleted}/${s.modulesTotal} | ${s.timeOnTaskMin} | ${s.status}`);
  });

  doc.end();
}));

/* ========= STUDENT-SPECIFIC QUIZ ANALYTICS (NEW) =========
   GET /student-quiz-analytics?teacherId=...&student=...&courseId=optional
   Returns per-quiz rows with best%/attempts/lastSubmittedAt for a single student.
=========================================================== */
router.get('/student-quiz-analytics', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const studentKey = String(req.query.student || req.query.studentId || req.query.userId || '').trim();
  const courseIdFilter = req.query.courseId ? String(req.query.courseId) : null;

  if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });
  if (!studentKey) return res.status(400).json({ success:false, message:'student (id/email) is required' });

  // resolve user ref from id/email/username/etc.
  const userRef = await getUserRefByAnyId(studentKey);
  if (!userRef) return res.status(404).json({ success:false, message:'Student not found' });

  // fetch quizzes (optionally filter by courseId), hide future-scheduled (publishAt > now)
  const nowMs = Date.now();
  const quizzesSnap = await firestore.collection('quizzes').orderBy('createdAt', 'desc').get();
  const quizzes = quizzesSnap.docs
    .map(d => ({ id: d.id, ...(d.data() || {}) }))
    .filter(q => {
      if (courseIdFilter && String(q.courseId || '') !== courseIdFilter) return false;
      const pMs = q.publishAt?.toMillis ? q.publishAt.toMillis() : null;
      if (pMs && pMs > nowMs) return false;
      return true;
    });

  const rows = [];
  for (const q of quizzes) {
    const root = userRef.collection('quizAttempts').doc(q.id);

    let attemptsSnap;
    try {
      attemptsSnap = await root.collection('attempts').orderBy('submittedAt', 'asc').get();
    } catch {
      // fallback if index/field missing
      attemptsSnap = await root.collection('attempts').get();
    }

    let attemptsUsed = 0;
    let bestPercent = null;
    let lastSubmittedAt = null;

    attemptsSnap.forEach(doc => {
      attemptsUsed++;
      const a = doc.data() || {};
      const combined =
        (typeof a.percent === 'number' ? a.percent : null) ??
        (typeof a.gradedPercent === 'number' ? a.gradedPercent : null) ??
        (typeof a.autoPercent === 'number' ? a.autoPercent : null);
      if (combined != null && (bestPercent == null || combined > bestPercent)) bestPercent = combined;
      if (a.submittedAt) lastSubmittedAt = a.submittedAt;
    });

    rows.push({
      quizId: q.id,
      title: q.title || q.id,
      courseId: q.courseId || null,
      bestPercent,
      attemptsUsed,
      lastSubmittedAt,
    });
  }

  // summary: average best% across quizzes with a score
  const scored = rows.filter(r => typeof r.bestPercent === 'number');
  const averageQuizScore = scored.length
    ? Math.round(scored.reduce((s, r) => s + r.bestPercent, 0) / scored.length)
    : 0;

  return res.json({
    success: true,
    quizzes: {
      rows,
      labels: rows.map(r => r.title),
      bestPercents: rows.map(r => r.bestPercent ?? 0),
      attempts: rows.map(r => r.attemptsUsed || 0),
    },
    summary: { averageQuizScore }
  });
}));

/* ========= STUDENT ANALYTICS (NEW, normalized assignment percent) =========
   GET /student-analytics?teacherId=...&student=...&courseId=optional
   Returns profile, summary (incl. modules), assignments.grades with percent normalized.
=========================================================== */
router.get('/student-analytics', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const studentKey = String(req.query.student || req.query.studentId || req.query.userId || '').trim();
  const courseIdFilter = req.query.courseId ? String(req.query.courseId) : null;

  if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });
  if (!studentKey) return res.status(400).json({ success:false, message:'student (id/email) is required' });

  const userRef = await getUserRefByAnyId(studentKey);
  if (!userRef) return res.status(404).json({ success:false, message:'Student not found' });

  // Profile
  const userSnap = await userRef.get();
  const u = userSnap.exists ? (userSnap.data() || {}) : {};
  const profile = {
    // Show the human-friendly Student ID (fallback to UID)
    studentId: getStudentIdFromUser(u, userRef.id),
    name: fullNameFromUser(u),
  };

  // ===== Assignments (normalized percent) =====
  let gSnap;
  try {
    gSnap = await userRef.collection('assignmentGrades').orderBy('gradedAt','desc').get();
  } catch {
    gSnap = await userRef.collection('assignmentGrades').get();
  }

  const baseGrades = gSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }))
    .filter(row => (courseIdFilter ? String(row.courseId || '') === courseIdFilter : true));

  // Build map of assignmentId -> maxPoints (for rows missing percent/max)
  const needMax = baseGrades
    .filter(r => (typeof r.percent !== 'number' || !Number.isFinite(r.percent)) )
    .map(r => r.assignmentId || r.id)
    .filter(Boolean);

  const maxByAssignment = new Map();
  for (const ids of chunk(needMax, 10)) {
    if (!ids.length) continue;
    const snap = await firestore.collection('assignments').where('__name__','in', ids).get();
    const found = new Set();
    snap.forEach(doc => {
      const a = doc.data() || {};
      const max = Number.isFinite(a.maxPoints) ? Number(a.maxPoints)
                : (Number.isFinite(a.points) ? Number(a.points) : null);
      maxByAssignment.set(doc.id, max);
      found.add(doc.id);
    });
    ids.forEach(id => { if (!found.has(id)) maxByAssignment.set(id, null); });
  }

  const grades = baseGrades.map(row => {
    const assignmentId = row.assignmentId || row.id;
    const maxPoints = Number.isFinite(row.maxPoints) ? Number(row.maxPoints)
                    : (Number.isFinite(row.points) ? Number(row.points)
                    : maxByAssignment.get(assignmentId));
    const raw = Number(row.grade);
    let percent = Number(row.percent);
    if (!Number.isFinite(percent)) {
      if (Number.isFinite(raw) && Number.isFinite(maxPoints) && maxPoints > 0) {
        percent = (raw / maxPoints) * 100;
      } else if (Number.isFinite(raw) && raw <= 1) {
        percent = raw * 100; // fractional legacy
      } else if (Number.isFinite(raw) && raw <= 100) {
        percent = raw;       // already a percent
      } else {
        percent = 0;
      }
    }
    return {
      assignmentId,
      assignmentTitle: row.assignmentTitle || 'Untitled',
      courseId: row.courseId || null,
      gradedAt: row.gradedAt || null,
      grade: Number.isFinite(raw) ? raw : null,
      maxPoints: Number.isFinite(maxPoints) ? maxPoints : null,
      percent: Math.round(percent * 100) / 100
    };
  });

  const percentVals = grades.map(g => g.percent).filter(p => Number.isFinite(p));
  const averageAssignmentGrade = percentVals.length
    ? Math.round((percentVals.reduce((s, n) => s + n, 0) / percentVals.length) * 100) / 100
    : 0;

  // ===== Modules (completed list + totals) =====
  const cmSnap = await userRef.collection('completedModules').get();
  let completedRaw = cmSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

  if (courseIdFilter) {
    completedRaw = completedRaw.filter(m => String(m.courseId || '') === courseIdFilter);
  }

  const courseIds = Array.from(new Set(completedRaw.map(m => m.courseId).filter(Boolean)));
  const moduleIds = Array.from(new Set(completedRaw.map(m => m.moduleId).filter(Boolean)));

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

  const modulesCompleted = completedRaw.map(m => ({
    courseId: m.courseId || null,
    courseTitle: m.courseTitle || courseTitleById[m.courseId] || null,
    moduleId: m.moduleId || null,
    moduleTitle: m.moduleTitle || moduleTitleById[m.moduleId] || null,
    percent: (typeof m.percent === 'number') ? Math.round(m.percent) : 100,
    completedAt: m.completedAt || null
  }));

  // Compute totalModules:
  // - If courseId filter provided -> count modules in that course only.
  // - Else -> count modules across courses assigned to student's enrolled classes.
  let totalModules = 0;

  if (courseIdFilter) {
    // all modules for this course
    const q = await firestore.collection('modules').where('courseId', '==', courseIdFilter).get();
    totalModules = q.size;
  } else {
    // 1) enrollments (classIds)
    const enrollSnap = await userRef.collection('enrollments').get();
    const classIds = enrollSnap.docs.map(d => d.id);

    // 2) courses for those classes (courses.assignedClasses array-contains-any classId)
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

    // 3) count modules across those courses
    for (const ids of chunk(assignedCourseIds, 10)) {
      if (!ids.length) continue;
      const snap = await firestore.collection('modules').where('courseId', 'in', ids).get();
      totalModules += snap.size;
    }
  }

  // final summary
  const summary = {
    averageQuizScore: null, // UI derives from /student-quiz-analytics
    averageAssignmentGrade,
    modulesCompleted: modulesCompleted.length,
    totalModules
  };

  // Placeholders for essays (unchanged)
  const essays = { submissions: [] };

  return res.json({
    success: true,
    profile,
    summary,
    assignments: { grades: grades.sort((a,b) => (iso(b.gradedAt)||'').localeCompare(iso(a.gradedAt)||'')) },
    essays,
    modules: { completed: modulesCompleted }
  });
}));

/* ========= ASSIGNMENT ANALYTICS ========= */

// JSON
router.get('/assignment-analytics', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

  const data = await buildTeacherAssignmentAnalytics({ teacherId, classId });

  // Enrich with decrypted names and display Student ID
  if (Array.isArray(data.progress)) {
    for (const s of data.progress) {
      if (!s.studentId) continue;
      try {
        const userRef = await getUserRefByAnyId(s.studentId);
        if (!userRef) continue;
        const userSnap = await userRef.get();
        const user = userSnap.data() || {};

        const names = decryptNamesFromUser(user);
        const fullName = [names.firstName, names.middleName, names.lastName]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        if (fullName) s.name = fullName;

        // IMPORTANT: replace internal ID with display Student ID
        s.studentId = getStudentIdFromUser(user, userRef.id);
      } catch {}
    }
  }
  return res.json(data);
}));

// CSV
router.get('/assignment-analytics/csv', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

  const { progress } = await buildTeacherAssignmentAnalytics({ teacherId, classId });

  const rows = [];
  rows.push([
    'Class','Student','Student ID','Avg Quiz Score','Quizzes Taken','On-time %','Modules Completed','Total Modules','Status'
  ]);
  (progress || []).forEach(s => rows.push([
    s.className || '',
    s.name || '',
    s.studentId || '',
    `${s.avgQuizScore ?? ''}`,
    `${s.quizzesTaken ?? ''}`,
    `${s.onTimePct ?? ''}`,
    `${s.modulesCompleted ?? ''}`,
    `${s.totalModules ?? ''}`,
    s.status || '',
  ]));

  const csv = rows.map(r => r.map(v => {
    const val = String(v ?? '');
    return /[",\n]/.test(val) ? `"${val.replace(/"/g,'""')}"` : val;
  }).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="assignment_analytics_${teacherId}.csv"`);
  return res.send(csv);
}));

// PDF
router.get('/assignment-analytics/pdf', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

  const { summary, progress, byAssignment } = await buildTeacherAssignmentAnalytics({ teacherId, classId });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="assignment_analytics_${teacherId}.pdf"`);

  const doc = new PDFDocument({ size:'A4', margin: 36 });
  doc.pipe(res);

  doc.fontSize(18).text('Assignment Analytics Report', { align:'left' });
  doc.moveDown(0.3).fontSize(10).fillColor('#666').text(`Teacher: ${teacherId}`, { align:'left' });
  doc.moveDown();

  doc.fillColor('#000').fontSize(12).text('Summary', { underline:true });
  doc.moveDown(0.3);
  doc.text(`Total Assignments: ${summary.totalAssignments}`);
  doc.text(`Average Assignment Score: ${summary.averageAssignmentScore}%`);
  doc.text(`On-time Submission Rate: ${summary.onTimeRate}%`);
  doc.text(`Modules Completed: ${summary.modulesCompleted}/${summary.totalModules} (${summary.modulesCompletedPct}%)`);
  doc.moveDown();

  doc.fontSize(12).text('By Assignment', { underline:true });
  doc.fontSize(10);
  (byAssignment.labels || []).forEach((label, i) => {
    const avg = byAssignment.avgScores?.[i] ?? 0;
    const subs = byAssignment.submissions?.[i] ?? 0;
    doc.text(`${label}: Avg ${avg}% | Submissions: ${subs}`);
  });
  doc.moveDown();

  doc.fontSize(12).text('Student Progress', { underline:true });
  doc.moveDown(0.2);
  doc.fontSize(9).text('Class | Student | ID | Avg% | Submitted/Total | On-time% | Modules | Status');
  doc.moveDown(0.2).moveTo(doc.x, doc.y).lineTo(559, doc.y).stroke();

  (progress || []).slice(0, 150).forEach(s => {
    const st = `${s.assignmentsSubmitted ?? 0}/${s.totalAssignments ?? 0}`;
    const mods = `${s.modulesCompleted ?? 0}/${s.totalModules ?? 0}`;
    doc.text(`${s.className} | ${s.name} | ${s.studentId} | ${s.avgAssignmentScore}% | ${st} | ${s.onTimePct ?? 0}% | ${mods} | ${s.status}`);
  });

  doc.end();
}));

module.exports = router;
