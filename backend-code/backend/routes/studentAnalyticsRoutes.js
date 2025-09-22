// backend/routes/studentAnalyticsRoutes.js
'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { getUserRefByAnyId } = require('../utils/idUtils');
const { safeDecrypt } = require('../utils/fieldCrypto'); // ⬅️ use safeDecrypt

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

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Parse grades written like "50/50", "10 / 20", "8.5/10"
function parseFractionstr(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const raw = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isFinite(raw) || !Number.isFinite(max)) return null;
  return { raw, max };
}

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

// Decrypt helper for user docs
function decryptNamesFromUser(u = {}) {
  return {
    firstName:  safeDecrypt(u.firstNameEnc  || '', ''),
    middleName: safeDecrypt(u.middleNameEnc || '', ''),
    lastName:   safeDecrypt(u.lastNameEnc   || '', ''),
  };
}

/* ----------------------------- route ------------------------------ */
router.get(
  '/student-analytics',
  asyncHandler(async (req, res) => {
    const teacherId = String(req.query.teacherId || '').trim(); // compatibility
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

    // Build profile name from DECRYPTED fields (First Middle Last)
    const names = decryptNamesFromUser(user);
    const fullName = [names.firstName, names.middleName, names.lastName]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const profile = {
      userId: userRef.id,
      studentId: user.studentId || null,
      name:
        fullName ||
        (user.fullName && user.fullName.trim()) ||
        user.username ||
        'Student',
      firstName: names.firstName || '',
      middleName: names.middleName || '',
      lastName: names.lastName || '',
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

    // Enrich missing quiz titles
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

    /* ----------------------- assignments (percent) ------------------------- */
    const gradesSnap = await userRef.collection('assignmentGrades').get();

    const gradesRaw = [];
    const needMaxIds = new Set();
    const rowsNeedingTitleLookup = []; // when id lookup fails but we have a title

    gradesSnap.forEach((d) => {
      const g = d.data() || {};

      // 1) Try to parse fraction-like grades from multiple possible fields
      const frac =
        parseFractionstr(g.grade) ||
        parseFractionstr(g.score) ||
        parseFractionstr(g.result) ||
        parseFractionstr(g.gradeText) ||
        parseFractionstr(g.gradeStr) ||
        null;

      let rawFromFrac = null;
      let maxFromFrac = null;
      if (frac) {
        rawFromFrac = frac.raw;
        maxFromFrac = frac.max;
      }

      // 2) Try common "max" field names on the grade doc itself
      const possibleMax =
        maxFromFrac ??
        toNum(g.max) ??
        toNum(g.maxScore) ??
        toNum(g.totalPoints) ??
        toNum(g.pointsPossible) ??
        toNum(g.possiblePoints) ??
        toNum(g.pointsMax) ??
        toNum(g.points) ??              // sometimes denominator is called "points"
        toNum(g.denominator) ??
        toNum(g.outOf) ??
        toNum(g.total) ??
        toNum(g.scoreTotal) ??
        toNum(g.scoreMax) ??
        toNum(g.fullMark) ??
        toNum(g.out_of) ?? null;

      // 3) Grade raw number (if not from fraction)
      const rawNum =
        (rawFromFrac != null ? rawFromFrac : (
          toNum(g.grade) ?? toNum(g.score) ?? toNum(g.pointsEarned) ?? toNum(g.marks) ?? null
        ));

      const assignmentId = g.assignmentId || g.assignmentRefId || d.id;
      const assignmentTitle = g.assignmentTitle || g.title || null;

      const row = {
        assignmentId,
        assignmentTitle,
        courseId: g.courseId || null,
        moduleId: g.moduleId || null,
        gradeRaw: rawNum,        // numeric numerator
        maxPoints: possibleMax,  // numeric denominator (may be null)
        dueAt: g.dueAt || null,
        submittedAt: g.submittedAt || null,
        gradedAt: g.gradedAt || null,
      };

      if (!row.maxPoints) {
        needMaxIds.add(assignmentId);
        if (assignmentTitle) rowsNeedingTitleLookup.push(row);
      }
      gradesRaw.push(row);
    });

    // For rows that still lack max, fetch from master assignments/{id} in batches
    if (needMaxIds.size) {
      for (const part of chunk(Array.from(needMaxIds), 10)) {
        const aSnap = await firestore
          .collection('assignments')
          .where(admin.firestore.FieldPath.documentId(), 'in', part)
          .get();

        const maxMap = {};
        const titleMap = {};
        aSnap.forEach((doc) => {
          const a = doc.data() || {};
          const m =
            toNum(a.max) ??
            toNum(a.maxScore) ??
            toNum(a.totalPoints) ??
            toNum(a.pointsPossible) ??
            toNum(a.possiblePoints) ??
            toNum(a.pointsMax) ??
            toNum(a.points) ??
            toNum(a.denominator) ??
            toNum(a.outOf) ??
            toNum(a.total) ??
            toNum(a.scoreTotal) ??
            toNum(a.scoreMax) ??
            toNum(a.fullMark) ??
            toNum(a.out_of) ?? null;
          maxMap[doc.id] = m;

          titleMap[doc.id] =
            a.title ||
            a.name ||
            a.assignmentTitle ||
            (a.number != null ? `Assignment ${a.number}` : null) ||
            doc.id;
        });

        gradesRaw.forEach(r => {
          if (!r.maxPoints && maxMap[r.assignmentId] != null) r.maxPoints = maxMap[r.assignmentId];
          if (!r.assignmentTitle && titleMap[r.assignmentId]) r.assignmentTitle = titleMap[r.assignmentId];
        });
      }
    }

    // EXTRA: If still missing max, try lookup by title (==) to find the master assignment
    // This helps when grade rows have titles but no reliable assignmentId.
    const rowsStillMissingMax = gradesRaw.filter(r => !r.maxPoints && r.assignmentTitle);
    if (rowsStillMissingMax.length) {
      // Query by title in small batches (10 distinct titles at a time)
      const titles = Array.from(new Set(rowsStillMissingMax.map(r => r.assignmentTitle))).filter(Boolean);
      for (const part of chunk(titles, 10)) {
        const aSnap = await firestore
          .collection('assignments')
          .where('title', 'in', part)
          .get();

        const titleToMax = {};
        aSnap.forEach(doc => {
          const a = doc.data() || {};
          const m =
            toNum(a.max) ??
            toNum(a.maxScore) ??
            toNum(a.totalPoints) ??
            toNum(a.pointsPossible) ??
            toNum(a.possiblePoints) ??
            toNum(a.pointsMax) ??
            toNum(a.points) ??
            toNum(a.denominator) ??
            toNum(a.outOf) ??
            toNum(a.total) ??
            toNum(a.scoreTotal) ??
            toNum(a.scoreMax) ??
            toNum(a.fullMark) ??
            toNum(a.out_of) ?? null;
          if (a.title) titleToMax[a.title] = m;
        });

        gradesRaw.forEach(r => {
          if (!r.maxPoints && r.assignmentTitle && titleToMax[r.assignmentTitle] != null) {
            r.maxPoints = titleToMax[r.assignmentTitle];
          }
        });
      }
    }

    // Compute percentage
    const grades = [];
    let asgPercentSum = 0;
    let asgPercentCnt = 0;

    for (const r of gradesRaw) {
      let gradePercent = null;

      if (typeof r.gradeRaw === 'number' && typeof r.maxPoints === 'number' && r.maxPoints > 0) {
        gradePercent = Math.round((r.gradeRaw / r.maxPoints) * 100);   // 50/50 -> 100
      } else if (typeof r.gradeRaw === 'number') {
        // If there's no max, assume r.gradeRaw is already a percent
        const clamped = Math.max(0, Math.min(100, r.gradeRaw));
        gradePercent = Math.round(clamped);
      }

      if (typeof gradePercent === 'number') {
        asgPercentSum += gradePercent;
        asgPercentCnt += 1;
      }

      grades.push({
        assignmentId: r.assignmentId,
        assignmentTitle: r.assignmentTitle || r.assignmentId,
        courseId: r.courseId || null,
        moduleId: r.moduleId || null,
        // audit fields (optional to display)
        gradeRaw: (typeof r.gradeRaw === 'number' ? r.gradeRaw : null),
        maxPoints: (typeof r.maxPoints === 'number' ? r.maxPoints : null),
        // canonical
        gradePercent,                 // canonical percentage
        grade: gradePercent,          // compatibility: legacy UIs reading "grade" will see percent
        dueAt: r.dueAt,
        submittedAt: r.submittedAt,
        gradedAt: r.gradedAt,
      });
    }

    /* ---------------------------- essay subs ------------------------------ */
    const essays = [];
    const quizIdSet = new Set();

    let eSnap = null;
    try {
      eSnap = await firestore
        .collection('quizEssaySubmissions')
        .where('userId', '==', userRef.id)
        .get();
    } catch (e) { /* ignore */ }

    if (!eSnap || eSnap.empty) {
      try {
        eSnap = await firestore
          .collection('quizEssaySubmissions')
          .where('userRefPath', '==', userRef.path)
          .get();
      } catch (e) { /* ignore */ }
    }

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
          quizTitle: x.quizTitle || null,
          questionIndex: x.questionIndex ?? null,
          status: x.status || 'pending',
          score: (typeof x.score === 'number') ? x.score : null,
          maxScore: (typeof x.maxScore === 'number') ? x.maxScore : 10,
          createdAt: x.createdAt || null,
        });
        if (x.quizId) quizIdSet.add(x.quizId);
      });

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

      essays.sort((a, b) => (toMillis(b.createdAt) || 0) - (toMillis(a.createdAt) || 0));
    }

    /* ------------------------- completed modules -------------------------- */
    const cmSnap = await userRef.collection('completedModules').get();
    const completedRaw = cmSnap.docs.map((d) => {
      const m = d.data() || {};
      return {
        moduleId: m.moduleId || d.id,
        courseId: m.courseId || null,
        rawPercent: typeof m.percent === 'number' ? m.percent : null,
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
      percent: 100,              // normalized for display
      completedCount: 1,
      totalModules: 1
    }));

    const modulesCompleted = completedModules.length;
    const totalModules = null;

    /* ----------------------------- summary ------------------------------- */
    const averageQuizScore = quizBestCnt ? Math.round(quizBestSum / quizBestCnt) : 0;
    const averageAssignmentGrade = (asgPercentCnt ? Math.round(asgPercentSum / asgPercentCnt) : 0);

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
      essays: { submissions: essays },
      modules: {
        completed: completedModules.sort((a, b) => (toMillis(b.completedAt) || 0) - (toMillis(a.completedAt) || 0)),
      },
    };

    return res.json(payload);
  })
);

module.exports = router;
