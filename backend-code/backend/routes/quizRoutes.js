// ==== routes/quizRoutes.js ====
'use strict';

const router = require('express').Router();

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin, bucket } = require('../config/firebase');

// utils
const { parseDueAtToTimestamp } = require('../utils/timeUtils');
const { normalizeAttemptsAllowed } = require('../utils/validators');
const { getUserRefByEmail } = require('../utils/userUtils');

// Storage helpers
const { uploadMemory } = require('../config/multerConfig');
const { saveBufferToStorage, safeName, ensureTokenForObject } = require('../services/storageService');

/* ===========================================================
   Rubric upload config (teacher)
=========================================================== */
const TEACHER_FILE_LIMIT_MB = parseInt(process.env.TEACHER_FILE_LIMIT_MB || '300', 10);
const TEACHER_FILE_LIMIT_BYTES = TEACHER_FILE_LIMIT_MB * 1024 * 1024;

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
]);
const ALLOWED_EXTS = /\.(pdf|doc|docx|xls|xlsx|csv|txt)$/i;

function rubricFileOk(file) {
  const okMime = ALLOWED_MIMES.has(file.mimetype);
  const okExt = ALLOWED_EXTS.test(file.originalname || '');
  return okMime || okExt;
}

/* ===========================================================
   assignedClasses helpers
=========================================================== */
/**
 * Ensure assignedClasses is a deduped array of string IDs.
 * Limits to 500 IDs and trims falsy values.
 */
function sanitizeAssignedClasses(input) {
  if (!input) return [];
  let arr = Array.isArray(input) ? input : [];
  arr = arr
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  const set = new Set(arr);
  const out = Array.from(set);
  return out.slice(0, 500);
}

/* ===========================================================
   Student-class helpers
=========================================================== */
async function getStudentEmailById(userId) {
  try {
    const u = await firestore.collection('users').doc(userId).get();
    if (u.exists) {
      const d = u.data() || {};
      const email =
        (d.email || d.userEmail || d.username || '').trim();
      return email || null;
    }
  } catch {}
  return null;
}

/**
 * Returns a deduped array of class IDs a student belongs to.
 * Tries several common schema patterns:
 *  - classes.students: array of userId
 *  - classes.studentIds: array of userId
 *  - classes.members: array of userId
 *  - classes.studentEmails: array of email
 */
async function getClassesForStudent(studentId) {
  const classesCol = firestore.collection('classes');
  const results = new Map();
  const email = await getStudentEmailById(studentId);

  const tryQuery = async (field, value) => {
    try {
      const snap = await classesCol.where(field, 'array-contains', value).get();
      snap.forEach(doc => results.set(doc.id, { id: doc.id, ...doc.data() }));
    } catch {}
  };

  await tryQuery('students', studentId);
  await tryQuery('studentIds', studentId);
  await tryQuery('members', studentId);
  if (email) await tryQuery('studentEmails', email);

  return Array.from(results.values()).map(c => c.id);
}

/* ===========================================================
   Conditionally run multer when multipart (memory storage)
=========================================================== */
const uploadRubricMaybe = (req, res, next) => {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.toLowerCase().startsWith('multipart/form-data')) return next();
  uploadMemory.single('rubrics')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, code: err.code, message: `Rubric exceeds limit of ${TEACHER_FILE_LIMIT_MB} MB.` });
      }
      return res.status(400).json({ success: false, message: err.message || 'Upload error' });
    }
    return next();
  });
};

/* ===========================================================
   settings normalization
=========================================================== */
function normalizeSettings(input = {}) {
  const out = { timerEnabled:false, shuffleQuestions:true, pagination:{ enabled:false, perPage:1 }, backtrackingAllowed:true };
  if (input && typeof input === 'object') {
    if (input.timerEnabled === true) {
      const mins = parseInt(input.durationMinutes, 10);
      const grace = input.graceSeconds != null ? parseInt(input.graceSeconds, 10) : 0;
      if (!Number.isInteger(mins) || mins < 1) throw new Error('Invalid durationMinutes (minimum 1).');
      if (!Number.isInteger(grace) || grace < 0) throw new Error('Invalid graceSeconds (>= 0).');
      out.timerEnabled = true;
      out.durationMinutes = mins;
      out.graceSeconds = grace;
      out.durationMs = mins * 60 * 1000;
      out.graceMs = grace * 1000;
    }
    if (typeof input.shuffleQuestions === 'boolean') out.shuffleQuestions = input.shuffleQuestions;
    if (input.pagination && typeof input.pagination === 'object') {
      const en = !!input.pagination.enabled;
      let per = parseInt(input.pagination.perPage, 10);
      if (!Number.isInteger(per) || per < 1) per = 1;
      out.pagination = { enabled: en, perPage: per };
    }
    if (typeof input.backtrackingAllowed === 'boolean') out.backtrackingAllowed = input.backtrackingAllowed;
  }
  return out;
}

