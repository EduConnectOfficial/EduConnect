// backend/routes/usersRoutes.js
const router = require('express').Router();
const bcrypt = require('bcrypt');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { uploadProfilePic } = require('../config/multerConfig');
const { generateRoleId } = require('../utils/idUtils');
const { encryptField, decryptField } = require('../utils/fieldCrypto');

const USERS_COL = 'users';

// ---------- helpers ----------
function decryptNamesFromDoc(d = {}) {
  return {
    firstName: decryptField(d.firstNameEnc || ''),
    middleName: decryptField(d.middleNameEnc || ''),
    lastName: decryptField(d.lastNameEnc || ''),
  };
}

// Make a safe user object for clients (strip password & decrypt names)
function shapeUserDecrypted(d, id) {
  if (!d) return null;
  const { password, firstNameEnc, middleNameEnc, lastNameEnc, ...rest } = d;

  const names = decryptNamesFromDoc(d);
  return {
    id,
    userId: d.userId || id,
    ...rest,
    ...names, // expose decrypted names as firstName/middleName/lastName
  };
}

// Build encrypted name updates from potential plaintext inputs
function maybeEncryptNameUpdates({ firstName, middleName, lastName }) {
  const updates = {};
  if (firstName != null) updates.firstNameEnc = encryptField(String(firstName));
  if (middleName != null) updates.middleNameEnc = encryptField(String(middleName));
  if (lastName != null) updates.lastNameEnc = encryptField(String(lastName));
  return updates;
}

// ---------- ROUTES ----------

/**
 * GET /api/users/:userId
 * Return a single user (decrypted names, no password)
 */
router.get('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const doc = await firestore.collection(USERS_COL).doc(userId).get();
  if (!doc.exists) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }
  return res.json({ success: true, user: shapeUserDecrypted(doc.data(), doc.id) });
}));

/**
 * GET /api/users
 * Optional filters: ?role=user|itsupport|admin|teacher|student & ?mobileOnly=true
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
  const users = snap.docs.map(d => shapeUserDecrypted(d.data(), d.id));
  res.json({ success: true, users });
}));

/**
 * POST /api/users/:userId/profile
 * multipart/form-data with optional profilePic
 * fields: firstName?, middleName?, lastName?, username?
 */
router.post('/:userId/profile',
  uploadProfilePic.single('profilePic'),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const file = req.file;

    const raw = {
      firstName: req.body.firstName,
      middleName: req.body.middleName,
      lastName: req.body.lastName,
    };

    const updates = {
      ...maybeEncryptNameUpdates(raw),
    };

    if (req.body.username != null) {
      updates.username = String(req.body.username);
    }

    if (file) {
      updates.photoURL = `/uploads/profile_pics/${file.filename}`;
    }

    await firestore.collection(USERS_COL).doc(userId).set(updates, { merge: true });
    // Return the merged user
    const doc = await firestore.collection(USERS_COL).doc(userId).get();
    return res.json({ success: true, user: shapeUserDecrypted(doc.data(), doc.id) });
  })
);

/**
 * PATCH /api/users/:userId
 * JSON body: firstName?, middleName?, lastName?, username?, password?
 * (names are written encrypted; password is hashed)
 */
router.patch('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { firstName, middleName, lastName, username, password } = req.body || {};

  const updates = {
    ...maybeEncryptNameUpdates({ firstName, middleName, lastName })
  };

  if (username != null) updates.username = String(username);

  if (password && String(password).trim() !== '') {
    updates.password = await bcrypt.hash(String(password), 10);
  }

  await firestore.collection(USERS_COL).doc(userId).set(updates, { merge: true });
  const doc = await firestore.collection(USERS_COL).doc(userId).get();
  res.json({ success: true, user: shapeUserDecrypted(doc.data(), doc.id) });
}));

/**
 * POST /api/users/:userId/change-password
 * JSON body: { currentPassword, newPassword }
 */
router.post('/:userId/change-password', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Missing currentPassword or newPassword.' });
  }

  const ref = firestore.collection(USERS_COL).doc(userId);
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

/**
 * GET /api/users/admins
 * Returns decrypted names, no passwords
 */
router.get('/admins/list', asyncHandler(async (_req, res) => {
  const snap = await firestore.collection(USERS_COL).where('isAdmin', '==', true).get();
  const users = snap.docs.map(doc => shapeUserDecrypted(doc.data(), doc.id));
  res.json({ success: true, users });
}));

/**
 * GET /api/users/itsupport
 * Returns decrypted names, no passwords
 */
router.get('/itsupport', asyncHandler(async (_req, res) => {
  const snap = await firestore.collection(USERS_COL).where('isITsupport', '==', true).get();
  const users = snap.docs.map(doc => shapeUserDecrypted(doc.data(), doc.id));
  res.json({ success: true, users });
}));

/**
 * DELETE /api/users/:id
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  await firestore.collection(USERS_COL).doc(userId).delete();
  res.json({ success: true, message: 'User deleted successfully.' });
}));

/**
 * PATCH /api/users/:id/status
 * body: { active: boolean }
 */
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { active } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Invalid active status.' });
  }
  await firestore.collection(USERS_COL).doc(userId).update({ active });
  const doc = await firestore.collection(USERS_COL).doc(userId).get();
  res.json({ success: true, message: `User ${active ? 'activated' : 'deactivated'} successfully.`, user: shapeUserDecrypted(doc.data(), doc.id) });
}));

/**
 * PATCH /api/users/:id/admin
 * body: { isAdmin: boolean }
 */
router.patch('/:id/admin', asyncHandler(async (req, res) => {
  const userId = decodeURIComponent(req.params.id);
  const { isAdmin } = req.body || {};
  if (typeof isAdmin !== 'boolean') {
    return res.status(400).json({ success: false, message: 'Invalid admin status.' });
  }
  const ref = firestore.collection(USERS_COL).doc(userId);
  await ref.update({ isAdmin });
  const doc = await ref.get();
  res.json({ success: true, message: `User admin access ${isAdmin ? 'granted' : 'revoked'}.`, user: shapeUserDecrypted(doc.data(), doc.id) });
}));

/**
 * PATCH /api/users/:id/itsupport
 * body: { isITsupport: boolean }
 */
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
  const updated = await ref.get();
  res.json({ success: true, message: `IT Support access ${isITsupport ? 'granted' : 'revoked'}.`, user: shapeUserDecrypted(updated.data(), updated.id) });
}));

/**
 * PATCH /api/users/:id/teacher
 * body: { isTeacher: boolean }
 * - assigns/removes teacherId
 */
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
  res.json({ success: true, user: shapeUserDecrypted(updated, userId) });
}));

/**
 * PATCH /api/users/:id/student
 * body: { isStudent: boolean }
 * - assigns studentId when enabling
 */
router.patch('/:id/student', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { isStudent } = req.body || {};
  if (typeof isStudent !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isStudent boolean required.' });
  }

  const ref = firestore.collection(USERS_COL).doc(userId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, message: 'User not found.' });

  const data = snap.data() || {};
  const updates = { isStudent };
  if (isStudent && !data.studentId) {
    updates.studentId = await generateRoleId('student'); // S-YYYY-xxxxx
  }
  if (!isStudent) {
    // You can choose to keep studentId for history; comment out to preserve
    // updates.studentId = admin.firestore.FieldValue.delete();
  }

  await ref.update(updates);
  const updated = (await ref.get()).data();
  res.json({ success: true, user: shapeUserDecrypted(updated, userId) });
}));

module.exports = router;
