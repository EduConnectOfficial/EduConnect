// ==== routes/authRoutes.js ==== //
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { sendVerificationEmail, transporter } = require('../config/email');
const { generateRoleId } = require('../utils/idUtils');
const { encryptField, decryptField } = require('../utils/fieldCrypto');

// --- in-memory stores (signup + reset flows) ---
// Key ALL of these by normalized email (lowercased + trimmed)
const verificationStore = Object.create(null);   // { [emailLower]: { code, expiresAt, userData } }
const verificationCodes = new Map();             // Map<emailLower, { code, expiresAt }>
const resetTokens = Object.create(null);         // { [emailLower]: { token, expires } }

// helpers
const normalizeEmail = (v) => String(v || '').trim().toLowerCase();
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// lockout policy
const TEMP_LOCK_THRESHOLD_MIN = 3;     // 3–4 -> temp lock
const TEMP_LOCK_THRESHOLD_MAX = 4;
const TEMP_LOCK_MINUTES = 3;           // <-- 3 minutes as requested
const DEACTIVATE_THRESHOLD_MIN = 5;    // 5–10 -> set active=false
const DEACTIVATE_THRESHOLD_MAX = 10;

// NEW: Pending signup persistence (to make resend robust)
const PENDING_COLL = 'pending_signups';
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute cooldown between resends

// robust converter: Firestore Timestamp | number | string -> millis (or 0)
function tsToMillis(v) {
  if (!v) return 0;
  try {
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v === 'number') return v;
    const d = new Date(v);
    const m = d.getTime();
    return Number.isFinite(m) ? m : 0;
  } catch { return 0; }
}

function unpackNamesFromDoc(userDocData) {
  return {
    firstName: decryptField(userDocData.firstNameEnc || ''),
    middleName: decryptField(userDocData.middleNameEnc || ''),
    lastName: decryptField(userDocData.lastNameEnc || ''),
  };
}

