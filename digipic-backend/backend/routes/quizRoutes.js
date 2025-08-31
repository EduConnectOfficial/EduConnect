// ==== routes/quizRoutes.js ====
const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');

// utils
const { parseDueAtToTimestamp } = require('../utils/timeUtils'); // keep your existing helper
const { normalizeAttemptsAllowed } = require('../utils/validators'); // integer >=0, 0 => unlimited
const { getUserRefByEmail } = require('../utils/userUtils'); // resolves users/{userId} by email

// ---- helpers for settings normalization ----
function normalizeSettings(input = {}) {
  const out = {
    timerEnabled: false,
    // randomization (default true). If teacher toggles it OFF, questions preserve authoring order.
    shuffleQuestions: true,
    // pagination + backtracking policy
    pagination: {
      enabled: false,
      perPage: 1
    },
    backtrackingAllowed: true
  };

  // timer
  if (input && typeof input === 'object') {
    if (input.timerEnabled === true) {
      const mins  = parseInt(input.durationMinutes, 10);
      const grace = input.graceSeconds != null ? parseInt(input.graceSeconds, 10) : 0;
      if (!Number.isInteger(mins)  || mins < 1) throw new Error('Invalid durationMinutes (minimum 1).');
      if (!Number.isInteger(grace) || grace < 0) throw new Error('Invalid graceSeconds (>= 0).');
      out.timerEnabled = true;
      out.durationMinutes = mins;
      out.graceSeconds = grace;
      out.durationMs = mins * 60 * 1000;
      out.graceMs = grace * 1000;
    }

    // shuffle toggle (default true)
    if (typeof input.shuffleQuestions === 'boolean') {
      out.shuffleQuestions = input.shuffleQuestions;
    }

    // pagination
    if (input.pagination && typeof input.pagination === 'object') {
      const en = !!input.pagination.enabled;
      let per = parseInt(input.pagination.perPage, 10);
      if (!Number.isInteger(per) || per < 1) per = 1;
      out.pagination = { enabled: en, perPage: per };
    }

    // backtracking policy
    if (typeof input.backtrackingAllowed === 'boolean') {
      out.backtrackingAllowed = input.backtrackingAllowed;
    }
  }

  return out;
}

// --- helpers for chunked deletes + attempts cascade ---

