// backend/routes/bugReportRoutes.js
const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { uploadBug } = require('../config/multerConfig');

/**
 * Only run Multer if the request is multipart. This avoids Multer errors
 * when the client sends JSON (no file).
 */
const conditionalUpload = (req, res, next) => {
  const isMultipart = req.is('multipart/form-data');
  // Debug: quick signal of how the request arrived
  console.log('[bug-reports] conditionalUpload -> multipart:', !!isMultipart);
  if (isMultipart) {
    return uploadBug.fields([
      { name: 'screenshot', maxCount: 1 },      // preferred field
      { name: 'bugScreenshot', maxCount: 1 },   // legacy field
    ])(req, res, next);
  }
  return next();
};

/* ============================
   POST /api/bug-reports
   Accepts: multipart/form-data or application/json
   Body fields:
     - title (required)
     - description (required)
     - severity? (e.g. "Bug", "High", etc.)
     - createdBy? (username/email; default "Anonymous")
     - screenshot? (file) OR bugScreenshot? (legacy)
============================ */
router.post(
  '/bug-reports',
  conditionalUpload,
  asyncHandler(async (req, res) => {
    const { title, description, severity, createdBy } = req.body || {};

    // Debug: show what we got
    console.log('[POST /api/bug-reports] body.keys =', Object.keys(req.body || {}));
    console.log('[POST /api/bug-reports] files.keys =', Object.keys(req.files || {}));

    if (!title || !description) {
      return res.status(400).json({ success: false, message: 'Missing title or description.' });
    }

    // Pick the uploaded file if present
    const file =
      (req.files?.screenshot?.[0]) ||
      (req.files?.bugScreenshot?.[0]) ||
      null;

    const bugData = {
      title: String(title).trim(),
      description: String(description).trim(),
      severity: severity ? String(severity) : 'Bug',
      createdBy: createdBy ? String(createdBy) : 'Anonymous',
      status: 'Pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      screenshotPath: file ? `/uploads/bugs/${file.filename}` : '',
    };

    const ref = await firestore.collection('bugReports').add(bugData);
    console.log('[POST /api/bug-reports] saved id =', ref.id);

    return res.status(201).json({ success: true, id: ref.id });
  })
);

/* ============================
   GET /api/bug-reports
   Returns: { success:true, bugs:[...] }
============================ */
router.get('/bug-reports', asyncHandler(async (req, res) => {
  const { createdBy, status } = req.query;
  try {
    let ref = firestore.collection('bugReports');
    if (createdBy) ref = ref.where('createdBy', '==', String(createdBy));
    if (status) ref = ref.where('status', '==', String(status));
    // order by createdAt desc (add composite index in Firestore if prompted)
    const snap = await ref.orderBy('createdAt', 'desc').get();
    const reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, reports });
  } catch (e) {
    // Fallback without index
    const snap = await firestore.collection('bugReports').get();
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const reports = all
      .filter(r => !createdBy || r.createdBy === String(createdBy))
      .filter(r => !status || String(r.status || '').toLowerCase() === String(status).toLowerCase())
      .sort((a,b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    return res.json({ success: true, reports });
  }
}));


/* ============================
   PATCH /api/bug-reports/:id/status
   Body: { status: 'Pending'|'Open'|'Resolved', reply? }
============================ */
router.patch(
  '/bug-reports/:id/status',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, reply } = req.body || {};

    console.log('[PATCH /api/bug-reports/:id/status] id =', id, 'status =', status);

    if (!status) {
      return res.status(400).json({ success: false, message: 'Missing status.' });
    }

    await firestore.collection('bugReports').doc(id).set(
      {
        status: String(status),
        ...(reply !== undefined ? { reply: String(reply) } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.json({ success: true });
  })
);

module.exports = router;
