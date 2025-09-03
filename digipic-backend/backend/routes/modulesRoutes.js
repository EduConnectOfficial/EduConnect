// ==== routes/modulesRoutes.js ==== //
const router = require('express').Router();
const multer = require('multer');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { commonUpload } = require('../config/multerConfig');

// Helpers for upload fallback behavior
const arrayUpload = commonUpload.array('attachmentFiles');
const singleUpload = commonUpload.single('moduleFile');

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

/* -----------------------------------------------------------
   ARCHIVE HELPERS
----------------------------------------------------------- */

/** Update archive flag on related collections that reference the moduleId. */
async function cascadeArchiveToRelated({ moduleId, archived }) {
  const batch = firestore.batch();

  // Assignments referencing this module
  const assignmentsSnap = await firestore
    .collection('assignments')
    .where('moduleId', '==', moduleId)
    .get();
  assignmentsSnap.forEach(doc => batch.update(doc.ref, {
    archived,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }));

  // Quizzes referencing this module
  const quizzesSnap = await firestore
    .collection('quizzes')
    .where('moduleId', '==', moduleId)
    .get();
  quizzesSnap.forEach(doc => batch.update(doc.ref, {
    archived,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }));

  await batch.commit();
}

/** Sets archived flag on a module and cascades to related docs. */
async function setArchiveStateForModule(moduleId, archived) {
  const moduleRef = firestore.collection('modules').doc(moduleId);
  const snap = await moduleRef.get();
  if (!snap.exists) return { ok: false, code: 404, message: 'Module not found.' };

  await moduleRef.update({
    archived,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await cascadeArchiveToRelated({ moduleId, archived });
  return { ok: true };
}

/* -----------------------------------------------------------
   MODULE: UPLOAD
----------------------------------------------------------- */

// POST /upload-module
router.post('/upload-module', flexibleUpload, asyncHandler(async (req, res) => {
  const startTime = Date.now();

  const { moduleTitle, moduleType, courseId } = req.body;
  // Accept videoUrls as array for text modules
  let videoUrls = req.body.videoUrls;
  if (videoUrls && !Array.isArray(videoUrls)) videoUrls = [videoUrls];

  // Always use req.files for attachments, fallback to req.file for legacy single upload
  let files = req.files;
  if ((!files || files.length === 0) && req.file) files = [req.file];

  // For multiple descriptions, req.body.attachmentDescs can be a string or array
  let attachmentDescs = req.body.attachmentDescs;
  if (attachmentDescs && !Array.isArray(attachmentDescs)) attachmentDescs = [attachmentDescs];

  // Validation
  if (!moduleTitle || !moduleType || !courseId) {
    return res.status(400).json({ success: false, message: 'Missing required fields (title/type/course).' });
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
  const moduleSnapshot = await firestore.collection('modules')
    .where('courseId', '==', courseId)
    .orderBy('moduleNumber', 'desc')
    .limit(1)
    .get();

  let nextModuleNumber = 1;
  if (!moduleSnapshot.empty) {
    const lastModule = moduleSnapshot.docs[0].data();
    nextModuleNumber = (lastModule.moduleNumber || 0) + 1;
  }

  // Collect sub titles and descriptions (arrays)
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
    // Important: ensure the field is always present so we can reliably filter
    archived: false
  };

  // Attachments for file type
  if (moduleType === 'file' && files && files.length > 0) {
    let lessonIdxs = req.body.attachmentLessonIdx;
    if (lessonIdxs && !Array.isArray(lessonIdxs)) lessonIdxs = [lessonIdxs];

    if (!lessonIdxs || lessonIdxs.length !== files.length) {
      return res.status(400).json({
        success: false,
        message: 'Lesson index missing or mismatched for attachments.'
      });
    }

    const lessonCount = Array.isArray(moduleSubTitles) ? moduleSubTitles.length : 0;
    const flatAttachments = [];
    files.forEach((file, i) => {
      const idx = parseInt(lessonIdxs[i], 10);
      if (!Number.isNaN(idx) && idx >= 0 && idx < lessonCount) {
        flatAttachments.push({
          filePath: `/uploads/modules/${file.filename}`,
          description: (attachmentDescs && attachmentDescs[i]) ? attachmentDescs[i] : '',
          lessonIdx: idx
        });
      }
    });

    if (!flatAttachments.length) {
      return res.status(400).json({ success: false, message: 'File upload failed. Please try again.' });
    }

    moduleData.attachments = flatAttachments;
  }

  // For text type, store each video URL as an attachment with lessonIdx
  if (moduleType === 'text' && videoUrls && Array.isArray(videoUrls)) {
    let videoDescs = req.body.videoDesc || req.body['videoDesc[]'] || req.body['videoDescs'] || [];
    if (typeof videoDescs === 'string') videoDescs = [videoDescs];

    const urlAttachments = videoUrls
      .map((url, idx) => {
        if (url && String(url).trim()) {
          return {
            url: String(url).trim(),
            videoDesc: (videoDescs && videoDescs[idx]) ? videoDescs[idx] : '',
            lessonIdx: idx
          };
        }
        return null;
      })
      .filter(Boolean);

    if (!urlAttachments.length) {
      return res.status(400).json({
        success: false,
        message: 'URL upload failed. Please provide at least one valid video URL.'
      });
    }

    moduleData.attachments = urlAttachments;
  }

  // Save to Firestore
  await firestore.collection('modules').add(moduleData);

  const processingTime = Date.now() - startTime;
  return res.status(200).json({
    success: true,
    message: 'Module uploaded successfully.',
    moduleNumber: nextModuleNumber,
    processingTime
  });
}));

// ---- Multer & file-type error handler (scoped to this router) ----
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'File too large. Maximum size is 50MB.' });
    }
    return res.status(400).json({ success: false, message: `File upload error: ${error.message}` });
  }
  if (error && error.message === 'File type not allowed') {
    return res.status(400).json({ success: false, message: 'File type not allowed. Please upload a supported file type.' });
  }
  return next(error); // let the global error handler catch other errors
});