// Delete an arbitrary list of DocumentReferences in safe chunks
async function deleteDocsInChunks(docRefs, chunkSize = 400) {
  if (!Array.isArray(docRefs) || docRefs.length === 0) return;
  for (let i = 0; i < docRefs.length; i += chunkSize) {
    const slice = docRefs.slice(i, i + chunkSize);
    const batch = firestore.batch();
    slice.forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

// Delete all documents returned by a query, in chunks
async function deleteQueryInChunks(query, chunkSize = 400) {
  // Loop until query returns empty so we handle >chunkSize results too
  // (collection queries aren't strongly consistent during deletes)
  // This is fine for admin operations.
  // If your dataset is huge, consider partitioning by time.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await query.limit(chunkSize).get();
    if (snap.empty) break;
    await deleteDocsInChunks(snap.docs.map(d => d.ref), chunkSize);
  }
}

// Delete all users' attempts for a quiz (fast path via collectionGroup, fallback per user)
async function deleteAllAttemptsForQuiz(quizId) {
  try {
    // FAST: requires a collection-group index on quizAttempts.quizId
    const rootsSnap = await firestore
      .collectionGroup('quizAttempts')
      .where('quizId', '==', quizId)
      .get();

    for (const rootDoc of rootsSnap.docs) {
      const attemptsSnap = await rootDoc.ref.collection('attempts').get();
      await deleteDocsInChunks(attemptsSnap.docs.map(d => d.ref));
      await rootDoc.ref.delete();
    }
  } catch (err) {
    // Missing CG index? Firestore throws 9 FAILED_PRECONDITION
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
   QUIZ: UPLOAD
   POST /upload-quiz
=========================================================== */
router.post('/upload-quiz', asyncHandler(async (req, res) => {
  const {
    courseId,
    moduleId,
    quiz,            // [{question, choices, correct}] (essay can be saved with no choices, or a placeholder)
    settings,        // { timerEnabled?, durationMinutes?, graceSeconds?, shuffleQuestions?, pagination?, backtrackingAllowed? }
    title,
    description,
    dueAt,
    attemptsAllowed  // number | 0 for unlimited | null
  } = req.body || {};

  if (!courseId || !moduleId || !Array.isArray(quiz) || quiz.length === 0) {
    return res.status(400).json({ success:false, message:'Missing required fields or empty quiz array.' });
  }
  if (!title || String(title).trim() === '') {
    return res.status(400).json({ success:false, message:'Quiz title is required.' });
  }

  // attempts
  let attempts = null;
  try { attempts = normalizeAttemptsAllowed(attemptsAllowed); }
  catch (e) { return res.status(400).json({ success:false, message: e.message }); }

  // settings (timer, shuffle, pagination, backtracking)
  let normalizedSettings;
  try {
    normalizedSettings = normalizeSettings(settings || {});
  } catch (e) {
    return res.status(400).json({ success:false, message: e.message });
  }

  const dueAtTs = parseDueAtToTimestamp(dueAt);

  // sanitize questions
  const validQuestions = (quiz || [])
    .filter(q => q && q.question)
    .map(q => ({
      question: String(q.question),
      // allow essays (no choices), or MCQ/TF with choices
      choices: q.choices && typeof q.choices === 'object' ? q.choices : {},
      correctAnswer: q.correct ?? q.correctAnswer ?? null, // essays can be null
      imageUrl: q.imageUrl ?? null
    }));

  if (!validQuestions.length) {
    return res.status(400).json({ success:false, message:'No valid quiz questions provided.' });
  }

  const quizRef = firestore.collection('quizzes').doc();
  const batch = firestore.batch();

  batch.set(quizRef, {
    title: String(title).trim(),
    description: description ? String(description).trim() : '',
    courseId, moduleId,
    totalQuestions: validQuestions.length,
    settings: normalizedSettings,
    attemptsAllowed: attempts, // null => unlimited
    dueAt: dueAtTs,
    archived: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  validQuestions.forEach(q => batch.set(quizRef.collection('questions').doc(), q));

  await batch.commit();
  res.json({ success:true, message:'Quiz uploaded successfully.', quizId: quizRef.id });
}));

/* ===========================================================
   QUIZ: GET ALL
   GET /quizzes?includeArchived=1|true (optional)
   - default: exclude archived from response
=========================================================== */
router.get('/quizzes', asyncHandler(async (req, res) => {
  const includeArchived = ['1','true','yes'].includes(String(req.query.includeArchived || '').toLowerCase());

  const snapshot = await firestore.collection('quizzes')
    .orderBy('createdAt', 'desc')
    .get();

  const quizzes = [];
  const docs = includeArchived
    ? snapshot.docs
    // exclude if either archived flag is true (support both keys just in case)
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
      archived: data.archived === true,  // canonical flag
      totalQuestions: data.totalQuestions ?? qs.size,
      settings: data.settings || {
        timerEnabled:false,
        shuffleQuestions:true,
        pagination:{enabled:false, perPage:1},
        backtrackingAllowed:true
      },
      questions: qs.docs.map(d=>d.data())
    });
  }

  res.json({ success:true, quizzes });
}));


/* ===========================================================
   QUIZ: GET ONE
   GET /quizzes/:quizId
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
      archived: d.archived === true,  // <-- add this
      totalQuestions: d.totalQuestions ?? qs.size,
      settings: d.settings || { timerEnabled:false, shuffleQuestions:true, pagination:{enabled:false, perPage:1}, backtrackingAllowed:true },
      questions: qs.docs.map(dd => ({ id: dd.id, ...dd.data() })),
      isArchived: d.isArchived === true   
    }
  });
}));

/* ===========================================================
   QUIZ: UPDATE (replace questions)
   PUT /quizzes/:quizId
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

  // settings (timer, shuffle, pagination, backtracking)
  if (settings !== undefined) {
    try {
      updates.settings = normalizeSettings(settings || {});
    } catch (e) {
      return res.status(400).json({ success:false, message:e.message });
    }
  }

  if (title        !== undefined) updates.title        = String(title||'').trim();
  if (description  !== undefined) updates.description  = String(description||'').trim();
  if (dueAt        !== undefined) updates.dueAt        = parseDueAtToTimestamp(dueAt);
  if (attemptsAllowed !== undefined) {
    try { updates.attemptsAllowed = normalizeAttemptsAllowed(attemptsAllowed); }
    catch (e) { return res.status(400).json({ success:false, message:e.message }); }
  }

  // Replace questions atomically
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
   QUIZ: DELETE (with cascade)
   DELETE /quizzes/:quizId
=========================================================== */
router.delete('/quizzes/:quizId', asyncHandler(async (req, res) => {
  const quizId = req.params.quizId;
  const quizRef = firestore.collection('quizzes').doc(quizId);
  const snap = await quizRef.get();
  if (!snap.exists) {
    return res.status(404).json({ success:false, message:'Quiz not found.' });
  }

  // 1) Delete questions under quiz
  const questionsSnap = await quizRef.collection('questions').get();
  await deleteDocsInChunks(questionsSnap.docs.map(d => d.ref));

  // 2) Delete essay submissions for this quiz
  const essayQ = firestore.collection('quizEssaySubmissions').where('quizId', '==', quizId);
  await deleteQueryInChunks(essayQ);

  // 3) Delete all users' attempts for this quiz (CG fast path + fallback)
  await deleteAllAttemptsForQuiz(quizId);

  // 4) Delete the quiz doc itself
  await quizRef.delete();

  res.json({ success:true, message:'Quiz and all related scores/attempts deleted.' });
}));



/* ===========================================================
   QUIZ: SUBMIT SCORE + ENFORCE ATTEMPTS
   POST /submit-quiz-score
=========================================================== */
router.post('/submit-quiz-score', asyncHandler(async (req, res) => {
  const {
    email,
    quizId,
    score,
    total,
    moduleId,
    courseId,
    reason,
    timeTakenSeconds,
    answers
  } = req.body || {};

  if (!email || !quizId || typeof score !== 'number' || typeof total !== 'number') {
    return res.status(400).json({ success:false, message:'Missing or invalid fields.' });
  }

  // resolve user
  const userRef = await getUserRefByEmail(email);
  if (!userRef) return res.status(404).json({ success:false, message:'User not found.' });

  // load quiz + questions (for optional questionText, and attemptsAllowed)
  const qRef = firestore.collection('quizzes').doc(quizId);
  const qDoc = await qRef.get();
  if (!qDoc.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });
  const qData = qDoc.data() || {};
  const qsSnap = await qRef.collection('questions').get();
  const qList = qsSnap.docs.map(d => d.data());

  // ALWAYS use live attemptsAllowed from quiz doc
  const rawAllowed = qData.attemptsAllowed ?? null;
  const attemptsAllowed = rawAllowed === 0 ? null : rawAllowed;

  const resolvedCourseId = courseId || qData.courseId || null;
  const resolvedModuleId = moduleId || qData.moduleId || null;

  // resolve the teacherId for this course (BEFORE essay creation)
  let teacherId = null;
  try {
    if (resolvedCourseId) {
      const cSnap = await firestore.collection('courses').doc(resolvedCourseId).get();
      if (cSnap.exists) {
        const c = cSnap.data() || {};
        teacherId = c.uploadedBy || (Array.isArray(c.teachers) ? c.teachers[0] : null) || null;
      }
    }
  } catch (e) {
    console.warn('Could not resolve teacherId for course', resolvedCourseId, e.message);
  }

  // users/{uid}/quizAttempts/{quizId}/attempts/{autoId}
  const attemptRoot = userRef.collection('quizAttempts').doc(quizId);
  const attemptsCol = attemptRoot.collection('attempts');

  // enforce attempts (live)
  const attemptsSnap = await attemptsCol.get();
  const used = attemptsSnap.size;
  if (attemptsAllowed !== null && used >= attemptsAllowed) {
    return res.status(403).json({
      success:false,
      message:`Attempt limit reached (${attemptsAllowed}).`,
      attempts:{ used, allowed:attemptsAllowed, left:0 }
    });
  }

  const autoPercent = total ? Math.round((score / total) * 100) : 0;

  // create attempt (auto portion only for now)
  const attemptRef = await attemptsCol.add({
    autoScore: score,
    autoTotal: total,
    autoPercent,
    percent: autoPercent,       // combined; will be updated after essays are graded
    gradedScore: 0,
    gradedTotal: 0,
    gradedPercent: 0,
    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    reason: reason || 'manual',
    timeTakenSeconds: timeTakenSeconds ?? null,
  });

  // === create essay submissions linked to this attempt ===
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
          quizAttemptId: attemptRoot.id,   // equals quizId
          attemptId: attemptRef.id,
          attemptRefPath: attemptRef.path,

          courseId: resolvedCourseId || null,
          moduleId: resolvedModuleId || null,
          teacherId,                       // resolved above

          questionIndex: Number.isFinite(idx) ? idx : null,
          questionText,

          answer: text,
          status: 'pending',
          score: null,
          maxScore: 10,                    // default; teacher may change
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }
  } catch (e) {
    console.warn('Essay submission creation failed (non-fatal):', e.message);
  }

  // summarize at quizAttempts root (do NOT persist attemptsAllowed here to avoid staleness)
  const passingPercent = qData.passingPercent ?? 60;

  await firestore.runTransaction(async (tx) => {
    const all = await attemptsCol.get();
    let cnt = 0;
    let bestPercent = 0;
    all.forEach(d => {
      cnt++;
      const a = d.data() || {};
      const p = typeof a.percent === 'number'
        ? a.percent
        : (typeof a.autoPercent === 'number' ? a.autoPercent : 0);
      if (p > bestPercent) bestPercent = p;
    });

    tx.set(
      attemptRoot,
      {
        quizId,
        courseId: resolvedCourseId,
        moduleId: resolvedModuleId,
        attemptsUsed: cnt,
        // attemptsAllowed: <--- intentionally omitted to prevent stale locks
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

  // recompute user.averageQuizScore from quizAttempts
  const qaSnap = await userRef.collection('quizAttempts').get();
  const bests = [];
  qaSnap.forEach(doc => {
    const d = doc.data() || {};
    if (typeof d.bestGradedPercent === 'number') bests.push(d.bestGradedPercent);
    else if (typeof d.bestPercent === 'number') bests.push(d.bestPercent);
    else if (d.lastScore?.percent != null) bests.push(d.lastScore.percent);
  });
  const averageQuizScore = bests.length
    ? Math.round(bests.reduce((a,b)=>a+b,0)/bests.length)
    : 0;
  await userRef.set({ averageQuizScore }, { merge: true });

  const finalCount = used + 1;
  const left = attemptsAllowed === null ? null : Math.max(0, attemptsAllowed - finalCount);

  res.json({
    success: true,
    message: 'Quiz attempt recorded.',
    attemptId: attemptRef.id,
    attempts: { used: finalCount, allowed: attemptsAllowed, left }
  });
}));

/* ===========================================================
   LIVE attempt status for multiple quizzes (teacher updates reflect)
   GET /api/students/:userId/quiz-attempts?quizIds=Q1,Q2,Q3
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
      // 1) Always read the LIVE attemptsAllowed from the quiz
      const qSnap = await firestore.collection('quizzes').doc(qid).get();
      if (!qSnap.exists) {
        // quiz deleted or not found – treat as unlocked with no attempts
        out[qid] = { used: 0, allowed: null, left: null, lock: false };
        continue;
      }
      const qData = qSnap.data() || {};
      const rawAllowed = qData.attemptsAllowed ?? null;
      const liveAllowed = rawAllowed === 0 ? null : rawAllowed; // null => unlimited

      // 2) Count USED attempts from the student's subcollection (authoritative)
      const atSnap = await userRef.collection('quizAttempts').doc(qid).collection('attempts').get();
      const used = atSnap.size;

      // 3) Compute left/lock based on LIVE allowed
      const left = (liveAllowed == null) ? null : Math.max(0, liveAllowed - used);
      out[qid] = { used, allowed: liveAllowed, left, lock: (liveAllowed != null && left === 0) };
    } catch (e) {
      console.warn('attempt-status error for', qid, e.message);
      out[qid] = { used: 0, allowed: null, left: null, lock: false };
    }
  }

  res.json({ success: true, data: out });
}));

/* ===========================================================
   QUIZ: LIST RESULTS (all attempts for one quiz for one user)
   GET /api/students/:userId/quiz-results?quizId=QID
   Returns:
   {
     success: true,
     attempts: [
       { attempt, submittedAt, score, total, percent,
         autoScore, autoTotal, autoPercent,
         gradedScore, gradedTotal, gradedPercent,
         timeTakenSeconds, reason, attemptId }
     ],
     best:   {...} | null,
     latest: {...} | null
   }
=========================================================== */
router.get('/api/students/:userId/quiz-results', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const quizId = String(req.query.quizId || '').trim();
  if (!quizId) return res.status(400).json({ success:false, message:'quizId is required' });

  const userRef = firestore.collection('users').doc(userId);
  const rootRef = userRef.collection('quizAttempts').doc(quizId);
  const atCol   = rootRef.collection('attempts');

  // order by submittedAt asc so "attempt" number is stable
  const snap = await atCol.orderBy('submittedAt', 'asc').get();

  const attempts = [];
  let idx = 0;

  snap.forEach(doc => {
    idx++;
    const d = doc.data() || {};

    // AUTO (machine) portion
    const autoScore    = typeof d.autoScore === 'number' ? d.autoScore : null;
    const autoTotal    = typeof d.autoTotal === 'number' ? d.autoTotal : null;
    const autoPercent  = typeof d.autoPercent === 'number'
                           ? d.autoPercent
                           : (autoScore!=null && autoTotal ? Math.round(autoScore/autoTotal*100) : null);

    // GRADED (manual essay) portion
    const gradedScore   = typeof d.gradedScore === 'number' ? d.gradedScore : null;
    const gradedTotal   = typeof d.gradedTotal === 'number' ? d.gradedTotal : null;
    const gradedPercent = typeof d.gradedPercent === 'number'
                            ? d.gradedPercent
                            : (gradedScore!=null && gradedTotal ? Math.round(gradedScore/gradedTotal*100) : null);

    // Combined percent (prefer gradedPercent if present; else percent; else autoPercent)
    const combinedPercent =
      (typeof d.percent === 'number' ? d.percent : null) ??
      (gradedPercent != null ? gradedPercent : autoPercent);

    // If you want a combined "score/total" too, prefer graded* when present; else auto*
    const score = (gradedScore != null ? gradedScore : autoScore);
    const total = (gradedTotal != null ? gradedTotal : autoTotal);

    const item = {
      attempt: idx,
      attemptId: doc.id,
      submittedAt: d.submittedAt || null,        // may be null right after write (serverTimestamp)
      timeTakenSeconds: d.timeTakenSeconds ?? null,
      reason: d.reason || 'manual',

      // unified fields used by UI table:
      score, total, percent: combinedPercent,

      // expose sub-scores for debugging/advanced UIs:
      autoScore, autoTotal, autoPercent,
      gradedScore, gradedTotal, gradedPercent
    };
    attempts.push(item);
  });

  // Compute 'best' and 'latest'
  const latest = attempts.length ? attempts[attempts.length - 1] : null;

  let best = null;
  for (const a of attempts) {
    if (a.percent == null) continue;
    if (!best || a.percent > best.percent) best = a;
  }

  res.json({ success:true, attempts, best, latest });
}));

// PATCH /quizzes/:quizId/archive  -> body: { archived: true|false }
router.patch('/quizzes/:quizId/archive', asyncHandler(async (req, res) => {
  const { quizId } = req.params;
  const { archived } = req.body || {};

  if (typeof archived !== 'boolean') {
    return res.status(400).json({ success:false, message:'archived must be boolean (true|false).' });
  }

  const ref = firestore.collection('quizzes').doc(quizId);
  const snap = await ref.get();
  if (!snap.exists) {
    return res.status(404).json({ success:false, message:'Quiz not found.' });
  }

  await ref.set(
    { archived, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge:true }
  );

  const after = await ref.get();
  res.json({ success:true, quiz:{ id: ref.id, ...after.data() } });
}));



module.exports = router;
