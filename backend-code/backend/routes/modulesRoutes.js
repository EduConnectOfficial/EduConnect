// ==== routes/modulesRoutes.js ====
'use strict';

const router = require('express').Router();
const multer = require('multer');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { uploadMemory } = require('../config/multerConfig');
const { saveBufferToStorage, buildStoragePath, safeName } = require('../services/storageService');

// ---------------- File size limit (PER FILE) ----------------
// Keep this in sync with your frontend. Override via env: MODULE_FILE_LIMIT_MB=300
const PER_FILE_LIMIT_MB = parseInt(process.env.MODULE_FILE_LIMIT_MB || '300', 10);
const PER_FILE_LIMIT_BYTES = PER_FILE_LIMIT_MB * 1024 * 1024;

// Helpers for upload fallback behavior (array field)
const arrayUpload = uploadMemory.array('attachmentFiles');
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

/* Small helper to check per-file size after Multer.
   NOTE: For true pre-write enforcement, also set `limits.fileSize`
   in ../config/multerConfig to PER_FILE_LIMIT_BYTES. */
function findOversizeFile(files) {
  if (!files || !files.length) return null;
  return files.find(f => typeof f.size === 'number' && f.size > PER_FILE_LIMIT_BYTES) || null;
}

// Random id for attachments
function genId() {
  return firestore.collection('_').doc().id;
}

/* -----------------------------------------------------------
   GENERAL HELPERS (assigned classes + publish fields)
----------------------------------------------------------- */

function normalizeToArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

// Read assignedClasses from either repeated fields or a JSON field.
function readAssignedClasses(req) {
  // From FormData: repeated fields
  let list = normalizeToArray(req.body.assignedClasses)
    .map(s => String(s || '').trim())
    .filter(Boolean);

  // Or JSON string
  if (!list.length && req.body.assignedClassesJson) {
    try {
      const as = JSON.parse(String(req.body.assignedClassesJson));
      if (Array.isArray(as)) {
        list = as.map(s => String(s || '').trim()).filter(Boolean);
      }
    } catch {
      /* ignore JSON parse error; will be validated later */
    }
  }

  // Unique
  return Array.from(new Set(list));
}

async function validateClassIds(classIds) {
  if (!classIds.length) return { ok: true, validIds: [] };

  // Firestore 'in' supports up to 10. Batch by 10.
  const chunks = [];
  for (let i = 0; i < classIds.length; i += 10) {
    chunks.push(classIds.slice(i, i + 10));
  }

  const found = new Set();
  for (const chunk of chunks) {
    const snap = await firestore.collection('classes')
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .get();
    snap.forEach(d => {
      const data = d.data() || {};
      if (data.archived === true) return; // exclude archived from assignment
      found.add(d.id);
    });
  }

  const validIds = classIds.filter(id => found.has(id));
  return { ok: true, validIds };
}

/** Parse publish controls coming from the frontend.
 *  - published: boolean
 *  - publishAt: ISO string from <input type="datetime-local"> (local time), or null/'' to clear
 *  Returns { hasPublished, publishedValue, hasPublishAt, publishAtTimestamp|null, publishNow }
 */
function parsePublishFields(body = {}, currentDoc = {}) {
  // published toggle
  let hasPublished = false;
  let publishedValue = undefined;
  if (typeof body.published === 'boolean') {
    hasPublished = true;
    publishedValue = body.published;
  } else if (typeof body.published === 'string') {
    // Accept "true"/"false" strings
    const s = body.published.trim().toLowerCase();
    if (s === 'true' || s === 'false') {
      hasPublished = true;
      publishedValue = (s === 'true');
    }
  }

  // publishAt ISO / clear
  let hasPublishAt = false;
  let publishAtTimestamp = undefined;
  if ('publishAt' in body) {
    hasPublishAt = true;
    const v = body.publishAt;
    if (v === null || v === '' || v === 'null') {
      publishAtTimestamp = null; // explicitly clear
    } else if (typeof v === 'string') {
      const dt = new Date(v); // frontend sends ISO with local tz -> JS Date
      if (!isNaN(dt.getTime())) {
        publishAtTimestamp = admin.firestore.Timestamp.fromDate(dt);
      } else {
        // invalid string -> ignore by not setting hasPublishAt
        hasPublishAt = false;
      }
    }
  }

  // infer "publish now" event:
  // If published flips to true and there is no existing publishedAt on the doc, stamp it now.
  let publishNow = false;
  if (hasPublished && publishedValue === true) {
    const curPublished = !!currentDoc.published;
    const alreadyStamped = !!currentDoc.publishedAt;
    if (!curPublished && !alreadyStamped) {
      publishNow = true;
    }
  }

  return { hasPublished, publishedValue, hasPublishAt, publishAtTimestamp, publishNow };
}