/* -----------------------------------------------------------
   MODULE: GET (by moduleId)
----------------------------------------------------------- */

// GET /modules/:id
router.get('/modules/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await firestore.collection('modules').doc(id).get();
  if (!doc.exists) {
    return res.status(404).json({ success: false, message: 'Module not found.' });
  }
  res.json({ id: doc.id, ...doc.data() });
}));

/* -----------------------------------------------------------
   MODULES: LIST FOR COURSE
   Default: hide archived. Use ?includeArchived=true to show all.
   (Sorted by moduleNumber DESC)
----------------------------------------------------------- */

// GET /courses/:id/modules
router.get('/courses/:id/modules', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const includeArchived = String(req.query.includeArchived).toLowerCase() === 'true';

  // We fetch all for the course, then filter in-memory to avoid Firestore inequality+orderBy constraints
  const snapshot = await firestore
    .collection('modules')
    .where('courseId', '==', id)
    .orderBy('moduleNumber', 'desc')
    .get();

  let list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  if (!includeArchived) {
    // keep if archived is not true (missing -> treated as active)
    list = list.filter(m => m.archived !== true);
  }

  res.json(list);
}));

/* -----------------------------------------------------------
   MODULE: UPDATE
----------------------------------------------------------- */

// PUT /modules/:id  body: { title, description, moduleSubTitles?, moduleSubDescs? }
router.put('/modules/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, moduleSubTitles, moduleSubDescs } = req.body;

  if (!title || !description) {
    return res.status(400).json({ success: false, message: 'Title and description are required.' });
  }

  const moduleDoc = await firestore.collection('modules').doc(id).get();
  if (!moduleDoc.exists) {
    return res.status(404).json({ success: false, message: 'Module not found.' });
  }

  const updateObj = {
    title,
    description,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (Array.isArray(moduleSubTitles)) updateObj.moduleSubTitles = moduleSubTitles;
  if (Array.isArray(moduleSubDescs)) updateObj.moduleSubDescs = moduleSubDescs;

  await firestore.collection('modules').doc(id).update(updateObj);
  res.json({ success: true, message: 'Module updated successfully.' });
}));

