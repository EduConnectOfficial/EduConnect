// backend/routes/usersRoutes.js
const router = require('express').Router();
const bcrypt = require('bcrypt');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { uploadProfilePic } = require('../config/multerConfig');
const { generateRoleId } = require('../utils/idUtils'); // NEW
const USERS_COL = 'users';                               // NEW


// sanitize helper (don’t send password hashes to client)
function shapeUser(d, id) {
  if (!d) return null;
  const {
    password, // strip
    ...rest
  } = d;
  return { id, userId: d.userId || id, ...rest };
}

/* ===========================
   GET /api/users/:userId
   =========================== */
router.get('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const doc = await firestore.collection('users').doc(userId).get();
  if (!doc.exists) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }
  return res.json({ success: true, user: shapeUser(doc.data(), doc.id) });
}));

/* (optional) list users
   GET /api/users
*/
router.get('/', asyncHandler(async (req, res) => {
  const role = (req.query.role || '').toString().toLowerCase();
  const mobileOnly = String(req.query.mobileOnly || '') === 'true';

  let q = firestore.collection(USERS_COL);

  if (mobileOnly) {
    q = q.where('isMobile', '==', true);
  } else if (role === 'user') {
    q = q.where('isUser', '==', true).where('isMobile', '==', true);
  } else if (role === 'itsupport') {
    q = q.where('isITsupport', '==', true);
  } else if (role === 'admin') {
    q = q.where('isAdmin', '==', true);
  } else if (role === 'teacher') {
    q = q.where('isTeacher', '==', true);
  } else if (role === 'student') {
    q = q.where('isStudent', '==', true);
  }

  const snap = await q.get();
  const users = snap.docs.map(d => {
    const u = d.data() || {};
    // keep your current response style
    const { password, ...rest } = u;
    return { id: d.id, userId: u.userId || d.id, ...rest };
  });

  res.json({ success: true, users });
}));


/* ===========================
   POST /api/users/:userId/profile
   multipart/form-data with optional profilePic
   fields: firstName, middleName, lastName, username
   =========================== */
router.post('/:userId/profile',
  uploadProfilePic.single('profilePic'),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const file = req.file;

    const updateData = {};
    ['firstName', 'middleName', 'lastName', 'username'].forEach(k => {
      if (req.body[k] != null) updateData[k] = String(req.body[k]);
    });
    if (file) {
      updateData.photoURL = `/uploads/profile_pics/${file.filename}`;
    }

    await firestore.collection('users').doc(userId).set(updateData, { merge: true });
    return res.json({ success: true, updatedUser: updateData });
  })
);

/* ===========================
   PATCH /api/users/:userId
   JSON body: firstName?, middleName?, lastName?, username?, password?
   =========================== */
router.patch('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { firstName, middleName, lastName, username, password } = req.body;

  const updateData = {};
  if (firstName != null)  updateData.firstName  = String(firstName);
  if (middleName != null) updateData.middleName = String(middleName);
  if (lastName != null)   updateData.lastName   = String(lastName);
  if (username != null)   updateData.username   = String(username);

  if (password && String(password).trim() !== '') {
    updateData.password = await bcrypt.hash(String(password), 10);
  }

  await firestore.collection('users').doc(userId).set(updateData, { merge: true });
  res.json({ success: true });
}));

/* ===========================
   POST /api/users/:userId/change-password
   JSON body: { currentPassword, newPassword }
   =========================== */
router.post('/:userId/change-password', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Missing currentPassword or newPassword.' });
  }

  const ref = firestore.collection('users').doc(userId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'User not found.' });

  const user = snap.data() || {};
  if (!user.password) {
    return res.status(400).json({ success: false, error: 'No password set for this account.' });
  }

  const ok = await bcrypt.compare(String(currentPassword), user.password);
  if (!ok) return res.status(401).json({ success: false, error: 'Current password is incorrect.' });

  const hashed = await bcrypt.hash(String(newPassword), 10);
  await ref.update({ password: hashed });

  return res.json({ success: true, message: 'Password updated.' });
}));

// GET /api/users/admins
router.get('/admins', asyncHandler(async (_req, res) => {
  const snap = await firestore.collection(USERS_COL).where('isAdmin', '==', true).get();
  const admins = snap.docs.map(doc => {
    const d = doc.data() || {};
    return {
      firstName: d.firstName || '',
      middleName: d.middleName || '',
      lastName: d.lastName || '',
      username: d.username || '',
      email: d.email || '',
      active: d.active ?? true,
      isAdmin: true
    };
  });
  res.json({ success: true, users: admins });
}));

