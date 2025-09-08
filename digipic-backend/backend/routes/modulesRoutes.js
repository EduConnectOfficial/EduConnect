// ==== routes/modulesRoutes.js ====
'use strict';

const router = require('express').Router();
const multer = require('multer');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin, bucket } = require('../config/firebase');
const { uploadMemory } = require('../config/multerConfig');
const { saveBufferToStorage, safeName } = require('../services/storageService');

// ---------------- File size limit (PER FILE) ----------------
const PER_FILE_LIMIT_MB = parseInt(process.env.MODULE_FILE_LIMIT_MB || '300', 10);
const PER_FILE_LIMIT_BYTES = PER_FILE_LIMIT_MB * 1024 * 1024;

// Memory upload (array)
const arrayUpload = uploadMemory.array('attachmentFiles', 50);
const singleUpload = uploadMemory.single('moduleFile');

// ---- Upload middleware: prefer array; fallback to single on LIMIT_UNEXPECTED_FILE ----
const flexibleUpload = (req, res, next) => {
  arrayUpload(req, res, (err) => {
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
      return singleUpload(req, res, next);
    } else if (err) {
      return next(err);
    }
    next();
  });
};

/* Small helper to check per-file size after Multer */
function findOversizeFile(files) {
  if (!files || !files.length) return null;
  return files.find(f => typeof f.size === 'number' && f.size > PER_FILE_LIMIT_BYTES) || null;
}

/* -----------------------------------------------------------
   ARCHIVE HELPERS
----------------------------------------------------------- */