async function createClassIndexDocs({ moduleId, title, courseId, moduleNumber, archived, classIds }) {
  if (!classIds || !classIds.length) return;
  const batch = firestore.batch();
  classIds.forEach(cid => {
    const ref = firestore.collection('classes').doc(cid).collection('modules').doc(moduleId);
    batch.set(ref, {
      moduleId,
      courseId,
      title: title || '',
      moduleNumber: moduleNumber || 0,
      archived: !!archived,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
  await batch.commit();
}

async function updateClassIndexArchive({ moduleId, classIds, archived }) {
  if (!classIds || !classIds.length) return;
  const batch = firestore.batch();
  classIds.forEach(cid => {
    const ref = firestore.collection('classes').doc(cid).collection('modules').doc(moduleId);
    batch.set(ref, {
      archived: !!archived,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
  await batch.commit();
}

async function deleteClassIndexDocs({ moduleId, classIds }) {
  if (!classIds || !classIds.length) return;
  const batch = firestore.batch();
  classIds.forEach(cid => {
    const ref = firestore.collection('classes').doc(cid).collection('modules').doc(moduleId);
    batch.delete(ref);
  });
  await batch.commit();
}

/* -----------------------------------------------------------
   STORAGE HELPERS (delete)
----------------------------------------------------------- */

function pathFromGsUri(gsUri = '') {
  if (!gsUri || typeof gsUri !== 'string') return '';
  if (!gsUri.startsWith('gs://')) return '';
  const noScheme = gsUri.replace('gs://', '');
  const parts = noScheme.split('/');
  parts.shift(); // bucket
  return parts.join('/');
}
function pathFromPublicUrl(publicUrl = '') {
  try {
    if (!publicUrl) return '';
    const u = new URL(publicUrl);
    // https://storage.googleapis.com/<bucket>/<path>
    const parts = u.pathname.replace(/^\/+/, '').split('/');
    parts.shift(); // bucket
    return parts.join('/');
  } catch {
    return '';
  }
}
function pathFromDownloadUrl(downloadUrl = '') {
  try {
    if (!downloadUrl) return '';
    const u = new URL(downloadUrl);
    // https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<ENCODED_PATH>?...
    if (u.pathname.includes('/o/')) {
      const enc = u.pathname.split('/o/')[1];
      return decodeURIComponent(enc);
    }
  } catch {
    /* ignore */
  }
  return '';
}

async function deleteStorageObjectFromAttachment(att) {
  try {
    const bucket = admin.storage().bucket();
    // Prefer explicit storagePath if you saved it
    let storagePath =
      att.storagePath ||
      pathFromGsUri(att.gsUri) ||
      pathFromDownloadUrl(att.downloadUrl || att.previewUrl) ||
      pathFromPublicUrl(att.publicUrl);

    if (!storagePath) {
      // Nothing to delete (likely a pure external link)
      return;
    }
    const file = bucket.file(storagePath);
    await file.delete({ ignoreNotFound: true });
  } catch (e) {
    // Non-fatal: log and continue
    console.warn('deleteStorageObjectFromAttachment failed:', e.message);
  }
}

/* -----------------------------------------------------------
   ARCHIVE HELPERS
----------------------------------------------------------- */

/** Update archive flag on related collections that reference the moduleId. */
async function cascadeArchiveToRelated({ moduleId, archived, assignedClasses }) {
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

  // Also propagate to class index docs
  if (Array.isArray(assignedClasses) && assignedClasses.length) {
    await updateClassIndexArchive({ moduleId, classIds: assignedClasses, archived });
  }
}

/** Sets archived flag on a module and cascades to related docs. */
async function setArchiveStateForModule(moduleId, archived) {
  const moduleRef = firestore.collection('modules').doc(moduleId);
  const snap = await moduleRef.get();
  if (!snap.exists) return { ok: false, code: 404, message: 'Module not found.' };

  const data = snap.data() || {};
  await moduleRef.update({
    archived,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await cascadeArchiveToRelated({
    moduleId,
    archived,
    assignedClasses: data.assignedClasses || []
  });
  return { ok: true };
}

/* -----------------------------------------------------------
   LESSON HELPERS (for per-lesson completion)
----------------------------------------------------------- */

// Compute total lesson count just like the frontend does
function computeLessonCount(mod = {}) {
  const subs  = Array.isArray(mod.moduleSubTitles) ? mod.moduleSubTitles.length : 0;
  const descs = Array.isArray(mod.moduleSubDescs) ? mod.moduleSubDescs.length : 0;
  const lc = Number.isFinite(mod.lessonCount) ? mod.lessonCount : 0;
  return Math.max(lc, subs, descs);
}

async function _getUserIdByEmail(email) {
  const snap = await firestore.collection('users').where('email', '==', email).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].id;
}

/* -----------------------------------------------------------
   MODULE: UPLOAD (Cloud Storage + inline previews)
   + Publish fields (published, publishAt, publishedAt)
----------------------------------------------------------- */

// POST /upload-module
router.post('/upload-module', flexibleUpload, asyncHandler(async (req, res) => {
  const startTime = Date.now();

  const { moduleTitle, moduleType, courseId } = req.body;

  // Accept videoUrls as array for text modules
  let videoUrls = req.body.videoUrls;
  if (videoUrls && !Array.isArray(videoUrls)) videoUrls = [videoUrls];

  // Assigned classes (from repeated fields or JSON)
  const assignedClassesRaw = readAssignedClasses(req);

  // Always use req.files for attachments, fallback to req.file for legacy single upload
  let files = req.files;
  if ((!files || files.length === 0) && req.file) files = [req.file];

  // For multiple descriptions, req.body.attachmentDescs can be a string or array
  let attachmentDescs = req.body.attachmentDescs;
  if (attachmentDescs && !Array.isArray(attachmentDescs)) attachmentDescs = [attachmentDescs];

  // Validation: basic fields
  if (!moduleTitle || !moduleType || !courseId) {
    return res.status(400).json({ success: false, message: 'Missing required fields (title/type/course).' });
  }

  // Validation: enforce per-file size limit early (if there are files at all)
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

  // Validate assigned classes (optional)
  let assignedClasses = [];
  if (assignedClassesRaw.length) {
    const { validIds } = await validateClassIds(assignedClassesRaw);
    if (!validIds.length) {
      return res.status(400).json({ success: false, message: 'Selected classes are invalid or archived.' });
    }
    assignedClasses = validIds;
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

  // Publish fields
  const { hasPublished, publishedValue, hasPublishAt, publishAtTimestamp, publishNow } = parsePublishFields(req.body);

  const baseModuleDoc = {
    title: moduleTitle,
    type: moduleType,
    courseId,
    moduleNumber: nextModuleNumber,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    moduleSubTitles,
    moduleSubDescs,
    archived: false,
    assignedClasses,
    assignedClassCount: assignedClasses.length,
    // default publish state (overridden below if provided)
    published: false,
    publishAt: null,
    publishedAt: null
  };

  if (hasPublished) baseModuleDoc.published = !!publishedValue;
  if (hasPublishAt) baseModuleDoc.publishAt = publishAtTimestamp;
  if ((hasPublished && publishedValue === true) && publishNow) {
    baseModuleDoc.publishedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  // Create module shell (with assigned classes)
  const moduleDocRef = await firestore.collection('modules').add(baseModuleDoc);
  const moduleId = moduleDocRef.id;

  // Create per-class index docs (fast reverse lookups)
  if (assignedClasses.length) {
    await createClassIndexDocs({
      moduleId,
      title: moduleTitle,
      courseId,
      moduleNumber: nextModuleNumber,
      archived: false,
      classIds: assignedClasses
    });
  }

  // Attachments for file type (save to Cloud Storage with inline disposition)
  if (moduleType === 'file' && files && files.length > 0) {
    let lessonIdxs = req.body.attachmentLessonIdx;
    if (lessonIdxs && !Array.isArray(lessonIdxs)) lessonIdxs = [lessonIdxs];

    if (!lessonIdxs || lessonIdxs.length !== files.length) {
      // Rollback module shell & indexes
      await moduleDocRef.delete().catch(() => {});
      await deleteClassIndexDocs({ moduleId, classIds: assignedClasses }).catch(()=>{});
      return res.status(400).json({
        success: false,
        message: 'Lesson index missing or mismatched for attachments.'
      });
    }

    const lessonCount = Array.isArray(moduleSubTitles) ? moduleSubTitles.length : 0;
    const flatAttachments = [];

    // Save all files to storage
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const idx = parseInt(lessonIdxs[i], 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= lessonCount) continue;

      const originalName = f.originalname || f.filename || 'file';
      const destPath = buildStoragePath('modules', moduleId, originalName);
      const saved = await saveBufferToStorage(f.buffer, {
        destPath,
        contentType: f.mimetype || 'application/octet-stream',
        metadata: { originalName },
        filenameForDisposition: originalName, // ensures inline rendering filename
      });

      flatAttachments.push({
        id: genId(),
        url: saved.downloadUrl,
        gsUri: saved.gsUri,
        publicUrl: saved.publicUrl,
        storagePath: destPath,
        description: (attachmentDescs && attachmentDescs[i]) ? attachmentDescs[i] : '',
        lessonIdx: idx,
        originalName,
        size: f.size || null,
        mime: f.mimetype || null,
        createdAt: admin.firestore.Timestamp.now() // array-safe timestamp
      });
    }

    if (!flatAttachments.length) {
      await moduleDocRef.delete().catch(() => {});
      await deleteClassIndexDocs({ moduleId, classIds: assignedClasses }).catch(()=>{});
      return res.status(400).json({ success: false, message: 'File upload failed. Please try again.' });
    }

    await moduleDocRef.set({ attachments: flatAttachments }, { merge: true });
  }

  // For text type, store each video URL as an attachment and also create a tiny placeholder file
  if (moduleType === 'text' && videoUrls && Array.isArray(videoUrls)) {
    let videoDescs = req.body.videoDesc || req.body['videoDesc[]'] || req.body['videoDescs'] || [];
    if (typeof videoDescs === 'string') videoDescs = [videoDescs];

    const urlAttachments = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const url = String(videoUrls[i] || '').trim();
      if (!url) continue;

      const pretty = `VIDEO_URL_${i + 1}.txt`;
      const placeholderPath = buildStoragePath('modules', moduleId, pretty);
      const placeholderBody = Buffer.from(`Video URL:\n${url}\n`);
      const saved = await saveBufferToStorage(placeholderBody, {
        destPath: placeholderPath,
        contentType: 'text/plain',
        metadata: { originalName: pretty },
        filenameForDisposition: pretty,
      });

      urlAttachments.push({
        id: genId(),
        url,                              // external link for new tab
        previewUrl: saved.downloadUrl,    // token URL you can embed in modal as inline text
        gsUri: saved.gsUri,
        publicUrl: saved.publicUrl,
        storagePath: placeholderPath,
        videoDesc: (videoDescs && videoDescs[i]) ? videoDescs[i] : '',
        lessonIdx: i,
        createdAt: admin.firestore.Timestamp.now()
      });
    }

    if (!urlAttachments.length) {
      await moduleDocRef.delete().catch(() => {});
      await deleteClassIndexDocs({ moduleId, classIds: assignedClasses }).catch(()=>{});
      return res.status(400).json({
        success: false,
        message: 'URL upload failed. Please provide at least one valid video URL.'
      });
    }

    await moduleDocRef.set({ attachments: urlAttachments }, { merge: true });
  }

  const processingTime = Date.now() - startTime;
  return res.status(200).json({
    success: true,
    message: 'Module uploaded successfully.',
    moduleId,
    moduleNumber: nextModuleNumber,
    assignedClasses,
    assignedClassCount: assignedClasses.length,
    processingTime
  });
}));

// ---- Multer & file-type error handler (scoped to this router) ----
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: `File too large. Maximum per-file size is ${PER_FILE_LIMIT_MB} MB.`
      });
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
   Optional: filter by classId => only modules assigned to that class.
   (Sorted by moduleNumber DESC)
----------------------------------------------------------- */

// GET /courses/:id/modules
router.get('/courses/:id/modules', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const includeArchived = String(req.query.includeArchived).toLowerCase() === 'true';
  const classFilter = String(req.query.classId || '').trim();

  const snapshot = await firestore
    .collection('modules')
    .where('courseId', '==', id)
    .orderBy('moduleNumber', 'desc')
    .get();

  let list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  if (!includeArchived) {
    list = list.filter(m => m.archived !== true);
  }

  if (classFilter) {
    list = list.filter(m => Array.isArray(m.assignedClasses) && m.assignedClasses.includes(classFilter));
  }

  res.json(list);
}));

/* -----------------------------------------------------------
   MODULE: UPDATE (supports assignedClasses + publish fields)
----------------------------------------------------------- */

// PATCH /modules/:id
// body: { title?, description?, moduleSubTitles?, moduleSubDescs?, lessonCount?, assignedClasses?, assignedClassesJson?, published?, publishAt? }
router.patch('/modules/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, moduleSubTitles, moduleSubDescs, lessonCount } = req.body;

  const moduleRef = firestore.collection('modules').doc(id);
  const moduleDoc = await moduleRef.get();
  if (!moduleDoc.exists) {
    return res.status(404).json({ success: false, message: 'Module not found.' });
  }

  const current = moduleDoc.data() || {};
  const updateObj = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (typeof title === 'string') updateObj.title = title;
  if (typeof description === 'string') updateObj.description = description;
  if (Array.isArray(moduleSubTitles)) updateObj.moduleSubTitles = moduleSubTitles;
  if (Array.isArray(moduleSubDescs)) updateObj.moduleSubDescs = moduleSubDescs;
  if (typeof lessonCount === 'number') updateObj.lessonCount = lessonCount;

  // Publish changes
  const { hasPublished, publishedValue, hasPublishAt, publishAtTimestamp, publishNow } = parsePublishFields(req.body, current);
  if (hasPublished) updateObj.published = !!publishedValue;
  if (hasPublishAt) updateObj.publishAt = publishAtTimestamp; // can be Timestamp or null to clear
  if (publishNow) updateObj.publishedAt = admin.firestore.FieldValue.serverTimestamp();

  // Assigned classes update (optional)
  const incomingAssigned = readAssignedClasses(req);
  let changedAssigned = false;
  let finalAssigned = Array.isArray(current.assignedClasses) ? current.assignedClasses.slice() : [];

  if (incomingAssigned.length) {
    const { validIds } = await validateClassIds(incomingAssigned);
    // Compute diffs
    const prevSet = new Set(finalAssigned);
    const newSet = new Set(validIds);
    const toAdd = validIds.filter(x => !prevSet.has(x));
    const toRemove = finalAssigned.filter(x => !newSet.has(x));

    if (toAdd.length || toRemove.length) {
      changedAssigned = true;
      finalAssigned = Array.from(newSet);
      updateObj.assignedClasses = finalAssigned;
      updateObj.assignedClassCount = finalAssigned.length;

      // update class index docs
      if (toAdd.length) {
        await createClassIndexDocs({
          moduleId: id,
          title: updateObj.title ?? current.title ?? '',
          courseId: current.courseId,
          moduleNumber: current.moduleNumber || 0,
          archived: current.archived === true,
          classIds: toAdd
        });
      }
      if (toRemove.length) {
        await deleteClassIndexDocs({ moduleId: id, classIds: toRemove });
      }
    }
  }

  await moduleRef.update(updateObj);
  res.json({
    success: true,
    message: 'Module updated successfully.',
    ...(changedAssigned ? { assignedClasses: finalAssigned, assignedClassCount: finalAssigned.length } : {})
  });
}));

// POST /modules/:id/files
// - multipart/form-data with field 'attachmentFiles' (+ 'attachmentDescs', 'attachmentLessonIdx')
// - application/json with body { links:[...]} OR { videoUrls:[...], videoDesc:[...], attachmentLessonIdx:[...] }
router.post('/modules/:id/files', flexibleUpload, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const moduleRef = firestore.collection('modules').doc(id);
  const snap = await moduleRef.get();
  if (!snap.exists) return res.status(404).json({ success: false, message: 'Module not found.' });

  const moduleData = snap.data() || {};
  const type = moduleData.type || 'file';
  let attachments = Array.isArray(moduleData.attachments) ? moduleData.attachments.slice() : [];

  // ---------- JSON branch (add links) ----------
  const isJson = req.is('application/json');
  if (isJson) {
    if (type !== 'text') {
      return res.status(400).json({ success: false, message: 'Links can only be added to text (Video URL) modules.' });
    }

    // Accept both shapes
    let links = req.body.links ?? req.body.videoUrls ?? [];
    if (!Array.isArray(links)) links = [links];

    let linkDescs = req.body.videoDesc ?? req.body.videoDescs ?? req.body['videoDesc[]'] ?? [];
    if (!Array.isArray(linkDescs)) linkDescs = [linkDescs];

    let linkIdxs = req.body.attachmentLessonIdx ?? req.body.lessonIdx ?? [];
    if (!Array.isArray(linkIdxs)) linkIdxs = [linkIdxs];

    links = links.map(v => String(v || '').trim()).filter(Boolean);
    if (!links.length) return res.status(400).json({ success: false, message: 'No valid links provided.' });

    const linkItems = [];
    for (let i = 0; i < links.length; i++) {
      const url = links[i];
      const pretty = `VIDEO_URL_${Date.now()}_${i + 1}.txt`;
      const destPath = buildStoragePath('modules', id, safeName(pretty));
      const body = Buffer.from(`Video URL:\n${url}\n`);

      const saved = await saveBufferToStorage(body, {
        destPath,
        contentType: 'text/plain',
        metadata: { originalName: pretty },
        filenameForDisposition: pretty,
      });

      let idxRaw = linkIdxs[i] ?? i;
      const idx = Number.isFinite(parseInt(idxRaw, 10)) ? Math.max(0, parseInt(idxRaw, 10)) : 0;

      linkItems.push({
        id: genId(),
        url,                          // external link
        previewUrl: saved.downloadUrl, // inline text preview
        gsUri: saved.gsUri,
        publicUrl: saved.publicUrl,
        storagePath: destPath,
        videoDesc: linkDescs[i] || '',
        lessonIdx: idx,
        createdAt: admin.firestore.Timestamp.now()
      });
    }

    attachments = attachments.concat(linkItems);
    await moduleRef.update({ attachments, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ success: true, files: attachments });
  }

  // ---------- Multipart branch (add files) ----------
  let files = req.files;
  if ((!files || !files.length) && req.file) files = [req.file];

  if (!files || !files.length) {
    return res.status(400).json({ success: false, message: 'No files found in request.' });
  }
  if (type !== 'file') {
    return res.status(400).json({ success: false, message: 'Files can only be uploaded to file-type modules.' });
  }

  // Enforce per-file size limit
  const oversize = findOversizeFile(files);
  if (oversize) {
    const mb = (oversize.size / (1024 * 1024)).toFixed(1);
    return res.status(400).json({
      success: false,
      message: `File "${oversize.originalname || oversize.filename}" is ${mb} MB, which exceeds the per-file limit of ${PER_FILE_LIMIT_MB} MB.`
    });
  }

  // Optional per-file descriptions + lesson indices
  let lessonIdxs = req.body.attachmentLessonIdx;
  if (lessonIdxs && !Array.isArray(lessonIdxs)) lessonIdxs = [lessonIdxs];

  let descs = req.body.attachmentDescs;
  if (descs && !Array.isArray(descs)) descs = [descs];

  const newItems = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const originalName = f.originalname || f.filename || 'file';
    const destPath = buildStoragePath('modules', id, originalName);

    const saved = await saveBufferToStorage(f.buffer, {
      destPath,
      contentType: f.mimetype || 'application/octet-stream',
      metadata: { originalName },
      filenameForDisposition: originalName,
    });

    let idxRaw = lessonIdxs?.[i];
    const idx = Number.isFinite(parseInt(idxRaw, 10)) ? Math.max(0, parseInt(idxRaw, 10)) : 0;

    newItems.push({
      id: genId(),
      url: saved.downloadUrl,
      gsUri: saved.gsUri,
      publicUrl: saved.publicUrl,
      storagePath: destPath,
      originalName,
      description: descs?.[i] || '',
      lessonIdx: idx,                           // tie to lesson
      size: f.size || null,
      mime: f.mimetype || null,
      createdAt: admin.firestore.Timestamp.now()
    });
  }

  attachments = attachments.concat(newItems);
  await moduleRef.update({
    attachments,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.json({ success: true, files: attachments });
}));


/* -----------------------------------------------------------
   MODULE: ATTACHMENT DELETE (and delete storage object)
----------------------------------------------------------- */

// DELETE /modules/:id/files/:fileId
// Supports both true attachment ids and a fallback "__idx_<n>" for older entries without ids.
router.delete('/modules/:id/files/:fileId', asyncHandler(async (req, res) => {
  const { id, fileId } = req.params;

  const moduleRef = firestore.collection('modules').doc(id);
  const snap = await moduleRef.get();
  if (!snap.exists) return res.status(404).json({ success: false, message: 'Module not found.' });

  const data = snap.data() || {};
  let attachments = Array.isArray(data.attachments) ? data.attachments.slice() : [];
  if (!attachments.length) return res.json({ success: true, files: attachments });

  // Find by id or by fallback index token
  let idx = attachments.findIndex(a => String(a.id || '') === String(fileId));
  if (idx < 0) {
    const m = String(fileId).match(/^__idx_(\d+)$/);
    if (m) {
      const iNum = parseInt(m[1], 10);
      if (!Number.isNaN(iNum) && iNum >= 0 && iNum < attachments.length) {
        idx = iNum;
      }
    }
  }

  if (idx < 0) return res.status(404).json({ success: false, message: 'Attachment not found.' });

  const target = attachments[idx];

  // Attempt to delete the storage object if we own one
  await deleteStorageObjectFromAttachment(target);

  // Remove from array
  attachments.splice(idx, 1);

  await moduleRef.update({
    attachments,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.json({ success: true, files: attachments });
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
  res.json({ success: true, message: 'Module archived. Related assignments, quizzes, and class indexes updated.' });
}));

// PUT /modules/:id/unarchive
router.put('/modules/:id/unarchive', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await setArchiveStateForModule(id, false);
  if (!result.ok) {
    return res.status(result.code || 500).json({ success: false, message: result.message || 'Failed to unarchive.' });
  }
  res.json({ success: true, message: 'Module unarchived. Related assignments, quizzes, and class indexes updated.' });
}));

/* -----------------------------------------------------------
   MODULE: DELETE & RENUMBER (also delete stored files, class index docs)
----------------------------------------------------------- */

// DELETE /modules/:id
router.delete('/modules/:id', asyncHandler(async (req, res) => {
  const moduleId = req.params.id;

  // Get the module to find its courseId, attachments, and assigned classes
  const moduleRef = firestore.collection('modules').doc(moduleId);
  const moduleDoc = await moduleRef.get();

  if (!moduleDoc.exists) {
    return res.status(404).json({ success: false, message: 'Module not found.' });
  }

  const { courseId, attachments, assignedClasses } = moduleDoc.data();

  // Best-effort delete of stored objects
  if (Array.isArray(attachments)) {
    await Promise.all(attachments.map(a => deleteStorageObjectFromAttachment(a)));
  }

  // Delete class index docs
  if (Array.isArray(assignedClasses) && assignedClasses.length) {
    await deleteClassIndexDocs({ moduleId, classIds: assignedClasses });
  }

  // Delete module doc
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

  res.json({ success: true, message: 'Module deleted (files & class indexes cleaned) and modules renumbered.' });
}));

/* -----------------------------------------------------------
   COMPLETIONS ENDPOINTS (UPGRADED: per-lesson + auto-promotion)
----------------------------------------------------------- */

// ==== LESSON: IS COMPLETED ====
// GET /users/:email/modules/:moduleId/lessons/:lessonIdx/isCompleted
router.get('/users/:email/modules/:moduleId/lessons/:lessonIdx/isCompleted', asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const moduleId = req.params.moduleId;
  const lessonIdx = parseInt(req.params.lessonIdx, 10);

  if (!Number.isFinite(lessonIdx) || lessonIdx < 0) {
    return res.status(400).json({ completed: false, message: 'Invalid lessonIdx' });
  }

  const userId = await _getUserIdByEmail(email);
  if (!userId) return res.json({ completed: false });

  const doc = await firestore
    .collection('users').doc(userId)
    .collection('completedLessons')
    .doc(`${moduleId}_${lessonIdx}`)
    .get();

  res.json({ completed: doc.exists });
}));

