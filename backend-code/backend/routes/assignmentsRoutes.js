// ==== routes/assignmentsRoutes.js ====
'use strict';

const router = require('express').Router();
const crypto = require('crypto'); // for genId
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin, bucket } = require('../config/firebase');
const { uploadMemory } = require('../config/multerConfig');
const { saveBufferToStorage, safeName } = require('../services/storageService');
const { getUserRefByAnyId } = require('../utils/idUtils');

/* ---------------- Config: per-file limits (MB) ---------------- */
const TEACHER_FILE_LIMIT_MB = parseInt(process.env.TEACHER_FILE_LIMIT_MB || '300', 10);
const STUDENT_FILE_LIMIT_MB = parseInt(process.env.STUDENT_FILE_LIMIT_MB || '100', 10);

/* ---------------- Helpers ---------------- */

// deterministic id for attachments
const genId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2,9)}`);

// Convert millis/ISO to Firestore Timestamp (or null)
function toTimestampOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isNaN(n)) {
    const d = new Date(n);
    if (!Number.isNaN(d.getTime())) return admin.firestore.Timestamp.fromDate(d);
  }
  const d = new Date(String(v));
  if (!Number.isNaN(d.getTime())) return admin.firestore.Timestamp.fromDate(d);
  return null;
}

/** Gather assigned classes from body (supports multiple shapes) */
function parseAssignedClassesFromBody(body = {}) {
  // Accept: assignedClasses (string|array), assignedClasses[], classIds, classId
  const raw = []
    .concat(body.assignedClasses ?? [])
    .concat(body['assignedClasses[]'] ?? [])
    .concat(body.classIds ?? [])
    .concat(body.classId ?? []);
  const arr = Array.isArray(raw) ? raw : [raw];
  return Array.from(new Set(arr
    .map(x => (x == null ? '' : String(x)).trim())
    .filter(Boolean)));
}

/** Given classIds, returns { activeIds, archivedIds, missingIds } */
async function splitClassIdsByArchived(classIds) {
  const activeIds = [], archivedIds = [], missingIds = [];
  const chunk = (arr, size = 10) => { const out = []; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; };
  const classesCol = firestore.collection('classes');
  for (const ids of chunk(classIds, 10)) {
    if (!ids.length) continue;
    const snap = await classesCol.where('__name__', 'in', ids).get();
    const found = new Set();
    snap.forEach(doc => {
      found.add(doc.id);
      const d = doc.data() || {};
      if (d.archived === true) archivedIds.push(doc.id); else activeIds.push(doc.id);
    });
    ids.forEach(id => { if (!found.has(id)) missingIds.push(id); });
  }
  return { activeIds, archivedIds, missingIds };
}

/** Check if a course is archived. Returns { ok, archived, code?, message? } */
async function checkCourseArchived(courseId) {
  if (!courseId) return { ok:false, code:400, message:'courseId required' };
  const doc = await firestore.collection('courses').doc(courseId).get();
  if (!doc.exists) return { ok:false, code:404, message:'Course not found.' };
  return { ok:true, archived: doc.data().archived === true };
}

/** Check if a module is archived. Returns { ok, archived, code?, message? } */
async function checkModuleArchived(moduleId) {
  if (!moduleId) return { ok:true, archived:false };
  const doc = await firestore.collection('modules').doc(moduleId).get();
  if (!doc.exists) return { ok:false, code:404, message:'Module not found.' };
  return { ok:true, archived: doc.data().archived === true, courseId: doc.data().courseId, moduleNumber: doc.data().moduleNumber ?? null };
}

/** Parse includeArchived flag from querystring */
function wantsArchived(req) {
  const v = String(req.query.includeArchived ?? '').toLowerCase().trim();
  return v === 'true' || v === '1' || v === 'yes';
}

/** Small util: decrypt first/middle/last and form full name */
const { decryptField } = require('../utils/fieldCrypto');
function decryptNamesFromUser(u = {}) {
  return {
    firstName: decryptField(u.firstNameEnc || '') || '',
    middleName: decryptField(u.middleNameEnc || '') || '',
    lastName: decryptField(u.lastNameEnc || '') || '',
  };
}
function fullNameFromUser(u = {}) {
  const names = decryptNamesFromUser(u);
  const full = [names.firstName, names.middleName, names.lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (full) return full;
  if (u.fullName && String(u.fullName).trim()) return String(u.fullName).trim();
  if (u.firstName || u.lastName) return `${u.firstName||''} ${u.lastName||''}`.trim();
  return 'Student';
}

/** Batch-load class labels */
async function getClassLabelsById(ids) {
  const out = new Map();
  const todo = Array.from(new Set((ids || []).filter(Boolean)));
  while (todo.length) {
    const chunk = todo.splice(0, 10);
    if (!chunk.length) break;
    const snap = await firestore.collection('classes').where('__name__', 'in', chunk).get();
    const found = new Set();
    snap.forEach(d => {
      const c = d.data() || {};
      const labelParts = [c.name || c.title, c.section].filter(Boolean);
      const label = labelParts.length ? labelParts.join(' • ') : (c.name || c.title || d.id);
      out.set(d.id, label); found.add(d.id);
    });
    chunk.forEach(id => { if (!found.has(id)) out.set(id, id); });
  }
  return out;
}

/** Try to infer a student's classId for an assignment/course */
async function inferClassIdForStudent({ assignmentDoc, studentId }) {
  try {
    if (!assignmentDoc) return null;
    const a = assignmentDoc.data() || {};
    const assigned = Array.isArray(a.classIds) ? a.classIds : [];
    if (assigned.length === 1) return assigned[0];

    let courseAssigned = [];
    if (a.courseId) {
      const cSnap = await firestore.collection('courses').doc(a.courseId).get();
      if (cSnap.exists) {
        const c = cSnap.data() || {};
        if (Array.isArray(c.assignedClasses)) courseAssigned = c.assignedClasses.filter(Boolean);
      }
    }
    if (!courseAssigned.length) return null;

    const uRef = await getUserRefByAnyId(studentId);
    if (!uRef) return null;
    const enrSnap = await uRef.collection('enrollments').get();
    const myClasses = new Set(enrSnap.docs.map(d => d.id));
    const match = courseAssigned.find(cid => myClasses.has(cid));
    return match || null;
  } catch {
    return null;
  }
}

/* --------------- Multer error wrapper (nice messages) --------------- */
function runMulter(mw, maxMb) {
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: `Each file must be ≤ ${maxMb} MB.` });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(413).json({ success: false, message: 'Too many files uploaded.' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ success: false, message: `Unexpected file field: "${err.field}".` });
      }
      return next(err);
    });
  };
}

/* -----------------------------------------------------------
   Ensure previewable URLs for attachments (downloadUrl/publicUrl or signed)
----------------------------------------------------------- */
async function ensurePreviewableUrls(attArr = []) {
  const out = [];
  for (const a of attArr) {
    const att = { ...a };
    if (att.downloadUrl || att.publicUrl || att.previewUrl) {
      out.push(att);
      continue;
    }
    let path = att.storagePath || '';
    if (!path && typeof att.gsUri === 'string' && att.gsUri.startsWith('gs://')) {
      const parts = att.gsUri.replace('gs://', '').split('/');
      parts.shift(); // bucket
      path = parts.join('/');
    }
    if (path) {
      try {
        const [url] = await bucket.file(path).getSignedUrl({
          action: 'read',
          expires: Date.now() + 10 * 60 * 1000,
        });
        att.previewUrl = url;
      } catch { /* ignore */ }
    }
    out.push(att);
  }
  return out;
}

/* ===========================================================
   CREATE ASSIGNMENT (now supports assigned classes)
=========================================================== */
const memAssignUpload = uploadMemory.fields([
  { name: 'files',   maxCount: 30 },
  { name: 'rubrics', maxCount: 1  },
]);

router.post(
  '/assignments',
  runMulter(memAssignUpload, TEACHER_FILE_LIMIT_MB),
  asyncHandler(async (req, res) => {
    const {
      title, content, courseId, courseTitle, moduleId,
      publishAt, dueAt, points, teacherId
    } = req.body;

    if (!title || !content || !courseId || !teacherId) {
      return res.status(400).json({ success: false, message: 'Missing required fields: title, content, courseId, teacherId.' });
    }

    const courseStatus = await checkCourseArchived(String(courseId).trim());
    if (!courseStatus.ok) return res.status(courseStatus.code).json({ success:false, message:courseStatus.message });
    if (courseStatus.archived) return res.status(403).json({ success:false, message:'Course is archived; cannot create assignments.' });

    let moduleNumber = null;
    if (moduleId) {
      const modStatus = await checkModuleArchived(String(moduleId).trim());
      if (!modStatus.ok) return res.status(modStatus.code).json({ success:false, message:modStatus.message });
      if (modStatus.archived) return res.status(403).json({ success:false, message:'Module is archived; cannot create assignments under it.' });
      moduleNumber = modStatus.moduleNumber ?? null;
    }

    // links
    let links = req.body.links || req.body['links[]'] || [];
    if (typeof links === 'string') links = [links];

    // NEW: assigned classes -> classIds (filter archived/missing)
    const requestedClassIds = parseAssignedClassesFromBody(req.body);
    let classIds = [];
    const warnings = {};
    if (requestedClassIds.length) {
      const { activeIds, archivedIds, missingIds } = await splitClassIdsByArchived(requestedClassIds);
      classIds = activeIds;
      if (archivedIds.length) warnings.archivedClassIds = archivedIds;
      if (missingIds.length) warnings.missingClassIds = missingIds;
    }

    const payloadBase = {
      title: String(title).trim(),
      content: String(content).trim(),
      courseId: String(courseId).trim(),
      courseTitle: courseTitle ? String(courseTitle).trim() : undefined,
      moduleId: moduleId ? String(moduleId).trim() : null,
      moduleNumber,
      points: points != null && points !== '' ? Number(points) : null,
      publishAt: toTimestampOrNull(publishAt) || admin.firestore.Timestamp.now(),
      dueAt: toTimestampOrNull(dueAt) || null,
      createdBy: String(teacherId).trim(),
      attachments: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      teacherId: String(teacherId).trim(),
      archived: false,
      // NEW:
      classIds: classIds.length ? classIds : []
    };
    Object.keys(payloadBase).forEach(k => payloadBase[k] === undefined && delete payloadBase[k]);

    // create doc first
    const ref = await firestore.collection('assignments').add(payloadBase);

    const filesArr   = (req.files && Array.isArray(req.files.files))   ? req.files.files   : [];
    const rubricsArr = (req.files && Array.isArray(req.files.rubrics)) ? req.files.rubrics : [];

    // upload files
    const fileAttachments = [];
    for (const f of filesArr) {
      if (typeof f.size === 'number' && f.size > TEACHER_FILE_LIMIT_MB * 1024 * 1024) {
        await ref.delete();
        return res.status(413).json({ success:false, message:`Each file must be ≤ ${TEACHER_FILE_LIMIT_MB} MB.` });
      }
      const destPath = `assignments/${ref.id}/files/${Date.now()}_${safeName(f.originalname || 'file')}`;
      const { gsUri, downloadUrl, publicUrl, metadata } = await saveBufferToStorage(f.buffer, {
        destPath,
        contentType: f.mimetype || 'application/octet-stream',
        metadata: { role: 'assignment-file', assignmentId: ref.id },
        filenameForDisposition: f.originalname || 'file',
      });
      fileAttachments.push({
        id: genId(),
        type: 'file',
        originalName: f.originalname || 'file',
        size: f.size || null,
        mime: f.mimetype || null,
        gsUri,
        publicUrl: downloadUrl || publicUrl,
        downloadUrl: downloadUrl || publicUrl,
        storagePath: destPath,
        storageMetadata: metadata
      });
    }

    // upload rubric
    const rubricsAttachments = [];
    for (const f of rubricsArr) {
      if (typeof f.size === 'number' && f.size > TEACHER_FILE_LIMIT_MB * 1024 * 1024) {
        await ref.delete();
        return res.status(413).json({ success:false, message:`Rubric exceeds limit of ${TEACHER_FILE_LIMIT_MB} MB.` });
      }
      const destPath = `assignments/${ref.id}/rubrics/${Date.now()}_${safeName(f.originalname || 'rubric')}`;
      const { gsUri, downloadUrl, publicUrl, metadata } = await saveBufferToStorage(f.buffer, {
        destPath,
        contentType: f.mimetype || 'application/octet-stream',
        metadata: { role: 'assignment-rubric', assignmentId: ref.id },
        filenameForDisposition: f.originalname || 'rubric',
      });
      rubricsAttachments.push({
        id: genId(),
        type: 'rubrics',
        originalName: f.originalname || 'rubric',
        size: f.size || null,
        mime: f.mimetype || null,
        gsUri,
        publicUrl: downloadUrl || publicUrl,
        downloadUrl: downloadUrl || publicUrl,
        storagePath: destPath,
        storageMetadata: metadata
      });
    }

    const linkAttachments = (links || [])
      .map(u => String(u).trim())
      .filter(u => u.length)
      .map(u => ({ id: genId(), type: 'link', url: u }));

    const attachAll = [...fileAttachments, ...rubricsAttachments, ...linkAttachments];

    await ref.set({
      attachments: attachAll,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const saved = await ref.get();
    return res.status(201).json({
      success:true,
      id: ref.id,
      assignment: { id: ref.id, ...saved.data() },
      ...(Object.keys(warnings).length ? { warnings } : {})
    });
  })
);

/* ===========================================================
   GET ONE ASSIGNMENT  (attachments include previewUrl if needed)
=========================================================== */
router.get('/assignments/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const snap = await firestore.collection('assignments').doc(id).get();
  if (!snap.exists) return res.status(404).json({ success:false, message:'Assignment not found.' });

  const data = snap.data() || {};
  const enriched = await ensurePreviewableUrls(Array.isArray(data.attachments) ? data.attachments : []);
  res.json({ success:true, assignment: { id: snap.id, ...data, attachments: enriched } });
}));

/* ===========================================================
   UPDATE (PATCH) ASSIGNMENT  (now supports changing classIds)
=========================================================== */
router.patch('/assignments/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (req.body.title !== undefined)   updates.title   = String(req.body.title).trim();
  if (req.body.content !== undefined) updates.content = String(req.body.content).trim();
  if (req.body.points !== undefined)  updates.points  = (req.body.points === null || req.body.points === '') ? null : Number(req.body.points);
  if (req.body.archived !== undefined) updates.archived = !!req.body.archived;

  if (req.body.publishAt !== undefined) {
    const ts = toTimestampOrNull(req.body.publishAt);
    if (ts) updates.publishAt = ts;
  }
  if (req.body.dueAt !== undefined) {
    updates.dueAt = toTimestampOrNull(req.body.dueAt);
  }

  if (req.body.moduleId !== undefined) {
    const newModuleId = req.body.moduleId ? String(req.body.moduleId).trim() : null;
    if (newModuleId) {
      const modStatus = await checkModuleArchived(newModuleId);
      if (!modStatus.ok) return res.status(modStatus.code).json({ success:false, message:modStatus.message });
      if (modStatus.archived) return res.status(403).json({ success:false, message:'Target module is archived; cannot move assignment there.' });
    }
    updates.moduleId = newModuleId;

    let moduleNumber = null;
    if (newModuleId) {
      try {
        const m = await firestore.collection('modules').doc(newModuleId).get();
        if (m.exists) moduleNumber = m.data().moduleNumber || null;
      } catch {}
    }
    updates.moduleNumber = moduleNumber;
  }

  // NEW: update assigned classes if provided
  let warnings = {};
  const requestedClassIds = parseAssignedClassesFromBody(req.body);
  if (requestedClassIds.length) {
    const { activeIds, archivedIds, missingIds } = await splitClassIdsByArchived(requestedClassIds);
    updates.classIds = activeIds;
    if (archivedIds.length) warnings.archivedClassIds = archivedIds;
    if (missingIds.length) warnings.missingClassIds = missingIds;
  } else if (req.body.classIds === null || req.body.assignedClasses === null) {
    // explicit clear
    updates.classIds = [];
  }

  const ref = firestore.collection('assignments').doc(id);
  const exists = await ref.get();
  if (!exists.exists) return res.status(404).json({ success:false, message:'Assignment not found.' });

  await ref.set(updates, { merge: true });
  const fresh = await ref.get();
  res.json({
    success:true,
    assignment: { id: fresh.id, ...fresh.data() },
    ...(Object.keys(warnings).length ? { warnings } : {})
  });
}));

/* ===========================================================
   DELETE ASSIGNMENT (cleanup storage + submissions)
=========================================================== */
router.delete('/assignments/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const aRef = firestore.collection('assignments').doc(id);
  const snap = await aRef.get();
  if (!snap.exists) return res.status(404).json({ success:false, message:'Assignment not found.' });

  // Grab attachments before deleting the doc (for defensive cleanup below)
  const data = snap.data() || {};
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];

  // 1) Delete Firestore doc
  await aRef.delete();

  // 2) Best-effort delete of all GCS objects tied to this assignment
  try {
    // Primary prefixes where we store teacher files/rubrics and student submissions
    const prefixes = [
      `assignments/${id}/`,                // teacher files & rubric
      `assignment_submissions/${id}/`,     // all student submissions for this assignment
    ];

    // Bulk delete by prefix (fast path)
    await Promise.all(prefixes.map(prefix =>
      bucket.deleteFiles({ prefix }).catch(() => {})
    ));

    // Defensive: if any attachment had a storagePath outside those prefixes, delete it too.
    // (e.g. if structure changed historically)
    await Promise.all(
      attachments
        .map(a => a && a.storagePath)
        .filter(Boolean)
        .map(storagePath => bucket.file(storagePath).delete().catch(() => {}))
    );
  } catch (e) {
    // Don’t fail the request if storage cleanup partially fails; just log it.
    console.error('Storage cleanup error for assignment', id, e);
  }

  return res.json({ success:true, message:'Assignment and associated files deleted.' });
}));


/* ===========================================================
   LIST BY MODULE
=========================================================== */
router.get('/modules/:moduleId/assignments', asyncHandler(async (req, res) => {
  const { moduleId } = req.params;
  const includeArchived = wantsArchived(req);

  const modStatus = await checkModuleArchived(moduleId);
  if (!modStatus.ok) return res.status(modStatus.code).json({ success:false, message:modStatus.message });

  if (modStatus.archived && !includeArchived) return res.json({ success:true, assignments: [] });

  const snap = await firestore
    .collection('assignments')
    .where('moduleId', '==', moduleId)
    .orderBy('publishAt', 'desc')
    .get();

  let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!includeArchived) items = items.filter(a => a.archived !== true);

  res.json({ success: true, assignments: items });
}));

/* ===========================================================
   LIST BY COURSE (teacher)
=========================================================== */
router.get('/courses/:courseId/assignments', asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  const includeArchived = wantsArchived(req);

  const status = await checkCourseArchived(courseId);
  if (!status.ok) return res.status(status.code).json({ success:false, message:status.message });

  if (status.archived && !includeArchived) return res.json({ success:true, assignments: [] });

  const snap = await firestore
    .collection('assignments')
    .where('courseId', '==', courseId)
    .orderBy('publishAt', 'desc')
    .get();

  let assignments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!includeArchived) assignments = assignments.filter(a => a.archived !== true);

  res.json({ success: true, assignments });
}));

/* ===========================================================
   CONSOLIDATED STUDENT ASSIGNMENTS
   (now hides assignments targeted at other classes)
=========================================================== */
router.get('/students/:userId/assignments', asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const enrollSnap = await firestore.collection('users').doc(userId).collection('enrollments').get();
  const classIds = enrollSnap.docs.map(d => d.id);
  if (!classIds.length) return res.json({ success: true, assignments: [] });

  const { activeIds } = await splitClassIdsByArchived(classIds);
  if (!activeIds.length) return res.json({ success: true, assignments: [] });
  const myActiveClassSet = new Set(activeIds);

  const classChunks = [];
  for (let i = 0; i < activeIds.length; i += 10) classChunks.push(activeIds.slice(i, i + 10));

  const courseSeen = new Set();
  const courses = [];
  for (const chunk of classChunks) {
    const snap = await firestore.collection('courses').where('assignedClasses', 'array-contains-any', chunk).get();
    snap.forEach(doc => {
      const data = doc.data() || {};
      if (!courseSeen.has(doc.id) && data.archived !== true) {
        courseSeen.add(doc.id);
        courses.push({ id: doc.id, ...data });
      }
    });
  }
  if (!courses.length) return res.json({ success: true, assignments: [] });

  const courseIds = courses.map(c => c.id);
  const aChunks = [];
  for (let i = 0; i < courseIds.length; i += 10) aChunks.push(courseIds.slice(i, i + 10));

  const results = [];
  for (const ids of aChunks) {
    const snap = await firestore.collection('assignments').where('courseId', 'in', ids).orderBy('publishAt', 'desc').get();
    snap.forEach(doc => results.push({ id: doc.id, ...doc.data() }));
  }

  let filtered = results.filter(a => a.archived !== true);

  // NEW: respect assignment.classIds targeting (empty/absent = visible to course)
  filtered = filtered.filter(a => {
    const arr = Array.isArray(a.classIds) ? a.classIds.filter(Boolean) : [];
    if (!arr.length) return true; // no targeting -> show
    return arr.some(cid => myActiveClassSet.has(cid));
  });

  const moduleIds = Array.from(new Set(filtered.map(a => a.moduleId).filter(Boolean)));
  const modState = new Map();
  while (moduleIds.length) {
    const chunk = moduleIds.splice(0, 10);
    const snap = await firestore.collection('modules').where('__name__', 'in', chunk).get();
    const found = new Set();
    snap.forEach(doc => { const d = doc.data() || {}; modState.set(doc.id, d.archived === true); found.add(doc.id); });
    chunk.forEach(id => { if (!found.has(id)) modState.set(id, false); });
  }
  filtered = filtered.filter(a => !a.moduleId || modState.get(a.moduleId) !== true);

  await Promise.all(filtered.map(async (a, idx) => {
    try {
      const subDoc = await firestore.collection('assignments').doc(a.id).collection('submissions').doc(userId).get();
      if (subDoc.exists) filtered[idx].mySubmission = subDoc.data();
    } catch {}
  }));

  filtered.sort((x, y) => {
    const xp = x.publishAt?.toMillis?.() ?? 0;
    const yp = y.publishAt?.toMillis?.() ?? 0;
    return yp - xp;
  });

  res.json({ success: true, assignments: filtered });
}));

/* ===========================================================
   STUDENT SUBMIT ASSIGNMENT (Cloud Storage)
=========================================================== */
const memSubmissionUpload = uploadMemory.array('files', 30);

router.post(
  '/assignments/:id/submissions',
  runMulter(memSubmissionUpload, STUDENT_FILE_LIMIT_MB),
  asyncHandler(async (req, res) => {
    const assignmentId = req.params.id;
    const { studentId } = req.body;

    if (!studentId) return res.status(400).json({ success: false, message: 'studentId is required.' });

    const aRef = firestore.collection('assignments').doc(assignmentId);
    const aDoc = await aRef.get();
    if (!aDoc.exists) return res.status(404).json({ success: false, message: 'Assignment not found.' });
    if (aDoc.data()?.archived === true) return res.status(403).json({ success:false, message:'Assignment is archived; submissions are closed.' });
    if (aDoc.data()?.moduleId) {
      const modStatus = await checkModuleArchived(aDoc.data().moduleId);
      if (modStatus.archived) return res.status(403).json({ success:false, message:'Module is archived; submissions are closed.' });
    }

    const text = (req.body.text || '').toString().trim();
    const files = Array.isArray(req.files) ? req.files : [];

    const fileBlobs = [];
    for (const f of files) {
      if (typeof f.size === 'number' && f.size > STUDENT_FILE_LIMIT_MB * 1024 * 1024) {
        return res.status(413).json({ success:false, message:`Each file must be ≤ ${STUDENT_FILE_LIMIT_MB} MB.` });
      }
      const destPath = `assignment_submissions/${assignmentId}/${studentId}/${Date.now()}_${safeName(f.originalname || 'file')}`;
      const { gsUri, downloadUrl, publicUrl, metadata } = await saveBufferToStorage(f.buffer, {
        destPath,
        contentType: f.mimetype || 'application/octet-stream',
        metadata: { role: 'assignment-submission', assignmentId, studentId },
        filenameForDisposition: f.originalname || 'file',
      });
      fileBlobs.push({
        originalName: f.originalname || 'file',
        size: f.size || null,
        mime: f.mimetype || null,
        gsUri,
        publicUrl: downloadUrl || publicUrl,
        downloadUrl: downloadUrl || publicUrl,
        storagePath: destPath,
        storageMetadata: metadata
      });
    }

    const bodyClassId = (req.body.classId || req.body.classID || req.body.class)?.toString().trim() || null;
    let classId = bodyClassId;
    if (!classId) {
      const assigned = Array.isArray(aDoc.data()?.classIds) ? aDoc.data().classIds : [];
      classId = assigned.length === 1 ? assigned[0] : await inferClassIdForStudent({ assignmentDoc: aDoc, studentId });
    }

    const subRef = aRef.collection('submissions').doc(studentId);
    const payload = {
      studentId,
      classId: classId || null,
      text: text || '',
      files: fileBlobs,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      graded: false,
      grade: null,
      feedback: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await subRef.set(payload, { merge: true });
    res.json({ success: true, message: 'Submission saved.' });
  })
);

/* ===========================================================
   TEACHER: GRADE SUBMISSION
=========================================================== */
router.patch('/assignments/:id/submissions/:studentId', asyncHandler(async (req, res) => {
  const { id: assignmentId, studentId } = req.params;
  const { grade, feedback } = req.body;

  const aRef  = firestore.collection('assignments').doc(assignmentId);
  const subRef = aRef.collection('submissions').doc(studentId);

  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (grade !== undefined) { updates.grade = Number(grade); updates.graded = true; }
  if (feedback !== undefined) { updates.feedback = String(feedback); }
  await subRef.set(updates, { merge: true });

  const [aSnap, sSnap] = await Promise.all([aRef.get(), subRef.get()]);
  if (!aSnap.exists) return res.status(404).json({ success: false, message: 'Assignment not found.' });

  const a = aSnap.data() || {};
  const s = sSnap.exists ? (sSnap.data() || {}) : {};

  const userRef = await getUserRefByAnyId(studentId);
  if (userRef) {
    const gradeDocRef = userRef.collection('assignmentGrades').doc(assignmentId);
    await gradeDocRef.set({
      assignmentId,
      courseId: a.courseId || null,
      moduleId: a.moduleId || null,
      assignmentTitle: a.title || 'Untitled',
      points: a.points ?? null,
      dueAt: a.dueAt ?? null,
      submittedAt: s.submittedAt ?? null,
      gradedAt: admin.firestore.FieldValue.serverTimestamp(),
      grade: grade !== undefined ? Number(grade) : (typeof s.grade === 'number' ? s.grade : null),
      feedback: feedback !== undefined ? String(feedback) : (s.feedback ?? null),
    }, { merge: true });

    const gSnap = await userRef.collection('assignmentGrades').get();
    let sum = 0, count = 0;
    gSnap.forEach(d => { const g = d.data()?.grade; if (typeof g === 'number') { sum += g; count += 1; } });
    await userRef.set({
      gradedAssignmentsCount: count,
      averageAssignmentGrade: count ? Math.round(sum / count) : 0,
      lastAssignmentGrade: {
        assignmentId,
        grade: grade !== undefined ? Number(grade) : (typeof s.grade === 'number' ? s.grade : null),
        at: admin.firestore.FieldValue.serverTimestamp(),
      },
    }, { merge: true });
  }

  return res.json({ success: true });
}));

/* ===========================================================
   VIEW OWN SUBMISSION
=========================================================== */
router.get('/assignments/:id/submissions/:studentId', asyncHandler(async (req, res) => {
  const { id: assignmentId, studentId } = req.params;

  const snap = await firestore.collection('assignments').doc(assignmentId).collection('submissions').doc(studentId).get();
  if (!snap.exists) return res.json({ success: true, submission: null });
  return res.json({ success: true, submission: { id: snap.id, ...snap.data() } });
}));

/* ===========================================================
   LIST ALL SUBMISSIONS FOR AN ASSIGNMENT
=========================================================== */
router.get('/assignments/:id/submissions', asyncHandler(async (req, res) => {
  const assignmentId = req.params.id;

  const aDoc = await firestore.collection('assignments').doc(assignmentId).get();
  if (!aDoc.exists) return res.status(404).json({ success:false, message:'Assignment not found.' });

  const a = aDoc.data() || {};
  const assigned = Array.isArray(a.classIds) ? a.classIds : [];
  const singleAssignedClassId = assigned.length === 1 ? a.classIds[0] : null;

  let courseAssigned = [];
  if (a.courseId) {
    try {
      const cSnap = await firestore.collection('courses').doc(a.courseId).get();
      if (cSnap.exists) {
        const c = cSnap.data() || {};
        if (Array.isArray(c.assignedClasses)) courseAssigned = c.assignedClasses.filter(Boolean);
      }
    } catch {}
  }

  const subsSnap = await firestore.collection('assignments').doc(assignmentId).collection('submissions').get();

  const raw = [];
  const classIdsNeeded = new Set();
  if (Array.isArray(assigned)) assigned.forEach(cid => cid && classIdsNeeded.add(cid));

  for (const doc of subsSnap.docs) {
    const data = doc.data() || {};
    const sid = data.studentId || doc.id;

    let classId = data.classId || data.classID || data.class || null;
    if (!classId && singleAssignedClassId) classId = singleAssignedClassId;

    if (!classId && courseAssigned.length) {
      try {
        const uRef = await getUserRefByAnyId(sid);
        if (uRef) {
          const enrSnap = await uRef.collection('enrollments').get();
          const myClasses = new Set(enrSnap.docs.map(d => d.id));
          const match = courseAssigned.find(cid => myClasses.has(cid));
          if (match) classId = match;
        }
      } catch {}
    }

    if (classId) classIdsNeeded.add(classId);
    raw.push({ sid, data, classId });
  }

  const classLabels = await getClassLabelsById(Array.from(classIdsNeeded));

  const submissions = [];
  for (const { sid, data, classId } of raw) {
    let studentName = sid;
    try {
      let userSnap = await firestore.collection('users').doc(sid).get();
      let user = null;
      if (userSnap.exists) user = userSnap.data();
      else {
        const userQuery = await firestore.collection('users').where('studentId', '==', sid).limit(1).get();
        if (!userQuery.empty) user = userQuery.docs[0].data();
      }
      if (user) studentName = fullNameFromUser(user);
    } catch {}
    submissions.push({
      ...data,
      studentId: sid,
      studentName,
      assignmentId,
      classId: classId || null,
      className: classId ? (classLabels.get(classId) || '—') : (singleAssignedClassId ? (classLabels.get(singleAssignedClassId) || '—') : '—'),
    });
  }

  res.json({ success: true, submissions });
}));

/* ===========================================================
   COMPAT submit endpoints
=========================================================== */
const uploadAny = uploadMemory.any();

async function saveSubmission({ assignmentId, studentId, text, files, bodyClassId = null }) {
  const aRef = firestore.collection('assignments').doc(assignmentId);
  const aDoc = await aRef.get();
  if (!aDoc.exists) { const err = new Error('Assignment not found.'); err.statusCode = 404; throw err; }
  if (aDoc.data()?.archived === true) { const err = new Error('Assignment is archived; submissions are closed.'); err.statusCode = 403; throw err; }
  if (aDoc.data()?.moduleId) {
    const modStatus = await checkModuleArchived(aDoc.data().moduleId);
    if (modStatus.archived) { const err = new Error('Module is archived; submissions are closed.'); err.statusCode = 403; throw err; }
  }

  let classId = (bodyClassId || '').toString().trim() || null;
  if (!classId) {
    const assigned = Array.isArray(aDoc.data()?.classIds) ? aDoc.data().classIds : [];
    classId = (assigned.length === 1) ? assigned[0] : await inferClassIdForStudent({ assignmentDoc: aDoc, studentId });
  }

  const fileBlobs = [];
  for (const f of (files || [])) {
    if (typeof f.size === 'number' && f.size > STUDENT_FILE_LIMIT_MB * 1024 * 1024) {
      const err = new Error(`Each file must be ≤ ${STUDENT_FILE_LIMIT_MB} MB.`); err.statusCode = 413; throw err;
    }
    const destPath = `assignment_submissions/${assignmentId}/${studentId}/${Date.now()}_${safeName(f.originalname || 'file')}`;
    const { gsUri, downloadUrl, publicUrl, metadata } = await saveBufferToStorage(f.buffer, {
      destPath, contentType: f.mimetype || 'application/octet-stream',
      metadata: { role: 'assignment-submission', assignmentId, studentId },
      filenameForDisposition: f.originalname || 'file',
    });
    fileBlobs.push({
      originalName: f.originalname || 'file',
      size: f.size || null,
      mime: f.mimetype || null,
      gsUri,
      publicUrl: downloadUrl || publicUrl,
      downloadUrl: downloadUrl || publicUrl,
      storagePath: destPath,
      storageMetadata: metadata
    });
  }

  const subRef = aRef.collection('submissions').doc(studentId);
  const payload = {
    studentId,
    classId: classId || null,
    text: (text || '').toString().trim(),
    files: fileBlobs,
    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    graded: false,
    grade: null,
    feedback: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await subRef.set(payload, { merge: true });
  return { success: true, message: 'Submission saved.' };
}

// 1) POST /assignments/:assignmentId/submit
router.post('/assignments/:assignmentId/submit', runMulter(uploadAny, STUDENT_FILE_LIMIT_MB), asyncHandler(async (req, res) => {
  const { assignmentId } = req.params;
  const { studentId } = req.body;
  if (!studentId) return res.status(400).json({ success: false, message: 'studentId is required.' });
  const text = req.body.note || req.body.text || '';
  const bodyClassId = (req.body.classId || req.body.classID || req.body.class) || null;
  try {
    const result = await saveSubmission({ assignmentId, studentId, text, files: req.files, bodyClassId });
    return res.json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success:false, message: err.message || 'Failed to save submission.' });
  }
}));

// 2) POST /students/:studentId/assignments/:assignmentId/submit
router.post('/students/:studentId/assignments/:assignmentId/submit', runMulter(uploadAny, STUDENT_FILE_LIMIT_MB), asyncHandler(async (req, res) => {
  const { assignmentId, studentId } = req.params;
  const text = req.body.note || req.body.text || '';
  const bodyClassId = (req.body.classId || req.body.classID || req.body.class) || null;
  try {
    const result = await saveSubmission({ assignmentId, studentId, text, files: req.files, bodyClassId });
    return res.json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success:false, message: err.message || 'Failed to save submission.' });
  }
}));

/* ===========================================================
   DELETE A STUDENT SUBMISSION
=========================================================== */
router.delete('/assignments/:id/submissions/:studentId', asyncHandler(async (req, res) => {
  const { id: assignmentId, studentId } = req.params;

  const aRef = firestore.collection('assignments').doc(assignmentId);
  const subRef = aRef.collection('submissions').doc(studentId);

  const [aSnap, sSnap] = await Promise.all([aRef.get(), subRef.get()]);
  if (!aSnap.exists) return res.status(404).json({ success:false, message:'Assignment not found.' });
  if (!sSnap.exists) return res.status(404).json({ success:false, message:'Submission not found.' });

  await subRef.delete();
  try { await bucket.deleteFiles({ prefix: `assignment_submissions/${assignmentId}/${studentId}/` }); } catch {}

  try {
    const userRef = await getUserRefByAnyId(studentId);
    if (userRef) await userRef.collection('assignmentGrades').doc(assignmentId).delete();
  } catch {}

  return res.json({ success:true, message:'Submission deleted.' });
}));

/* ===========================================================
   Attachment access helpers & routes
=========================================================== */

// Helper to sign a GCS object path for READ
async function signUrlForPath(storagePath, { expiresInMs = 10 * 60 * 1000 } = {}) {
  if (!storagePath) {
    const err = new Error('storagePath required');
    err.statusCode = 400;
    throw err;
  }
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    const err = new Error('File not found');
    err.statusCode = 404;
    throw err;
  }
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + expiresInMs,
  });
  return url;
}

/** Short-lived signed URL (legacy by path) */
router.get('/attachments/signed', asyncHandler(async (req, res) => {
  const storagePath = String(req.query.path || '').trim();
  if (!storagePath) return res.status(400).json({ success:false, message:'path is required' });
  const url = await signUrlForPath(storagePath);
  res.json({ success:true, url });
}));

/** Signed URL by attachment id (precise; used by the editor preview) */
router.get('/assignments/:id/attachments/:fileId/signed', asyncHandler(async (req, res) => {
  const { id, fileId } = req.params;
  const ref = firestore.collection('assignments').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success:false, message:'Assignment not found.' });
  const attachments = Array.isArray(snap.data().attachments) ? snap.data().attachments : [];
  const att = attachments.find(a => String(a.id||'') === String(fileId));
  if (!att) return res.status(404).json({ success:false, message:'Attachment not found.' });

  let path = att.storagePath || '';
  if (!path && att.gsUri && att.gsUri.startsWith('gs://')) {
    const parts = att.gsUri.replace('gs://', '').split('/');
    parts.shift();
    path = parts.join('/');
  }
  if (!path) return res.status(400).json({ success:false, message:'Attachment has no storage path.' });

  const [url] = await bucket.file(path).getSignedUrl({
    action: 'read',
    expires: Date.now() + 10 * 60 * 1000,
  });
  res.json({ success:true, url });
}));

/** Stream proxy (optional) */
router.get('/attachments/stream', asyncHandler(async (req, res) => {
  const storagePath = String(req.query.path || '').trim();
  if (!storagePath) return res.status(400).json({ success:false, message:'path required' });
  const file = bucket.file(storagePath);
  const [meta] = await file.getMetadata().catch(() => [null]);
  if (!meta) return res.status(404).json({ success:false, message:'Not found' });

  res.setHeader('Content-Type', meta.contentType || 'application/octet-stream');
  if (meta.size) res.setHeader('Content-Length', meta.size);
  res.setHeader('Cache-Control', 'private, max-age=0, no-transform');

  file.createReadStream()
    .on('error', (e) => {
      console.error('Attachment stream error:', e);
      if (!res.headersSent) res.status(500).end();
    })
    .pipe(res);
}));

/* ===========================================================
   ATTACHMENTS: add (upload or link), delete
=========================================================== */

const memAttachUpload = uploadMemory.array('files', 30);

async function getAssignmentDocOr404(id) {
  const ref = firestore.collection('assignments').doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('Assignment not found.');
    err.statusCode = 404;
    throw err;
  }
  return { ref, snap };
}

// Normalize attachments; ensure array
function ensureAttachmentsArray(docSnap) {
  const data = docSnap.data() || {};
  const arr = Array.isArray(data.attachments) ? data.attachments.slice() : [];
  return arr;
}

/** POST /assignments/:id/files  (upload or link) */
router.post(
  '/assignments/:id/files',
  runMulter(memAttachUpload, TEACHER_FILE_LIMIT_MB),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { ref, snap } = await getAssignmentDocOr404(id);
    let attachments = ensureAttachmentsArray(snap);

    // JSON link(s)
    let bodyUsed = false;
    if (req.is('application/json') || typeof req.body?.link === 'string' || Array.isArray(req.body?.links)) {
      bodyUsed = true;
      const links = [];
      if (typeof req.body.link === 'string') links.push(req.body.link);
      if (Array.isArray(req.body.links)) links.push(...req.body.links);

      const toAdd = links
        .map(u => String(u || '').trim())
        .filter(Boolean)
        .map(u => ({ id: genId(), type: 'link', url: u }));

      if (!toAdd.length) {
        return res.status(400).json({ success: false, message: 'No valid link provided.' });
      }

      attachments = attachments.concat(toAdd);
      await ref.set({ attachments, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      const fresh = await ref.get();
      return res.json({ success: true, files: ensureAttachmentsArray(fresh) });
    }

    // multipart files
    const incoming = Array.isArray(req.files) ? req.files : [];
    if (!incoming.length && !bodyUsed) {
      return res.status(400).json({ success: false, message: 'No files uploaded and no link provided.' });
    }

    const toAdd = [];
    for (const f of incoming) {
      if (typeof f.size === 'number' && f.size > TEACHER_FILE_LIMIT_MB * 1024 * 1024) {
        return res.status(413).json({ success:false, message:`Each file must be ≤ ${TEACHER_FILE_LIMIT_MB} MB.` });
      }
      const destPath = `assignments/${id}/files/${Date.now()}_${safeName(f.originalname || 'file')}`;
      const { gsUri, downloadUrl, publicUrl, metadata } = await saveBufferToStorage(f.buffer, {
        destPath,
        contentType: f.mimetype || 'application/octet-stream',
        metadata: { role: 'assignment-file', assignmentId: id },
        filenameForDisposition: f.originalname || 'file',
      });
      toAdd.push({
        id: genId(),
        type: 'file',
        originalName: f.originalname || 'file',
        size: f.size || null,
        mime: f.mimetype || null,
        gsUri,
        publicUrl: downloadUrl || publicUrl,
        downloadUrl: downloadUrl || publicUrl,
        storagePath: destPath,
        storageMetadata: metadata
      });
    }

    attachments = attachments.concat(toAdd);
    await ref.set({ attachments, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const fresh = await ref.get();
    return res.json({ success: true, files: ensureAttachmentsArray(fresh) });
  })
);

/** DELETE /assignments/:id/files/:fileId */
router.delete('/assignments/:id/files/:fileId', asyncHandler(async (req, res) => {
  const { id, fileId } = req.params;
  const { ref, snap } = await getAssignmentDocOr404(id);
  const attachments = ensureAttachmentsArray(snap);

  const idx = attachments.findIndex(a => String(a.id || '') === String(fileId));
  if (idx === -1) return res.status(404).json({ success:false, message:'Attachment not found.' });

  const att = attachments[idx];
  if (att?.storagePath) {
    try { await bucket.file(att.storagePath).delete(); } catch {}
  }

  const newArr = attachments.slice(0, idx).concat(attachments.slice(idx + 1));
  await ref.set({ attachments: newArr, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const fresh = await ref.get();
  return res.json({ success:true, files: ensureAttachmentsArray(fresh) });
}));

/** DELETE /assignments/:id/files   (fallback by url/storagePath) */
router.delete('/assignments/:id/files', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const matchUrl = String(req.body?.url || '').trim();
  const matchPath = String(req.body?.storagePath || '').trim();

  const { ref, snap } = await getAssignmentDocOr404(id);
  let attachments = ensureAttachmentsArray(snap);

  const before = attachments.length;
  const keep = [];
  for (const a of attachments) {
    const same =
      (matchPath && a.storagePath && String(a.storagePath) === matchPath) ||
      (matchUrl  && (a.url === matchUrl || a.publicUrl === matchUrl || a.downloadUrl === matchUrl));
    if (same) {
      if (a?.storagePath) { try { await bucket.file(a.storagePath).delete(); } catch {} }
    } else {
      keep.push(a);
    }
  }

  if (before === keep.length) {
    return res.status(404).json({ success:false, message:'No matching attachment found.' });
  }

  attachments = keep;
  await ref.set({ attachments, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const fresh = await ref.get();
  return res.json({ success:true, files: ensureAttachmentsArray(fresh) });
}));

/* ===========================================================
   RUBRIC: upsert & delete
=========================================================== */

// Accept any field name and robustly pick the rubric file.
const memRubricAny = uploadMemory.any();

// helper: remove existing rubric(s) from attachments & storage
async function removeExistingRubricsAndReturnKeep(attachments) {
  const keep = [];
  for (const a of attachments) {
    if (a?.type === 'rubrics') {
      if (a.storagePath) {
        try { await bucket.file(a.storagePath).delete(); } catch {}
      }
      // drop it
    } else {
      keep.push(a);
    }
  }
  return keep;
}

// pick rubric file from req for single upload regardless of field name
function pickRubricFileFromReq(req) {
  if (req.file && req.file.buffer) return req.file;

  if (Array.isArray(req.files) && req.files.length) {
    const byRubric = req.files.find(f => f.fieldname === 'rubric');
    if (byRubric) return byRubric;
    const byFile = req.files.find(f => f.fieldname === 'file');
    if (byFile) return byFile;
    return req.files[0];
  }

  if (req.files && req.files.rubric && Array.isArray(req.files.rubric) && req.files.rubric.length) {
    return req.files.rubric[0];
  }

  return null;
}

async function upsertRubric(req, res) {
  const { id } = req.params;
  const { ref, snap } = await getAssignmentDocOr404(id);
  let attachments = ensureAttachmentsArray(snap);

  const f = pickRubricFileFromReq(req);
  if (!f) return res.status(400).json({ success:false, message:'No rubric file provided (field "rubric" or "file").' });

  if (typeof f.size === 'number' && f.size > TEACHER_FILE_LIMIT_MB * 1024 * 1024) {
    return res.status(413).json({ success:false, message:`Rubric must be ≤ ${TEACHER_FILE_LIMIT_MB} MB.` });
  }

  // delete any existing rubric(s)
  attachments = await removeExistingRubricsAndReturnKeep(attachments);

  // upload new rubric
  const destPath = `assignments/${id}/rubrics/${Date.now()}_${safeName(f.originalname || 'rubric')}`;
  const { gsUri, downloadUrl, publicUrl, metadata } = await saveBufferToStorage(f.buffer, {
    destPath,
    contentType: f.mimetype || 'application/octet-stream',
    metadata: { role: 'assignment-rubric', assignmentId: id },
    filenameForDisposition: f.originalname || 'rubric',
  });

  const rubricAtt = {
    id: genId(),
    type: 'rubrics',
    originalName: f.originalname || 'rubric',
    size: f.size || null,
    mime: f.mimetype || null,
    gsUri,
    publicUrl: downloadUrl || publicUrl,
    downloadUrl: downloadUrl || publicUrl,
    storagePath: destPath,
    storageMetadata: metadata
  };

  attachments.push(rubricAtt);

  await ref.set({ attachments, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const fresh = await ref.get();
  return res.json({ success:true, files: ensureAttachmentsArray(fresh) });
}

router.post('/assignments/:id/rubric', runMulter(memRubricAny, TEACHER_FILE_LIMIT_MB), asyncHandler(upsertRubric));
router.put('/assignments/:id/rubric',  runMulter(memRubricAny, TEACHER_FILE_LIMIT_MB), asyncHandler(upsertRubric));

/** DELETE /assignments/:id/rubric */
router.delete('/assignments/:id/rubric', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { ref, snap } = await getAssignmentDocOr404(id);
  let attachments = ensureAttachmentsArray(snap);

  const before = attachments.length;
  const keep = [];
  for (const a of attachments) {
    if (a?.type === 'rubrics') {
      if (a.storagePath) { try { await bucket.file(a.storagePath).delete(); } catch {} }
      // drop
    } else {
      keep.push(a);
    }
  }
  if (before === keep.length) {
    return res.status(404).json({ success:false, message:'No rubric to delete.' });
  }

  attachments = keep;
  await ref.set({ attachments, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const fresh = await ref.get();
  return res.json({ success:true, files: ensureAttachmentsArray(fresh) });
}));

module.exports = router;
