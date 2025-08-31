// ==== routes/authRoutes.js ==== //
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { sendVerificationEmail, transporter } = require('../config/email');
const { generateRoleId } = require('../utils/idUtils');

// --- in-memory stores (signup + reset flows) ---
const verificationStore = Object.create(null);   // { [email]: { code, expiresAt, userData } }
const verificationCodes = new Map();             // Map<email, { code, expiresAt }>
const resetTokens = Object.create(null);         // { [email]: { token, expires } }

// small helper
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

/* ======================================================================
   AUTH: SIGNUP
   - NO IDs are generated here anymore.
   - We only stash minimal info + code until /verify-code succeeds.
====================================================================== */
router.post('/signup', asyncHandler(async (req, res) => {
  const {
    firstName, middleName, lastName, username, email, password,
    isITsupport, isUser, isAdmin, isMobile, isTeacher, isStudent
  } = req.body || {};

  if (!firstName || !lastName || !username || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Ensure uniqueness in persisted users (not pending)
  const emailSnapshot = await firestore.collection('users').where('email', '==', email).limit(1).get();
  if (!emailSnapshot.empty) return res.status(400).json({ error: 'Email already registered.' });

  const usernameSnapshot = await firestore.collection('users').where('username', '==', username).limit(1).get();
  if (!usernameSnapshot.empty) return res.status(400).json({ error: 'Username already taken.' });

  // Generate verification code, store *without* IDs
  const code = generateCode();
  verificationStore[email] = {
    code,
    // keep short; you can extend if needed
    expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes
    userData: {
      // NO userId / studentId / teacherId yet
      firstName,
      middleName,
      lastName,
      username,
      email,
      password, // plaintext in memory only; will be hashed on verify
      active: true,
      isITsupport: !!isITsupport,
      isUser: isUser !== false,
      isAdmin: !!isAdmin,
      isMobile: !!isMobile,
      isTeacher: !!isTeacher,
      isStudent: !!isStudent,
      createdAtLocalIso: new Date().toISOString(), // purely informational
    },
  };

  await sendVerificationEmail(email, code);

  // Do NOT return role IDs here (they don't exist yet)
  res.json({
    message: 'Verification code sent to your email. Complete verification to finish signup.',
  });
}));

/* ======================================================================
   VERIFY SIGNUP CODE
   - Only now do we mint userId / studentId / teacherId
   - We also re-check that email/username are still available
====================================================================== */
router.post('/verify-code', asyncHandler(async (req, res) => {
  const { email, code } = req.body || {};

  const record = verificationStore[email];
  if (!record) return res.status(400).json({ error: 'No verification code found.' });
  if (Date.now() > record.expiresAt) {
    delete verificationStore[email];
    return res.status(400).json({ error: 'Verification code expired.' });
  }
  if (record.code !== code) return res.status(400).json({ error: 'Incorrect verification code.' });

  const { userData } = record;
  const {
    firstName, middleName, lastName, username, password,
    isITsupport, isUser, isAdmin, isMobile, isTeacher, isStudent,
  } = userData;

  // Re-check uniqueness (race-safe)
  const emailSnapshot = await firestore.collection('users').where('email', '==', email).limit(1).get();
  if (!emailSnapshot.empty) {
    delete verificationStore[email];
    return res.status(400).json({ error: 'Email already registered. Please log in.' });
  }

  const usernameSnapshot = await firestore.collection('users').where('username', '==', username).limit(1).get();
  if (!usernameSnapshot.empty) {
    delete verificationStore[email];
    return res.status(400).json({ error: 'Username already taken. Please sign up again with a different username.' });
  }

  // ✅ Now mint IDs
  const userId = uuidv4();
  let studentId = null;
  let teacherId = null;
  if (isStudent) studentId = await generateRoleId('student');
  if (isTeacher) teacherId = await generateRoleId('teacher');

  // Hash & persist
  const hashedPassword = await bcrypt.hash(password, 10);
  const toStore = {
    userId,
    firstName,
    middleName: middleName || '',
    lastName,
    username,
    email,
    password: hashedPassword,
    active: true,
    isITsupport: !!isITsupport,
    isUser: isUser !== false,
    isAdmin: !!isAdmin,
    isMobile: !!isMobile,
    isTeacher: !!isTeacher,
    isStudent: !!isStudent,
    ...(studentId ? { studentId } : {}),
    ...(teacherId ? { teacherId } : {}),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await firestore.collection('users').doc(userId).set(toStore);

  // clear pending
  delete verificationStore[email];

  res.json({
    message: 'User verified and registered successfully.',
    user: {
      userId,
      email,
      username,
      firstName,
      lastName,
      isAdmin: !!isAdmin,
      isITsupport: !!isITsupport,
      isUser: isUser !== false,
      isTeacher: !!isTeacher,
      isStudent: !!isStudent,
      ...(studentId ? { studentId } : {}),
      ...(teacherId ? { teacherId } : {}),
    }
  });
}));

/* ======================================================================
   RESEND VERIFICATION CODE
   - keeps pending; still no IDs created here
====================================================================== */
router.post('/resend-code', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email || !verificationStore[email]) {
    return res.status(400).json({ error: 'No pending verification found for this email.' });
  }

  const code = generateCode();
  verificationStore[email].code = code;
  verificationStore[email].expiresAt = Date.now() + 15 * 60 * 1000;

  await sendVerificationEmail(email, code);
  res.json({ message: 'Verification code resent.' });
}));

