// ==== services/analytics.service.js ==== //
const { firestore } = require('../config/firebase');

function chunk(arr, size = 10) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * NEW: Quiz Analytics payload to match your final HTML
 * @param {{ teacherId: string, classId?: string|null, limitStudents?: number, passThreshold?: number }} params
 */
async function buildTeacherQuizAnalytics({
  teacherId,
  classId = null,
  limitStudents = 500,
  passThreshold = 75,
}) {
  // 1) Classes taught by teacher
  const classesSnap = await firestore
    .collection('classes')
    .where('teacherId', '==', teacherId)
    .orderBy('createdAt', 'desc')
    .get();

  let classes = classesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (classId) classes = classes.filter((c) => c.id === classId);

  const classById = Object.fromEntries(
    classes.map((c) => [c.id, c])
  );

  // 2) Courses uploaded by teacher
  const coursesSnap = await firestore
    .collection('courses')
    .where('uploadedBy', '==', teacherId)
    .get();
  const courses = coursesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const courseIds = courses.map((c) => c.id);

  // 3) Map: classId -> courseIds assigned
  const classToCourseIds = {};
  for (const c of courses) {
    (c.assignedClasses || []).forEach((cid) => {
      if (classId && cid !== classId) return;
      (classToCourseIds[cid] ||= []).push(c.id);
    });
  }

  // 4) Modules per course
  const modulesByCourseId = {};
  for (const batch of chunk(courseIds, 10)) {
    if (!batch.length) continue;
    const snap = await firestore.collection('modules').where('courseId', 'in', batch).get();
    snap.forEach((d) => {
      const m = d.data();
      (modulesByCourseId[m.courseId] ||= []).push({ id: d.id, ...m });
    });
  }

  // 5) Quizzes per course
  const quizzesByCourseId = {};
  for (const batch of chunk(courseIds, 10)) {
    if (!batch.length) continue;
    const snap = await firestore.collection('quizzes').where('courseId', 'in', batch).get();
    snap.forEach((d) => {
      const q = { id: d.id, ...d.data() };
      (quizzesByCourseId[q.courseId] ||= []).push(q);
    });
  }

  // 6) Roster & users
  const rosterByClass = {};
  for (const c of classes) {
    const rSnap = await firestore.collection('classes').doc(c.id).collection('roster').get();
    rosterByClass[c.id] = rSnap.docs.map((r) => r.id); // studentId is doc id
  }
  const rosterStudentIdsAll = Array.from(new Set(Object.values(rosterByClass).flat()));

  // Users lookup (users where "studentId" in roster)
  const studentIdToUser = {};
  for (const batch of chunk(rosterStudentIdsAll, 10)) {
    if (!batch.length) continue;
    const snap = await firestore.collection('users').where('studentId', 'in', batch).get();
    snap.forEach((d) => {
      const u = d.data();
      if (u?.studentId) studentIdToUser[u.studentId] = { docId: d.id, data: u };
    });
  }

  // Build student list (cap limit)
  const allStudents = rosterStudentIdsAll
    .map((sid) => ({ sid, userDocId: studentIdToUser[sid]?.docId, user: studentIdToUser[sid]?.data }))
    .filter((u) => !!u.userDocId)
    .slice(0, limitStudents);

  // 7) Per-quiz accumulators for charts
  const quizTitleById = {};
  const scoreSumByQuiz = {};
  const scoreCountByQuiz = {};
  const attemptsCountByQuiz = {};

  // 8) Build progress rows
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

    // Which class(es) this student is in (from selected classes)
    const myClassIds = classes.filter((c) => (rosterByClass[c.id] || []).includes(s.sid)).map((c) => c.id);

    // Choose a display class name (first match if multiple; you can change to join(', '))
    const className = myClassIds.length
      ? (classById[myClassIds[0]]?.name ||
         `${classById[myClassIds[0]]?.gradeLevel || ''}${classById[myClassIds[0]]?.section ? '-' + classById[myClassIds[0]]?.section : ''}`.trim() ||
         'Class')
      : '—';

    // Courses & modules
    const myCourseIds = Array.from(new Set(myClassIds.flatMap((cid) => classToCourseIds[cid] || [])));
    const modulesTotal = myCourseIds.reduce((acc, cid) => acc + (modulesByCourseId[cid]?.length || 0), 0);
    let modulesCompleted = 0;

    if (myCourseIds.length) {
      for (const batch of chunk(myCourseIds, 10)) {
        const snap = await firestore
          .collection('users')
          .doc(s.userDocId)
          .collection('completedModules')
          .where('courseId', 'in', batch)
          .get();
        modulesCompleted += snap.size;
      }
    }

    grandModulesCompleted += modulesCompleted;
    grandModulesTotal += modulesTotal;

    // Quizzes for these courses
    const myQuizzes = myCourseIds.flatMap((cid) => quizzesByCourseId[cid] || []);
    const myQuizIds = myQuizzes.map((q) => q.id);

    // Attempt stats for the student
    let totalScoreSum = 0;
    let totalScoreCnt = 0;
    let quizzesTaken = 0;

    // Pull attempts for up to N quizzes per student (protect from explosion)
    for (const q of myQuizzes) {
      quizTitleById[q.id] = q.title || `Quiz ${q.id.slice(0, 6)}`;
    }
    // Reasonable ceiling per student
    const QUIZ_LIMIT_PER_STUDENT = 50;
    for (const batch of chunk(myQuizIds.slice(0, QUIZ_LIMIT_PER_STUDENT), 10)) {
      if (!batch.length) continue;
      // For each quizId, we need attempts subcollection
      for (const qid of batch) {
        const attemptsSnap = await firestore
          .collection('users')
          .doc(s.userDocId)
          .collection('quizAttempts')
          .doc(qid)
          .collection('attempts')
          .get();

        const attempts = attemptsSnap.docs.map((a) => a.data());
        if (attempts.length) quizzesTaken += 1;

        // per-quiz aggregation (for charts)
        attemptsCountByQuiz[qid] = (attemptsCountByQuiz[qid] || 0) + attempts.length;

        for (const a of attempts) {
          if (typeof a.score === 'number') {
            scoreSumByQuiz[qid] = (scoreSumByQuiz[qid] || 0) + a.score;
            scoreCountByQuiz[qid] = (scoreCountByQuiz[qid] || 0) + 1;

            totalScoreSum += a.score;
            totalScoreCnt += 1;
          }
        }
      }
    }

    // Average quiz score for this student
    const avgQuizScore = totalScoreCnt ? Math.round(totalScoreSum / totalScoreCnt) : 0;

    // Time on task: mean seconds across all attempts (same approach you used)
    let secs = 0, cnt = 0;
    for (const batch of chunk(myQuizIds.slice(0, QUIZ_LIMIT_PER_STUDENT), 10)) {
      if (!batch.length) continue;
      for (const qid of batch) {
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
            secs += t; cnt += 1;
          }
        });
      }
    }
    const timeOnTaskMin = Math.round((cnt ? secs / cnt : 0) / 60);

    const completionPct = modulesTotal ? Math.round((modulesCompleted / modulesTotal) * 100) : 0;
    const atRisk = avgQuizScore < passThreshold || completionPct < 50;
    if (avgQuizScore >= passThreshold) passCount += 1;

    rows.push({
      className,
      name,
      studentId: u.studentId || s.sid,
      avgQuizScore,
      quizzesTaken,
      modulesCompleted,
      totalModules: modulesTotal,
      timeOnTaskMin,
      status: atRisk ? 'At Risk' : 'On Track',
    });
  }

  // 9) Build byQuiz charts (labels aligned, missing fill => 0)
  const quizIdsAll = Object.keys({
    ...scoreSumByQuiz, ...scoreCountByQuiz, ...attemptsCountByQuiz,
  });

  // Sort labels by title then id (stable & readable)
  const labels = quizIdsAll
    .map((qid) => ({ qid, title: quizTitleById[qid] || `Quiz ${qid.slice(0,6)}` }))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((x) => x.title);

  const labelsOrder = quizIdsAll
    .map((qid) => ({ qid, title: quizTitleById[qid] || `Quiz ${qid.slice(0,6)}` }))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((x) => x.qid);

  const avgScores = labelsOrder.map((qid) => {
    const sum = scoreSumByQuiz[qid] || 0;
    const cnt = scoreCountByQuiz[qid] || 0;
    return cnt ? Math.round(sum / cnt) : 0;
  });

  const attempts = labelsOrder.map((qid) => attemptsCountByQuiz[qid] || 0);

  // 10) Summary
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

