'use strict';

const { firestore } = require('../config/firebase');

// Helpers
const chunk = (arr, size = 10) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};
const toMillisAny = (x) => {
  if (!x) return null;
  if (typeof x?.toMillis === 'function') return x.toMillis();
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

/* =========================================================
 * QUIZ ANALYTICS
 * =======================================================*/
async function buildTeacherQuizAnalytics({
  teacherId,
  classId = null,
  limitStudents = 500,
  passThreshold = 75,
}) {
  // 1) Classes
  const classesSnap = await firestore
    .collection('classes')
    .where('teacherId', '==', teacherId)
    .orderBy('createdAt', 'desc')
    .get();

  let classes = classesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (classId) classes = classes.filter((c) => c.id === classId);
  const classById = Object.fromEntries(classes.map(c => [c.id, c]));

  // 2) Courses
  const coursesSnap = await firestore
    .collection('courses')
    .where('uploadedBy', '==', teacherId)
    .get();
  const courses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const courseIds = courses.map(c => c.id);

  // class -> courseIds
  const classToCourseIds = {};
  for (const c of courses) {
    (c.assignedClasses || []).forEach(cid => {
      if (classId && cid !== classId) return;
      (classToCourseIds[cid] ||= []).push(c.id);
    });
  }

  // 3) Modules per course
  const modulesByCourseId = {};
  for (let i = 0; i < courseIds.length; i += 10) {
    const batch = courseIds.slice(i, i + 10);
    if (!batch.length) continue;
    const snap = await firestore.collection('modules').where('courseId', 'in', batch).get();
    snap.forEach(d => {
      const m = d.data();
      (modulesByCourseId[m.courseId] ||= []).push({ id: d.id, ...m });
    });
  }

  // 4) Quizzes per course
  const quizzesByCourseId = {};
  const quizById = {};
  for (let i = 0; i < courseIds.length; i += 10) {
    const batch = courseIds.slice(i, i + 10);
    if (!batch.length) continue;
    const snap = await firestore.collection('quizzes').where('courseId', 'in', batch).get();
    snap.forEach(d => {
      const q = { id: d.id, ...d.data() };
      (quizzesByCourseId[q.courseId] ||= []).push(q);
      quizById[q.id] = q;
    });
  }

  // 5) Roster & users
  const rosterByClass = {};
  for (const c of classes) {
    const rSnap = await firestore.collection('classes').doc(c.id).collection('roster').get();
    rosterByClass[c.id] = rSnap.docs.map(r => r.id); // studentId in roster
  }
  const rosterStudentIdsAll = Array.from(new Set(Object.values(rosterByClass).flat()));

  const studentIdToUser = {};
  for (let i = 0; i < rosterStudentIdsAll.length; i += 10) {
    const batch = rosterStudentIdsAll.slice(i, i + 10);
    if (!batch.length) continue;
    const snap = await firestore.collection('users').where('studentId', 'in', batch).get();
    snap.forEach(d => {
      const u = d.data();
      if (u?.studentId) studentIdToUser[u.studentId] = { docId: d.id, data: u };
    });
  }

  const allStudents = rosterStudentIdsAll
    .map(sid => ({ sid, userDocId: studentIdToUser[sid]?.docId, user: studentIdToUser[sid]?.data }))
    .filter(u => !!u.userDocId)
    .slice(0, limitStudents);

  // 6) Per-quiz accumulators (for charting)
  const quizTitleById = {};
  const scoreSumByQuiz = {};      // sum of BEST per-student percent
  const scoreCountByQuiz = {};    // number of students who attempted that quiz
  const attemptsCountByQuiz = {}; // raw attempts count (for attempts chart)

  const rows = [];
  let grandModulesCompleted = 0;
  let grandModulesTotal = 0;
  let passCount = 0;

  for (const s of allStudents) {
    const u = s.user || {};
    const name =
      (u.fullName && u.fullName.trim()) ||
      `${u.firstName || ''} ${u.lastName || ''}`.trim() ||
      u.username ||
      'Student';

    const myClassIds = classes.filter(c => (rosterByClass[c.id] || []).includes(s.sid)).map(c => c.id);
    const className = myClassIds.length
      ? (classById[myClassIds[0]]?.name ||
         `${classById[myClassIds[0]]?.gradeLevel || ''}${classById[myClassIds[0]]?.section ? '-' + classById[myClassIds[0]]?.section : ''}`.trim() ||
         'Class')
      : '—';

    const myCourseIds = Array.from(new Set(myClassIds.flatMap(cid => classToCourseIds[cid] || [])));

    // modules summary
    const modulesTotal = myCourseIds.reduce((acc, cid) => acc + (modulesByCourseId[cid]?.length || 0), 0);
    let modulesCompleted = 0;
    if (myCourseIds.length) {
      for (let i = 0; i < myCourseIds.length; i += 10) {
        const batch = myCourseIds.slice(i, i + 10);
        const snap = await firestore
          .collection('users').doc(s.userDocId)
          .collection('completedModules')
          .where('courseId', 'in', batch)
          .get();
        modulesCompleted += snap.size;
      }
    }
    grandModulesCompleted += modulesCompleted;
    grandModulesTotal += modulesTotal;

    const myQuizzes = myCourseIds.flatMap(cid => quizzesByCourseId[cid] || []);
    const myQuizIds = myQuizzes.map(q => q.id);
    myQuizzes.forEach(q => { quizTitleById[q.id] = q.title || `Quiz ${q.id.slice(0, 6)}`; });

    let quizzesTaken = 0;
    let quizzesWithDue = 0;
    let onTimeHits = 0; // count **per quiz**, not per attempt!

    // collect BEST percent per quiz for this student
    const bestPercents = [];

    const QUIZ_LIMIT_PER_STUDENT = 50;
    for (let i = 0; i < Math.min(myQuizIds.length, QUIZ_LIMIT_PER_STUDENT); i += 10) {
      const batch = myQuizIds.slice(i, i + 10);
      for (const qid of batch) {
        const attemptsSnap = await firestore
          .collection('users').doc(s.userDocId)
          .collection('quizAttempts').doc(qid)
          .collection('attempts')
          .get();

        const attempts = attemptsSnap.docs.map(a => a.data());
        if (!attempts.length) continue;

        quizzesTaken += 1;
        attemptsCountByQuiz[qid] = (attemptsCountByQuiz[qid] || 0) + attempts.length;

        const q = quizById[qid] || {};
        const dueMs = toMillisAny(q.dueAt) ?? toMillisAny(q.closeAt) ?? null;
        if (dueMs) quizzesWithDue += 1;

        // compute BEST combined percent among attempts for this quiz
        let bestForQuiz = -1;
        let onTimeForThisQuiz = false; // <-- NEW: track per-quiz

        attempts.forEach(a => {
          // prefer gradedPercent, then a.percent, then autoPercent
          const autoPercent =
            (typeof a.autoPercent === 'number') ? a.autoPercent :
            (typeof a.autoScore === 'number' && typeof a.autoTotal === 'number' && a.autoTotal > 0
              ? Math.round((a.autoScore / a.autoTotal) * 100) : null);

          const gradedPercent =
            (typeof a.gradedPercent === 'number') ? a.gradedPercent :
            (typeof a.gradedScore === 'number' && typeof a.gradedTotal === 'number' && a.gradedTotal > 0
              ? Math.round((a.gradedScore / a.gradedTotal) * 100) : null);

          const combined = (typeof a.percent === 'number') ? a.percent :
                           (gradedPercent != null ? gradedPercent : autoPercent);

          if (combined != null && combined > bestForQuiz) bestForQuiz = combined;

          const submittedMs = toMillisAny(a.submittedAt) ?? toMillisAny(a.completedAt) ?? null;
          if (dueMs && submittedMs && submittedMs <= dueMs) {
            onTimeForThisQuiz = true; // mark once
          }
        });

        // <-- NEW: count at most once per quiz
        if (dueMs && onTimeForThisQuiz) onTimeHits += 1;

        if (bestForQuiz >= 0) {
          bestPercents.push(bestForQuiz);
          // contribute **once** per student to the by-quiz average
          scoreSumByQuiz[qid]   = (scoreSumByQuiz[qid] || 0) + bestForQuiz;
          scoreCountByQuiz[qid] = (scoreCountByQuiz[qid] || 0) + 1;
        }
      }
    }

    const avgQuizScore = bestPercents.length
      ? Math.round(bestPercents.reduce((a, b) => a + b, 0) / bestPercents.length)
      : 0;

    // clamp to [0..100] to be safe
    const onTimePct = quizzesWithDue
      ? Math.min(100, Math.max(0, Math.round((onTimeHits / quizzesWithDue) * 100)))
      : 0;

    const completionPct = modulesTotal ? Math.round((modulesCompleted / modulesTotal) * 100) : 0;
    const atRisk = avgQuizScore < passThreshold || completionPct < 50;
    if (avgQuizScore >= passThreshold) passCount += 1;

    rows.push({
      className,
      name,
      studentId: u.studentId || s.sid,
      avgQuizScore,
      quizzesTaken,
      totalQuizzes: myQuizIds.length,
      onTimePct,
      modulesCompleted,
      totalModules: modulesTotal,
      timeOnTaskMin: null,
      status: atRisk ? 'At Risk' : 'On Track',
    });
  }

  // 7) Build byQuiz arrays from BEST-of per student
  const quizIdsAll = Array.from(new Set([
    ...Object.keys(scoreSumByQuiz),
    ...Object.keys(scoreCountByQuiz),
    ...Object.keys(attemptsCountByQuiz),
  ]));

  const labeled = quizIdsAll.map(qid => ({
    qid, title: quizTitleById[qid] || `Quiz ${qid.slice(0, 6)}`
  })).sort((a, b) => a.title.localeCompare(b.title));

  const labels = labeled.map(x => x.title);
  const order  = labeled.map(x => x.qid);
  const avgScores = order.map(qid => {
    const sum = scoreSumByQuiz[qid] || 0;
    const cnt = scoreCountByQuiz[qid] || 0;
    return cnt ? Math.round(sum / cnt) : 0;
  });
  const attempts = order.map(qid => attemptsCountByQuiz[qid] || 0);

  // 8) Summary
  const totalQuizzes = labels.length;
  const averageQuizScore = rows.length
    ? Math.round(rows.reduce((a, r) => a + (r.avgQuizScore || 0), 0) / rows.length)
    : 0;
  const passRate = rows.length ? Math.round((passCount / rows.length) * 100) : 0;
  const modulesCompletedPct = grandModulesTotal
    ? Math.round((grandModulesCompleted / grandModulesTotal) * 100)
    : 0;

  return {
    byQuiz: { labels, avgScores, attempts },
    summary: {
      totalQuizzes,
      averageQuizScore,
      passRate,
      modulesCompleted: grandModulesCompleted,
      totalModules: grandModulesTotal,
      modulesCompletedPct,
    },
    progress: rows.sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name)),
  };
}

