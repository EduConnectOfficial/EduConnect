// ==== routes/forumRoutes.js ==== //
const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');

// Helpers
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();
const COURSE_COLLECTION = process.env.COURSE_COLLECTION || 'courses';
const THREADS_COLLECTION = process.env.FORUM_THREADS_COLLECTION || 'forum_threads';

/**
 * THREAD SCHEMA
 *  - forum_threads
 *      { id, title, text, courseId, courseTitle, createdAt, author{uid,username,email}, repliesCount, followers[] }
 *  - forum_threads/{id}/replies
 *      { id, text, author{uid,username,email}, createdAt }
 */

/* ---------------------------------------
   COURSES (Dynamic from Firestore)
---------------------------------------- */
// GET /api/forum/courses?uploadedBy=<uid>&includeArchived=true|false
router.get('/courses', asyncHandler(async (req, res) => {
  const uploadedBy = String(req.query.uploadedBy || '').trim();
  const includeArchived = String(req.query.includeArchived || 'false') === 'true';

  let q = firestore.collection(COURSE_COLLECTION);

  if (uploadedBy) q = q.where('uploadedBy', '==', uploadedBy);
  // Prefer order by createdAt desc (falls back if index missing)
  try {
    q = q.orderBy('createdAt', 'desc');
  } catch {
    // ignore; Firestore SDK will complain only when executing
  }

  let snap;
  try {
    snap = await q.get();
  } catch {
    // Fallback if there’s no composite index for (uploadedBy, createdAt)
    if (uploadedBy) {
      snap = await firestore.collection(COURSE_COLLECTION)
        .where('uploadedBy', '==', uploadedBy).get();
    } else {
      snap = await firestore.collection(COURSE_COLLECTION).get();
    }
  }

  let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Post-filter archived/active flags when present
  if (!includeArchived) {
    items = items.filter(c =>
      (c.active === undefined || c.active === true) &&
      (c.archived !== true)
    );
  }

  // Map to UI-friendly format for selects
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
// body: { title, text, courseId, author{uid,username,email} }
router.post('/threads', asyncHandler(async (req, res) => {
  const { title, text, courseId, author } = req.body;

  if (!title || !text || !courseId) {
    return res.status(400).json({ success: false, message: 'Missing fields: title, text, courseId' });
  }
  if (!author || !author.uid || !author.username || !author.email) {
    return res.status(401).json({ success: false, message: 'Missing/invalid author' });
  }

  // fetch course title once for denormalized display
  const courseDoc = await firestore.collection(COURSE_COLLECTION).doc(String(courseId)).get();
  if (!courseDoc.exists) {
    return res.status(404).json({ success: false, message: 'Course not found' });
  }
  const courseTitle = String(courseDoc.data().title || courseDoc.data().name || 'Untitled');

  const ref = await firestore.collection(THREADS_COLLECTION).add({
    title: String(title),
    text: String(text),
    courseId: String(courseId),
    courseTitle,
    createdAt: nowTS(),
    author: {
      uid: String(author.uid),
      username: String(author.username),
      email: String(author.email),
    },
    repliesCount: 0,
    followers: [],
  });

  const snap = await ref.get();
  res.json({ success: true, data: { id: ref.id, ...snap.data() } });
}));

// GET /api/forum/threads?courseId=<id>&q=...&sort=newest|replies&limit=50
router.get('/threads', asyncHandler(async (req, res) => {
  const { courseId = '', q = '', sort = 'newest', limit = '50' } = req.query;
  const max = Math.min(parseInt(limit, 10) || 50, 100);

  let qref = firestore.collection(THREADS_COLLECTION);

  if (courseId) {
    qref = qref.where('courseId', '==', String(courseId));
  }

  // default sort by createdAt desc
  try {
    qref = qref.orderBy('createdAt', 'desc');
  } catch {
    // ignore here; we’ll still attempt to get
  }

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

  res.json({ success: true, data: items });
}));

// GET /api/forum/threads/:id (with first N replies)
router.get('/threads/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

  const doc = await firestore.collection(THREADS_COLLECTION).doc(id).get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Thread not found' });

  const repliesSnap = await firestore.collection(THREADS_COLLECTION).doc(id)
    .collection('replies')
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get();

  const replies = repliesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  res.json({ success: true, data: { id: doc.id, ...doc.data(), replies } });
}));

// ✅ NEW: GET /api/forum/threads/:id/replies (for frontend compatibility)
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

  // Optional pagination by createdAt (accepts ISO string or ms epoch)
  if (after) {
    let cursorDate;
    const n = Number(after);
    if (!Number.isNaN(n)) {
      cursorDate = new Date(n);
    } else {
      const d = new Date(after);
      if (!isNaN(d.getTime())) cursorDate = d;
    }
    if (cursorDate) {
      q = q.startAfter(cursorDate);
    }
  }

  const snap = await q.get();
  const replies = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  res.json({ success: true, data: replies });
}));

// POST /api/forum/threads/:id/replies
// body: { text, parentId?, author{uid,username,email} }
router.post('/threads/:id/replies', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { text, parentId = null, author } = req.body;

  if (!text || !author || !author.uid || !author.username || !author.email) {
    return res.status(400).json({ success: false, message: 'Missing text/author' });
  }

  const threadRef = firestore.collection(THREADS_COLLECTION).doc(id);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) return res.status(404).json({ success: false, message: 'Thread not found' });

  // Optional: verify parentId exists
  if (parentId) {
    const parentSnap = await threadRef.collection('replies').doc(parentId).get();
    if (!parentSnap.exists) {
      return res.status(400).json({ success: false, message: 'Parent reply not found' });
    }
  }

  const replyRef = await threadRef.collection('replies').add({
    text: String(text),
    parentId: parentId ? String(parentId) : null,
    author: {
      uid: String(author.uid),
      username: String(author.username),
      email: String(author.email),
    },
    createdAt: nowTS(),
  });

  await threadRef.update({
    repliesCount: admin.firestore.FieldValue.increment(1),
  });

  const replySnap = await replyRef.get();
  res.json({ success: true, data: { id: replyRef.id, ...replySnap.data() } });
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
// DELETE /api/forum/threads/:id
// Deletes the thread and ALL replies in its subcollection
router.delete('/threads/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const threadRef = firestore.collection(THREADS_COLLECTION).doc(id);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) {
    return res.status(404).json({ success: false, message: 'Thread not found' });
  }

  // 1) delete replies in batches (covers “nested” because nesting is by parentId, all are in the same subcollection)
  const repliesRef = threadRef.collection('replies');
  const snap = await repliesRef.get();

  // Batch delete in chunks (Firestore limit: 500 writes per batch)
  const docs = snap.docs;
  while (docs.length) {
    const chunk = docs.splice(0, 400);
    const batch = firestore.batch();
    chunk.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  // 2) delete the thread doc
  await threadRef.delete();

  return res.json({ success: true, message: 'Thread and all replies deleted.' });
}));

// DELETE /api/forum/threads/:threadId/replies/:replyId
// Deletes a single reply and decrements repliesCount
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