/* ======================================================================
   CHECK EMAIL / USERNAME AVAILABILITY
====================================================================== */
router.get('/check-email', asyncHandler(async (req, res) => {
  const { email } = req.query || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const snapshot = await firestore.collection('users').where('email', '==', email).limit(1).get();
  res.json({ taken: !snapshot.empty });
}));

router.get('/check-username', asyncHandler(async (req, res) => {
  const { username } = req.query || {};
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const snapshot = await firestore.collection('users').where('username', '==', username).limit(1).get();
  res.json({ taken: !snapshot.empty });
}));

/* ======================================================================
   LOGIN
====================================================================== */
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const snapshot = await firestore
    .collection('users')
    .where('username', '==', username)
    .limit(1)
    .get();

  if (snapshot.empty) return res.status(401).json({ error: 'Invalid username or password.' });

  const user = snapshot.docs[0].data();

  if (!user.password || typeof user.password !== 'string') {
    return res.status(500).json({ error: 'Account has no password set. Please reset your password.' });
  }
  if (!user.password.startsWith('$2')) {
    return res.status(500).json({ error: 'Stored password is invalid. Please reset your password.' });
  }

  const ok = await bcrypt.compare(String(password), user.password);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
  if (user.active === false) return res.status(403).json({ error: 'Account is deactivated. Please contact admin.' });

  res.json({
    message: 'Login successful!',
    user: {
      userId: user.userId,
      username: user.username,
      email: user.email,
      fullName: `${user.firstName} ${user.lastName}`,
      isAdmin: !!user.isAdmin,
      isITsupport: !!user.isITsupport,
      isUser: !!user.isUser,
      isTeacher: !!user.isTeacher,
      isStudent: !!user.isStudent,
      ...(user.studentId ? { studentId: user.studentId } : {}),
      ...(user.teacherId ? { teacherId: user.teacherId } : {}),
    },
  });
}));

/* ======================================================================
   PASSWORD RESET VIA LINK (WEB)
====================================================================== */
router.post('/request-reset', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  const usersRef = firestore.collection('users');
  const userQuery = await usersRef.where('email', '==', email).limit(1).get();
  if (userQuery.empty) return res.status(404).json({ message: 'User not found' });

  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 15 * 60 * 1000;
  resetTokens[email] = { token, expires };

  const resetLinkBase = process.env.APP_RESET_URL || 'http://your-app/reset-password.html';
  const resetLink = `${resetLinkBase}?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Password Reset',
    html: `<p>Click <a href="${resetLink}">here</a> to reset your password. Link expires in 15 minutes.</p>`,
  });

  res.json({ message: 'Reset link sent' });
}));

/* ======================================================================
   SEND RESET CODE (MOBILE)
====================================================================== */
router.post('/send-reset-code', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const snapshot = await firestore.collection('users').where('email', '==', email).limit(1).get();
  if (snapshot.empty) return res.status(404).json({ error: 'No user found with that email' });

  const code = generateCode();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  verificationCodes.set(email, { code, expiresAt });

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'DigiPic Password Reset Code',
    text: `Your DigiPic verification code is: ${code}. It expires in 5 minutes.`,
  });

  res.json({ success: true, message: 'Verification code sent' });
}));

/* ======================================================================
   VERIFY RESET CODE (MOBILE)
====================================================================== */
router.post('/verify-reset-code', asyncHandler(async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'Missing fields' });

  const stored = verificationCodes.get(email);
  if (!stored || stored.code !== code || stored.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  const snapshot = await firestore.collection('users').where('email', '==', email).limit(1).get();
  if (snapshot.empty) return res.status(404).json({ error: 'User not found' });

  const userDoc = snapshot.docs[0];
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await firestore.collection('users').doc(userDoc.id).update({ password: hashedPassword });
  verificationCodes.delete(email);

  res.json({ success: true, message: 'Password updated successfully' });
}));

/* ======================================================================
   VERIFY RESET CODE (WEB VERSION)
====================================================================== */
router.post('/web-verify-reset', asyncHandler(async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'Missing fields' });

  const stored = verificationCodes.get(email);
  if (!stored || stored.code !== code || stored.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired code.' });
  }

  const snapshot = await firestore.collection('users').where('email', '==', email).limit(1).get();
  if (snapshot.empty) return res.status(404).json({ error: 'User not found.' });

  const userDoc = snapshot.docs[0];
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await firestore.collection('users').doc(userDoc.id).update({ password: hashedPassword });
  verificationCodes.delete(email);

  res.json({ success: true, message: 'Password updated successfully.' });
}));

module.exports = router;