// ==== LESSON: COMPLETE ====
// POST /mark-lesson-complete   body: { email, moduleId, lessonIdx }
router.post('/mark-lesson-complete', asyncHandler(async (req, res) => {
  const { email, moduleId, lessonIdx } = req.body;

  if (!email || !moduleId || !Number.isFinite(Number(lessonIdx)) || Number(lessonIdx) < 0) {
    return res.status(400).json({ success: false, message: 'Missing or invalid email/moduleId/lessonIdx.' });
  }
  const _lessonIdx = Number(lessonIdx);

  const userId = await _getUserIdByEmail(email);
  if (!userId) return res.status(404).json({ success: false, message: 'User not found.' });

  // Ensure the module exists and figure out lessonCount
  const modSnap = await firestore.collection('modules').doc(moduleId).get();
  if (!modSnap.exists) return res.status(404).json({ success: false, message: 'Module not found.' });

  const mod = modSnap.data() || {};
  const lessonCount = computeLessonCount(mod);
  if (_lessonIdx >= lessonCount) {
    return res.status(400).json({ success: false, message: 'lessonIdx out of range for this module.' });
  }

  const userRef = firestore.collection('users').doc(userId);
  const lessonsRef = userRef.collection('completedLessons');

  // Mark the lesson complete (id: `${moduleId}_${lessonIdx}`)
  await lessonsRef.doc(`${moduleId}_${_lessonIdx}`).set({
    moduleId,
    lessonIdx: _lessonIdx,
    courseId: mod.courseId || null,
    completedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Check if ALL lessons are completed; if so, mark the module complete too (backward compatibility)
  const lessonDocs = await lessonsRef
    .where('moduleId', '==', moduleId)
    .get();

  const completedSet = new Set(
    lessonDocs.docs.map(d => (d.data()?.lessonIdx)).filter(n => Number.isFinite(n))
  );

  const allCompleted = lessonCount > 0 && [...Array(lessonCount).keys()].every(i => completedSet.has(i));

  if (allCompleted) {
    const completedModulesRef = userRef.collection('completedModules');
    const modDone = await completedModulesRef.doc(moduleId).get();
    if (!modDone.exists) {
      await completedModulesRef.doc(moduleId).set({
        moduleId,
        courseId: mod.courseId || null,
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // optionally: also check whether all modules in the course are complete (existing logic)
      if (mod.courseId) {
        const allModulesSnap = await firestore.collection('modules')
          .where('courseId', '==', mod.courseId)
          .get();
        const allModuleIds = allModulesSnap.docs.map(d => d.id);

        const completedSnap = await completedModulesRef.where('courseId', '==', mod.courseId).get();
        const completedIds = completedSnap.docs.map(d => d.id);

        const courseAllDone = allModuleIds.every(id => completedIds.includes(id));
        if (courseAllDone) {
          await userRef.collection('completedCourses').doc(mod.courseId).set({
            courseId: mod.courseId,
            completedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }
    }
  }

  res.json({ success: true, message: 'Lesson marked complete.', allLessonsCompleted: allCompleted });
}));

// ==== LESSON: BULK STATUS (for current module) ====
// GET /users/:email/modules/:moduleId/lessons/completion
// Returns: { completedIdx: number[], lessonCount: number }
router.get('/users/:email/modules/:moduleId/lessons/completion', asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const moduleId = req.params.moduleId;

  const userId = await _getUserIdByEmail(email);
  if (!userId) return res.json({ completedIdx: [], lessonCount: 0 });

  const modSnap = await firestore.collection('modules').doc(moduleId).get();
  if (!modSnap.exists) return res.json({ completedIdx: [], lessonCount: 0 });

  const mod = modSnap.data() || {};
  const lessonCount = computeLessonCount(mod);

  const userRef = firestore.collection('users').doc(userId);
  const q = await userRef.collection('completedLessons')
    .where('moduleId', '==', moduleId)
    .get();

  const completedIdx = q.docs
    .map(d => d.data()?.lessonIdx)
    .filter(n => Number.isFinite(n));

  res.json({ completedIdx, lessonCount });
}));

// ==== (Legacy) MODULE-LEVEL ENDPOINTS kept for compatibility ====

// GET /users/:email/modules/:moduleId/isCompleted
router.get('/users/:email/modules/:moduleId/isCompleted', asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const moduleId = req.params.moduleId;

  const userId = await _getUserIdByEmail(email);
  if (!userId) return res.json({ completed: false });

  const doc = await firestore
    .collection('users').doc(userId)
    .collection('completedModules').doc(moduleId)
    .get();

  res.json({ completed: doc.exists });
}));

// GET /users/:email/completed-modules-count
router.get('/users/:email/completed-modules-count', asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const userId = await _getUserIdByEmail(email);
  if (!userId) return res.status(404).json({ count: 0, message: 'User not found' });

  const snapshot = await firestore
    .collection('users').doc(userId)
    .collection('completedModules').get();

  res.json({ count: snapshot.size });
}));

// POST /mark-module-complete   body: { email, moduleId }
// (kept for legacy callers)
router.post('/mark-module-complete', asyncHandler(async (req, res) => {
  const { email, moduleId } = req.body;
  if (!email || !moduleId) {
    return res.status(400).json({ success: false, message: 'Missing email or moduleId.' });
  }

  const userId = await _getUserIdByEmail(email);
  if (!userId) return res.status(404).json({ success: false, message: 'User not found.' });

  const modSnap = await firestore.collection('modules').doc(moduleId).get();
  if (!modSnap.exists) return res.status(404).json({ success: false, message: 'Module not found.' });
  const mod = modSnap.data() || {};

  const userRef = firestore.collection('users').doc(userId);
  await userRef.collection('completedModules').doc(moduleId).set({
    moduleId,
    courseId: mod.courseId || null,
    completedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  res.json({ success: true, message: 'Module marked complete (legacy).' });
}));

module.exports = router;