/* ===========================================================
   chunked deletions
=========================================================== */
async function deleteDocsInChunks(docRefs, chunkSize = 400) {
  if (!Array.isArray(docRefs) || docRefs.length === 0) return;
  for (let i = 0; i < docRefs.length; i += chunkSize) {
    const slice = docRefs.slice(i, i + chunkSize);
    const batch = firestore.batch();
    slice.forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}
async function deleteQueryInChunks(query, chunkSize = 400) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await query.limit(chunkSize).get();
    if (snap.empty) break;
    await deleteDocsInChunks(snap.docs.map(d => d.ref), chunkSize);
  }
}
async function deleteAllAttemptsForQuiz(quizId) {
  try {
    const rootsSnap = await firestore.collectionGroup('quizAttempts').where('quizId', '==', quizId).get();
    for (const rootDoc of rootsSnap.docs) {
      const attemptsSnap = await rootDoc.ref.collection('attempts').get();
      await deleteDocsInChunks(attemptsSnap.docs.map(d => d.ref));
      await rootDoc.ref.delete();
    }
  } catch (err) {
    if (err && (err.code === 9 || String(err.message || '').includes('FAILED_PRECONDITION'))) {
      console.warn('[quiz delete] Missing CG index for quizAttempts.quizId — fallback to per-user scan.');
      const usersSnap = await firestore.collection('users').get();
      for (const userDoc of usersSnap.docs) {
        const rootRef = userDoc.ref.collection('quizAttempts').doc(quizId);
        const root = await rootRef.get();
        if (!root.exists) continue;
        const attemptsSnap = await rootRef.collection('attempts').get();
        await deleteDocsInChunks(attemptsSnap.docs.map(d => d.ref));
        await rootRef.delete();
      }
    } else {
      throw err;
    }
  }
}

