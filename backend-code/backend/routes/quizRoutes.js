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

// ---------- Rubric upload config (teacher) ----------
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

// Conditionally run multer when multipart (memory storage)
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

// --- helpers for settings normalization ----
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

// --- chunked deletions ---
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
=========================================================== */
router.post('/upload-quiz', uploadRubricMaybe, asyncHandler(async (req, res) => {
  let body = req.body || {};
  if (req.file && typeof body.payload === 'string') {
    try { body = JSON.parse(body.payload); }
    catch (e) { return res.status(400).json({ success:false, message:'Invalid JSON in "payload".' }); }
  }

  const {
    courseId, moduleId, quiz, settings, title, description, dueAt, attemptsAllowed
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
      storagePath,          // helpful for later backfills
      originalName: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype,
      gsUri,
      publicUrl,            // fallback (public buckets only)
      downloadUrl,          // ✅ primary (works for private buckets)
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
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  validQuestions.forEach(q => batch.set(quizRef.collection('questions').doc(), q));

  await batch.commit();
  res.json({ success:true, message:'Quiz uploaded successfully.', quizId: quizRef.id });
}));

/* ===========================================================
   QUIZ: GET ALL
=========================================================== */
router.get('/quizzes', asyncHandler(async (req, res) => {
  const includeArchived = ['1','true','yes'].includes(String(req.query.includeArchived || '').toLowerCase());

  const snapshot = await firestore.collection('quizzes').orderBy('createdAt', 'desc').get();

  const quizzes = [];
  const docs = includeArchived
    ? snapshot.docs
    : snapshot.docs.filter(d => {
        const x = d.data() || {};
        return x.archived !== true && x.isArchived !== true;
      });

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
      archived: data.archived === true,
      totalQuestions: data.totalQuestions ?? qs.size,
      settings: data.settings || { timerEnabled:false, shuffleQuestions:true, pagination:{enabled:false, perPage:1}, backtrackingAllowed:true },
      rubricFile: data.rubricFile || null,
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
      archived: d.archived === true,
      totalQuestions: d.totalQuestions ?? qs.size,
      settings: d.settings || { timerEnabled:false, shuffleQuestions:true, pagination:{enabled:false, perPage:1}, backtrackingAllowed:true },
      rubricFile: d.rubricFile || null,
      questions: qs.docs.map(dd => ({ id: dd.id, ...dd.data() })),
      isArchived: d.isArchived === true
    }
  });
}));

/* ===========================================================
   QUIZ: UPDATE (replace questions)
=========================================================== */
router.put('/quizzes/:quizId', asyncHandler(async (req, res) => {
  const { questions, settings, title, description, dueAt, attemptsAllowed } = req.body || {};
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

  // remove rubric and any quiz assets
  try { await bucket.deleteFiles({ prefix: `quizzes/${quizId}/` }); } catch {}

  res.json({ success:true, message:'Quiz and all related scores/attempts deleted.' });
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
   LIVE attempt status + RESULTS (unchanged APIs)
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

// Archive toggle
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

module.exports = router;
