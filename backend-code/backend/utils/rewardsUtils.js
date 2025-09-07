// backend/utils/rewardsUtils.js
const { firestore } = require('../config/firebase');
const { getEnrollmentsClassIds, getCoursesForClassIds } = require('./studentUtils');

const DAY_MS = 24 * 60 * 60 * 1000;

function timeframeToStartMs(tf = 'all') {
  const now = Date.now();
  const t = (tf || 'all').toLowerCase();
  if (t === 'week')  return now - 7  * DAY_MS;
  if (t === 'month') return now - 30 * DAY_MS;
  return null; // 'all'
}

function ymd(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth()+1).padStart(2,'0');
  const dd = String(dt.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Compute a simple “points” score for a user.
 * Rules (tunable):
 *  - Completed modules: +10 each
 *  - Assignment grades: +grade (e.g., 85%)
 *  - Quizzes: use bestPercent (or lastScore.percent) + add that as points
 * Filters:
 *  - startMs: only include items on/after this time (null => all time)
 *  - courseFilterIds: restrict to a set of courseIds (null => all courses)
 */
async function computePointsForUser(userId, { startMs = null, courseFilterIds = null } = {}) {
  const userRef = firestore.collection('users').doc(userId);
  let points = 0;

  const inCourseFilter = (cid) => !courseFilterIds || (cid && courseFilterIds.includes(cid));
  const inTime = (ms) => !startMs || (typeof ms === 'number' && ms >= startMs);

  // completed modules
  try {
    const cmSnap = await userRef.collection('completedModules').get();
    cmSnap.forEach(d => {
      const x = d.data() || {};
      const at = x.completedAt?.toMillis?.() ?? 0;
      if (inTime(at) && inCourseFilter(x.courseId)) points += 10;
    });
  } catch {}

  // assignment grades
  try {
    const gSnap = await userRef.collection('assignmentGrades').get();
    gSnap.forEach(d => {
      const x = d.data() || {};
      const at = x.gradedAt?.toMillis?.() ?? x.submittedAt?.toMillis?.() ?? 0;
      if (!inTime(at) || !inCourseFilter(x.courseId)) return;
      const g = typeof x.grade === 'number' ? x.grade : null;
      if (g != null) points += Math.max(0, Math.min(100, Math.round(g)));
    });
  } catch {}

  // quiz attempts (summary docs)
  try {
    const qaSnap = await userRef.collection('quizAttempts').get();
    qaSnap.forEach(d => {
      const x = d.data() || {};
      const at = x.lastSubmittedAt?.toMillis?.() ?? 0;
      if (!inTime(at) || !inCourseFilter(x.courseId)) return;
      const pct = (typeof x.bestPercent === 'number')
        ? x.bestPercent
        : (x.bestScore?.percent ?? x.lastScore?.percent ?? null);
      if (pct != null) points += Math.max(0, Math.min(100, Math.round(pct)));
    });
  } catch {}

  return Math.round(points);
}

/**
 * Compute consecutive-day streak up to “today”.
 * We consider activity days from:
 *  - completedModules.completedAt
 *  - quizAttempts.lastSubmittedAt
 *  - assignmentGrades.gradedAt (best effort)
 */
async function computeStreakDays(userId) {
  const userRef = firestore.collection('users').doc(userId);
  const days = new Set();

  try {
    const cm = await userRef.collection('completedModules').get();
    cm.forEach(d => {
      const ms = d.data()?.completedAt?.toMillis?.();
      if (ms) days.add(ymd(ms));
    });
  } catch {}

  try {
    const qa = await userRef.collection('quizAttempts').get();
    qa.forEach(d => {
      const ms = d.data()?.lastSubmittedAt?.toMillis?.();
      if (ms) days.add(ymd(ms));
    });
  } catch {}

  try {
    const ag = await userRef.collection('assignmentGrades').orderBy('gradedAt','desc').limit(200).get();
    ag.forEach(d => {
      const ms = d.data()?.gradedAt?.toMillis?.();
      if (ms) days.add(ymd(ms));
    });
  } catch {}

  // walk backward from today
  let streak = 0;
  let cur = new Date();
  while (days.has(ymd(cur))) {
    streak += 1;
    cur = new Date(cur.getTime() - DAY_MS);
  }
  return streak;
}

/**
 * Compute badges per your rules:
 *  - Quiz Whiz: any best quiz >= 90%
 *  - On-Time Achiever: >= 3 assignment submissions on/before due date (recent, limited fetch)
 *  - Module Master: overall completion >= 80% OR >= 10 modules completed
 */
async function computeBadges(userId) {
  const userRef = firestore.collection('users').doc(userId);

  // Quiz Whiz
  let quizWhiz = false;
  try {
    const qaSnap = await userRef.collection('quizAttempts').get();
    qaSnap.forEach(doc => {
      const d = doc.data() || {};
      const best = typeof d.bestPercent === 'number'
        ? d.bestPercent
        : (d.bestScore?.percent ?? d.lastScore?.percent ?? 0);
      if (best >= 90) quizWhiz = true;
    });
  } catch {}

  // Determine courseIds from enrollments -> assigned courses
  const classIds = await getEnrollmentsClassIds(userId);
  const courses = await getCoursesForClassIds(classIds);
  const courseIds = courses.map(c => c.id);

  // On-Time Achiever (>=3)
  let onTimeCount = 0;
  if (courseIds.length) {
    // chunk courseIds by 10
    for (let i = 0; i < courseIds.length && onTimeCount < 3; i += 10) {
      const ids = courseIds.slice(i, i + 10);
      const asSnap = await firestore.collection('assignments')
        .where('courseId', 'in', ids)
        .orderBy('publishAt', 'desc')
        .limit(50) // keep it light
        .get();

      for (const aDoc of asSnap.docs) {
        const a = aDoc.data() || {};
        const dueAtMs = a.dueAt?.toMillis?.() ?? null;
        if (!dueAtMs) continue;

        const subDoc = await firestore
          .collection('assignments')
          .doc(aDoc.id)
          .collection('submissions')
          .doc(userId)
          .get();

        if (subDoc.exists) {
          const sub = subDoc.data() || {};
          const submittedMs = sub.submittedAt?.toMillis?.() ?? null;
          if (submittedMs && submittedMs <= dueAtMs) {
            onTimeCount += 1;
            if (onTimeCount >= 3) break;
          }
        }
      }
    }
  }
  const onTimeAchiever = onTimeCount >= 3;

  // Module Master
  let totalModules = 0, completedModules = 0;
  if (courseIds.length) {
    await Promise.all(courseIds.map(async cid => {
      const [modSnap, doneSnap] = await Promise.all([
        firestore.collection('modules').where('courseId','==', cid).get(),
        userRef.collection('completedModules').where('courseId','==', cid).get(),
      ]);
      totalModules += modSnap.size;
      completedModules += doneSnap.size;
    }));
  }
  const overallPct = totalModules ? Math.round((completedModules/totalModules)*100) : 0;
  const moduleMaster = (overallPct >= 80) || (completedModules >= 10);

  const badges = [];
  if (onTimeAchiever) badges.push({ label: 'On-Time Achiever', type:'success' });
  if (quizWhiz)       badges.push({ label: 'Quiz Whiz',        type:'info' });
  if (moduleMaster)   badges.push({ label: 'Module Master',    type:'warning' });

  return badges;
}

module.exports = {
  timeframeToStartMs,
  computePointsForUser,
  computeStreakDays,
  computeBadges,
};
