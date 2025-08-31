// backend/routes/announcementRoutes.js
const router = require('express').Router();

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { toTimestampOrNull } = require('../utils/timeUtils');

// ---- helpers ----
function computeAnnouncementStatus(a, nowMs = Date.now()) {
  const pub = a.publishAt?.toMillis?.() ?? null;
  const exp = a.expiresAt?.toMillis?.() ?? null;
  if (pub && nowMs < pub)  return 'scheduled';
  if (exp && nowMs > exp)  return 'expired';
  return 'published';
}

const chunk = (arr, size) => (arr.length ? [arr.slice(0, size), ...chunk(arr.slice(size), size)] : []);

// ==== CREATE ====
// POST /api/announcements
// body: { title, content, classes:[classId], publishAt, expiresAt?, important, teacherId }
router.post('/', asyncHandler(async (req, res) => {
  const { title, content, classes, publishAt, expiresAt, important, teacherId } = req.body;

  if (!title || !content || !teacherId || !Array.isArray(classes) || classes.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Missing fields: title, content, teacherId, classes[] are required.'
    });
  }

  const payload = {
    title: String(title).trim(),
    content: String(content).trim(),
    classIds: classes.map(String),
    teacherId: String(teacherId),
    important: !!important,
    publishAt: toTimestampOrNull(publishAt) || admin.firestore.Timestamp.now(),
    expiresAt: toTimestampOrNull(expiresAt) || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const docRef = await firestore.collection('announcements').add(payload);
  const saved = await docRef.get();
  res.status(201).json({ success: true, id: docRef.id, announcement: { id: docRef.id, ...saved.data() } });
}));

// ==== LIST (TEACHER) ====
// GET /api/announcements?teacherId=...&classIds=ID1,ID2&status=published|scheduled|expired|important
router.get('/', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '');
  if (!teacherId) {
    return res.status(400).json({ success: false, message: 'teacherId query parameter is required.' });
  }
  const status = (req.query.status || '').toString().toLowerCase();
  const classIdsParam = (req.query.classIds || '').toString().trim();
  const classIds = classIdsParam ? classIdsParam.split(',').map(s => s.trim()).filter(Boolean) : [];

  let q = firestore.collection('announcements').where('teacherId', '==', teacherId);

  if (classIds.length > 0 && classIds.length <= 10) {
    q = q.where('classIds', 'array-contains-any', classIds);
  }
  q = q.orderBy('publishAt', 'desc');

  const snap = await q.get();
  const now = Date.now();

  let items = snap.docs.map(d => {
    const data = d.data();
    return { id: d.id, ...data, status: computeAnnouncementStatus(data, now) };
  });

  if (status === 'important') {
    items = items.filter(a => !!a.important);
  } else if (['published', 'scheduled', 'expired'].includes(status)) {
    items = items.filter(a => a.status === status);
  }

  if (classIds.length > 10) {
    const set = new Set(classIds);
    items = items.filter(a => Array.isArray(a.classIds) && a.classIds.some(id => set.has(id)));
  }

  res.json({ success: true, announcements: items });
}));

// ==== UPDATE ====
// PUT /api/announcements/:id
// body: { title?, content?, classes?, publishAt?, expiresAt?, important? }
router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const ref = firestore.collection('announcements').doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    return res.status(404).json({ success: false, message: 'Announcement not found.' });
  }

  const { title, content, classes, publishAt, expiresAt, important } = req.body;
  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  if (title != null)      updates.title = String(title).trim();
  if (content != null)    updates.content = String(content).trim();
  if (Array.isArray(classes)) updates.classIds = classes.map(String);
  if (publishAt !== undefined) updates.publishAt = toTimestampOrNull(publishAt);
  if (expiresAt !== undefined) updates.expiresAt = toTimestampOrNull(expiresAt);
  if (important !== undefined) updates.important = !!important;

  await ref.update(updates);
  res.json({ success: true });
}));

// ==== STUDENT FEED ====
// GET /api/announcements/student/:userId
// (changed path slightly to avoid conflict with teacher list on '/')
router.get('/student/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const userRef = firestore.collection('users').doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    return res.status(404).json({ success: false, message: 'Student not found.' });
  }

  const enrollSnap = await userRef.collection('enrollments').get();
  const classIds = enrollSnap.docs.map(d => d.id);
  if (classIds.length === 0) {
    return res.json({ success: true, announcements: [] });
  }

  const now = Date.now();
  const results = [];
  for (const ids of chunk(classIds, 10)) {
    const snap = await firestore
      .collection('announcements')
      .where('classIds', 'array-contains-any', ids)
      .orderBy('publishAt', 'desc')
      .get();

    snap.forEach(d => {
      const a = d.data();
      const status = computeAnnouncementStatus(a, now);
      if (status === 'published') results.push({ id: d.id, ...a, status });
    });
  }

  const map = new Map();
  results.forEach(a => map.set(a.id, a));
  const deduped = Array.from(map.values()).sort((a, b) => {
    const ap = a.publishAt?.toMillis?.() ?? 0;
    const bp = b.publishAt?.toMillis?.() ?? 0;
    return bp - ap;
  });

  res.json({ success: true, announcements: deduped });
}));

// ==== CLASS VISIBLE ====
// GET /api/announcements/class/:classId/visible
router.get('/class/:classId/visible', asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const now = Date.now();

  const snap = await firestore
    .collection('announcements')
    .where('classIds', 'array-contains', classId)
    .orderBy('publishAt', 'desc')
    .get();

  const items = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(a => computeAnnouncementStatus(a, now) === 'published');

  res.json({ success: true, announcements: items });
}));

module.exports = router;
