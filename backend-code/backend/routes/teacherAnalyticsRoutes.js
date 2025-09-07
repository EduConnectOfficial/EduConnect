// backend/routes/teacherAnalyticsRoutes.js
const router = require('express').Router();
const { firestore } = require('../config/firebase');
const PDFDocument = require('pdfkit');
const { asyncHandler } = require('../middleware/asyncHandler');

// Import from utils (single source)
const {
  buildTeacherAnalytics,             // legacy
  buildTeacherQuizAnalytics,         // new quizzes
  buildTeacherAssignmentAnalytics,   // new assignments
} = require('../utils/analyticsUtils');

// Decrypt helper for user docs
const { decryptField } = require('../utils/fieldCrypto');
const { getUserRefByAnyId } = require('../utils/idUtils');

function decryptNamesFromUser(u = {}) {
  return {
    firstName: decryptField(u.firstNameEnc || ''),
    middleName: decryptField(u.middleNameEnc || ''),
    lastName: decryptField(u.lastNameEnc || ''),
  };
}

// (Optional) sanity log
console.log('[analytics fns]', {
  legacy: !!buildTeacherAnalytics,
  quiz: !!buildTeacherQuizAnalytics,
  assignment: !!buildTeacherAssignmentAnalytics,
});

/* ========= QUIZ ANALYTICS ========= */

// JSON
router.get('/quiz-analytics', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });

  const data = await buildTeacherQuizAnalytics({ teacherId, classId });

  // Decrypt student names if possible
  if (Array.isArray(data.progress)) {
    for (const s of data.progress) {
      if (s.studentId) {
        try {
          const userRef = await getUserRefByAnyId(s.studentId);
          if (userRef) {
            const userSnap = await userRef.get();
            const user = userSnap.data() || {};
            const names = decryptNamesFromUser(user);
            const fullName = [names.firstName, names.middleName, names.lastName]
              .filter(Boolean)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (fullName) s.name = fullName;
          }
        } catch {}
      }
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

  // optional summary block at top (comment out if you don’t want it in CSV)
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

  progress.forEach(s => rows.push([
    s.className || '',
    s.name || '',
    s.studentId || '',
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

  progress.slice(0, 150).forEach(s => {
    const qt = `${s.quizzesTaken ?? 0}/${s.totalQuizzes ?? 0}`;
    const mods = `${s.modulesCompleted ?? 0}/${s.totalModules ?? 0}`;
    doc.text(`${s.className} | ${s.name} | ${s.studentId} | ${s.avgQuizScore}% | ${qt} | ${s.onTimePct ?? 0}% | ${mods} | ${s.status}`);
  });

  doc.end();
}));

/* ========= ASSIGNMENT ANALYTICS: CSV ========= */
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

  progress.forEach(s => rows.push([
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

/* ========= ASSIGNMENT ANALYTICS: PDF ========= */
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
  doc.moveDown(0.3).fontSize(10).fillColor('#666')
    .text(`Teacher: ${teacherId}${classId ? ' | Class: ' + classId : ''}`, { align:'left' });
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

  progress.slice(0, 150).forEach(s => {
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
  students.forEach(s => rows.push([
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

  students.slice(0, 150).forEach(s => {
    doc.text(`${s.name} | ${s.studentId} | ${s.avgScore}% | ${s.modulesCompleted}/${s.modulesTotal} | ${s.timeOnTaskMin} | ${s.status}`);
  });

  doc.end();
}));

/* ========= ASSIGNMENT ANALYTICS ========= */

// JSON
router.get('/assignment-analytics', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  const classId = req.query.classId ? String(req.query.classId) : null;
  if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

  const data = await buildTeacherAssignmentAnalytics({ teacherId, classId });

  // Decrypt student names if possible
  if (Array.isArray(data.progress)) {
    for (const s of data.progress) {
      if (s.studentId) {
        try {
          const userRef = await getUserRefByAnyId(s.studentId);
          if (userRef) {
            const userSnap = await userRef.get();
            const user = userSnap.data() || {};
            const names = decryptNamesFromUser(user);
            const fullName = [names.firstName, names.middleName, names.lastName]
              .filter(Boolean)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (fullName) s.name = fullName;
          }
        } catch {}
      }
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
progress.forEach(s => rows.push([
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
  doc.fontSize(9).text('Class | Student | ID | Avg | Submitted | On-time% | Modules | Status');
  doc.moveDown(0.2).moveTo(doc.x, doc.y).lineTo(559, doc.y).stroke();

  progress.slice(0, 150).forEach(s => {
    doc.text(`${s.className} | ${s.name} | ${s.studentId} | ${s.avgAssignmentScore}% | ${s.assignmentsSubmitted} | ${s.onTimePct}% | ${s.modulesCompleted}/${s.totalModules} | ${s.status}`);
  });

  doc.end();
}));

module.exports = router;