/* ===========================================================
   QUIZ: UPLOAD (rubric to Cloud Storage)
   Accepts JSON OR multipart with: (rubrics file) + (payload JSON)
   NEW: supports assignedClasses: string[]
=========================================================== */
router.post('/upload-quiz', uploadRubricMaybe, asyncHandler(async (req, res) => {
  let body = req.body || {};
  if (req.file && typeof body.payload === 'string') {
    try { body = JSON.parse(body.payload); }
    catch (e) { return res.status(400).json({ success:false, message:'Invalid JSON in "payload".' }); }
  }

  const {
    courseId, moduleId, quiz, settings, title, description, dueAt, attemptsAllowed,
    assignedClasses: assignedClassesRaw
  } = body || {};

  if (!courseId || !moduleId || !Array.isArray(quiz) || quiz.length === 0) {
    return res.status(400).json({ success:false, message:'Missing required fields or empty quiz array.' });
  }
  if (!title || String(title).trim() === '') {
    return res.status(400).json({ success:false, message:'Quiz title is required.' });
  }

  let attempts = null;
  try { attempts = normalizeAttemptsAllowed(attemptsAllowed); }
  catch (e) { return res.status(400).json({ success:false, message: e.message }); }

  let normalizedSettings;
  try { normalizedSettings = normalizeSettings(settings || {}); }
  catch (e) { return res.status(400).json({ success:false, message: e.message }); }

  const dueAtTs = parseDueAtToTimestamp(dueAt);

  const essayCount = (quiz || []).filter(q =>
    (q && (q.type === 'essay')) ||
    (q && q.choices && typeof q.choices === 'object' && Object.keys(q.choices).length === 1 && 'A' in q.choices && String(q.choices.A || '').toLowerCase().includes('essay response'))
  ).length;

  if (req.file) {
    if (!rubricFileOk(req.file)) {
      return res.status(400).json({ success:false, message:'Invalid rubric file type. Allowed: PDF, DOC/DOCX, XLS/XLSX, CSV, TXT.' });
    }
    if (essayCount === 0) {
      return res.status(400).json({ success:false, message:'Rubric can only be uploaded when there is at least one Essay question.' });
    }
    if (req.file.size > TEACHER_FILE_LIMIT_BYTES) {
      return res.status(413).json({ success:false, message:`Rubric exceeds limit of ${TEACHER_FILE_LIMIT_MB} MB.` });
    }
  }

  const validQuestions = (quiz || [])
    .filter(q => q && q.question)
    .map(q => ({
      question: String(q.question),
      choices: q.choices && typeof q.choices === 'object' ? q.choices : {},
      correctAnswer: q.correct ?? q.correctAnswer ?? null,
      imageUrl: q.imageUrl ?? null
    }));
  if (!validQuestions.length) return res.status(400).json({ success:false, message:'No valid quiz questions provided.' });

  // sanitize assigned classes
  const assignedClasses = sanitizeAssignedClasses(assignedClassesRaw);

  const quizRef = firestore.collection('quizzes').doc();
  const batch = firestore.batch();

  let rubricFile = null;
  if (req.file) {
    const destPath = `quizzes/${quizRef.id}/rubrics/${Date.now()}_${safeName(req.file.originalname || 'rubric')}`;
    const { gsUri, publicUrl, downloadUrl, metadata, storagePath } = await saveBufferToStorage(req.file.buffer, {
      destPath,
      contentType: req.file.mimetype,
      metadata: { role: 'quiz-rubric', quizId: quizRef.id },
      filenameForDisposition: req.file.originalname
    });
    rubricFile = {
      storagePath,
      originalName: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype,
      gsUri,
      publicUrl,
      downloadUrl,
      storageMetadata: metadata,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp()
    };
  }

  batch.set(quizRef, {
    title: String(title).trim(),
    description: description ? String(description).trim() : '',
    courseId, moduleId,
    totalQuestions: validQuestions.length,
    settings: normalizedSettings,
    attemptsAllowed: attempts, // null => unlimited
    dueAt: dueAtTs,
    archived: false,
    rubricFile: rubricFile || null,
    assignedClasses,                  // persisted
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  validQuestions.forEach(q => batch.set(quizRef.collection('questions').doc(), q));

  await batch.commit();
  res.json({ success:true, message:'Quiz uploaded successfully.', quizId: quizRef.id });
}));

/* ===========================================================
   QUIZ: GET ALL  (assignment-aware via ?forStudent=)
=========================================================== */
router.get('/quizzes', asyncHandler(async (req, res) => {
  const includeArchived = ['1','true','yes'].includes(String(req.query.includeArchived || '').toLowerCase());
  const forStudent = String(req.query.forStudent || '').trim();

  // collect student's classIds if filtering is requested
  let studentClassIds = null;
  if (forStudent) {
    studentClassIds = await getClassesForStudent(forStudent);
  }

  const snapshot = await firestore.collection('quizzes').orderBy('createdAt', 'desc').get();

  // first filter docs (archived + assignedClasses)
  const docs = snapshot.docs.filter(d => {
    const x = d.data() || {};
    if (!includeArchived && (x.archived === true || x.isArchived === true)) return false;
    if (!forStudent) return true;

    const assigned = Array.isArray(x.assignedClasses) ? x.assignedClasses : [];
    // business rule: no assignment means visible to all
    if (assigned.length === 0) return true;

    const set = new Set(studentClassIds || []);
    return assigned.some(cid => set.has(cid));
  });

  // then hydrate questions
  const quizzes = [];
  for (const doc of docs) {
    const data = doc.data() || {};
    const qs = await doc.ref.collection('questions').get();
    quizzes.push({
      id: doc.id,
      title: data.title || '',
      description: data.description || '',
      dueAt: data.dueAt || null,
      attemptsAllowed: data.attemptsAllowed ?? null,
      courseId: data.courseId,
      moduleId: data.moduleId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt || null,
      archived: data.archived === true,
      totalQuestions: data.totalQuestions ?? qs.size,
      settings: data.settings || { timerEnabled:false, shuffleQuestions:true, pagination:{enabled:false, perPage:1}, backtrackingAllowed:true },
      rubricFile: data.rubricFile || null,
      assignedClasses: Array.isArray(data.assignedClasses) ? data.assignedClasses : [],
      questions: qs.docs.map(d=>d.data())
    });
  }

  res.json({ success:true, quizzes });
}));

/* ===========================================================
   QUIZ: GET ONE
=========================================================== */
router.get('/quizzes/:quizId', asyncHandler(async (req, res) => {
  const quizRef = firestore.collection('quizzes').doc(req.params.quizId);
  const snap = await quizRef.get();
  if (!snap.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });

  const d = snap.data();
  const qs = await quizRef.collection('questions').get();

  res.json({
    success: true,
    quiz: {
      id: snap.id,
      title: d.title || '',
      description: d.description || '',
      dueAt: d.dueAt || null,
      attemptsAllowed: d.attemptsAllowed ?? null,
      courseId: d.courseId,
      moduleId: d.moduleId,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt || null,
      archived: d.archived === true,
      totalQuestions: d.totalQuestions ?? qs.size,
      settings: d.settings || { timerEnabled:false, shuffleQuestions:true, pagination:{enabled:false, perPage:1}, backtrackingAllowed:true },
      rubricFile: d.rubricFile || null,
      assignedClasses: Array.isArray(d.assignedClasses) ? d.assignedClasses : [],
      questions: qs.docs.map(dd => ({ id: dd.id, ...dd.data() })),
      isArchived: d.isArchived === true
    }
  });
}));

/* ===========================================================
   QUIZ: UPDATE (replace questions)
   NEW: allows updating assignedClasses
=========================================================== */
router.put('/quizzes/:quizId', asyncHandler(async (req, res) => {
  const { questions, settings, title, description, dueAt, attemptsAllowed, assignedClasses: assignedClassesRaw } = req.body || {};
  if (!Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ success:false, message:'Invalid or empty question list.' });
  }

  const quizRef = firestore.collection('quizzes').doc(req.params.quizId);
  const doc = await quizRef.get();
  if (!doc.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });

  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  if (settings !== undefined) {
    try { updates.settings = normalizeSettings(settings || {}); }
    catch (e) { return res.status(400).json({ success:false, message:e.message }); }
  }

  if (title        !== undefined) updates.title        = String(title||'').trim();
  if (description  !== undefined) updates.description  = String(description||'').trim();
  if (dueAt        !== undefined) updates.dueAt        = parseDueAtToTimestamp(dueAt);
  if (attemptsAllowed !== undefined) {
    try { updates.attemptsAllowed = normalizeAttemptsAllowed(attemptsAllowed); }
    catch (e) { return res.status(400).json({ success:false, message:e.message }); }
  }
  if (assignedClassesRaw !== undefined) {
    updates.assignedClasses = sanitizeAssignedClasses(assignedClassesRaw);
  }

  const existing = await quizRef.collection('questions').get();
  const delBatch = firestore.batch();
  existing.forEach(d => delBatch.delete(d.ref));
  await delBatch.commit();

  const batch = firestore.batch();
  questions.forEach(q => {
    batch.set(quizRef.collection('questions').doc(), {
      question: q.question,
      choices: q.choices && typeof q.choices === 'object' ? q.choices : {},
      correctAnswer: q.correct ?? q.correctAnswer ?? null,
      imageUrl: q.imageUrl ?? null
    });
  });
  updates.totalQuestions = questions.length;
  batch.set(quizRef, updates, { merge:true });

  await batch.commit();
  res.json({ success:true, message:'Quiz updated successfully.' });
}));

