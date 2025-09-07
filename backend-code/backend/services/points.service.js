// ==== services/points.service.js ==== //
const { firestore, admin } = require('../config/firebase');

function chunk(arr, size = 10) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getEnrollmentsClassIds(userId) {
  const snap = await firestore.collection('users').doc(userId).collection('enrollments').get();
  return snap.docs.map((d) => d.id);
}
async function getCoursesForClassIds(classIds) {
  const out = [];
  const seen = new Set();
  for (const ids of chunk(classIds, 10)) {
    const snap = await firestore
      .collection('courses')
      .where('assignedClasses', 'array-contains-any', ids)
      .get();
    snap.forEach((doc) => {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        out.push({ id: doc.id, ...doc.data() });
      }
    });
  }
  return out;
}

// points
async function computePointsForUser(userId, { startMs = null, courseFilterIds = null } = {}) {
  const userRef = firestore.collection('users').doc(userId);
  const tMin = startMs ? admin.firestore.Timestamp.fromMillis(startMs) : null;
  const courseSet = courseFilterIds ? new Set(courseFilterIds) : null;

  let points = 0;

  try {
    const snap = await userRef.collection('completedModules').get();
    snap.forEach((d) => {
      const x = d.data() || {};
      if (tMin && x.completedAt?.toMillis?.() < startMs) return;
      if (courseSet && x.courseId && !courseSet.has(x.courseId)) return;
      points += 10;
    });
  } catch {}

  try {
    const qaSnap = await userRef.collection('quizAttempts').get();
    const addPerQuiz = [];
    for (const qaDoc of qaSnap.docs) {
      const meta = qaDoc.data() || {};
      if (courseSet && meta.courseId && !courseSet.has(meta.courseId)) continue;
      const attemptsSnap = await qaDoc.ref.collection('attempts').get();
      let best = null;
      attemptsSnap.forEach((at) => {
        const a = at.data() || {};
        const ts = a.submittedAt?.toMillis?.();
        if (tMin && (!ts || ts < startMs)) return;
        if (typeof a.percent === 'number') best = best == null ? a.percent : Math.max(best, a.percent);
      });
      if (typeof best === 'number') addPerQuiz.push(best);
    }
    points += addPerQuiz.reduce((s, v) => s + v, 0);
  } catch {}

  try {
    const courseIds = courseFilterIds
      ? courseFilterIds
      : (await getCoursesForClassIds(await getEnrollmentsClassIds(userId))).map((c) => c.id);

    for (const ids of chunk(courseIds, 10)) {
      const aSnap = await firestore
        .collection('assignments')
        .where('courseId', 'in', ids)
        .orderBy('publishAt', 'desc')
        .limit(100)
        .get();

      for (const doc of aSnap.docs) {
        const a = doc.data() || {};
        const dueMs = a.dueAt?.toMillis?.() ?? null;

        const subDoc = await firestore.collection('assignments').doc(doc.id).collection('submissions').doc(userId).get();
        if (!subDoc.exists) continue;
        const s = subDoc.data() || {};
        const subMs = s.submittedAt?.toMillis?.();
        if (!subMs) continue;
        if (tMin && subMs < startMs) continue;

        if (dueMs && subMs <= dueMs) points += 20;
      }
    }
  } catch {}

  return points;
}

// streak
async function computeStreakDays(userId) {
  const userRef = firestore.collection('users').doc(userId);
  const days = new Set();
  const pushDay = (ms) => {
    const d = new Date(ms);
    days.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  };

  try {
    const snap = await userRef.collection('completedModules').get();
    snap.forEach((d) => {
      const ms = d.data()?.completedAt?.toMillis?.();
      if (ms) pushDay(ms);
    });
  } catch {}

  try {
    const qaSnap = await userRef.collection('quizAttempts').get();
    for (const r of qaSnap.docs) {
      const atSnap = await r.ref.collection('attempts').get();
      atSnap.forEach((a) => {
        const ms = a.data()?.submittedAt?.toMillis?.();
        if (ms) pushDay(ms);
      });
    }
  } catch {}

  try {
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    const courseIds = courses.map((c) => c.id);
    for (const ids of chunk(courseIds, 10)) {
      const aSnap = await firestore
        .collection('assignments')
        .where('courseId', 'in', ids)
        .orderBy('publishAt', 'desc')
        .limit(100)
        .get();
      for (const doc of aSnap.docs) {
        const subDoc = await firestore.collection('assignments').doc(doc.id).collection('submissions').doc(userId).get();
        if (subDoc.exists) {
          const ms = subDoc.data()?.submittedAt?.toMillis?.();
          if (ms) pushDay(ms);
        }
      }
    }
  } catch {}

  // count back from today (UTC)
  let streak = 0;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  while (true) {
    const key = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(
      today.getUTCDate()
    ).padStart(2, '0')}`;
    if (days.has(key)) {
      streak += 1;
      today.setUTCDate(today.getUTCDate() - 1);
    } else break;
  }
  return streak;
}

// badges
async function computeBadges(userId) {
  const userRef = firestore.collection('users').doc(userId);

  let quizWhiz = false;
  try {
    const qaSnap = await userRef.collection('quizAttempts').get();
    qaSnap.forEach((doc) => {
      const d = doc.data() || {};
      const best =
        typeof d.bestPercent === 'number'
          ? d.bestPercent
          : d.bestScore?.percent ?? d.lastScore?.percent ?? 0;
      if (best >= 90) quizWhiz = true;
    });
  } catch {}

  let onTimeCount = 0;
  try {
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    const courseIds = courses.map((c) => c.id);
    for (const ids of chunk(courseIds, 10)) {
      const asSnap = await firestore
        .collection('assignments')
        .where('courseId', 'in', ids)
        .orderBy('publishAt', 'desc')
        .limit(100)
        .get();
      for (const aDoc of asSnap.docs) {
        const a = aDoc.data() || {};
        const dueMs = a.dueAt?.toMillis?.() ?? null;
        const subDoc = await firestore.collection('assignments').doc(aDoc.id).collection('submissions').doc(userId).get();
        if (subDoc.exists && dueMs) {
          const sMs = subDoc.data()?.submittedAt?.toMillis?.();
          if (sMs && sMs <= dueMs) {
            onTimeCount++;
            if (onTimeCount >= 3) break;
          }
        }
      }
      if (onTimeCount >= 3) break;
    }
  } catch {}
  const onTimeAchiever = onTimeCount >= 3;

  let totalModules = 0,
    completedModules = 0;
  try {
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    for (const c of courses) {
      const [modSnap, doneSnap] = await Promise.all([
        firestore.collection('modules').where('courseId', '==', c.id).get(),
        userRef.collection('completedModules').where('courseId', '==', c.id).get(),
      ]);
      totalModules += modSnap.size;
      completedModules += doneSnap.size;
    }
  } catch {}
  const overallPct = totalModules ? Math.round((completedModules / totalModules) * 100) : 0;
  const moduleMaster = overallPct >= 80 || completedModules >= 10;

  const badges = [];
  if (onTimeAchiever) badges.push({ label: 'On-Time Achiever', type: 'success' });
  if (quizWhiz) badges.push({ label: 'Quiz Whiz', type: 'info' });
  if (moduleMaster) badges.push({ label: 'Module Master', type: 'warning' });
  return badges;
}

module.exports = { computePointsForUser, computeStreakDays, computeBadges };
