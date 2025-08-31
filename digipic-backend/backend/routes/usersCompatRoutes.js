// backend/routes/usersCompatRoutes.js
const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore } = require('../config/firebase');

// GET /users  -> returns a plain array (no {success})
router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const role = (req.query.role || '').toString().toLowerCase();
    const mobileOnly = String(req.query.mobileOnly || '').toLowerCase() === 'true';

    let q = firestore.collection('users');

    if (mobileOnly) {
      q = q.where('isMobile', '==', true);
    } else if (role === 'user') {
      q = q.where('isUser', '==', true).where('isMobile', '==', true);
    } else if (role === 'itsupport') {
      q = q.where('isITsupport', '==', true);
    } else if (role === 'admin') {
      q = q.where('isAdmin', '==', true);
    }

    const snap = await q.get();
    const users = snap.docs.map(doc => {
      const d = doc.data() || {};
      return {
        userId: d.userId || doc.id,
        username: d.username || '',
        firstName: d.firstName || '',
        middleName: d.middleName || '',
        lastName: d.lastName || '',
        email: d.email || '',
        active: d.active ?? true,

        // role flags the dashboard expects
        isTeacher: d.isTeacher ?? Boolean(d.teacherId),
        teacherId: d.teacherId || null,
        isStudent: d.isStudent ?? Boolean(d.studentId),
        studentId: d.studentId || null,

        // super admin / IT support
        isITsupport: d.isITsupport ?? false,
        isSuperAdmin: d.isSuperAdmin ?? d.isITsupport ?? false,

        // keep original flags for other pages
        isUser: d.isUser ?? false,
        isMobile: d.isMobile ?? false,
        isAdmin: d.isAdmin ?? false,
      };
    });

    res.json(users);
  })
);

// (optional) GET /users/itsupport used by your Super Admin page
router.get(
  '/users/itsupport',
  asyncHandler(async (_req, res) => {
    const snap = await firestore.collection('users')
      .where('isITsupport', '==', true)
      .get();

    const users = snap.docs.map(doc => {
      const d = doc.data() || {};
      return {
        userId: d.userId || doc.id,
        username: d.username || '',
        firstName: d.firstName || '',
        middleName: d.middleName || '',
        lastName: d.lastName || '',
        email: d.email || '',
        isITsupport: d.isITsupport ?? true,
      };
    });

    res.json(users);
  })
);

module.exports = router;
