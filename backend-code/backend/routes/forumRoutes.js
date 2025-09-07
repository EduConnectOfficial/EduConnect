// ==== routes/forumRoutes.js ==== //
const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { encryptField, decryptField } = require('../utils/fieldCrypto');

// Helpers
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();
const COURSE_COLLECTION  = process.env.COURSE_COLLECTION        || 'courses';
const THREADS_COLLECTION = process.env.FORUM_THREADS_COLLECTION || 'forum_threads';

/**
 * THREAD SCHEMA
 *  - forum_threads
 *      {
 *        id, title, text, courseId, courseTitle, createdAt, updatedAt?,
 *        author: {
 *          uid,
 *          emailEnc,
 *          firstNameEnc,
 *          middleNameEnc,
 *          lastNameEnc,
 *        },
 *        repliesCount, followers[]
 *      }
 *  - forum_threads/{id}/replies
 *      {
 *        id, text, createdAt, updatedAt?, parentId?,
 *        author: {
 *          uid,
 *          emailEnc,
 *          firstNameEnc,
 *          middleNameEnc,
 *          lastNameEnc,
 *        }
 *      }
 *
 * API responses hydrate ONLY:
 *   author.firstName, author.middleName, author.lastName, author.fullName, author.email
 *   (NO username field returned)
 *   Additionally, top-level authorFullName mirrors author.fullName for easy rendering.
 */

// ---------- Profile resolution from users/{uid} (with email fallback) ----------
async function getUserNameAndEmail(uid) {
  const fallback = { firstName: 'User', middleName: '', lastName: '', fullName: 'User', email: '' };
  if (!uid) return fallback;

  try {
    const usersCol = firestore.collection('users');
    let snap = await usersCol.doc(String(uid)).get();

    // If users/{uid} doesn't exist and uid looks like an email, try lookup by email field.
    if (!snap.exists && typeof uid === 'string' && uid.includes('@')) {
      const byEmail = await usersCol.where('email', '==', String(uid)).limit(1).get();
      if (!byEmail.empty) snap = byEmail.docs[0];
    }

    if (!snap.exists) return fallback;

    const u = snap.data() || {};

    // Support encrypted OR plaintext name fields; prefer encrypted when present.
    const readField = (encKey, plainKey) => {
      try {
        if (u[encKey]) return decryptField(u[encKey]) || '';
      } catch {}
      return u[plainKey] || '';
    };

    const firstName  = readField('firstNameEnc',  'firstName');
    const middleName = readField('middleNameEnc', 'middleName');
    const lastName   = readField('lastNameEnc',   'lastName');
    const email      = String(u.email || (typeof uid === 'string' && uid.includes('@') ? uid : ''));
    const fullName   = `${firstName} ${middleName ? middleName + ' ' : ''}${lastName}`.replace(/\s+/g, ' ').trim() || 'User';

    return { firstName, middleName, lastName, fullName, email };
  } catch {
    return fallback;
  }
}

/**
 * Hydrate author fields for a list of items (threads or replies).
 * Priority:
 *   1) Resolve from users/{uid} (fresh, reflects changes)
 *   2) Fallback: decrypt the enc fields stored on the item
 * Adds top-level authorFullName mirror.
 * NEVER returns username.
 */
async function resolveAuthors(items) {
  const uids = new Set();
  for (const it of items) {
    const uid = it?.author?.uid;
    if (uid) uids.add(String(uid));
  }

  const profileMap = {};
  if (uids.size > 0) {
    await Promise.all([...uids].map(async (uid) => {
      profileMap[uid] = await getUserNameAndEmail(uid);
    }));
  }

  return items.map((it) => {
    const author = it.author || {};
    const uid = author.uid ? String(author.uid) : '';

    // Prefer live values from user profile
    let firstName  = (uid && profileMap[uid]?.firstName)  || '';
    let middleName = (uid && profileMap[uid]?.middleName) || '';
    let lastName   = (uid && profileMap[uid]?.lastName)   || '';
    let email      = (uid && profileMap[uid]?.email)      || '';

    // Fallback to decrypting stored ciphertext if user doc missing or empty
    if (!firstName && author.firstNameEnc) {
      try { firstName = decryptField(author.firstNameEnc) || ''; } catch {}
    }
    if (!middleName && author.middleNameEnc) {
      try { middleName = decryptField(author.middleNameEnc) || ''; } catch {}
    }
    if (!lastName && author.lastNameEnc) {
      try { lastName = decryptField(author.lastNameEnc) || ''; } catch {}
    }
    if (!email && author.emailEnc) {
      try { email = decryptField(author.emailEnc) || ''; } catch {}
    }

    const fullName = `${firstName} ${middleName ? middleName + ' ' : ''}${lastName}`
      .replace(/\s+/g, ' ')
      .trim() || 'User';

    const hydrated = {
      ...it,
      author: {
        uid,
        // keep ciphertext fields in the DB object
        emailEnc:      author.emailEnc,
        firstNameEnc:  author.firstNameEnc,
        middleNameEnc: author.middleNameEnc,
        lastNameEnc:   author.lastNameEnc,

        // Decrypted fields for UI:
        email,
        firstName,
        middleName,
        lastName,
        fullName,
      },
      // Top-level mirror to simplify legacy frontends
      authorFullName: fullName,
    };

    return hydrated;
  });
}

