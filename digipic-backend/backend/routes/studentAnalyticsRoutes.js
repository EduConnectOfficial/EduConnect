// backend/routes/studentAnalyticsRoutes.js
'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { getUserRefByAnyId } = require('../utils/idUtils');

/* ----------------------------- helpers ----------------------------- */
function chunk(arr, size = 10) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const toMillis = (x) => {
  if (!x) return null;
  if (typeof x?.toMillis === 'function') return x.toMillis();
  if (typeof x === 'number') return x;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
};
async function fetchTitlesMap({ collection, ids }) {
  const map = {};
  const uniq = Array.from(new Set((ids || []).filter(Boolean)));
  if (!uniq.length) return map;

  for (const part of chunk(uniq, 10)) {
    const snap = await firestore
      .collection(collection)
      .where(admin.firestore.FieldPath.documentId(), 'in', part)
      .get();
    snap.forEach((d) => {
      const x = d.data() || {};
      map[d.id] =
        x.title ||
        x.name ||
        x.courseTitle ||
        x.moduleTitle ||
        (x.moduleNumber != null ? `Module ${x.moduleNumber}` : null) ||
        d.id;
    });
  }
  return map;
}

/* ----------------------------- route ------------------------------ */
router.get(
  '/student-analytics',
  asyncHandler(async (req, res) => {
    const teacherId = String(req.query.teacherId || '').trim(); // optional
    const studentKey = String(req.query.student || '').trim();
    if (!studentKey) {
      return res.status(400).json({ success: false, message: 'student is required' });
    }

    // Resolve user doc (accepts userId or studentId)
    const userRef = await getUserRefByAnyId(studentKey);
    if (!userRef) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const userSnap = await userRef.get();
    const user = userSnap.data() || {};
    const profile = {
      userId: userRef.id,
      studentId: user.studentId || null,
      name:
        (user.fullName && user.fullName.trim()) ||
        `${user.firstName || ''} ${user.lastName || ''}`.trim() ||
        user.username ||
        'Student',
      email: user.email || null,
    };

    /* ----------------------- quizzes (best per quiz) ----------------------- */
    const qaRootSnap = await userRef.collection('quizAttempts').get();
    const perQuiz = [];
    let quizBestSum = 0;
    let quizBestCnt = 0;

    for (const doc of qaRootSnap.docs) {
      const d = doc.data() || {};
      const bestPercent =
        typeof d.bestGradedPercent === 'number'
          ? d.bestGradedPercent
          : typeof d.bestPercent === 'number'
          ? d.bestPercent
          : (d.lastScore?.percent != null ? d.lastScore.percent : null);

      if (typeof bestPercent === 'number') {
        quizBestSum += bestPercent;
        quizBestCnt += 1;
      }

      let attemptsUsed = 0;
      try {
        const atSnap = await userRef.collection('quizAttempts').doc(doc.id).collection('attempts').get();
        attemptsUsed = atSnap.size;
      } catch { /* noop */ }

      perQuiz.push({
        quizId: doc.id,
        title: d.quizTitle || d.title || null,
        attemptsUsed,
        bestPercent: typeof bestPercent === 'number' ? Math.round(bestPercent) : null,
        lastSubmittedAt: d.lastSubmittedAt || null,
      });
    }

    // Enrich any missing quiz titles
    {
      const qidsMissing = perQuiz.filter(q => !q.title).map(q => q.quizId);
      if (qidsMissing.length) {
        for (const part of chunk(Array.from(new Set(qidsMissing)), 10)) {
          const qSnap = await firestore.collection('quizzes')
            .where(admin.firestore.FieldPath.documentId(), 'in', part)
            .get();
          const map = {};
          qSnap.forEach(d => { map[d.id] = (d.data()?.title || d.id); });
          perQuiz.forEach(p => { if (!p.title) p.title = map[p.quizId] || p.quizId; });
        }
      }
    }

    /* ----------------------- assignments (mirrored) ------------------------ */
    const gradesSnap = await userRef.collection('assignmentGrades').get();
    const grades = [];
    let asgSum = 0;
    let asgCnt = 0;

    gradesSnap.forEach((d) => {
      const g = d.data() || {};
      const grade = typeof g.grade === 'number' ? g.grade : null;
      if (typeof grade === 'number') { asgSum += grade; asgCnt += 1; }
      grades.push({
        assignmentId: g.assignmentId || d.id,
        assignmentTitle: g.assignmentTitle || null,
        courseId: g.courseId || null,
        moduleId: g.moduleId || null,
        grade,
        dueAt: g.dueAt || null,
        submittedAt: g.submittedAt || null,
        gradedAt: g.gradedAt || null,
      });
    });

    // Enrich missing assignment titles
    {
      const missing = grades.filter(a => !a.assignmentTitle).map(a => a.assignmentId);
      if (missing.length) {
        for (const part of chunk(Array.from(new Set(missing)), 10)) {
          const aSnap = await firestore.collection('assignments')
            .where(admin.firestore.FieldPath.documentId(), 'in', part)
            .get();
          const map = {};
          aSnap.forEach(d => { map[d.id] = (d.data()?.title || d.id); });
          grades.forEach(a => { if (!a.assignmentTitle) a.assignmentTitle = map[a.assignmentId] || a.assignmentId; });
        }
      }
    }

    /* ---------------------------- essay subs ------------------------------ */
    // Avoid orderBy to prevent composite index requirement; sort client-side.
    const essays = [];
    const quizIdSet = new Set();

    // Try by userId
    let eSnap = null;
    try {
      eSnap = await firestore
        .collection('quizEssaySubmissions')
        .where('userId', '==', userRef.id)
        .get();
    } catch (e) {
      // ignore
    }

    // Fallback by userRefPath
    if (!eSnap || eSnap.empty) {
      try {
        eSnap = await firestore
          .collection('quizEssaySubmissions')
          .where('userRefPath', '==', userRef.path)
          .get();
      } catch (e) { /* ignore */ }
    }

    // Fallback by studentEmail if we have it
    if ((!eSnap || eSnap.empty) && profile.email) {
      try {
        eSnap = await firestore
          .collection('quizEssaySubmissions')
          .where('studentEmail', '==', profile.email)
          .get();
      } catch (e) { /* ignore */ }
    }

    if (eSnap && !eSnap.empty) {
      eSnap.forEach(d => {
        const x = d.data() || {};
        essays.push({
          id: d.id,
          quizId: x.quizId || null,
          quizTitle: x.quizTitle || null, // enrich below if null
          questionIndex: x.questionIndex ?? null,
          status: x.status || 'pending',
          score: (typeof x.score === 'number') ? x.score : null,
          maxScore: (typeof x.maxScore === 'number') ? x.maxScore : 10,
          createdAt: x.createdAt || null,
        });
        if (x.quizId) quizIdSet.add(x.quizId);
      });

      // Enrich quiz titles for essays
      const quizIds = Array.from(quizIdSet);
      if (quizIds.length) {
        for (const part of chunk(quizIds, 10)) {
          const qSnap = await firestore.collection('quizzes')
            .where(admin.firestore.FieldPath.documentId(), 'in', part)
            .get();

          const qmap = {};
          qSnap.forEach(d => { qmap[d.id] = (d.data()?.title || d.id); });
          essays.forEach(e => { if (!e.quizTitle && e.quizId) e.quizTitle = qmap[e.quizId] || e.quizId; });
        }
      }

      // Sort newest first (client-side)
      essays.sort((a, b) => (toMillis(b.createdAt) || 0) - (toMillis(a.createdAt) || 0));
    }

    /* ------------------------- completed modules -------------------------- */
    const cmSnap = await userRef.collection('completedModules').get();
    const completedRaw = cmSnap.docs.map((d) => {
      const m = d.data() || {};
      return {
        moduleId: m.moduleId || d.id,
        courseId: m.courseId || null,
        percent: typeof m.percent === 'number' ? m.percent : null,
        completedAt: m.completedAt || null,
      };
    });

    const courseIds = completedRaw.map((m) => m.courseId).filter(Boolean);
    const moduleIds = completedRaw.map((m) => m.moduleId).filter(Boolean);
    const [courseTitleMap, moduleTitleMap] = await Promise.all([
      fetchTitlesMap({ collection: 'courses', ids: courseIds }),
      fetchTitlesMap({ collection: 'modules', ids: moduleIds }),
    ]);

    const completedModules = completedRaw.map((m) => ({
      ...m,
      courseTitle: courseTitleMap[m.courseId] || m.courseId || '',
      moduleTitle: moduleTitleMap[m.moduleId] || m.moduleId || '',
    }));

    const modulesCompleted = completedModules.length;
    const totalModules = null;

    /* ----------------------------- summary ------------------------------- */
    const averageQuizScore = quizBestCnt ? Math.round(quizBestSum / quizBestCnt) : 0;
    const averageAssignmentGrade = asgCnt ? Math.round(asgSum / asgCnt) : 0;

    const payload = {
      success: true,
      profile,
      summary: {
        averageQuizScore,
        averageAssignmentGrade,
        modulesCompleted,
        totalModules,
      },
      quizzes: {
        perQuiz: perQuiz.sort((a, b) => (a.title || '').localeCompare(b.title || '')),
      },
      assignments: {
        grades: grades.sort((a, b) => (toMillis(b.gradedAt) || 0) - (toMillis(a.gradedAt) || 0)),
      },
      essays: {
        submissions: essays,
      },
      modules: {
        completed: completedModules.sort((a, b) => (toMillis(b.completedAt) || 0) - (toMillis(a.completedAt) || 0)),
      },
    };

    return res.json(payload);
  })
);

module.exports = router;