// GET /api/users/itsupport
router.get('/itsupport', asyncHandler(async (_req, res) => {
  const snap = await firestore.collection(USERS_COL).where('isITsupport', '==', true).get();
  const it = snap.docs.map(doc => {
    const d = doc.data() || {};
    return {
      userId: d.userId || doc.id,
      firstName: d.firstName || '',
      middleName: d.middleName || '',
      lastName: d.lastName || '',
      username: d.username || '',
      email: d.email || '',
      isITsupport: d.isITsupport ?? false
    };
  });
  res.json({ success: true, users: it });
}));

// DELETE /api/users/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  await firestore.collection(USERS_COL).doc(userId).delete();
  res.json({ success: true, message: 'User deleted successfully.' });
}));

// PATCH /api/users/:id/status   body: { active: boolean }
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { active } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Invalid active status.' });
  }
  await firestore.collection(USERS_COL).doc(userId).update({ active });
  res.json({ success: true, message: `User ${active ? 'activated' : 'deactivated'} successfully.` });
}));

// PATCH /api/users/:id/admin       body: { isAdmin: boolean }
router.patch('/:id/admin', asyncHandler(async (req, res) => {
  const userId = decodeURIComponent(req.params.id);
  const { isAdmin } = req.body || {};
  if (typeof isAdmin !== 'boolean') {
    return res.status(400).json({ success: false, message: 'Invalid admin status.' });
  }
  await firestore.collection(USERS_COL).doc(userId).update({ isAdmin });
  res.json({ success: true, message: `User admin access ${isAdmin ? 'granted' : 'revoked'}.` });
}));

// PATCH /api/users/:id/itsupport   body: { isITsupport: boolean }
router.patch('/:id/itsupport', asyncHandler(async (req, res) => {
  const userId = decodeURIComponent(req.params.id);
  const { isITsupport } = req.body || {};
  if (typeof isITsupport !== 'boolean') {
    return res.status(400).json({ success: false, message: 'Missing isITsupport boolean.' });
  }
  const ref = firestore.collection(USERS_COL).doc(userId);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'User not found.' });
  await ref.update({ isITsupport });
  res.json({ success: true, message: `IT Support access ${isITsupport ? 'granted' : 'revoked'}.` });
}));

// PATCH /api/users/:id/teacher     body: { isTeacher: boolean }
router.patch('/:id/teacher', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { isTeacher } = req.body || {};
  if (typeof isTeacher !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isTeacher must be boolean.' });
  }

  const ref = firestore.collection(USERS_COL).doc(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  const data = snap.data() || {};
  const updates = { isTeacher };

  if (isTeacher) {
    updates.teacherId = data.teacherId || (await generateRoleId('teacher')); // T-YYYY-xxxxx
    if (data.isUser === undefined) updates.isUser = true; // optional baseline
  } else {
    updates.teacherId = admin.firestore.FieldValue.delete();
  }

  await ref.update(updates);
  const updated = (await ref.get()).data();
  res.json({ success: true, user: { userId, ...updated } });
}));

// PATCH /api/users/:id/student     body: { isStudent: boolean }
router.patch('/:id/student', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { isStudent } = req.body || {};
  if (typeof isStudent !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isStudent boolean required.' });
  }

  const ref = firestore.collection(USERS_COL).doc(userId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, message: 'User not found.' });

  const updates = { isStudent };
  if (isStudent && !snap.data()?.studentId) {
    updates.studentId = await generateRoleId('student'); // S-YYYY-xxxxx
  }

  await ref.update(updates);
  res.json({ success: true, ...updates });
}));

// GET /api/users/itsupport
router.get('/itsupport', asyncHandler(async (_req, res) => {
  const snap = await firestore.collection('users').where('isITsupport', '==', true).get();
  const users = snap.docs.map(doc => {
    const d = doc.data() || {};
    return {
      userId: d.userId || doc.id,
      firstName: d.firstName || '',
      middleName: d.middleName || '',
      lastName: d.lastName || '',
      username: d.username || '',
      email: d.email || '',
      isITsupport: d.isITsupport ?? false
    };
  });
  res.json({ success: true, users });
}));

// Activate/Deactivate
router.patch('/:userId/status', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { active } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ success: false, message: 'Invalid active status.' });
  }
  await firestore.collection('users').doc(userId).set({ active }, { merge: true });
  res.json({ success: true, message: `User ${active ? 'activated' : 'deactivated'} successfully.` });
}));

// Delete
router.delete('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  await firestore.collection('users').doc(userId).delete();
  res.json({ success: true, message: 'User deleted successfully.' });
}));


// KEEP THIS ONE LAST so it doesn't swallow "/itsupport"
router.get('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const doc = await firestore.collection('users').doc(userId).get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({ success: true, user: { id: doc.id, userId: doc.id, ...doc.data() } });
}));

module.exports = router;
