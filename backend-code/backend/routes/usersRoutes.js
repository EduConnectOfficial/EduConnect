// backend/routes/usersRoutes.js
const router = require('express').Router();
const bcrypt = require('bcrypt');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin, bucket } = require('../config/firebase'); // ⬅️ include bucket

// memory uploader
const { uploadMemory } = require('../config/multerConfig');

// Cloud Storage helpers
const { saveBufferToStorage, buildStoragePath } = require('../services/storageService');

const { generateRoleId } = require('../utils/idUtils');
const { encryptField, safeDecrypt } = require('../utils/fieldCrypto');

const USERS_COL = 'users';

// ---------- helpers ----------
const normalizeEmail = (v) => String(v || '').trim().toLowerCase();

function decryptNamesFromDoc(d = {}) {
  return {
    firstName:  safeDecrypt(d.firstNameEnc  || d.firstName  || ''),
    middleName: safeDecrypt(d.middleNameEnc || d.middleName || ''),
    lastName:   safeDecrypt(d.lastNameEnc   || d.lastName   || ''),
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
  if (firstName != null)  updates.firstNameEnc  = encryptField(String(firstName));
  if (middleName != null) updates.middleNameEnc = encryptField(String(middleName));
  if (lastName != null)   updates.lastNameEnc   = encryptField(String(lastName));
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

/** Only run Multer if multipart. */
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

// Small helpers for profile overwrite
function extFromMime(mime = '') {
  const m = String(mime).toLowerCase();
  if (m.includes('jpeg')) return '.jpg';
  if (m.includes('jpg'))  return '.jpg';
  if (m.includes('png'))  return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif'))  return '.gif';
  return ''; // let it be extensionless if unknown
}

async function deleteFileIfExists(storagePath) {
  if (!storagePath) return;
  try {
    await bucket.file(storagePath).delete({ ignoreNotFound: true });
  } catch (err) {
    // soft fail; we don't want to block the request on delete issues
    console.warn('[usersRoutes] delete old profile failed:', storagePath, err?.message || err);
  }
}

// --- availability checks MUST come before "/:userId" ---

router.get('/check-username', asyncHandler(async (req, res) => {
  const username = String((req.query || {}).username || '').trim();
  if (!username) return res.status(400).json({ error: 'Username is required' });

  try {
    const snap = await firestore.collection(USERS_COL)
      .where('username', '==', username)
      .limit(1).get();
    return res.json({ taken: !snap.empty });
  } catch (err) {
    console.error('check-username failed:', err?.message || err);
    return res.json({ taken: false, _softFail: true });
  }
}));

router.get('/check-email', asyncHandler(async (req, res) => {
  const emailLower = normalizeEmail((req.query || {}).email);
  if (!emailLower) return res.status(400).json({ error: 'Email is required' });

  try {
    const snap = await firestore.collection(USERS_COL)
      .where('email', '==', emailLower)
      .limit(1).get();
    return res.json({ taken: !snap.empty });
  } catch (err) {
    console.error('check-email failed:', err?.message || err);
    return res.json({ taken: false, _softFail: true });
  }
}));

// ---------- ROUTES ----------

/** GET /api/users/:userId */
router.get('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const doc = await firestore.collection(USERS_COL).doc(userId).get();
  if (!doc.exists) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }
  return res.json({ success: true, user: shapeUserDecrypted(doc.data(), doc.id) });
}));

/** GET /api/users */
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