async function cascadeArchiveToRelated({ moduleId, archived }) {
  const batch = firestore.batch();

  const assignmentsSnap = await firestore.collection('assignments').where('moduleId', '==', moduleId).get();
  assignmentsSnap.forEach(doc => batch.update(doc.ref, { archived, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));

  const quizzesSnap = await firestore.collection('quizzes').where('moduleId', '==', moduleId).get();
  quizzesSnap.forEach(doc => batch.update(doc.ref, { archived, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));

  await batch.commit();
}

async function setArchiveStateForModule(moduleId, archived) {
  const moduleRef = firestore.collection('modules').doc(moduleId);
  const snap = await moduleRef.get();
  if (!snap.exists) return { ok: false, code: 404, message: 'Module not found.' };

  await moduleRef.update({ archived, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await cascadeArchiveToRelated({ moduleId, archived });
  return { ok: true };
}

/* -----------------------------------------------------------
   MODULE: UPLOAD  (Cloud Storage)
----------------------------------------------------------- */

// POST /upload-module
router.post('/upload-module', flexibleUpload, asyncHandler(async (req, res) => {
  const startTime = Date.now();

  const { moduleTitle, moduleType, courseId } = req.body;
  let videoUrls = req.body.videoUrls;
  if (videoUrls && !Array.isArray(videoUrls)) videoUrls = [videoUrls];

  let files = req.files;
  if ((!files || files.length === 0) && req.file) files = [req.file];

  let attachmentDescs = req.body.attachmentDescs;
  if (attachmentDescs && !Array.isArray(attachmentDescs)) attachmentDescs = [attachmentDescs];

  if (!moduleTitle || !moduleType || !courseId) {
    return res.status(400).json({ success: false, message: 'Missing required fields (title/type/course).' });
  }

  const oversize = findOversizeFile(files);
  if (oversize) {
    const mb = (oversize.size / (1024 * 1024)).toFixed(1);
    return res.status(400).json({
      success: false,
      message: `File "${oversize.originalname || oversize.filename}" is ${mb} MB, which exceeds the per-file limit of ${PER_FILE_LIMIT_MB} MB.`
    });
  }

  if (moduleType === 'file' && (!files || files.length === 0)) {
    return res.status(400).json({ success: false, message: 'At least one attachment file is required.' });
  }
  if (moduleType === 'text') {
    const noUrls = !videoUrls || !Array.isArray(videoUrls) || videoUrls.length === 0 ||
                   videoUrls.every(url => !url || String(url).trim() === '');
    if (noUrls) {
      return res.status(400).json({ success: false, message: 'At least one video URL is required for text type module.' });
    }
  }

  // Determine next module number for this course
  const moduleSnapshot = await firestore.collection('modules').where('courseId', '==', courseId).orderBy('moduleNumber', 'desc').limit(1).get();
  let nextModuleNumber = 1;
  if (!moduleSnapshot.empty) {
    const lastModule = moduleSnapshot.docs[0].data();
    nextModuleNumber = (lastModule.moduleNumber || 0) + 1;
  }

  let moduleSubTitles = req.body.moduleSubTitles || [];
  let moduleSubDescs = req.body.moduleSubDescs || [];
  if (typeof moduleSubTitles === 'string') moduleSubTitles = [moduleSubTitles];
  if (typeof moduleSubDescs === 'string') moduleSubDescs = [moduleSubDescs];

  const moduleData = {
    title: moduleTitle,
    type: moduleType,
    courseId,
    moduleNumber: nextModuleNumber,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    moduleSubTitles,
    moduleSubDescs,
    archived: false,
    attachments: []
  };

  // First create the module doc to obtain moduleId
  const moduleRef = await firestore.collection('modules').add(moduleData);

  if (moduleType === 'file' && files && files.length > 0) {
    let lessonIdxs = req.body.attachmentLessonIdx;
    if (lessonIdxs && !Array.isArray(lessonIdxs)) lessonIdxs = [lessonIdxs];

    if (!lessonIdxs || lessonIdxs.length !== files.length) {
      await moduleRef.delete();
      return res.status(400).json({ success: false, message: 'Lesson index missing or mismatched for attachments.' });
    }

    const oversizeAgain = findOversizeFile(files);
    if (oversizeAgain) {
      const mb = (oversizeAgain.size / (1024 * 1024)).toFixed(1);
      await moduleRef.delete();
      return res.status(400).json({
        success: false,
        message: `File "${oversizeAgain.originalname || oversizeAgain.filename}" is ${mb} MB, which exceeds the per-file limit of ${PER_FILE_LIMIT_MB} MB.`
      });
    }

    const lessonCount = Array.isArray(moduleSubTitles) ? moduleSubTitles.length : 0;
    const flatAttachments = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const idx = parseInt(lessonIdxs[i], 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= lessonCount) continue;

      const destPath = `modules/${courseId}/${moduleRef.id}/lesson_${idx}/${Date.now()}_${safeName(file.originalname || 'file')}`;
      const { gsUri, publicUrl, metadata } = await saveBufferToStorage(file.buffer, {
        destPath,
        contentType: file.mimetype,
        metadata: { role: 'module-attachment', courseId, moduleId: moduleRef.id, lessonIdx: String(idx) }
      });

      flatAttachments.push({
        lessonIdx: idx,
        description: (attachmentDescs && attachmentDescs[i]) ? attachmentDescs[i] : '',
        originalName: file.originalname,
        size: file.size,
        mime: file.mimetype,
        gsUri, publicUrl, storageMetadata: metadata
      });
    }

    if (!flatAttachments.length) {
      await moduleRef.delete();
      return res.status(400).json({ success: false, message: 'File upload failed. Please try again.' });
    }

    await moduleRef.set({ attachments: flatAttachments }, { merge: true });
  }

  if (moduleType === 'text' && videoUrls && Array.isArray(videoUrls)) {
    let videoDescs = req.body.videoDesc || req.body['videoDesc[]'] || req.body['videoDescs'] || [];
    if (typeof videoDescs === 'string') videoDescs = [videoDescs];

    const urlAttachments = videoUrls
      .map((url, idx) => {
        if (url && String(url).trim()) {
          return { url: String(url).trim(), videoDesc: (videoDescs && videoDescs[idx]) ? videoDescs[idx] : '', lessonIdx: idx };
        }
        return null;
      })
      .filter(Boolean);

    if (!urlAttachments.length) {
      await moduleRef.delete();
      return res.status(400).json({ success: false, message: 'URL upload failed. Please provide at least one valid video URL.' });
    }

    await moduleRef.set({ attachments: urlAttachments }, { merge: true });
  }

  const processingTime = Date.now() - startTime;
  return res.status(200).json({
    success: true,
    message: 'Module uploaded successfully.',
    moduleNumber: nextModuleNumber,
    moduleId: moduleRef.id,
    processingTime
  });
}));

// ---- Multer & file-type error handler (scoped to this router) ----
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: `File too large. Maximum per-file size is ${PER_FILE_LIMIT_MB} MB.` });
    }
    return res.status(400).json({ success: false, message: `File upload error: ${error.message}` });
  }
  if (error && error.message === 'File type not allowed') {
    return res.status(400).json({ success: false, message: 'File type not allowed. Please upload a supported file type.' });
  }
  return next(error);
});

/* -----------------------------------------------------------
   MODULE: GET (by moduleId)
----------------------------------------------------------- */
router.get('/modules/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await firestore.collection('modules').doc(id).get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Module not found.' });
  res.json({ id: doc.id, ...doc.data() });
}));

/* -----------------------------------------------------------
   MODULES: LIST FOR COURSE
----------------------------------------------------------- */
router.get('/courses/:id/modules', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const includeArchived = String(req.query.includeArchived).toLowerCase() === 'true';

  const snapshot = await firestore.collection('modules').where('courseId', '==', id).orderBy('moduleNumber', 'desc').get();
  let list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  if (!includeArchived) list = list.filter(m => m.archived !== true);

  res.json(list);
}));

