// backend/routes/adminDashboardRoutes.js
const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore } = require('../config/firebase');

function buildBasicStats(users) {
  const { decryptField } = require('../utils/fieldCrypto');
  function decryptNamesFromUser(u = {}) {
    return {
      firstName: decryptField(u.firstNameEnc || ''),
      middleName: decryptField(u.middleNameEnc || ''),
      lastName: decryptField(u.lastNameEnc || ''),
    };
  }

  const totalUsers    = users.length;
  const activeUsers   = users.filter(u => u.active === true).length;
  const inactiveUsers = totalUsers - activeUsers;

  // Add decrypted full names to each user
  const usersWithNames = users.map(u => {
    const names = decryptNamesFromUser(u);
    const fullName = [names.firstName, names.middleName, names.lastName]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      ...u,
      fullName: fullName || u.fullName || u.username || 'User',
      firstName: names.firstName || '',
      middleName: names.middleName || '',
      lastName: names.lastName || '',
    };
  });

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
    users: usersWithNames,
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