/* ---------------------------------------
   COURSES (Dynamic from Firestore)
---------------------------------------- */
// GET /api/forum/courses?uploadedBy=<uid>&includeArchived=true|false
router.get('/courses', asyncHandler(async (req, res) => {
  const uploadedBy = String(req.query.uploadedBy || '').trim();
  const includeArchived = String(req.query.includeArchived || 'false') === 'true';

  let q = firestore.collection(COURSE_COLLECTION);
  if (uploadedBy) q = q.where('uploadedBy', '==', uploadedBy);
  try { q = q.orderBy('createdAt', 'desc'); } catch {}

  let snap;
  try {
    snap = await q.get();
  } catch {
    if (uploadedBy) {
      snap = await firestore.collection(COURSE_COLLECTION)
        .where('uploadedBy', '==', uploadedBy).get();
    } else {
      snap = await firestore.collection(COURSE_COLLECTION).get();
    }
  }

  let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (!includeArchived) {
    items = items.filter(c =>
      (c.active === undefined || c.active === true) &&
      (c.archived !== true)
    );
  }

  const data = items.map(c => ({
    id: c.id,
    title: String(c.title || c.name || 'Untitled'),
    category: c.category || '',
    courseNumber: c.courseNumber ?? null,
  }));

  res.json({ success: true, data });
}));

/* ---------------------------------------
   THREADS
---------------------------------------- */

// POST /api/forum/threads
// body: { title, text, courseId, author{uid} }
router.post('/threads', asyncHandler(async (req, res) => {
  const { title, text, courseId, author } = req.body;

  if (!title || !text || !courseId) {
    return res.status(400).json({ success: false, message: 'Missing fields: title, text, courseId' });
  }
  if (!author || !author.uid) {
    return res.status(401).json({ success: false, message: 'Missing/invalid author' });
  }

  // fetch course title once for denormalized display
  const courseDoc = await firestore.collection(COURSE_COLLECTION).doc(String(courseId)).get();
  if (!courseDoc.exists) {
    return res.status(404).json({ success: false, message: 'Course not found' });
  }
  const courseTitle = String(courseDoc.data().title || courseDoc.data().name || 'Untitled');

  // Resolve fresh profile, then store encrypted fields
  const profile = await getUserNameAndEmail(author.uid);
  const firstNameEnc  = encryptField(profile.firstName || '');
  const middleNameEnc = encryptField(profile.middleName || '');
  const lastNameEnc   = encryptField(profile.lastName || '');
  const emailEnc      = encryptField(profile.email || '');

  const ref = await firestore.collection(THREADS_COLLECTION).add({
    title: String(title),
    text: String(text),
    courseId: String(courseId),
    courseTitle,
    createdAt: nowTS(),
    author: {
      uid: String(author.uid),
      emailEnc,
      firstNameEnc,
      middleNameEnc,
      lastNameEnc,
    },
    repliesCount: 0,
    followers: [],
  });

  const snap = await ref.get();
  const hydrated = await resolveAuthors([{ id: ref.id, ...snap.data() }]);
  res.json({ success: true, data: hydrated[0] });
}));