/** POST /api/users/:userId/profile (multipart or JSON) */
router.post(
  '/:userId/profile',
  maybeRunUploadSingle('profilePic'),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const file = req.file;

    const raw = {
      firstName: req.body.firstName,
      middleName: req.body.middleName,
      lastName: req.body.lastName,
    };

    const updates = { ...maybeEncryptNameUpdates(raw) };

    if (req.body.username != null) {
      const username = String(req.body.username);
      await assertUsernameAvailable(username, userId);
      updates.username = username;
    }

    // ⚙️ Profile picture overwrite flow
    if (file && file.buffer && file.originalname) {
      // 1) Load existing user to know prior storagePath (for cleanup)
      const userRef = firestore.collection(USERS_COL).doc(userId);
      const existingSnap = await userRef.get();
      const existing = existingSnap.exists ? existingSnap.data() : null;
      const priorStoragePath = existing?.photo?.storagePath;

      // 2) Choose a deterministic destination path (overwrite same key)
      const ext = extFromMime(file.mimetype) || (file.originalname.includes('.') ? ('.' + file.originalname.split('.').pop()) : '');
      // Prefer ext from mimetype; fallback to originalname if present
      const destPath = `profiles/${userId}/avatar${ext || ''}`;

      // 3) (Optional but safe) delete if path changed or object exists
      //    - If your bucket has versioning disabled (default), overwriting is fine.
      //    - We still delete any previous different path to clean up legacy uploads.
      if (priorStoragePath && priorStoragePath !== destPath) {
        await deleteFileIfExists(priorStoragePath);
      }
      // Also defensively delete the target key to ensure a fresh object
      await deleteFileIfExists(destPath);

      try {
        const saved = await saveBufferToStorage(file.buffer, {
          destPath,
          contentType: file.mimetype,
          metadata: {
            uploadedBy: userId,
            source: 'usersRoutes.profile',
            cacheControl: 'no-cache', // reduce stale caching
          },
        });

        // Cache-bust clients (esp. if they cached previous token/url)
        const ts = Date.now();
        const bust = saved.downloadUrl.includes('?') ? `&t=${ts}` : `?t=${ts}`;

        updates.photoURL = `${saved.downloadUrl}${bust}`;
        updates.photo = {
          originalName: file.originalname,
          size: file.size,
          mime: file.mimetype,
          gsUri: saved.gsUri,
          storagePath: saved.storagePath, // equals destPath
          publicUrl: saved.publicUrl,
          downloadUrl: saved.downloadUrl,
          token: saved.token,
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
          cacheBust: ts,
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

/** PATCH /api/users/:userId (names encrypted; password hashed) */
router.patch('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { firstName, middleName, lastName, username, password } = req.body || {};

  const updates = { ...maybeEncryptNameUpdates({ firstName, middleName, lastName }) };

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

/** POST /api/users/:userId/change-password */
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

/** GET /api/users/admins/list */
router.get('/admins/list', asyncHandler(async (_req, res) => {
  const snap = await firestore.collection(USERS_COL).where('isAdmin', '==', true).get();
  const users = snap.docs.map(doc => shapeUserDecrypted(doc.data(), doc.id));
  res.json({ success: true, users });
}));

/** GET /api/users/itsupport */
router.get('/itsupport', asyncHandler(async (_req, res) => {
  const snap = await firestore.collection(USERS_COL).where('isITsupport', '==', true).get();
  const users = snap.docs.map(doc => shapeUserDecrypted(doc.data(), doc.id));
  res.json({ success: true, users });
}));

/** DELETE /api/users/:id */
router.delete('/:id', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  await firestore.collection(USERS_COL).doc(userId).delete();
  res.json({ success: true, message: 'User deleted successfully.' });
}));

/** PATCH /api/users/:id/status */
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

/** PATCH /api/users/:id/active (alias) */
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

/** PATCH /api/users/:id/edit (admin edit; encrypted names; uniqueness checks) */
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

  if (typeof isMobile === 'boolean') updates.isMobile = isMobile;
  if (typeof isUser === 'boolean') updates.isUser = isUser;
  if (typeof isTeacher === 'boolean') updates.isTeacher = isTeacher;
  if (typeof isStudent === 'boolean') updates.isStudent = isStudent;
  if (typeof isITsupport === 'boolean') updates.isITsupport = isITsupport;

  if (photoURL != null) {
    updates.photoURL = String(photoURL);
  }

  await firestore.collection(USERS_COL).doc(userId).set(updates, { merge: true });
  const doc = await firestore.collection(USERS_COL).doc(userId).get();
  res.json({ success: true, user: shapeUserDecrypted(doc.data(), doc.id) });
}));

/** PATCH /api/users/:id/admin */
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

/** PATCH /api/users/:id/itsupport */
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

/** PATCH /api/users/:id/teacher */
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
    updates.teacherId = data.teacherId || (await generateRoleId('teacher'));
    if (data.isUser === undefined) updates.isUser = true;
  } else {
    updates.teacherId = admin.firestore.FieldValue.delete();
  }

  await ref.update(updates);
  const updated = (await ref.get()).data();
  res.json({ success: true, user: shapeUserDecrypted(updated, userId) });
}));

/** PATCH /api/users/:id/student */
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
    updates.studentId = await generateRoleId('student');
  }

  await ref.update(updates);
  const updated = (await ref.get()).data();
  res.json({ success: true, user: shapeUserDecrypted(updated, userId) });
}));

module.exports = router;
