// ==== routes/assignmentsRoutes.js ====
const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { uploadAssign, uploadSubmission } = require('../config/multerConfig');
const { getUserRefByAnyId } = require('../utils/idUtils');

/* ---------------- Helpers ---------------- */

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

/** Given classIds, returns { activeIds, archivedIds, missingIds } */
async function splitClassIdsByArchived(classIds) {
  const activeIds = [], archivedIds = [], missingIds = [];
  const chunk = (arr, size = 10) => {
    const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out;
  };
  const classesCol = firestore.collection('classes');
  for (const ids of chunk(classIds, 10)) {
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

/* ===========================================================
   CREATE ASSIGNMENT  (archive-aware)
   POST /assignments
=========================================================== */
router.post(
  '/assignments',
  uploadAssign.array('files'),
  asyncHandler(async (req, res) => {
    const {
      title, content, courseId, courseTitle, moduleId,
      publishAt, dueAt, points, teacherId
    } = req.body;

    if (!title || !content || !courseId || !teacherId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: title, content, courseId, teacherId.'
      });
    }

    // ❗ Block creation if the course is archived
    const status = await checkCourseArchived(String(courseId).trim());
    if (!status.ok) return res.status(status.code).json({ success:false, message:status.message });
    if (status.archived) {
      return res.status(403).json({ success:false, message:'Course is archived; cannot create assignments.' });
    }

    // Optional links[] from body
    let links = req.body.links || req.body['links[]'] || [];
    if (typeof links === 'string') links = [links];

    // Build attachments from files + links
    const files = Array.isArray(req.files) ? req.files : [];
    const fileAttachments = files.map(f => ({
      filePath: `/uploads/assignments/${f.filename}`,
      originalName: f.originalname,
      size: f.size,
      mime: f.mimetype
    }));

    const linkAttachments = (links || [])
      .map(u => String(u).trim())
      .filter(u => u.length)
      .map(u => ({ url: u }));

    // Fetch moduleNumber if moduleId present
    let moduleNumber = null;
    if (moduleId) {
      try {
        const m = await firestore.collection('modules').doc(String(moduleId)).get();
        if (m.exists) moduleNumber = m.data().moduleNumber || null;
      } catch { /* ignore */ }
    }

    const payload = {
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
      attachments: [...fileAttachments, ...linkAttachments],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      teacherId: String(teacherId).trim(),
    };

    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    const ref = await firestore.collection('assignments').add(payload);
    const saved = await ref.get();

    return res.status(201).json({
      success: true,
      id: ref.id,
      assignment: { id: ref.id, ...saved.data() }
    });
  })
);

/* ===========================================================
   GET ONE ASSIGNMENT
   GET /assignments/:id
=========================================================== */
router.get(
  '/assignments/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const snap = await firestore.collection('assignments').doc(id).get();
    if (!snap.exists) {
      return res.status(404).json({ success:false, message:'Assignment not found.' });
    }
    res.json({ success:true, assignment: { id: snap.id, ...snap.data() } });
  })
);

/* ===========================================================
   UPDATE (PATCH) ASSIGNMENT
   PATCH /assignments/:id
=========================================================== */
router.patch(
  '/assignments/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (req.body.title !== undefined)   updates.title   = String(req.body.title).trim();
    if (req.body.content !== undefined) updates.content = String(req.body.content).trim();
    if (req.body.points !== undefined)  updates.points  = (req.body.points === null || req.body.points === '') ? null : Number(req.body.points);

    if (req.body.publishAt !== undefined) {
      const ts = toTimestampOrNull(req.body.publishAt);
      if (ts) updates.publishAt = ts;
    }
    if (req.body.dueAt !== undefined) {
      updates.dueAt = toTimestampOrNull(req.body.dueAt);
    }

    // handle module move
    if (req.body.moduleId !== undefined) {
      const newModuleId = req.body.moduleId ? String(req.body.moduleId).trim() : null;
      updates.moduleId = newModuleId;

      // recompute moduleNumber
      let moduleNumber = null;
      if (newModuleId) {
        try {
          const m = await firestore.collection('modules').doc(newModuleId).get();
          if (m.exists) moduleNumber = m.data().moduleNumber || null;
        } catch { /* ignore */ }
      }
      updates.moduleNumber = moduleNumber;
    }

    const ref = firestore.collection('assignments').doc(id);
    const exists = await ref.get();
    if (!exists.exists) {
      return res.status(404).json({ success:false, message:'Assignment not found.' });
    }

    await ref.set(updates, { merge: true });
    const fresh = await ref.get();
    res.json({ success:true, assignment: { id: fresh.id, ...fresh.data() } });
  })
);