/* ===========================================================
   QUIZ: RUBRIC UPDATE/DELETE (for editor)
=========================================================== */
// accept either 'rubric' or 'rubrics'
const uploadRubricUpdate = (req, res, next) => {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('multipart/form-data')) return next();
  uploadMemory.any()(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success:false, code:err.code, message:`Rubric exceeds limit of ${TEACHER_FILE_LIMIT_MB} MB.` });
      }
      return res.status(400).json({ success:false, message: err.message || 'Upload error' });
    }
    return next();
  });
};

// POST /quizzes/:quizId/rubric  (replace/set)
router.post('/quizzes/:quizId/rubric', uploadRubricUpdate, asyncHandler(async (req, res) => {
  const quizId = req.params.quizId;
  const quizRef = firestore.collection('quizzes').doc(quizId);
  const snap = await quizRef.get();
  if (!snap.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });

  const file = (req.files || []).find(f => f.fieldname === 'rubric' || f.fieldname === 'rubrics');
  if (!file) return res.status(400).json({ success:false, message:'No rubric file provided.' });
  if (!rubricFileOk(file)) return res.status(400).json({ success:false, message:'Invalid rubric file type. Allowed: PDF, DOC/DOCX, XLS/XLSX, CSV, TXT.' });
  if (file.size > TEACHER_FILE_LIMIT_BYTES) return res.status(413).json({ success:false, message:`Rubric exceeds limit of ${TEACHER_FILE_LIMIT_MB} MB.` });

  // ensure at least one essay question exists (same rule as upload)
  const qs = await quizRef.collection('questions').get();
  const hasEssay = qs.docs.some(d => {
    const q = d.data() || {};
    const ch = q.choices && typeof q.choices === 'object' ? q.choices : {};
    const keys = Object.keys(ch);
    return (keys.length === 1 && keys[0] === 'A' && String(ch.A || '').toLowerCase().includes('essay response'));
  });
  if (!hasEssay) return res.status(400).json({ success:false, message:'Rubric can only be uploaded when there is at least one Essay question.' });

  const destPath = `quizzes/${quizId}/rubrics/${Date.now()}_${safeName(file.originalname || 'rubric')}`;
  const { gsUri, publicUrl, downloadUrl, metadata, storagePath } = await saveBufferToStorage(file.buffer, {
    destPath,
    contentType: file.mimetype,
    metadata: { role:'quiz-rubric', quizId },
    filenameForDisposition: file.originalname
  });

  await quizRef.set({
    rubricFile: {
      storagePath,
      originalName: file.originalname,
      size: file.size,
      mime: file.mimetype,
      gsUri,
      publicUrl,
      downloadUrl,
      storageMetadata: metadata,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge:true });

  res.json({ success:true, message:'Rubric uploaded.' });
}));