/**
 * Your original builder (kept for compatibility with anything else calling it).
 * No changes.
 */
async function buildTeacherAnalytics({ teacherId, classId = null, limitStudents = 500 }) {
  // ... (your original implementation exactly as you pasted)
  // Keeping it untouched so existing callers won’t break.
  // If you want, you can delete it later and migrate everything to buildTeacherQuizAnalytics.
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
      .flatMap((cid) => quizzesByCourseId[cid] || [])
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
          .collection('users')
          .doc(udoc.docId)
          .collection('completedModules')
          .where('courseId', 'in', myCourses.slice(i, i + 10))
          .limit(1)
          .get();
        if (!snap.empty) {
          has = true;
          break;
        }
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
        datasets: [{ label: 'Students', data: [/* buckets */] }],
      },
      completionRate: {
        labels: completionRateLabels,
        datasets: [{ label: '% Completion', data: completionRateData }],
      },
    },
    students: studentsOut.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// backend/services/analytics.service.js
// Keep this file as a thin re-export so there's a single source of truth.

const {
  buildTeacherAnalytics,            // legacy
  buildTeacherQuizAnalytics,        // quizzes
  buildTeacherAssignmentAnalytics,  // assignments
} = require('../utils/analyticsUtils');

module.exports = {
  buildTeacherAnalytics,
  buildTeacherQuizAnalytics,
  buildTeacherAssignmentAnalytics,
};