/* ===========================================================
   DELETE ASSIGNMENT
   DELETE /assignments/:id
=========================================================== */
router.delete(
  '/assignments/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const aRef = firestore.collection('assignments').doc(id);
    const snap = await aRef.get();
    if (!snap.exists) {
      return res.status(404).json({ success:false, message:'Assignment not found.' });
    }
    await aRef.delete();
    res.json({ success:true, message:'Assignment deleted.' });
  })
);

/* ===========================================================
   LIST ASSIGNMENTS BY MODULE (archive-aware)
   GET /modules/:moduleId/assignments
=========================================================== */
router.get(
  '/modules/:moduleId/assignments',
  asyncHandler(async (req, res) => {
    const { moduleId } = req.params;

    // find the parent course via module
    const mDoc = await firestore.collection('modules').doc(moduleId).get();
    if (!mDoc.exists) return res.json({ success:true, assignments: [] });

    const courseId = mDoc.data()?.courseId;
    const status = await checkCourseArchived(courseId);
    if (!status.ok) return res.status(status.code).json({ success:false, message:status.message });
    if (status.archived) return res.json({ success:true, assignments: [] });

    const snap = await firestore
      .collection('assignments')
      .where('moduleId', '==', moduleId)
      .orderBy('publishAt', 'desc')
      .get();

    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, assignments: items });
  })
);

/* ===========================================================
   LIST ASSIGNMENTS BY COURSE (teacher, archive-aware)
   GET /courses/:courseId/assignments
=========================================================== */
router.get(
  '/courses/:courseId/assignments',
  asyncHandler(async (req, res) => {
    const { courseId } = req.params;

    const status = await checkCourseArchived(courseId);
    if (!status.ok) return res.status(status.code).json({ success:false, message:status.message });
    if (status.archived) return res.json({ success:true, assignments: [] });

    const snap = await firestore
      .collection('assignments')
      .where('courseId', '==', courseId)
      .orderBy('publishAt', 'desc')
      .get();

    const assignments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, assignments });
  })
);

/* ===========================================================
   CONSOLIDATED STUDENT ASSIGNMENTS (archive-aware)
   GET /students/:userId/assignments
=========================================================== */
router.get(
  '/students/:userId/assignments',
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    // 1) get class enrollments
    const enrollSnap = await firestore
      .collection('users').doc(userId)
      .collection('enrollments').get();

    const classIds = enrollSnap.docs.map(d => d.id);
    if (!classIds.length) return res.json({ success: true, assignments: [] });

    // Keep only ACTIVE classIds (hide archived by default)
    const { activeIds } = await splitClassIdsByArchived(classIds);
    if (!activeIds.length) return res.json({ success: true, assignments: [] });

    // 2) find courses assigned to those active classes
    const classChunks = [];
    for (let i = 0; i < activeIds.length; i += 10) classChunks.push(activeIds.slice(i, i + 10));

    const courseSeen = new Set();
    const courses = [];
    for (const chunk of classChunks) {
      const snap = await firestore
        .collection('courses')
        .where('assignedClasses', 'array-contains-any', chunk)
        .get();

      snap.forEach(doc => {
        const data = doc.data() || {};
        // ❗ Exclude archived courses here
        if (!courseSeen.has(doc.id) && data.archived !== true) {
          courseSeen.add(doc.id);
          courses.push({ id: doc.id, ...data });
        }
      });
    }
    if (!courses.length) return res.json({ success: true, assignments: [] });

    // 3) fetch assignments for those (non-archived) courses
    const courseIds = courses.map(c => c.id);
    const aChunks = [];
    for (let i = 0; i < courseIds.length; i += 10) aChunks.push(courseIds.slice(i, i + 10));

    const results = [];
    for (const ids of aChunks) {
      const snap = await firestore
        .collection('assignments')
        .where('courseId', 'in', ids)
        .orderBy('publishAt', 'desc')
        .get();

      snap.forEach(doc => results.push({ id: doc.id, ...doc.data() }));
    }

    // 4) attach mySubmission for this userId (best-effort)
    await Promise.all(results.map(async (a, idx) => {
      try {
        const subDoc = await firestore
          .collection('assignments').doc(a.id)
          .collection('submissions').doc(userId)
          .get();
        if (subDoc.exists) results[idx].mySubmission = subDoc.data();
      } catch { /* ignore */ }
    }));

    // newest first
    results.sort((x, y) => {
      const xp = x.publishAt?.toMillis?.() ?? 0;
      const yp = y.publishAt?.toMillis?.() ?? 0;
      return yp - xp;
    });

    res.json({ success: true, assignments: results });
  })
);

