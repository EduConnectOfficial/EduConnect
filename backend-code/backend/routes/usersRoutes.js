// backend/routes/usersRoutes.js
const router = require('express').Router();
const bcrypt = require('bcrypt');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');

// ⬇️ switch from disk -> memory uploader
const { uploadMemory } = require('../config/multerConfig');

// ⬇️ Cloud Storage helpers
const { saveBufferToStorage, buildStoragePath } = require('../services/storageService');

const { generateRoleId } = require('../utils/idUtils');
const { encryptField, decryptField } = require('../utils/fieldCrypto');

const USERS_COL = 'users';

// ---------- helpers ----------
const normalizeEmail = (v) => String(v || '').trim().toLowerCase();

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
function maybeEncryptNameUpdates({ firstName, middleName, lastName } = {}) {
  const updates = {};
  if (firstName != null) updates.firstNameEnc = encryptField(String(firstName));
  if (middleName != null) updates.middleNameEnc = encryptField(String(middleName));
  if (lastName != null) updates.lastNameEnc = encryptField(String(lastName));
  return updates;
}

// Uniqueness checks
async function assertEmailAvailable(emailLower, excludeUserId = null) {
  if (!emailLower) return;
  const snap = await firestore.collection(USERS_COL).where('email', '==', emailLower).get();
  const taken = snap.docs.some(d => d.id !== excludeUserId);
  if (taken) {
    const err = new Error('Email already in use.');
    err.status = 400;
    throw err;
  }
}
async function assertUsernameAvailable(username, excludeUserId = null) {
  if (!username) return;
  const snap = await firestore.collection(USERS_COL).where('username', '==', username).get();
  const taken = snap.docs.some(d => d.id !== excludeUserId);
  if (taken) {
    const err = new Error('Username already in use.');
    err.status = 400;
    throw err;
  }
}

/**
 * Small helper: only run Multer if multipart.
 * Keeps JSON-only requests happy on the profile route.
 */
function maybeRunUploadSingle(field) {
  const mw = uploadMemory.single(field);
  return (req, res, next) => {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('multipart/form-data')) return next();
    mw(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: 'File too large.' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ success: false, message: `Unexpected file field: "${err.field}".` });
      }
      return next(err);
    });
  };
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
 * Optional filters:
 *   ?role=user|itsupport|admin|teacher|student
 *   ?mobileOnly=true
 *   ?isAdmin=true  <-- added for convenience
 */
router.get('/', asyncHandler(async (req, res) => {
  const role = (req.query.role || '').toString().toLowerCase();
  const mobileOnly = String(req.query.mobileOnly || '') === 'true';
  const isAdminFlag = String(req.query.isAdmin || '') === 'true';

  let q = firestore.collection(USERS_COL);

  if (mobileOnly) {
    q = q.where('isMobile', '==', true);
  } else if (role === 'user') {
    q = q.where('isUser', '==', true).where('isMobile', '==', true);
  } else if (role === 'itsupport') {
    q = q.where('isITsupport', '==', true);
  } else if (role === 'admin' || isAdminFlag) {
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
 *
 * ⬇️ Refactored to store profilePic in Firebase Cloud Storage
 */
router.post(
  '/:userId/profile',
  maybeRunUploadSingle('profilePic'), // only parses if multipart
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const file = req.file; // from uploadMemory.single('profilePic'), if present

    const raw = {
      firstName: req.body.firstName,
      middleName: req.body.middleName,
      lastName: req.body.lastName,
    };

    const updates = {
      ...maybeEncryptNameUpdates(raw),
    };

    if (req.body.username != null) {
      const username = String(req.body.username);
      await assertUsernameAvailable(username, userId);
      updates.username = username;
    }

    /// ---------- in /:userId/profile ----------
if (file && file.buffer && file.originalname) {
  // Path like: profiles/{userId}/{timestamp_safeName.ext}
  const destPath = buildStoragePath('profiles', userId, file.originalname);
  try {
    const saved = await saveBufferToStorage(file.buffer, {
      destPath,
      contentType: file.mimetype,
      metadata: {
        uploadedBy: userId,
        source: 'usersRoutes.profile',
      },
    });

    // ✅ Use downloadUrl for reliable access (token-based)
    updates.photoURL = saved.downloadUrl;

    // (Optional) keep storage pointer fields for admin/debugging
    updates.photo = {
      originalName: file.originalname,
      size: file.size,
      mime: file.mimetype,
      gsUri: saved.gsUri,
      storagePath: saved.storagePath,    // 👈 add this
      publicUrl: saved.publicUrl,        // still stored for completeness
      downloadUrl: saved.downloadUrl,    // 👈 add this
      token: saved.token,                // 👈 add this
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: 'Failed to upload profile picture.',
      error: e.message || 'upload_error',
    });
  }
}


    await firestore.collection(USERS_COL).doc(userId).set(updates, { merge: true });

    const doc = await firestore.collection(USERS_COL).doc(userId).get();
    const shaped = shapeUserDecrypted(doc.data(), doc.id);
    return res.json({ success: true, user: shaped, updatedUser: shaped });
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

  if (username != null) {
    const uname = String(username);
    await assertUsernameAvailable(uname, userId);
    updates.username = uname;
  }

  if (password && String(password).trim() !== '') {
    updates.password = await bcrypt.hash(String(password), 10);
  }

  await firestore.collection(USERS_COL).doc(userId).set(updates, { merge: true });
  const doc = await firestore.collection(USERS_COL).doc(userId).get();
  const shaped = shapeUserDecrypted(doc.data(), doc.id);
  res.json({ success: true, user: shaped, updatedUser: shaped });
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
 * GET /api/users/admins/list
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
 * (De/activate account — keep role; no revocation)
 */
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { active } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Invalid active status.' });
  }
  await firestore.collection(USERS_COL).doc(userId).update({ active });
  const doc = await firestore.collection(USERS_COL).doc(userId).get();
  res.json({
    success: true,
    message: `User ${active ? 'activated' : 'deactivated'} successfully.`,
    user: shapeUserDecrypted(doc.data(), doc.id)
  });
}));

