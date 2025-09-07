// backend/routes/studentProgressRoutes.js
const express = require('express');
const router = express.Router();

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore } = require('../config/firebase');
const { decryptField } = require('../utils/fieldCrypto'); // <-- NEW: use same decrypt as in auth

const {
  getEnrollmentsClassIds,
  getCoursesForClassIds,
  mapRosterIdsToUserIds,
} = require('../utils/studentUtils');

const {
  computePointsForUser,
  computeStreakDays,
  computeBadges,
  timeframeToStartMs,
} = require('../utils/rewardsUtils');

// ---------- helpers ----------
const toDateMs = (ts) => ts?.toMillis?.() ?? (typeof ts === 'number' ? ts : null);

// Decrypt full name from a users/{id} doc that stores encrypted names
function getDecryptedFullName(u = {}) {
  try {
    const first = decryptField(u.firstNameEnc || '');
    const middle = decryptField(u.middleNameEnc || '');
    const last = decryptField(u.lastNameEnc || '');
    const full = [first, middle, last].map(s => String(s || '').trim()).filter(Boolean).join(' ');
    if (full) return full;
  } catch { /* fall through */ }

  // legacy/fallbacks if anything’s missing or decrypt fails
  const legacy = `${u.firstName || ''} ${u.lastName || ''}`.trim();
  return legacy || u.username || u.email || 'Student';
}

// ===== STUDENT PROGRESS (overall + per-course) =====
// GET /api/students/:userId/progress
router.get('/students/:userId/progress', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const userRef = firestore.collection('users').doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    return res.status(404).json({ success:false, message: 'Student not found.' });
  }

  // 1) Enrolled classes
  const classIds = await getEnrollmentsClassIds(userId);
  if (!classIds.length) {
    return res.json({ success:true, overall:{completed:0,total:0,percent:0}, subjects:[] });
  }

  // 2) Courses for those classes
  const courses = await getCoursesForClassIds(classIds);
  if (!courses.length) {
    return res.json({ success:true, overall:{completed:0,total:0,percent:0}, subjects:[] });
  }

  // 3) Per course: modules total vs completed
  let overallTotal = 0;
  let overallCompleted = 0;
  const subjects = [];

  await Promise.all(courses.map(async (c) => {
    const [modSnap, doneSnap] = await Promise.all([
      firestore.collection('modules').where('courseId','==', c.id).get(),
      userRef.collection('completedModules').where('courseId','==', c.id).get(),
    ]);

    const total = modSnap.size;
    const completed = doneSnap.size;
    const percent = total ? Math.round((completed/total)*100) : 0;

    overallTotal += total;
    overallCompleted += completed;

    subjects.push({
      courseId: c.id,
      name: c.title || 'Course',
      completed,
      total,
      percent,
    });
  }));

  const overallPercent = overallTotal ? Math.round((overallCompleted/overallTotal)*100) : 0;

  return res.json({
    success: true,
    overall: { completed: overallCompleted, total: overallTotal, percent: overallPercent },
    subjects
  });
}));

// ===== STUDENT BADGES =====
// GET /api/students/:userId/badges
router.get('/students/:userId/badges', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const userRef = firestore.collection('users').doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    return res.status(404).json({ success:false, message:'Student not found.' });
  }
  const badges = await computeBadges(userId);
  return res.json({ success:true, badges });
}));

// ---------- API: Rewards summary ----------
// GET /api/students/:userId/rewards
router.get('/students/:userId/rewards', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const userRef = firestore.collection('users').doc(userId);
  const doc = await userRef.get();
  if (!doc.exists) return res.status(404).json({ success:false, message:'Student not found.' });

  const totalPoints = await computePointsForUser(userId, { startMs: null, courseFilterIds: null });
  const streakDays  = await computeStreakDays(userId);
  const recentBadges = await computeBadges(userId);
  const optIn = doc.data()?.leaderboardOptIn !== false;

  return res.json({ success:true, totalPoints, streakDays, recentBadges, optIn });
}));

// ---------- API: Opt-in/out for leaderboard ----------
// PATCH /api/students/:userId/leaderboard-optin
router.patch('/students/:userId/leaderboard-optin', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { optIn } = req.body || {};
  if (typeof optIn !== 'boolean') {
    return res.status(400).json({ success:false, message:'optIn boolean is required.' });
  }
  await firestore.collection('users').doc(userId).set({ leaderboardOptIn: optIn }, { merge:true });
  return res.json({ success:true });
}));

// ---------- API: Leaderboard ----------
// GET /api/leaderboard?userId=...&scope=class|subject&timeframe=all|month|week&subject=ICT
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const userId = String(req.query.userId || '');
  const scope = (req.query.scope || 'class').toString();
  const timeframe = (req.query.timeframe || 'all').toString();
  const subjectTitle = (req.query.subject || '').toString().trim();

  if (!userId) return res.status(400).json({ success:false, message:'userId required' });
  const startMs = timeframeToStartMs(timeframe);

  // 1) Determine peers and optional course filter
  const classIds = await getEnrollmentsClassIds(userId);
  if (!classIds.length) return res.json({ success:true, entries: [] });

  let courseFilterIds = null;
  let peerClassIds = classIds.slice();

  if (scope === 'subject' && subjectTitle) {
    const allCourses = await getCoursesForClassIds(classIds);
    const targetCourses = allCourses.filter(c => (c.title || '').toLowerCase() === subjectTitle.toLowerCase());
    courseFilterIds = targetCourses.map(c => c.id);

    const classSet = new Set();
    targetCourses.forEach(c => (c.assignedClasses || []).forEach(id => classSet.add(id)));
    if (classSet.size) peerClassIds = Array.from(classSet);
  }

  // 2) Build peer userIds from class rosters
  const peerUserIdsSet = new Set();
  for (const cid of peerClassIds) {
    const rosterSnap = await firestore.collection('classes').doc(cid).collection('roster').get();
    const rosterIds = rosterSnap.docs.map(d => d.id); // studentId strings in roster
    const mapped = await mapRosterIdsToUserIds(rosterIds);
    mapped.forEach(id => peerUserIdsSet.add(id));
  }
  peerUserIdsSet.add(userId); // ensure self
  const peerUserIds = Array.from(peerUserIdsSet);

  // 3) Compute points per user (hide non-opt-in peers; always show self)
  const entries = [];
  for (const uid of peerUserIds) {
    try {
      const uDoc = await firestore.collection('users').doc(uid).get();
      if (!uDoc.exists) continue;
      const u = uDoc.data() || {};
      const optIn = u.leaderboardOptIn !== false;
      if (!optIn && uid !== userId) continue;

      const points = await computePointsForUser(uid, { startMs, courseFilterIds });
      const badges = await computeBadges(uid);
      const topBadge = badges[0]?.label || '-';

      const name = getDecryptedFullName(u); // <-- decrypted full name

      entries.push({ userId: uid, name, points, topBadge });
    } catch {}
  }

  entries.sort((a,b)=> (b.points||0) - (a.points||0));
  return res.json({ success:true, entries: entries.slice(0, 50) });
}));

module.exports = router;