/* ===========================================================
   STUDENT SUBMIT ASSIGNMENT
   POST /assignments/:id/submissions
=========================================================== */
router.post(
  '/assignments/:id/submissions',
  uploadSubmission.array('files'),
  asyncHandler(async (req, res) => {
    const assignmentId = req.params.id;
    const { studentId } = req.body;

    if (!studentId) {
      return res.status(400).json({ success: false, message: 'studentId is required.' });
    }

    // validate assignment exists
    const aRef = firestore.collection('assignments').doc(assignmentId);
    const aDoc = await aRef.get();
    if (!aDoc.exists) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }

    const text = (req.body.text || '').toString().trim();
    const files = Array.isArray(req.files) ? req.files : [];
    const fileBlobs = files.map(f => ({
      filePath: `/uploads/assignment_submissions/${f.filename}`,
      originalName: f.originalname,
      size: f.size,
      mime: f.mimetype
    }));

    const subRef = aRef.collection('submissions').doc(studentId);
    const payload = {
      studentId,
      text: text || '',
      files: fileBlobs,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      graded: false,
      grade: null,
      feedback: null
    };

    await subRef.set(payload, { merge: true });
    res.json({ success: true, message: 'Submission saved.' });
  })
);

/* ===========================================================
   TEACHER: GRADE SUBMISSION
   PATCH /assignments/:id/submissions/:studentId
=========================================================== */
router.patch(
  '/assignments/:id/submissions/:studentId',
  asyncHandler(async (req, res) => {
    const { id: assignmentId, studentId } = req.params;
    const { grade, feedback } = req.body;

    const aRef  = firestore.collection('assignments').doc(assignmentId);
    const subRef = aRef.collection('submissions').doc(studentId);

    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (grade !== undefined) { updates.grade = Number(grade); updates.graded = true; }
    if (feedback !== undefined) { updates.feedback = String(feedback); }
    await subRef.set(updates, { merge: true });

    const [aSnap, sSnap] = await Promise.all([aRef.get(), subRef.get()]);
    if (!aSnap.exists) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }

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

      // recompute simple average
      const gSnap = await userRef.collection('assignmentGrades').get();
      let sum = 0, count = 0;
      gSnap.forEach(d => {
        const g = d.data()?.grade;
        if (typeof g === 'number') { sum += g; count += 1; }
      });
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
  })
);

/* ===========================================================
   STUDENT: VIEW OWN SUBMISSION
   GET /assignments/:id/submissions/:studentId
=========================================================== */
router.get(
  '/assignments/:id/submissions/:studentId',
  asyncHandler(async (req, res) => {
    const { id: assignmentId, studentId } = req.params;

    const snap = await firestore
      .collection('assignments')
      .doc(assignmentId)
      .collection('submissions')
      .doc(studentId)
      .get();

    if (!snap.exists) return res.json({ success: true, submission: null });
    return res.json({ success: true, submission: { id: snap.id, ...snap.data() } });
  })
);