/* -----------------------------------------------------------
   MODULE: ARCHIVE / UNARCHIVE
----------------------------------------------------------- */

// PUT /modules/:id/archive
router.put('/modules/:id/archive', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await setArchiveStateForModule(id, true);
  if (!result.ok) {
    return res.status(result.code || 500).json({ success: false, message: result.message || 'Failed to archive.' });
  }
  res.json({ success: true, message: 'Module archived. Related assignments and quizzes hidden.' });
}));

// PUT /modules/:id/unarchive
router.put('/modules/:id/unarchive', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await setArchiveStateForModule(id, false);
  if (!result.ok) {
    return res.status(result.code || 500).json({ success: false, message: result.message || 'Failed to unarchive.' });
  }
  res.json({ success: true, message: 'Module unarchived. Related assignments and quizzes restored.' });
}));

/* -----------------------------------------------------------
   MODULE: DELETE & RENUMBER
----------------------------------------------------------- */

// DELETE /modules/:id
router.delete('/modules/:id', asyncHandler(async (req, res) => {
  const moduleId = req.params.id;

  // Get the module to find its courseId
  const moduleRef = firestore.collection('modules').doc(moduleId);
  const moduleDoc = await moduleRef.get();

  if (!moduleDoc.exists) {
    return res.status(404).json({ success: false, message: 'Module not found.' });
  }

  const { courseId } = moduleDoc.data();

  // Delete module
  await moduleRef.delete();

  // Re-number remaining modules for this course by moduleNumber ASC
  const modulesSnapshot = await firestore
    .collection('modules')
    .where('courseId', '==', courseId)
    .orderBy('moduleNumber')
    .get();

  let moduleNumber = 1;
  const batch = firestore.batch();
  modulesSnapshot.forEach(doc => {
    batch.update(doc.ref, { moduleNumber });
    moduleNumber++;
  });
  await batch.commit();

  res.json({ success: true, message: 'Module deleted and modules renumbered.' });
}));

/* -----------------------------------------------------------
   COMPLETIONS ENDPOINTS (unchanged)
----------------------------------------------------------- */

// ==== MODULE: CHECK IF SPECIFIC MODULE IS COMPLETED ====
// GET /users/:email/modules/:moduleId/isCompleted
router.get('/users/:email/modules/:moduleId/isCompleted', asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const moduleId = req.params.moduleId;

  const userSnapshot = await firestore.collection('users').where('email', '==', email).get();
  if (userSnapshot.empty) return res.json({ completed: false });

  const userId = userSnapshot.docs[0].id;
  const moduleDoc = await firestore
    .collection('users')
    .doc(userId)
    .collection('completedModules')
    .doc(moduleId)
    .get();

  res.json({ completed: moduleDoc.exists });
}));

// ==== MODULE: COMPLETED MODULE COUNT ====
// GET /users/:email/completed-modules-count
router.get('/users/:email/completed-modules-count', asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email);

  const userSnapshot = await firestore.collection('users').where('email', '==', email).get();
  if (userSnapshot.empty) {
    return res.status(404).json({ count: 0, message: 'User not found' });
  }
  const userId = userSnapshot.docs[0].id;

  const snapshot = await firestore
    .collection('users')
    .doc(userId)
    .collection('completedModules')
    .get();

  res.json({ count: snapshot.size });
}));

// ==== MODULE: MARK AS COMPLETE ====
// POST /mark-module-complete   body: { email, moduleId }
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
    if (!moduleDoc.exists) {
      return res.status(404).json({ success: false, message: 'Module not found.' });
    }

    const { courseId } = moduleDoc.data();

    await completedModulesRef.doc(moduleId).set({
      moduleId,
      courseId,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Check if all modules in the course are completed
    const allModulesSnapshot = await firestore.collection('modules')
      .where('courseId', '==', courseId)
      .get();

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
