// backend/routes/adminDashboardRoutes.js
const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore } = require('../config/firebase');

function buildBasicStats(users) {
  const totalUsers    = users.length;
  const activeUsers   = users.filter(u => u.active === true).length;
  const inactiveUsers = totalUsers - activeUsers;

  // placeholders you can replace later
  const topCourse           = 'Photography Basics';
  const mostCompletedModule = 'Lighting & Composition';
  const averageQuizScore    = 87;
  const dailyActiveUsers    = 394;

  return {
    totalUsers,
    activeUsers,
    inactiveUsers,
    topCourse,
    mostCompletedModule,
    averageQuizScore,
    dailyActiveUsers,
  };
}

// GET /api/dashboard-stats
router.get(
  '/dashboard-stats',
  asyncHandler(async (_req, res) => {
    const snap = await firestore.collection('users').get();
    const users = snap.docs.map(d => d.data() || {});
    return res.json({ success: true, stats: buildBasicStats(users) });
  })
);

module.exports = router;