/**
 * PATCH /api/users/:id/active
 * Alias of /:id/status for convenience
 */
router.patch('/:id/active', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { active } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Invalid active status.' });
  }
  await firestore.collection(USERS_COL).doc(userId).update({ active });
  const doc = await firestore.collection(USERS_COL).doc(userId).get();
  res.json({
    success: true,
    message: `User ${active ? 'activated' : 'deactivated'} successfully.`,
    user: shapeUserDecrypted(doc.data(), doc.id)
  });
}));

/**
 * PATCH /api/users/:id/edit
 * Admin edit of user fields (no admin revocation here).
 * Body supports (all optional):
 *   { username, email, firstName, middleName, lastName,
 *     isMobile, isUser, isTeacher, isStudent, isITsupport, photoURL }
 * - Names are stored encrypted
 * - Username & email uniqueness enforced
 * - DOES NOT change isAdmin (to avoid revocation here)
 */
router.patch('/:id/edit', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const {
    username,
    email,
    firstName,
    middleName,
    lastName,
    isMobile,
    isUser,
    isTeacher,
    isStudent,
    isITsupport,
    photoURL
  } = req.body || {};

  const updates = {
    ...maybeEncryptNameUpdates({ firstName, middleName, lastName })
  };

  if (username != null) {
    const uname = String(username);
    await assertUsernameAvailable(uname, userId);
    updates.username = uname;
  }

  if (email != null) {
    const emailLower = normalizeEmail(email);
    await assertEmailAvailable(emailLower, userId);
    updates.email = emailLower;
  }

  // Optional booleans
  if (typeof isMobile === 'boolean') updates.isMobile = isMobile;
  if (typeof isUser === 'boolean') updates.isUser = isUser;
  if (typeof isTeacher === 'boolean') updates.isTeacher = isTeacher;
  if (typeof isStudent === 'boolean') updates.isStudent = isStudent;
  if (typeof isITsupport === 'boolean') updates.isITsupport = isITsupport;

  if (photoURL != null) {
    updates.photoURL = String(photoURL);
  }

  // NOTE: Intentionally not touching isAdmin here (no revocation in "edit")
  await firestore.collection(USERS_COL).doc(userId).set(updates, { merge: true });

  const doc = await firestore.collection(USERS_COL).doc(userId).get();
  res.json({ success: true, user: shapeUserDecrypted(doc.data(), doc.id) });
}));

/**
 * PATCH /api/users/:id/admin
 * body: { isAdmin: boolean }
 * (Keep if you still need a separate explicit admin grant/revoke endpoint)
 */
router.patch('/:id/admin', asyncHandler(async (req, res) => {
  const userId = decodeURIComponent(req.params.id);
  const { isAdmin: isAdminFlag } = req.body || {};
  if (typeof isAdminFlag !== 'boolean') {
    return res.status(400).json({ success: false, message: 'Invalid admin status.' });
  }
  const ref = firestore.collection(USERS_COL).doc(userId);
  await ref.update({ isAdmin: isAdminFlag });
  const doc = await ref.get();
  res.json({
    success: true,
    message: `User admin access ${isAdminFlag ? 'granted' : 'revoked'}.`,
    user: shapeUserDecrypted(doc.data(), doc.id)
  });
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
  res.json({
    success: true,
    message: `IT Support access ${isITsupport ? 'granted' : 'revoked'}.`,
    user: shapeUserDecrypted(updated.data(), updated.id)
  });
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
  // Optional: keep studentId for history
  // if (!isStudent) updates.studentId = admin.firestore.FieldValue.delete();

  await ref.update(updates);
  const updated = (await ref.get()).data();
  res.json({ success: true, user: shapeUserDecrypted(updated, userId) });
}));

module.exports = router;