// DELETE /quizzes/:quizId/rubric  (remove)
router.delete('/quizzes/:quizId/rubric', asyncHandler(async (req, res) => {
  const quizId = req.params.quizId;
  const ref = firestore.collection('quizzes').doc(quizId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });

  await ref.set({ rubricFile: admin.firestore.FieldValue.delete(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge:true });

  // best-effort: remove all rubric files
  try { await bucket.deleteFiles({ prefix: `quizzes/${quizId}/rubrics/` }); } catch {}

  res.json({ success:true, message:'Rubric removed.' });
}));

/* ===========================================================
   QUIZ: DELETE (cascade + Storage cleanup)
=========================================================== */
router.delete('/quizzes/:quizId', asyncHandler(async (req, res) => {
  const quizId = req.params.quizId;
  const quizRef = firestore.collection('quizzes').doc(quizId);
  const snap = await quizRef.get();
  if (!snap.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });

  const questionsSnap = await quizRef.collection('questions').get();
  await deleteDocsInChunks(questionsSnap.docs.map(d => d.ref));

  const essayQ = firestore.collection('quizEssaySubmissions').where('quizId', '==', quizId);
  await deleteQueryInChunks(essayQ);

  await deleteAllAttemptsForQuiz(quizId);
  await quizRef.delete();

  // remove rubric and ANY quiz assets (images, etc.) stored under this quiz
  try { await bucket.deleteFiles({ prefix: `quizzes/${quizId}/` }); } catch {}

  res.json({ success:true, message:'Quiz and all related files/scores/attempts deleted.' });
}));