/* =========================================================
 * LEGACY (kept, unchanged)
 * =======================================================*/
async function buildTeacherAnalytics({ teacherId, classId = null, limitStudents = 500 }) {
  // ... your legacy code unchanged ...
  // (left exactly as in your current file)
  const classesSnap = await firestore
    .collection('classes')
    .where('teacherId', '==', teacherId)
    .orderBy('createdAt', 'desc')
    .get();

  let classes = classesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (classId) classes = classes.filter((c) => c.id === classId);

  const coursesSnap = await firestore.collection('courses').where('uploadedBy', '==', teacherId).get();
  const courses = coursesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const courseIds = courses.map((c) => c.id);

  const classToCourseIds = {};
  for (const c of courses) {
    (c.assignedClasses || []).forEach((cid) => {
      if (classId && cid !== classId) return;
      (classToCourseIds[cid] ||= []).push(c.id);
    });
  }

  const modulesByCourseId = {};
  for (let i = 0; i < courseIds.length; i += 10) {
    const snap = await firestore.collection('modules').where('courseId', 'in', courseIds.slice(i, i + 10)).get();
    snap.forEach((d) => {
      const m = d.data();
      (modulesByCourseId[m.courseId] ||= []).push({ id: d.id, ...m });
    });
  }

  const quizzesByCourseId = {};
  for (let i = 0; i < courseIds.length; i += 10) {
    const snap = await firestore.collection('quizzes').where('courseId', 'in', courseIds.slice(i, i + 10)).get();
    snap.forEach((d) => {
      const q = { id: d.id, ...d.data() };
      (quizzesByCourseId[q.courseId] ||= []).push(q);
    });
  }

  const rosterByClass = {};
  let totalStudents = 0;
  for (const c of classes) {
    const rSnap = await firestore.collection('classes').doc(c.id).collection('roster').get();
    rosterByClass[c.id] = rSnap.docs.map((r) => r.id);
    totalStudents += typeof c.students === 'number' ? c.students : rSnap.size;
  }
  const rosterStudentIdsAll = Array.from(new Set(Object.values(rosterByClass).flat()));

  const studentIdToUser = {};
  for (let i = 0; i < rosterStudentIdsAll.length; i += 10) {
    const snap = await firestore.collection('users').where('studentId', 'in', rosterStudentIdsAll.slice(i, i + 10)).get();
    snap.forEach((d) => {
      const u = d.data();
      if (u?.studentId) studentIdToUser[u.studentId] = { docId: d.id, data: u };
    });
  }

  const allStudents = rosterStudentIdsAll
    .map((sid) => ({ sid, userDocId: studentIdToUser[sid]?.docId, user: studentIdToUser[sid]?.data }))
    .filter((u) => !!u.userDocId)
    .slice(0, limitStudents);

  const buckets = [0, 0, 0, 0, 0];
  const bump = (pct) => {
    if (pct == null || Number.isNaN(pct)) return;
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    if (v < 60) buckets[0]++;
    else if (v < 70) buckets[1]++;
    else if (v < 80) buckets[2]++;
    else if (v < 90) buckets[3]++;
    else buckets[4]++;
  };

  const studentsOut = [];
  for (const s of allStudents) {
    const u = s.user || {};
    const name =
      (u.fullName && u.fullName.trim()) ||
      `${u.firstName || ''} ${u.lastName || ''}`.trim() ||
      u.username ||
      'Student';

    const myClassIds = classes.filter((c) => (rosterByClass[c.id] || []).includes(s.sid)).map((c) => c.id);
    const myCourseIds = Array.from(new Set(myClassIds.flatMap((cid) => classToCourseIds[cid] || [])));

    const modulesTotal = myCourseIds.reduce((acc, cid) => acc + (modulesByCourseId[cid]?.length || 0), 0);

    let modulesCompleted = 0;
    if (myCourseIds.length) {
      for (let i = 0; i < myCourseIds.length; i += 10) {
        const snap = await firestore
          .collection('users')
          .doc(s.userDocId)
          .collection('completedModules')
          .where('courseId', 'in', myCourseIds.slice(i, i + 10))
          .get();
        modulesCompleted += snap.size;
      }
    }

    const avgScore =
      typeof u.averageQuizScore === 'number'
        ? u.averageQuizScore
        : typeof u.averageAssignmentGrade === 'number'
        ? u.averageAssignmentGrade
        : 0;

    bump(avgScore);

    let secs = 0,
      cnt = 0;
    const myQuizIds = myCourseIds
      .flatMap((cid) => (quizzesByCourseId[cid] || []))
      .map((q) => q.id)
      .slice(0, 12);

    for (const qid of myQuizIds) {
      const attemptsSnap = await firestore
        .collection('users')
        .doc(s.userDocId)
        .collection('quizAttempts')
        .doc(qid)
        .collection('attempts')
        .get();
      attemptsSnap.forEach((a) => {
        const t = a.data()?.timeTakenSeconds;
        if (typeof t === 'number' && t > 0) {
          secs += t;
          cnt += 1;
        }
      });
    }
    const timeOnTaskMin = Math.round((cnt ? secs / cnt : 0) / 60);

    const completionPct = modulesTotal ? Math.round((modulesCompleted / modulesTotal) * 100) : 0;
    const atRisk = avgScore < 75 || completionPct < 50;

    studentsOut.push({
      studentId: u.studentId || s.sid,
      userId: s.userDocId,
      name,
      avgScore,
      modulesCompleted,
      modulesTotal,
      timeOnTaskMin,
      status: atRisk ? 'At Risk' : 'On Track',
    });
  }

  const nonZeroScores = studentsOut.map((s) => s.avgScore).filter((n) => typeof n === 'number');
  const avgScoreOverall = nonZeroScores.length
    ? Math.round(nonZeroScores.reduce((a, b) => a + b, 0) / nonZeroScores.length)
    : 0;

  const totCompleted = studentsOut.reduce((a, s) => a + s.modulesCompleted, 0);
  const totAvailable = studentsOut.reduce((a, s) => a + s.modulesTotal, 0);
  const completionOverall = totAvailable ? Math.round((totCompleted / totAvailable) * 100) : 0;

  const completionRateLabels = [];
  const completionRateData = [];
  for (const c of classes) {
    const roster = rosterByClass[c.id] || [];
    const myCourses = classToCourseIds[c.id] || [];
    let completedCount = 0;

    for (const sid of roster) {
      const udoc = studentIdToUser[sid];
      if (!udoc) continue;
      let has = false;
      for (let i = 0; i < myCourses.length; i += 10) {
        const snap = await firestore
          .collection('users').doc(udoc.docId)
          .collection('completedModules')
          .where('courseId', 'in', myCourses.slice(i, i + 10))
          .limit(1)
          .get();
        if (!snap.empty) { has = true; break; }
      }
      if (has) completedCount += 1;
    }
    completionRateLabels.push(
      c.name || `${c.gradeLevel || ''}${c.section ? '-' + c.section : ''}`.trim() || 'Class'
    );
    completionRateData.push(roster.length ? Math.round((completedCount / roster.length) * 100) : 0);
  }

  return {
    summary: { avgScore: avgScoreOverall, overallCompletion: completionOverall, totalStudents },
    charts: {
      gradeDistribution: {
        labels: ['0-59', '60-69', '70-79', '80-89', '90-100'],
        datasets: [{ label: 'Students', data: buckets }],
      },
      completionRate: {
        labels: completionRateLabels,
        datasets: [{ label: '% Completion', data: completionRateData }],
      },
    },
    students: studentsOut.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/* =========================================================
 * ASSIGNMENT ANALYTICS
 * =======================================================*/
async function buildTeacherAssignmentAnalytics({
  teacherId,
  classId = null,
  limitStudents = 500,
  passThreshold = 75,
}) {
  // ... your original function body unchanged except the final onTimePct clamp ...
  // (keeping your logic; only minor edits shown)

  // 1) Classes
  const classesSnap = await firestore
    .collection('classes')
    .where('teacherId', '==', teacherId)
    .orderBy('createdAt', 'desc')
    .get();

  let classes = classesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (classId) classes = classes.filter(c => c.id === classId);
  const classById = Object.fromEntries(classes.map(c => [c.id, c]));

  // 2) Courses
  const coursesSnap = await firestore.collection('courses').where('uploadedBy', '==', teacherId).get();
  const courses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const courseIds = courses.map(c => c.id);

  // class -> courseIds
  const classToCourseIds = {};
  for (const c of courses) {
    (c.assignedClasses || []).forEach(cid => {
      if (classId && cid !== classId) return;
      (classToCourseIds[cid] ||= []).push(c.id);
    });
  }

  // 3) Modules per course
  const modulesByCourseId = {};
  for (let i = 0; i < courseIds.length; i += 10) {
    const batch = courseIds.slice(i, i + 10);
    if (!batch.length) continue;
    const snap = await firestore.collection('modules').where('courseId', 'in', batch).get();
    snap.forEach(d => {
      const m = d.data();
      (modulesByCourseId[m.courseId] ||= []).push({ id: d.id, ...m });
    });
  }

  // 4) Assignments (top-level + course subcollection)
  const assignmentsByCourseId = {};
  const assignmentById = {};
  if (courseIds.length) {
    for (let i = 0; i < courseIds.length; i += 10) {
      const batch = courseIds.slice(i, i + 10);
      const snap = await firestore.collection('assignments').where('courseId', 'in', batch).get();
      snap.forEach(d => {
        const a = { id: d.id, ...d.data() };
        (assignmentsByCourseId[a.courseId] ||= []).push(a);
        assignmentById[a.id] = a;
      });
    }
  }
  for (const cid of courseIds) {
    const subSnap = await firestore.collection('courses').doc(cid).collection('assignments').get();
    subSnap.forEach(d => {
      const a = { id: d.id, courseId: cid, ...d.data() };
      (assignmentsByCourseId[cid] ||= []).push(a);
      assignmentById[a.id] = a;
    });
  }

  // 5) Roster & users
  const rosterByClass = {};
  for (const c of classes) {
    const rSnap = await firestore.collection('classes').doc(c.id).collection('roster').get();
    rosterByClass[c.id] = rSnap.docs.map(r => r.id);
  }
  const rosterStudentIdsAll = Array.from(new Set(Object.values(rosterByClass).flat()));

  const studentIdToUser = {};
  for (let i = 0; i < rosterStudentIdsAll.length; i += 10) {
    const batch = rosterStudentIdsAll.slice(i, i + 10);
    if (!batch.length) continue;
    const snap = await firestore.collection('users').where('studentId', 'in', batch).get();
    snap.forEach(d => {
      const u = d.data();
      if (u?.studentId) studentIdToUser[u.studentId] = { docId: d.id, data: u };
    });
  }

  const allStudents = rosterStudentIdsAll
    .map(sid => ({ sid, userDocId: studentIdToUser[sid]?.docId, user: studentIdToUser[sid]?.data }))
    .filter(u => !!u.userDocId)
    .slice(0, limitStudents);

  // Accumulators for charts
  const assignmentTitleById = {};
  const scoreSumByAsg = {};
  const scoreCountByAsg = {};
  const submissionsCountByAsg = {};
  const onTimeCountByAsg = {};

  const rows = [];
  let grandModulesCompleted = 0;
  let grandModulesTotal = 0;

  const toMillis = (x) =>
    (x?.toMillis?.() ? x.toMillis() :
      (typeof x === 'number' ? x :
        (Number.isFinite(Date.parse(x)) ? Date.parse(x) : null)));

  function normalizeToPercent({ grade, score, points }) {
    const pts = (typeof points === 'number' && points > 0) ? points : null;
    if (typeof grade === 'number') {
      return pts ? Math.round((grade / pts) * 100) : Math.round(grade);
    }
    if (typeof score === 'number') {
      return pts ? Math.round((score / pts) * 100) : Math.round(score);
    }
    return null;
  }

  for (const s of allStudents) {
    const u = s.user || {};
    const name = (u.fullName && u.fullName.trim())
      ? u.fullName.trim()
      : `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || 'Student';

    const myClassIds = classes.filter(c => (rosterByClass[c.id] || []).includes(s.sid)).map(c => c.id);
    const className = myClassIds.length
      ? (classById[myClassIds[0]]?.name ||
         `${classById[myClassIds[0]]?.gradeLevel || ''}${classById[myClassIds[0]]?.section ? '-' + classById[myClassIds[0]]?.section : ''}`.trim() ||
         'Class')
      : '—';

    const myCourseIds = Array.from(new Set(myClassIds.flatMap(cid => classToCourseIds[cid] || [])));

    // module summary
    const modulesTotal = myCourseIds.reduce((acc, cid) => acc + (modulesByCourseId[cid]?.length || 0), 0);
    let modulesCompleted = 0;
    if (myCourseIds.length) {
      for (let i = 0; i < myCourseIds.length; i += 10) {
        const batch = myCourseIds.slice(i, i + 10);
        const snap = await firestore
          .collection('users').doc(s.userDocId)
          .collection('completedModules')
          .where('courseId', 'in', batch)
          .get();
        modulesCompleted += snap.size;
      }
    }
    grandModulesCompleted += modulesCompleted;
    grandModulesTotal += modulesTotal;

    const myAssignments = myCourseIds.flatMap(cid => assignmentsByCourseId[cid] || []);
    myAssignments.forEach(a => { assignmentTitleById[a.id] = a.title || `Assignment ${a.id.slice(0, 6)}`; });

    let totalPercentSum = 0;
    let totalPercentCnt = 0;
    let assignmentsSubmitted = 0;
    let onTimeSubmissions = 0;

    const ASSIGN_LIMIT_PER_STUDENT = 200;
    for (let i = 0; i < Math.min(myAssignments.length, ASSIGN_LIMIT_PER_STUDENT); i++) {
      const asg = myAssignments[i];
      const asgId = asg.id;
      const asgPts = (typeof asg.points === 'number') ? asg.points : null;

      // submission lookup
      let subSnap = await firestore
        .collection('assignments').doc(asgId)
        .collection('submissions').doc(s.sid)
        .get();
      if (!subSnap.exists && s.userDocId) {
        subSnap = await firestore
          .collection('assignments').doc(asgId)
          .collection('submissions').doc(s.userDocId)
          .get();
      }

      let sub = subSnap.exists ? subSnap.data() : null;

      if (!sub && s.userDocId) {
        const gradeDoc = await firestore
          .collection('users').doc(s.userDocId)
          .collection('assignmentGrades').doc(asgId)
          .get();
        if (gradeDoc.exists) {
          const g = gradeDoc.data();
          sub = {
            grade: typeof g.grade === 'number' ? g.grade : null,
            submittedAt: g.submittedAt || g.gradedAt || null
          };
        }
      }

      if (!sub) continue;

      assignmentsSubmitted += 1;
      submissionsCountByAsg[asgId] = (submissionsCountByAsg[asgId] || 0) + 1;

      const percent = normalizeToPercent({
        grade: sub.grade,
        score: sub.score,
        points: asgPts
      });

      if (percent != null) {
        scoreSumByAsg[asgId] = (scoreSumByAsg[asgId] || 0) + percent;
        scoreCountByAsg[asgId] = (scoreCountByAsg[asgId] || 0) + 1;
        totalPercentSum += percent;
        totalPercentCnt += 1;
      }

      const dueMs = toMillis(asg.dueAt);
      const subMs  = toMillis(sub.submittedAt);
      if (dueMs && subMs && subMs <= dueMs) {
        onTimeCountByAsg[asgId] = (onTimeCountByAsg[asgId] || 0) + 1;
        onTimeSubmissions += 1;
      }
    }

    const avgAssignmentScore = totalPercentCnt ? Math.round(totalPercentSum / totalPercentCnt) : 0;

    // clamp to [0..100] to be safe
    const onTimePct = assignmentsSubmitted
      ? Math.min(100, Math.max(0, Math.round((onTimeSubmissions / assignmentsSubmitted) * 100)))
      : 0;

    const completionPct = modulesTotal ? Math.round((modulesCompleted / modulesTotal) * 100) : 0;
    const atRisk = avgAssignmentScore < passThreshold || completionPct < 50;

    rows.push({
      className,
      name,
      studentId: u.studentId || s.sid,
      avgAssignmentScore,
      assignmentsSubmitted,
      totalAssignments: myAssignments.length,
      onTimePct,
      modulesCompleted,
      totalModules: modulesTotal,
      timeOnTaskMin: null,
      status: atRisk ? 'At Risk' : 'On Track',
    });
  }

  // Build series
  const asgIdsAll = Array.from(new Set([
    ...Object.keys(scoreSumByAsg),
    ...Object.keys(scoreCountByAsg),
    ...Object.keys(submissionsCountByAsg),
  ]));

  const labeled = asgIdsAll.map(id => ({
    id,
    title: assignmentTitleById[id] || `Assignment ${id.slice(0, 6)}`
  })).sort((a, b) => a.title.localeCompare(b.title));

  const labels = labeled.map(x => x.title);
  const order  = labeled.map(x => x.id);
  const avgScores   = order.map(id => {
    const sum = scoreSumByAsg[id] || 0;
    const cnt = scoreCountByAsg[id] || 0;
    return cnt ? Math.round(sum / cnt) : 0;
  });
  const submissions = order.map(id => submissionsCountByAsg[id] || 0);

  if (!labels.length) { labels.push('No assignments'); avgScores.push(0); submissions.push(0); }

  // Summary
  const averageAssignmentScore = rows.length
    ? Math.round(rows.reduce((a, r) => a + (r.avgAssignmentScore || 0), 0) / rows.length)
    : 0;

  const totalAssignments = labels.length;
  const onTimeRate = rows.length
    ? Math.round(rows.reduce((a, r) => a + (r.onTimePct || 0), 0) / rows.length)
    : 0;

  const modulesCompletedPct = grandModulesTotal
    ? Math.round((grandModulesCompleted / grandModulesTotal) * 100)
    : 0;

  return {
    byAssignment: { labels, avgScores, submissions },
    summary: {
      totalAssignments,
      averageAssignmentScore,
      onTimeRate,
      modulesCompleted: grandModulesCompleted,
      totalModules: grandModulesTotal,
      modulesCompletedPct,
    },
    progress: rows.sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name)),
  };
}

module.exports = {
  buildTeacherAnalytics,            // legacy
  buildTeacherQuizAnalytics,        // quizzes
  buildTeacherAssignmentAnalytics,  // assignments
};