/* ======================================================================
   AUTH: SIGNUP
   - Stash minimal info and a code (no IDs yet)
   - Persist pending signup in Firestore so resend works after restarts
====================================================================== */
router.post('/signup', asyncHandler(async (req, res) => {
  let {
    firstName, middleName, lastName, username, email, password,
    isUser, isAdmin, isMobile, isTeacher, isStudent
  } = req.body || {};

  const emailLower = normalizeEmail(email);

  if (!firstName || !lastName || !username || !emailLower || !password) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Ensure uniqueness in persisted users (not pending)
  const emailSnapshot = await firestore.collection('users').where('email', '==', emailLower).limit(1).get();
  if (!emailSnapshot.empty) return res.status(400).json({ error: 'Email already registered.' });

  const usernameSnapshot = await firestore.collection('users').where('username', '==', username).limit(1).get();
  if (!usernameSnapshot.empty) return res.status(400).json({ error: 'Username already taken.' });

  // Generate verification code, store *without* IDs
  const code = generateCode();
  const now = Date.now();
  const expiresAtMs = now + 15 * 60 * 1000; // 15 minutes

  verificationStore[emailLower] = {
    code,
    expiresAt: expiresAtMs,
    userData: {
      // NO userId / studentId / teacherId / adminId yet
      firstName,
      middleName,
      lastName,
      username,
      email: emailLower, // store normalized email
      password, // plaintext in memory only; will be hashed on verify
      active: true,
      isUser: isUser !== false,
      isAdmin: !!isAdmin,
      isMobile: !!isMobile,
      isTeacher: !!isTeacher,
      isStudent: !!isStudent,
      createdAtLocalIso: new Date(now).toISOString(),
    },
  };

  // Persist a minimal, encrypted pending record so resends survive restarts
  const pendingRef = firestore.collection(PENDING_COLL).doc(emailLower);
  await pendingRef.set({
    email: emailLower,
    username,
    // encrypt sensitive fields (we'll decrypt on verify)
    firstNameEnc: encryptField(firstName),
    middleNameEnc: encryptField(middleName || ''),
    lastNameEnc: encryptField(lastName),
    passwordEnc: encryptField(password),
    isUser: isUser !== false,
    isAdmin: !!isAdmin,
    isMobile: !!isMobile,
    isTeacher: !!isTeacher,
    isStudent: !!isStudent,
    code,
    expiresAtMs,
    lastSentAtMs: now,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  try {
    await sendVerificationEmail(emailLower, code);
  } catch (err) {
    delete verificationStore[emailLower];
    // clean pending doc too
    await pendingRef.delete().catch(() => {});
    return res.status(500).json({ error: 'Failed to send verification email.' });
  }

  res.json({
    message: 'Verification code sent to your email. Complete verification to finish signup.',
  });
}));

/* ======================================================================
   VERIFY SIGNUP CODE
   - Mint userId / studentId / teacherId / adminId here
   - Encrypt names before persisting (no plaintext saved)
   - Falls back to Firestore pending doc if memory lost
====================================================================== */
router.post('/verify-code', asyncHandler(async (req, res) => {
  const emailLower = normalizeEmail(req.body && req.body.email);
  const { code } = req.body || {};

  let record = verificationStore[emailLower];

  // If memory was lost (restart), load pending from Firestore
  if (!record) {
    const pendingSnap = await firestore.collection(PENDING_COLL).doc(emailLower).get();
    if (pendingSnap.exists) {
      const p = pendingSnap.data();
      record = {
        code: p.code,
        expiresAt: Number(p.expiresAtMs) || 0,
        userData: {
          firstName: decryptField(p.firstNameEnc || ''),
          middleName: decryptField(p.middleNameEnc || ''),
          lastName: decryptField(p.lastNameEnc || ''),
          username: p.username,
          email: p.email,
          password: decryptField(p.passwordEnc || ''), // will be hashed below
          active: true,
          isUser: !!p.isUser,
          isAdmin: !!p.isAdmin,
          isMobile: !!p.isMobile,
          isTeacher: !!p.isTeacher,
          isStudent: !!p.isStudent,
          createdAtLocalIso: new Date().toISOString(),
        },
      };
      // repopulate memory for the rest of the flow
      verificationStore[emailLower] = record;
    }
  }

  if (!record) return res.status(400).json({ error: 'No verification code found.' });

  if (Date.now() > record.expiresAt) {
    delete verificationStore[emailLower];
    // remove stale pending doc as well
    await firestore.collection(PENDING_COLL).doc(emailLower).delete().catch(() => {});
    return res.status(400).json({ error: 'Verification code expired.' });
  }
  if (record.code !== code) return res.status(400).json({ error: 'Incorrect verification code.' });

  const { userData } = record;
  const {
    firstName, middleName, lastName, username, password,
    isUser, isAdmin, isMobile, isTeacher, isStudent,
  } = userData;

  // Re-check uniqueness (race-safe)
  const emailSnapshot = await firestore.collection('users').where('email', '==', emailLower).limit(1).get();
  if (!emailSnapshot.empty) {
    delete verificationStore[emailLower];
    await firestore.collection(PENDING_COLL).doc(emailLower).delete().catch(() => {});
    return res.status(400).json({ error: 'Email already registered. Please log in.' });
  }

  const usernameSnapshot = await firestore.collection('users').where('username', '==', username).limit(1).get();
  if (!usernameSnapshot.empty) {
    delete verificationStore[emailLower];
    await firestore.collection(PENDING_COLL).doc(emailLower).delete().catch(() => {});
    return res.status(400).json({ error: 'Username already taken. Please sign up again with a different username.' });
  }

  // ✅ Mint IDs
  const userId = uuidv4();
  let studentId = null;
  let teacherId = null;
  let adminId   = null;

  if (isStudent) studentId = await generateRoleId('student');
  if (isTeacher) teacherId = await generateRoleId('teacher');
  if (isAdmin)   adminId   = await generateRoleId('admin');

  // Hash & persist (ENCRYPT names, DO NOT store plaintext)
  const hashedPassword = await bcrypt.hash(password, 10);

  const toStore = {
    userId,
    // names (encrypted)
    firstNameEnc: encryptField(firstName),
    middleNameEnc: encryptField(middleName || ''),
    lastNameEnc: encryptField(lastName),

    // DO NOT store plaintext name fields
    username,
    email: emailLower,
    password: hashedPassword,
    active: true,
    failedLoginAttempts: 0,
    lockedUntil: null,

    isUser: isUser !== false,
    isAdmin: !!isAdmin,
    isMobile: !!isMobile,
    isTeacher: !!isTeacher,
    isStudent: !!isStudent,
    ...(studentId ? { studentId } : {}),
    ...(teacherId ? { teacherId } : {}),
    ...(adminId   ? { adminId   } : {}),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await firestore.collection('users').doc(userId).set(toStore);

  // clear pending (memory + Firestore)
  delete verificationStore[emailLower];
  await firestore.collection(PENDING_COLL).doc(emailLower).delete().catch(() => {});

  // Prepare response with DECRYPTED names for convenience
  res.json({
    message: 'User verified and registered successfully.',
    user: {
      userId,
      email: emailLower,
      username,
      firstName,
      middleName: middleName || '',
      lastName,
      isAdmin: !!isAdmin,
      isUser: isUser !== false,
      isTeacher: !!isTeacher,
      isStudent: !!isStudent,
      ...(studentId ? { studentId } : {}),
      ...(teacherId ? { teacherId } : {}),
      ...(adminId   ? { adminId   } : {}),
    }
  });
}));

/* ======================================================================
   RESEND VERIFICATION CODE
   - Works even after server restarts (Firestore fallback)
   - 1-minute cooldown to prevent spam
====================================================================== */
router.post('/resend-code', asyncHandler(async (req, res) => {
  const emailLower = normalizeEmail(req.body && req.body.email);
  if (!emailLower) return res.status(400).json({ error: 'Email is required.' });

  // Try in-memory first
  let pending = verificationStore[emailLower];

  // Also load from Firestore (fallback or to apply cooldown)
  const docRef = firestore.collection(PENDING_COLL).doc(emailLower);
  const snap = await docRef.get();
  const fsPending = snap.exists ? snap.data() : null;

  if (!pending && !fsPending) {
    return res.status(400).json({ error: 'No pending verification found for this email.' });
  }

  // Cooldown (use whichever source has the timestamp)
  const now = Date.now();
  const lastSentAtMs = fsPending?.lastSentAtMs ?? now - RESEND_COOLDOWN_MS - 1;
  const diff = now - lastSentAtMs;
  if (diff < RESEND_COOLDOWN_MS) {
    const waitMs = RESEND_COOLDOWN_MS - diff;
    return res.status(429).json({
      error: 'Please wait before requesting another code.',
      retryAfterMs: waitMs
    });
  }

  // If memory missing, rebuild from Firestore so /verify-code will work seamlessly
  if (!pending && fsPending) {
    pending = {
      code: fsPending.code,
      expiresAt: Number(fsPending.expiresAtMs) || (now + 15 * 60 * 1000),
      userData: {
        firstName: decryptField(fsPending.firstNameEnc || ''),
        middleName: decryptField(fsPending.middleNameEnc || ''),
        lastName: decryptField(fsPending.lastNameEnc || ''),
        username: fsPending.username,
        email: fsPending.email,
        password: decryptField(fsPending.passwordEnc || ''),
        active: true,
        isUser: !!fsPending.isUser,
        isAdmin: !!fsPending.isAdmin,
        isMobile: !!fsPending.isMobile,
        isTeacher: !!fsPending.isTeacher,
        isStudent: !!fsPending.isStudent,
        createdAtLocalIso: new Date().toISOString(),
      },
    };
    verificationStore[emailLower] = pending;
  }

  // Issue a new code + new expiry
  const newCode = generateCode();
  const newExpiresAtMs = now + 15 * 60 * 1000;

  pending.code = newCode;
  pending.expiresAt = newExpiresAtMs;

  // Reflect in Firestore
  await docRef.set({
    ...(fsPending || {}),
    email: emailLower,
    username: pending.userData.username,
    firstNameEnc: encryptField(pending.userData.firstName),
    middleNameEnc: encryptField(pending.userData.middleName || ''),
    lastNameEnc: encryptField(pending.userData.lastName),
    passwordEnc: encryptField(pending.userData.password),
    isUser: !!pending.userData.isUser,
    isAdmin: !!pending.userData.isAdmin,
    isMobile: !!pending.userData.isMobile,
    isTeacher: !!pending.userData.isTeacher,
    isStudent: !!pending.userData.isStudent,
    code: newCode,
    expiresAtMs: newExpiresAtMs,
    lastSentAtMs: now,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  try {
    await sendVerificationEmail(emailLower, newCode);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to resend verification email.' });
  }

  res.json({
    message: 'Verification code resent.',
    expiresAt: newExpiresAtMs
  });
}));

/* ======================================================================
   CHECK EMAIL / USERNAME AVAILABILITY
====================================================================== */
router.get('/check-email', asyncHandler(async (req, res) => {
  const emailLower = normalizeEmail((req.query || {}).email);
  if (!emailLower) return res.status(400).json({ error: 'Email is required' });

  const snapshot = await firestore.collection('users').where('email', '==', emailLower).limit(1).get();
  res.json({ taken: !snapshot.empty });
}));

router.get('/check-username', asyncHandler(async (req, res) => {
  const { username } = req.query || {};
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const snapshot = await firestore.collection('users').where('username', '==', username).limit(1).get();
  res.json({ taken: !snapshot.empty });
}));

/* ======================================================================
   LOGIN  (with lockout policy + decrypted names in response)
====================================================================== */
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const qs = await firestore
    .collection('users')
    .where('username', '==', username)
    .limit(1)
    .get();

  if (qs.empty) return res.status(401).json({ error: 'Invalid username or password.' });

  const userDoc = qs.docs[0];
  const user = userDoc.data();

  // If previously locked, check if lock expired; if expired, clear it (but keep attempts)
  const nowMs = Date.now();
  const lockedUntilMs = tsToMillis(user.lockedUntil);
  if (lockedUntilMs && lockedUntilMs > nowMs) {
    const secondsLeft = Math.ceil((lockedUntilMs - nowMs) / 1000);
    return res.status(423).json({
      error: `Account temporarily locked. Try again in ${secondsLeft}s.`,
      lockedUntil: lockedUntilMs,
    });
  } else if (lockedUntilMs && lockedUntilMs <= nowMs) {
    // lock expired, clear it
    await userDoc.ref.update({ lockedUntil: null });
  }

  // Check active flag (could have been deactivated due to many failures)
  if (user.active === false) {
    return res.status(403).json({ error: 'Account is deactivated due to multiple failed attempts. Please contact admin or reset your password.' });
  }

  if (!user.password || typeof user.password !== 'string') {
    return res.status(500).json({ error: 'Account has no password set. Please reset your password.' });
  }
  if (!user.password.startsWith('$2')) {
    return res.status(500).json({ error: 'Stored password is invalid. Please reset your password.' });
  }

  const ok = await bcrypt.compare(String(password), user.password);

  if (!ok) {
    // increment attempts
    const attempts = (user.failedLoginAttempts || 0) + 1;
    const updates = {
      failedLoginAttempts: attempts,
      lastFailedLogin: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Apply policy
    if (attempts >= TEMP_LOCK_THRESHOLD_MIN && attempts <= TEMP_LOCK_THRESHOLD_MAX) {
      const lockUntilDate = new Date(Date.now() + TEMP_LOCK_MINUTES * 60 * 1000);
      updates.lockedUntil = admin.firestore.Timestamp.fromDate(lockUntilDate);
      await userDoc.ref.update(updates);
      return res.status(423).json({
        error: `Too many failed attempts. Account locked for ${TEMP_LOCK_MINUTES} minutes.`,
        lockedUntil: lockUntilDate.getTime(),
      });
    }

    if (attempts >= DEACTIVATE_THRESHOLD_MIN) {
      // 5+ -> deactivate
      updates.active = false;
      updates.lockedUntil = null;
      await userDoc.ref.update(updates);
      return res.status(403).json({
        error: 'Account deactivated after too many failed attempts. Please contact admin or reset your password.',
      });
    }

    // Otherwise just record the failed attempt
    await userDoc.ref.update(updates);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Successful login: reset counters and clear locks
  await userDoc.ref.update({
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLogin: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Decrypt names for response
  const names = unpackNamesFromDoc(user);

  res.json({
    message: 'Login successful!',
    user: {
      userId: user.userId,
      username: user.username,
      email: user.email,
      fullName: `${names.firstName} ${names.lastName}`.trim(),
      firstName: names.firstName,
      middleName: names.middleName,
      lastName: names.lastName,
      isAdmin: !!user.isAdmin,
      isUser: !!user.isUser,
      isTeacher: !!user.isTeacher,
      isStudent: !!user.isStudent,
      ...(user.studentId ? { studentId: user.studentId } : {}),
      ...(user.teacherId ? { teacherId: user.teacherId } : {}),
      ...(user.adminId   ? { adminId:   user.adminId   } : {}),
    },
  });
}));

/* ======================================================================
   PASSWORD RESET VIA LINK (WEB)
====================================================================== */
router.post('/request-reset', asyncHandler(async (req, res) => {
  const emailLower = normalizeEmail(req.body && req.body.email);
  const usersRef = firestore.collection('users');
  const userQuery = await usersRef.where('email', '==', emailLower).limit(1).get();
  if (userQuery.empty) return res.status(404).json({ message: 'User not found' });

  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 15 * 60 * 1000;
  resetTokens[emailLower] = { token, expires };

  const resetLinkBase = process.env.APP_RESET_URL || 'http://your-app/reset-password.html';
  const resetLink = `${resetLinkBase}?email=${encodeURIComponent(emailLower)}&token=${encodeURIComponent(token)}`;

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: emailLower,
    subject: 'Password Reset',
    html: `<p>Click <a href="${resetLink}">here</a> to reset your password. Link expires in 15 minutes.</p>`,
  });

  res.json({ message: 'Reset link sent' });
}));

/* ======================================================================
   SEND RESET CODE (MOBILE)
====================================================================== */
router.post('/send-reset-code', asyncHandler(async (req, res) => {
  const emailLower = normalizeEmail(req.body && req.body.email);
  if (!emailLower) return res.status(400).json({ error: 'Email is required' });

  const snapshot = await firestore.collection('users').where('email', '==', emailLower).limit(1).get();
  if (snapshot.empty) return res.status(404).json({ error: 'No user found with that email' });

  const code = generateCode();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  verificationCodes.set(emailLower, { code, expiresAt });

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: emailLower,
    subject: 'DigiPic Password Reset Code',
    text: `Your DigiPic verification code is: ${code}. It expires in 5 minutes.`,
  });

  res.json({ success: true, message: 'Verification code sent' });
}));

/* ======================================================================
   VERIFY RESET CODE (MOBILE)
====================================================================== */
router.post('/verify-reset-code', asyncHandler(async (req, res) => {
  const emailLower = normalizeEmail(req.body && req.body.email);
  const { code, newPassword } = req.body || {};
  if (!emailLower || !code || !newPassword) return res.status(400).json({ error: 'Missing fields' });

  const stored = verificationCodes.get(emailLower);
  if (!stored || stored.code !== code || stored.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  const snapshot = await firestore.collection('users').where('email', '==', emailLower).limit(1).get();
  if (snapshot.empty) return res.status(404).json({ error: 'User not found' });

  const userDoc = snapshot.docs[0];
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await firestore.collection('users').doc(userDoc.id).update({
    password: hashedPassword,
    failedLoginAttempts: 0,
    lockedUntil: null,
    active: true, // reactivate on password reset
  });
  verificationCodes.delete(emailLower);

  res.json({ success: true, message: 'Password updated successfully' });
}));

/* ======================================================================
   VERIFY RESET CODE (WEB VERSION)
====================================================================== */
router.post('/web-verify-reset', asyncHandler(async (req, res) => {
  const emailLower = normalizeEmail(req.body && req.body.email);
  const { code, newPassword } = req.body || {};
  if (!emailLower || !code || !newPassword) return res.status(400).json({ error: 'Missing fields' });

  const stored = verificationCodes.get(emailLower);
  if (!stored || stored.code !== code || stored.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired code.' });
  }

  const snapshot = await firestore.collection('users').where('email', '==', emailLower).limit(1).get();
  if (snapshot.empty) return res.status(404).json({ error: 'User not found.' });

  const userDoc = snapshot.docs[0];
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await firestore.collection('users').doc(userDoc.id).update({
    password: hashedPassword,
    failedLoginAttempts: 0,
    lockedUntil: null,
    active: true, // reactivate on password reset
  });
  verificationCodes.delete(emailLower);

  res.json({ success: true, message: 'Password updated successfully.' });
}));

module.exports = router;