// GET /api/forum/threads?courseId=<id>&q=...&sort=newest|replies&limit=50
router.get('/threads', asyncHandler(async (req, res) => {
  const { courseId = '', q = '', sort = 'newest', limit = '50' } = req.query;
  const max = Math.min(parseInt(limit, 10) || 50, 100);

  let qref = firestore.collection(THREADS_COLLECTION);
  if (courseId) qref = qref.where('courseId', '==', String(courseId));
  try { qref = qref.orderBy('createdAt', 'desc'); } catch {}
  qref = qref.limit(max);

  const snap = await qref.get();
  let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const qq = String(q || '').trim().toLowerCase();
  if (qq) {
    items = items.filter(t =>
      (t.title || '').toLowerCase().includes(qq) ||
      (t.text || '').toLowerCase().includes(qq) ||
      (t.courseTitle || '').toLowerCase().includes(qq)
    );
  }

  if (sort === 'replies') {
    items.sort((a, b) => (b.repliesCount || 0) - (a.repliesCount || 0));
  }

  items = await resolveAuthors(items);
  res.json({ success: true, data: items });
}));

// GET /api/forum/threads/:id (with first N replies)
router.get('/threads/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

  const doc = await firestore.collection(THREADS_COLLECTION).doc(id).get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Thread not found' });

  const thread = { id: doc.id, ...doc.data() };

  const repliesSnap = await firestore.collection(THREADS_COLLECTION).doc(id)
    .collection('replies')
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get();

  let replies = repliesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const hydrated = await resolveAuthors([thread, ...replies]);
  const hydratedThread  = hydrated[0];
  const hydratedReplies = hydrated.slice(1);

  res.json({ success: true, data: { ...hydratedThread, replies: hydratedReplies } });
}));

// GET /api/forum/threads/:id/replies (supports after + limit)
router.get('/threads/:id/replies', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const after = req.query.after; // optional cursor (createdAt)

  const threadRef = firestore.collection(THREADS_COLLECTION).doc(id);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) {
    return res.status(404).json({ success: false, message: 'Thread not found' });
  }

  let q = threadRef.collection('replies')
    .orderBy('createdAt', 'asc')
    .limit(limit);

  if (after) {
    let cursorDate;
    const n = Number(after);
    if (!Number.isNaN(n)) cursorDate = new Date(n);
    else {
      const d = new Date(after);
      if (!isNaN(d.getTime())) cursorDate = d;
    }
    if (cursorDate) q = q.startAfter(cursorDate);
  }

  const snap = await q.get();
  let replies = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  replies = await resolveAuthors(replies);
  res.json({ success: true, data: replies });
}));

// POST /api/forum/threads/:id/replies
// body: { text, parentId?, author{uid} }
router.post('/threads/:id/replies', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { text, parentId = null, author } = req.body;

  if (!text || !author || !author.uid) {
    return res.status(400).json({ success: false, message: 'Missing text/author' });
  }

  const threadRef = firestore.collection(THREADS_COLLECTION).doc(id);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) return res.status(404).json({ success: false, message: 'Thread not found' });

  if (parentId) {
    const parentSnap = await threadRef.collection('replies').doc(parentId).get();
    if (!parentSnap.exists) {
      return res.status(400).json({ success: false, message: 'Parent reply not found' });
    }
  }

  // Resolve profile, then store encrypted fields
  const profile = await getUserNameAndEmail(author.uid);
  const firstNameEnc  = encryptField(profile.firstName || '');
  const middleNameEnc = encryptField(profile.middleName || '');
  const lastNameEnc   = encryptField(profile.lastName || '');
  const emailEnc      = encryptField(profile.email || '');

  const replyRef = await threadRef.collection('replies').add({
    text: String(text),
    parentId: parentId ? String(parentId) : null,
    author: {
      uid: String(author.uid),
      emailEnc,
      firstNameEnc,
      middleNameEnc,
      lastNameEnc,
    },
    createdAt: nowTS(),
  });

  await threadRef.update({
    repliesCount: admin.firestore.FieldValue.increment(1),
  });

  const replySnap = await replyRef.get();
  const hydrated = await resolveAuthors([{ id: replyRef.id, ...replySnap.data() }]);
  res.json({ success: true, data: hydrated[0] });
}));

// PATCH /api/forum/threads/:id/follow
// body: { uid }
router.patch('/threads/:id/follow', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ success: false, message: 'Missing uid' });

  const ref = firestore.collection(THREADS_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, message: 'Thread not found' });

  const followers = new Set(snap.data().followers || []);
  let followed;
  if (followers.has(uid)) {
    followers.delete(uid);
    followed = false;
  } else {
    followers.add(uid);
    followed = true;
  }

  await ref.update({ followers: Array.from(followers) });
  res.json({ success: true, data: { followed } });
}));

