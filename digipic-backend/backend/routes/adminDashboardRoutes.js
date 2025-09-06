// backend/routes/adminDashboardRoutes.js
const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore } = require('../config/firebase');
const { decryptField } = require('../utils/fieldCrypto');

/* ========== SCHEMA CONFIG (adjust if your schema differs) ========== */
const COLLECTIONS = {
  users: 'users',
  courses: 'courses',            // fields: title|name, completedCount (Number)
  modules: 'modules',            // fields: title|name, completedCount (Number)
  quizResults: 'quizResults',    // fields: score (Number 0-100)
  activityLogs: 'activityLogs',  // fields: userId (string), timestamp (Number ms OR Firestore Timestamp)
};

/* ========== Helpers ========== */

function decryptNamesFromUser(u = {}) {
  return {
    firstName: decryptField(u.firstNameEnc || ''),
    middleName: decryptField(u.middleNameEnc || ''),
    lastName: decryptField(u.lastNameEnc || ''),
  };
}

function toMillis(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v._seconds) return v._seconds * 1000;           // Firestore Timestamp-like object
  if (typeof v.toMillis === 'function') return v.toMillis(); // Firestore Timestamp
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Get "today" window [startOfDay, endOfDay) in server local time.
 * If you store timestamps in UTC (recommended), this still works for daily counts.
 */
function todayBounds() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return { start, end };
}

/* ========== Real-data builders ========== */

async function fetchUsersWithDecryptedNames() {
  const snap = await firestore.collection(COLLECTIONS.users).get();
  const users = snap.docs.map(d => d.data() || []);
  return users.map(u => {
    const names = decryptNamesFromUser(u);
    const fullName = [names.firstName, names.middleName, names.lastName]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      ...u,
      firstName: names.firstName || '',
      middleName: names.middleName || '',
      lastName: names.lastName || '',
      fullName: fullName || u.fullName || u.username || 'User',
    };
  });
}

async function getTopCourse() {
  try {
    const snap = await firestore.collection(COLLECTIONS.courses).get();
    if (snap.empty) return '—';
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (b.completedCount || 0) - (a.completedCount || 0));
    const top = rows[0];
    return top?.title || top?.name || '—';
  } catch {
    return '—';
  }
}

async function getMostCompletedModule() {
  try {
    const snap = await firestore.collection(COLLECTIONS.modules).get();
    if (snap.empty) return '—';
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (b.completedCount || 0) - (a.completedCount || 0));
    const top = rows[0];
    return top?.title || top?.name || '—';
  } catch {
    return '—';
  }
}

/**
 * Global average across ALL quiz results.
 * If you prefer to mirror teacherAnalytics calculation exactly,
 * query the same underlying `quizResults` your utils use.
 */
async function getGlobalAverageQuizScore() {
  try {
    const snap = await firestore.collection(COLLECTIONS.quizResults).get();
    if (snap.empty) return 0;
    let sum = 0, n = 0;
    snap.docs.forEach(doc => {
      const score = doc.data()?.score;
      if (typeof score === 'number' && Number.isFinite(score)) {
        sum += score;
        n += 1;
      }
    });
    return n ? Math.round(sum / n) : 0;
  } catch {
    return 0;
  }
}

/**
 * Daily Active Users = unique users with an activity log entry today.
 * Expects activityLogs with fields: userId (string), timestamp (ms/TS)
 */
async function getDailyActiveUsers() {
  try {
    const { start, end } = todayBounds();
    // Works if timestamp is stored as Number (ms) OR Firestore Timestamp
    const snap = await firestore
      .collection(COLLECTIONS.activityLogs)
      .where('timestamp', '>=', start)
      .where('timestamp', '<', end)
      .get();

    if (snap.empty) return 0;
    const set = new Set();
    snap.docs.forEach(d => {
      const row = d.data() || {};
      if (row.userId) set.add(row.userId);
    });
    return set.size;
  } catch {
    return 0;
  }
}

async function buildBasicStatsReal() {
  // Users (with decrypted names)
  const users = await fetchUsersWithDecryptedNames();
  const totalUsers = users.length;
  const activeUsers = users.filter(u => u.active === true).length;
  const inactiveUsers = totalUsers - activeUsers;

  // Real analytics
  const [topCourse, mostCompletedModule, averageQuizScore, dailyActiveUsers] = await Promise.all([
    getTopCourse(),
    getMostCompletedModule(),
    getGlobalAverageQuizScore(),
    getDailyActiveUsers(),
  ]);

  return {
    totalUsers,
    activeUsers,
    inactiveUsers,
    topCourse,
    mostCompletedModule,
    averageQuizScore,
    dailyActiveUsers,
    users,
  };
}

/* ========== Routes ========== */

// GET /api/dashboard-stats
router.get(
  '/dashboard-stats',
  asyncHandler(async (_req, res) => {
    const stats = await buildBasicStatsReal();
    return res.json({ success: true, stats });
  })
);

module.exports = router;