/* -----------------------------------------------------------
   MODULE: UPDATE
----------------------------------------------------------- */
router.put('/modules/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, moduleSubTitles, moduleSubDescs } = req.body;

  if (!title || !description) {
    return res.status(400).json({ success: false, message: 'Title and description are required.' });
  }

  const moduleDoc = await firestore.collection('modules').doc(id).get();
  if (!moduleDoc.exists) return res.status(404).json({ success: false, message: 'Module not found.' });

  const updateObj = { title, description, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (Array.isArray(moduleSubTitles)) updateObj.moduleSubTitles = moduleSubTitles;
  if (Array.isArray(moduleSubDescs)) updateObj.moduleSubDescs = moduleSubDescs;

  await firestore.collection('modules').doc(id).update(updateObj);
  res.json({ success: true, message: 'Module updated successfully.' });
}));

/* -----------------------------------------------------------
   MODULE: ARCHIVE / UNARCHIVE
----------------------------------------------------------- */
router.put('/modules/:id/archive', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await setArchiveStateForModule(id, true);
  if (!result.ok) return res.status(result.code || 500).json({ success: false, message: result.message || 'Failed to archive.' });
  res.json({ success: true, message: 'Module archived. Related assignments and quizzes hidden.' });
}));

router.put('/modules/:id/unarchive', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await setArchiveStateForModule(id, false);
  if (!result.ok) return res.status(result.code || 500).json({ success: false, message: result.message || 'Failed to unarchive.' });
  res.json({ success: true, message: 'Module unarchived. Related assignments and quizzes restored.' });
}));

/* -----------------------------------------------------------
   MODULE: DELETE & RENUMBER  (+ Storage cleanup)
----------------------------------------------------------- */
router.delete('/modules/:id', asyncHandler(async (req, res) => {
  const moduleId = req.params.id;

  const moduleRef = firestore.collection('modules').doc(moduleId);
  const moduleDoc = await moduleRef.get();
  if (!moduleDoc.exists) return res.status(404).json({ success: false, message: 'Module not found.' });

  const { courseId } = moduleDoc.data();

  await moduleRef.delete();
  try { await bucket.deleteFiles({ prefix: `modules/${courseId}/${moduleId}/` }); } catch {}

  const modulesSnapshot = await firestore.collection('modules').where('courseId', '==', courseId).orderBy('moduleNumber').get();

  let moduleNumber = 1;
  const batch = firestore.batch();
  modulesSnapshot.forEach(doc => { batch.update(doc.ref, { moduleNumber }); moduleNumber++; });
  await batch.commit();

  res.json({ success: true, message: 'Module deleted and modules renumbered.' });
}));

/* -----------------------------------------------------------
   COMPLETIONS (unchanged)
----------------------------------------------------------- */
router.get('/users/:email/modules/:moduleId/isCompleted', asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const moduleId = req.params.moduleId;

  const userSnapshot = await firestore.collection('users').where('email', '==', email).get();
  if (userSnapshot.empty) return res.json({ completed: false });

  const userId = userSnapshot.docs[0].id;
  const moduleDoc = await firestore.collection('users').doc(userId).collection('completedModules').doc(moduleId).get();

  res.json({ completed: moduleDoc.exists });
}));

router.get('/users/:email/completed-modules-count', asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email);

  const userSnapshot = await firestore.collection('users').where('email', '==', email).get();
  if (userSnapshot.empty) return res.status(404).json({ count: 0, message: 'User not found' });
  const userId = userSnapshot.docs[0].id;

  const snapshot = await firestore.collection('users').doc(userId).collection('completedModules').get();
  res.json({ count: snapshot.size });
}));

router.post('/mark-module-complete', asyncHandler(async (req, res) => {
  const { email, moduleId } = req.body;

  if (!email || !moduleId) {
    return res.status(400).json({ success: false, message: 'Missing email or moduleId.' });
  }

  const userSnapshot = await firestore.collection('users').where('email', '==', email).get();
  if (userSnapshot.empty) return res.status(404).json({ success: false, message: 'User not found.' });

  const userId = userSnapshot.docs[0].id;
  const userRef = firestore.collection('users').doc(userId);

  const completedModulesRef = userRef.collection('completedModules');
  const existingModuleDoc = await completedModulesRef.doc(moduleId).get();

  if (!existingModuleDoc.exists) {
    const moduleDoc = await firestore.collection('modules').doc(moduleId).get();
    if (!moduleDoc.exists) return res.status(404).json({ success: false, message: 'Module not found.' });

    const { courseId } = moduleDoc.data();

    await completedModulesRef.doc(moduleId).set({
      moduleId,
      courseId,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const allModulesSnapshot = await firestore.collection('modules').where('courseId', '==', courseId).get();
    const allModuleIds = allModulesSnapshot.docs.map(doc => doc.id);
    const completedSnapshot = await completedModulesRef.where('courseId', '==', courseId).get();
    const completedIds = completedSnapshot.docs.map(doc => doc.id);
    const allCompleted = allModuleIds.every(id => completedIds.includes(id));

    if (allCompleted) {
      const completedCoursesRef = userRef.collection('completedCourses');
      await completedCoursesRef.doc(courseId).set({
        courseId,
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }

  res.json({ success: true, message: 'Module marked complete. Course updated if fully complete.' });
}));

module.exports = router;
