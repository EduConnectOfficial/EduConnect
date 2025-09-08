// backend/routes/bugReportRoutes.js
'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin, bucket } = require('../config/firebase');
const { uploadMemory } = require('../config/multerConfig');
const { saveBufferToStorage, safeName } = require('../services/storageService');

/**
 * Only run Multer if the request is multipart. Avoid errors when JSON.
 */
const conditionalUpload = (req, res, next) => {
  const isMultipart = req.is('multipart/form-data');
  if (isMultipart) {
    return uploadMemory.fields([
      { name: 'screenshot', maxCount: 1 },
      { name: 'bugScreenshot', maxCount: 1 },
    ])(req, res, next);
  }
  return next();
};

/* ============================
   POST /api/bug-reports
============================ */
router.post(
  '/bug-reports',
  conditionalUpload,
  asyncHandler(async (req, res) => {
    const { title, description, severity, createdBy } = req.body || {};
    if (!title || !description) {
      return res.status(400).json({ success: false, message: 'Missing title or description.' });
    }

    const file = (req.files?.screenshot?.[0]) || (req.files?.bugScreenshot?.[0]) || null;

    const bugData = {
      title: String(title).trim(),
      description: String(description).trim(),
      severity: severity ? String(severity) : 'Bug',
      createdBy: createdBy ? String(createdBy) : 'Anonymous',
      status: 'Pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      screenshot: null
    };

    // create report first to get ID
    const ref = await firestore.collection('bugReports').add(bugData);

    if (file) {
      const destPath = `bugs/${ref.id}/screenshot/${Date.now()}_${safeName(file.originalname || 'screenshot')}`;
      const { gsUri, publicUrl, metadata } = await saveBufferToStorage(file.buffer, {
        destPath,
        contentType: file.mimetype,
        metadata: { role: 'bug-screenshot', bugId: ref.id }
      });
      await ref.set({
        screenshot: {
          originalName: file.originalname,
          size: file.size,
          mime: file.mimetype,
          gsUri, publicUrl, storageMetadata: metadata,
          uploadedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      }, { merge: true });
    }

    return res.status(201).json({ success: true, id: ref.id });
  })
);

/* ============================
   GET /api/bug-reports
============================ */
router.get('/bug-reports', asyncHandler(async (req, res) => {
  const { createdBy, status } = req.query;
  try {
    let ref = firestore.collection('bugReports');
    if (createdBy) ref = ref.where('createdBy', '==', String(createdBy));
    if (status) ref = ref.where('status', '==', String(status));
    const snap = await ref.orderBy('createdAt', 'desc').get();
    const reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, reports });
  } catch (e) {
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
============================ */
router.patch(
  '/bug-reports/:id/status',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, reply } = req.body || {};
    if (!status) return res.status(400).json({ success: false, message: 'Missing status.' });

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

/* (Optional) delete a bug report + storage cleanup
router.delete('/bug-reports/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  await firestore.collection('bugReports').doc(id).delete();
  try { await bucket.deleteFiles({ prefix: `bugs/${id}/` }); } catch {}
  res.json({ success:true });
}));
*/

module.exports = router;