/* ---------------------------------------
   EDIT (PATCH) ENDPOINTS
---------------------------------------- */

// PATCH /api/forum/threads/:id
// body: { title?, text? }
router.patch('/threads/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  let { title, text } = req.body || {};

  // sanitize inputs; ignore non-strings
  if (typeof title !== 'string') title = undefined;
  if (typeof text  !== 'string') text  = undefined;

  if (title === undefined && text === undefined) {
    return res.status(400).json({ success: false, message: 'Nothing to update (title/text missing).' });
  }

  const ref  = firestore.collection(THREADS_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, message: 'Thread not found' });

  // OPTIONAL ownership/role checks (uncomment if you wire auth to req.user):
  // const thread = snap.data();
  // const requesterUid = req.user?.uid;
  // const isTeacher    = req.user?.isTeacher === true;
  // if (!isTeacher && requesterUid !== thread.author?.uid) {
  //   return res.status(403).json({ success: false, message: 'Not allowed to edit this thread' });
  // }

  const updates = { updatedAt: nowTS() };
  if (title !== undefined) updates.title = String(title).trim();
  if (text  !== undefined) updates.text  = String(text).trim();

  await ref.update(updates);

  const updated = await ref.get();
  const hydrated = await resolveAuthors([{ id: ref.id, ...updated.data() }]);
  return res.json({ success: true, data: hydrated[0] });
}));

// PATCH /api/forum/threads/:threadId/replies/:replyId
// body: { text }
router.patch('/threads/:threadId/replies/:replyId', asyncHandler(async (req, res) => {
  const { threadId, replyId } = req.params;
  let { text } = req.body || {};

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ success: false, message: 'Missing/invalid text' });
  }
  text = String(text).trim();

  const threadRef = firestore.collection(THREADS_COLLECTION).doc(threadId);
  const replyRef  = threadRef.collection('replies').doc(replyId);

  const [threadSnap, replySnap] = await Promise.all([threadRef.get(), replyRef.get()]);
  if (!threadSnap.exists) return res.status(404).json({ success: false, message: 'Thread not found' });
  if (!replySnap.exists)  return res.status(404).json({ success: false, message: 'Reply not found' });

  // OPTIONAL ownership/role checks (uncomment if you wire auth to req.user):
  // const reply = replySnap.data();
  // const requesterUid = req.user?.uid;
  // const isTeacher    = req.user?.isTeacher === true;
  // if (!isTeacher && requesterUid !== reply.author?.uid) {
  //   return res.status(403).json({ success: false, message: 'Not allowed to edit this reply' });
  // }

  await replyRef.update({
    text,
    updatedAt: nowTS(),
  });

  const updatedReply = await replyRef.get();
  const hydrated = await resolveAuthors([{ id: replyRef.id, ...updatedReply.data() }]);
  return res.json({ success: true, data: hydrated[0] });
}));

/* ---------------------------------------
   DELETE
---------------------------------------- */

// DELETE /api/forum/threads/:id  (thread + all replies)
router.delete('/threads/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const threadRef = firestore.collection(THREADS_COLLECTION).doc(id);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) {
    return res.status(404).json({ success: false, message: 'Thread not found' });
  }

  // delete replies in batches
  const repliesRef = threadRef.collection('replies');
  const snap = await repliesRef.get();

  const docs = snap.docs.slice();
  while (docs.length) {
    const chunk = docs.splice(0, 400);
    const batch = firestore.batch();
    chunk.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  await threadRef.delete();

  return res.json({ success: true, message: 'Thread and all replies deleted.' });
}));

// DELETE /api/forum/threads/:threadId/replies/:replyId
router.delete('/threads/:threadId/replies/:replyId', asyncHandler(async (req, res) => {
  const { threadId, replyId } = req.params;
  const threadRef = firestore.collection(THREADS_COLLECTION).doc(threadId);
  const replyRef  = threadRef.collection('replies').doc(replyId);

  const [threadSnap, replySnap] = await Promise.all([threadRef.get(), replyRef.get()]);
  if (!threadSnap.exists) return res.status(404).json({ success: false, message: 'Thread not found' });
  if (!replySnap.exists)  return res.status(404).json({ success: false, message: 'Reply not found' });

  const batch = firestore.batch();
  batch.delete(replyRef);
  batch.update(threadRef, { repliesCount: admin.firestore.FieldValue.increment(-1) });
  await batch.commit();

  return res.json({ success: true, message: 'Reply deleted.' });
}));

module.exports = router;