/* ===========================================================
   LIST ALL SUBMISSIONS FOR AN ASSIGNMENT
   GET /assignments/:id/submissions
=========================================================== */
router.get(
  '/assignments/:id/submissions',
  asyncHandler(async (req, res) => {
    const assignmentId = req.params.id;

    const subsSnap = await firestore
      .collection('assignments')
      .doc(assignmentId)
      .collection('submissions')
      .get();

    const submissions = [];
    for (const doc of subsSnap.docs) {
      const data = doc.data();
      const sid = data.studentId || doc.id;

      // Resolve student display name
      let studentName = sid;
      try {
        let userSnap = await firestore.collection('users').doc(sid).get();
        let user = null;
        if (userSnap.exists) user = userSnap.data();
        else {
          const userQuery = await firestore.collection('users').where('studentId', '==', sid).limit(1).get();
          if (!userQuery.empty) user = userQuery.docs[0].data();
        }
        if (user) {
          if (user.fullName && user.fullName.trim()) studentName = user.fullName.trim();
          else studentName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || sid;
        }
      } catch { /* ignore and keep sid */ }

      submissions.push({
        ...data,
        studentId: sid,
        studentName,
        assignmentId,
      });
    }

    res.json({ success: true, submissions });
  })
);

/* ===========================================================
   COMPAT: SUBMIT ENDPOINTS
   - POST /assignments/:assignmentId/submit   (requires studentId in body)
   - POST /students/:studentId/assignments/:assignmentId/submit
=========================================================== */
const multer = require('multer');
const uploadAny = uploadSubmission.any();

function collectSubmissionFiles(filesArr) {
  const files = Array.isArray(filesArr) ? filesArr : [];
  if (!files.length) return [];
  return files.map(f => ({
    filePath: `/uploads/assignment_submissions/${f.filename}`,
    originalName: f.originalname,
    size: f.size,
    mime: f.mimetype
  }));
}

async function saveSubmission({ assignmentId, studentId, text, filesBlobs }) {
  // Validate assignment
  const aRef = firestore.collection('assignments').doc(assignmentId);
  const aDoc = await aRef.get();
  if (!aDoc.exists) {
    const err = new Error('Assignment not found.');
    err.statusCode = 404;
    throw err;
  }

  const subRef = aRef.collection('submissions').doc(studentId);
  const payload = {
    studentId,
    text: (text || '').toString().trim(),
    files: filesBlobs,
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
router.post(
  '/assignments/:assignmentId/submit',
  uploadAny,
  asyncHandler(async (req, res) => {
    const { assignmentId } = req.params;
    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'studentId is required.' });
    }
    const filesBlobs = collectSubmissionFiles(req.files);
    const text = req.body.note || req.body.text || '';
    const result = await saveSubmission({ assignmentId, studentId, text, filesBlobs });
    return res.json(result);
  })
);

// 2) POST /students/:studentId/assignments/:assignmentId/submit
router.post(
  '/students/:studentId/assignments/:assignmentId/submit',
  uploadAny,
  asyncHandler(async (req, res) => {
    const { assignmentId, studentId } = req.params;
    const filesBlobs = collectSubmissionFiles(req.files);
    const text = req.body.note || req.body.text || '';
    const result = await saveSubmission({ assignmentId, studentId, text, filesBlobs });
    return res.json(result);
  })
);

/* ===========================================================
   DELETE A STUDENT SUBMISSION
   DELETE /assignments/:id/submissions/:studentId
=========================================================== */
router.delete(
  '/assignments/:id/submissions/:studentId',
  asyncHandler(async (req, res) => {
    const { id: assignmentId, studentId } = req.params;

    const aRef = firestore.collection('assignments').doc(assignmentId);
    const subRef = aRef.collection('submissions').doc(studentId);

    const [aSnap, sSnap] = await Promise.all([aRef.get(), subRef.get()]);
    if (!aSnap.exists) {
      return res.status(404).json({ success:false, message:'Assignment not found.' });
    }
    if (!sSnap.exists) {
      return res.status(404).json({ success:false, message:'Submission not found.' });
    }

    await subRef.delete();

    // (Optional) also clear mirrored grade in user's assignmentGrades
    try {
      const userRef = await getUserRefByAnyId(studentId);
      if (userRef) {
        await userRef.collection('assignmentGrades').doc(assignmentId).delete();
      }
    } catch { /* ignore */ }

    return res.json({ success:true, message:'Submission deleted.' });
  })
);

module.exports = router;