/* ===========================================================
   SUBMIT QUIZ SCORE (unchanged core, minor tidy)
=========================================================== */
router.post('/submit-quiz-score', asyncHandler(async (req, res) => {
  const { email, quizId, score, total, moduleId, courseId, reason, timeTakenSeconds, answers } = req.body || {};

  if (!email || !quizId || typeof score !== 'number' || typeof total !== 'number') {
    return res.status(400).json({ success:false, message:'Missing or invalid fields.' });
  }

  const userRef = await getUserRefByEmail(email);
  if (!userRef) return res.status(404).json({ success:false, message:'User not found.' });

  const qRef = firestore.collection('quizzes').doc(quizId);
  const qDoc = await qRef.get();
  if (!qDoc.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });
  const qData = qDoc.data() || {};
  const qsSnap = await qRef.collection('questions').get();
  const qList = qsSnap.docs.map(d => d.data());

  const rawAllowed = qData.attemptsAllowed ?? null;
  const attemptsAllowedLive = rawAllowed === 0 ? null : rawAllowed;

  const resolvedCourseId = courseId || qData.courseId || null;
  const resolvedModuleId = moduleId || qData.moduleId || null;

  let teacherId = null;
  try {
    if (resolvedCourseId) {
      const cSnap = await firestore.collection('courses').doc(resolvedCourseId).get();
      if (cSnap.exists) {
        const c = cSnap.data() || {};
        teacherId = c.uploadedBy || (Array.isArray(c.teachers) ? c.teachers[0] : null) || null;
      }
    }
  } catch (e) {}

  const attemptRoot = userRef.collection('quizAttempts').doc(quizId);
  const attemptsCol = attemptRoot.collection('attempts');

  const attemptsSnap = await attemptsCol.get();
  const used = attemptsSnap.size;
  if (attemptsAllowedLive !== null && used >= attemptsAllowedLive) {
    return res.status(403).json({ success:false, message:`Attempt limit reached (${attemptsAllowedLive}).`, attempts:{ used, allowed:attemptsAllowedLive, left:0 } });
  }

  const autoPercent = total ? Math.round((score / total) * 100) : 0;

  const attemptRef = await attemptsCol.add({
    autoScore: score,
    autoTotal: total,
    autoPercent,
    percent: autoPercent,
    gradedScore: 0,
    gradedTotal: 0,
    gradedPercent: 0,
    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    reason: reason || 'manual',
    timeTakenSeconds: timeTakenSeconds ?? null,
  });

  try {
    const answersObj = answers && typeof answers === 'object' ? answers : null;
    if (answersObj) {
      const essayKeys = Object.keys(answersObj).filter(k => k.startsWith('essay_'));
      for (const k of essayKeys) {
        const idx = parseInt(k.split('_')[1], 10);
        const text = String(answersObj[k] || '').trim();
        if (!text) continue;
        const questionText = Number.isFinite(idx) && qList[idx] ? (qList[idx].question || '') : '';
        await firestore.collection('quizEssaySubmissions').add({
          userId: userRef.id,
          userRefPath: userRef.path,
          studentEmail: email,
          quizId,
          quizAttemptId: attemptRoot.id,
          attemptId: attemptRef.id,
          attemptRefPath: attemptRef.path,
          courseId: resolvedCourseId || null,
          moduleId: resolvedModuleId || null,
          teacherId,
          questionIndex: Number.isFinite(idx) ? idx : null,
          questionText,
          answer: text,
          status: 'pending',
          score: null,
          maxScore: 10,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }
  } catch {}

  const passingPercent = qData.passingPercent ?? 60;

  await firestore.runTransaction(async (tx) => {
    const all = await attemptsCol.get();
    let cnt = 0, bestPercent = 0;
    all.forEach(d => {
      cnt++;
      const a = d.data() || {};
      const p = typeof a.percent === 'number' ? a.percent : (typeof a.autoPercent === 'number' ? a.autoPercent : 0);
      if (p > bestPercent) bestPercent = p;
    });

    tx.set(
      attemptRoot,
      {
        quizId,
        courseId: resolvedCourseId,
        moduleId: resolvedModuleId,
        attemptsUsed: cnt,
        lastScore: { score, total, percent: autoPercent },
        bestPercent,
        lastSubmittedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    if (resolvedModuleId && autoPercent >= passingPercent) {
      const cmRef = userRef.collection('completedModules').doc(resolvedModuleId);
      tx.set(
        cmRef,
        {
          moduleId: resolvedModuleId,
          courseId: resolvedCourseId,
          quizId,
          percent: autoPercent,
          completedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  const finalCount = used + 1;
  const left = attemptsAllowedLive === null ? null : Math.max(0, attemptsAllowedLive - finalCount);

  res.json({ success: true, message: 'Quiz attempt recorded.', attemptId: attemptRef.id, attempts: { used: finalCount, allowed: attemptsAllowedLive, left } });
}));

/* ===========================================================
   LIVE attempt status + RESULTS
=========================================================== */
router.get('/api/students/:userId/quiz-attempts', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const raw = String(req.query.quizIds || '').trim();
  const quizIds = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!quizIds.length) return res.json({ success: true, data: {} });

  const userRef = firestore.collection('users').doc(userId);
  const out = {};

  for (const qid of quizIds) {
    try {
      const qSnap = await firestore.collection('quizzes').doc(qid).get();
      if (!qSnap.exists) { out[qid] = { used: 0, allowed: null, left: null, lock: false }; continue; }
      const qData = qSnap.data() || {};
      const rawAllowed = qData.attemptsAllowed ?? null;
      const liveAllowed = rawAllowed === 0 ? null : rawAllowed;

      const atSnap = await userRef.collection('quizAttempts').doc(qid).collection('attempts').get();
      const used = atSnap.size;
      const left = (liveAllowed == null) ? null : Math.max(0, liveAllowed - used);
      out[qid] = { used, allowed: liveAllowed, left, lock: (liveAllowed != null && left === 0) };
    } catch (e) {
      out[qid] = { used: 0, allowed: null, left: null, lock: false };
    }
  }

  res.json({ success: true, data: out });
}));

router.get('/api/students/:userId/quiz-results', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const quizId = String(req.query.quizId || '').trim();
  if (!quizId) return res.status(400).json({ success:false, message:'quizId is required' });

  const userRef = firestore.collection('users').doc(userId);
  const rootRef = userRef.collection('quizAttempts').doc(quizId);
  const atCol   = rootRef.collection('attempts');

  const snap = await atCol.orderBy('submittedAt', 'asc').get();

  const attempts = [];
  let idx = 0;

  snap.forEach(doc => {
    idx++;
    const d = doc.data() || {};

    const autoScore    = typeof d.autoScore === 'number' ? d.autoScore : null;
    const autoTotal    = typeof d.autoTotal === 'number' ? d.autoTotal : null;
    const autoPercent  = typeof d.autoPercent === 'number'
                           ? d.autoPercent
                           : (autoScore!=null && autoTotal ? Math.round(autoScore/autoTotal*100) : null);

    const gradedScore   = typeof d.gradedScore === 'number' ? d.gradedScore : null;
    const gradedTotal   = typeof d.gradedTotal === 'number' ? d.gradedTotal : null;
    const gradedPercent = typeof d.gradedPercent === 'number'
                            ? d.gradedPercent
                            : (gradedScore!=null && gradedTotal ? Math.round(gradedScore/gradedTotal*100) : null);

    const combinedPercent =
      (typeof d.percent === 'number' ? d.percent : null) ??
      (gradedPercent != null ? gradedPercent : autoPercent);

    const score = (gradedScore != null ? gradedScore : autoScore);
    const total = (gradedTotal != null ? gradedTotal : autoTotal);

    const item = {
      attempt: idx,
      attemptId: doc.id,
      submittedAt: d.submittedAt || null,
      timeTakenSeconds: d.timeTakenSeconds ?? null,
      reason: d.reason || 'manual',
      score, total, percent: combinedPercent,
      autoScore, autoTotal, autoPercent,
      gradedScore, gradedTotal, gradedPercent
    };
    attempts.push(item);
  });

  const latest = attempts.length ? attempts[attempts.length - 1] : null;

  let best = null;
  for (const a of attempts) {
    if (a.percent == null) continue;
    if (!best || a.percent > best.percent) best = a;
  }

  res.json({ success:true, attempts, best, latest });
}));

/* ===========================================================
   Archive toggle
=========================================================== */
router.patch('/quizzes/:quizId/archive', asyncHandler(async (req, res) => {
  const { quizId } = req.params;
  const { archived } = req.body || {};
  if (typeof archived !== 'boolean') return res.status(400).json({ success:false, message:'archived must be boolean (true|false).' });

  const ref = firestore.collection('quizzes').doc(quizId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });

  await ref.set({ archived, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
  const after = await ref.get();
  res.json({ success:true, quiz:{ id: ref.id, ...after.data() } });
}));

/* ===========================================================
   OPTIONAL: Backfill token URL for legacy rubric files
   GET /storage/token-url?path=<storagePath>
=========================================================== */
router.get('/storage/token-url', asyncHandler(async (req, res) => {
  const storagePath = String(req.query.path || '').trim();
  if (!storagePath) return res.status(400).json({ success:false, message:'Missing path' });

  try {
    const { token, downloadUrl, meta } = await ensureTokenForObject(storagePath);
    return res.json({ success:true, url: downloadUrl, token, mime: meta?.contentType || '' });
  } catch (e) {
    const notFound = e?.code === 'ENOENT';
    return res.status(notFound ? 404 : 500).json({
      success:false,
      message: notFound ? 'Object not found' : (e?.message || 'Failed to ensure token URL')
    });
  }
}));

/* ===========================================================
   Convenience endpoint (teacher):
   GET /api/classes?teacherId=<id>
   - Filters classes where uploadedBy == teacherId OR teacherId in teachers[]
=========================================================== */
router.get('/api/classes', asyncHandler(async (req, res) => {
  const teacherId = String(req.query.teacherId || '').trim();
  if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

  const classesCol = firestore.collection('classes'); // adjust collection name if needed
  const results = new Map();

  // uploadedBy == teacherId
  try {
    const q1 = await classesCol.where('uploadedBy', '==', teacherId).get();
    q1.forEach(doc => results.set(doc.id, { id: doc.id, ...doc.data() }));
  } catch {}

  // teachers array contains teacherId
  try {
    const q2 = await classesCol.where('teachers', 'array-contains', teacherId).get();
    q2.forEach(doc => results.set(doc.id, { id: doc.id, ...doc.data() }));
  } catch {}

  const classes = Array.from(results.values())
    .map(c => ({
      id: c.id,
      name: c.name || c.className || 'Untitled Class',
      gradeLevel: c.gradeLevel ?? c.grade ?? null,
      section: c.section ?? c.sectionName ?? null,
      uploadedBy: c.uploadedBy ?? null,
      teachers: Array.isArray(c.teachers) ? c.teachers : []
    }))
    .sort((a,b)=> String(a.name||'').localeCompare(String(b.name||'')));

  res.json({ success:true, classes });
}));

/* ===========================================================
   STUDENT: list classes
   - GET /api/students/:userId/classes
   - GET /classes?studentId=<id>       (compat for older clients)
=========================================================== */
router.get('/api/students/:userId/classes', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ success:false, message:'userId is required' });

  const classesCol = firestore.collection('classes');
  const results = new Map();

  const email = await getStudentEmailById(userId);

  const tryQuery = async (field, value) => {
    try {
      const snap = await classesCol.where(field, 'array-contains', value).get();
      snap.forEach(doc => results.set(doc.id, { id: doc.id, ...doc.data() }));
    } catch {}
  };

  await tryQuery('students', userId);
  await tryQuery('studentIds', userId);
  await tryQuery('members', userId);
  if (email) await tryQuery('studentEmails', email);

  const classes = Array.from(results.values()).map(c => ({
    id: c.id,
    name: c.name || c.className || 'Untitled Class',
    gradeLevel: c.gradeLevel ?? c.grade ?? null,
    section: c.section ?? c.sectionName ?? null,
    teachers: Array.isArray(c.teachers) ? c.teachers : [],
  })).sort((a,b)=> String(a.name||'').localeCompare(String(b.name||'')));

  res.json({ success:true, classes });
}));

router.get('/classes', asyncHandler(async (req, res) => {
  const studentId = String(req.query.studentId || '').trim();
  if (!studentId) return res.status(400).json({ success:false, message:'studentId is required' });

  const ids = await getClassesForStudent(studentId);
  if (!ids.length) return res.json({ success:true, classes: [] });

  const classesCol = firestore.collection('classes');
  const results = [];
  for (const id of ids) {
    try {
      const d = await classesCol.doc(id).get();
      if (d.exists) {
        const c = d.data() || {};
        results.push({
          id: d.id,
          name: c.name || c.className || 'Untitled Class',
          gradeLevel: c.gradeLevel ?? c.grade ?? null,
          section: c.section ?? c.sectionName ?? null,
          teachers: Array.isArray(c.teachers) ? c.teachers : [],
        });
      }
    } catch {}
  }

  results.sort((a,b)=> String(a.name||'').localeCompare(String(b.name||'')));
  res.json({ success:true, classes: results });
}));

module.exports = router;
