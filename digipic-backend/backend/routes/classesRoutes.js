// ==== routes/classesRoutes.js ==== //
const router = require('express').Router();
const XLSX = require('xlsx');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { uploadBulk } = require('../config/multerConfig');
const { isValidSchoolYear, isValidSemester } = require('../utils/validators');
const { enrollStudentIdempotent } = require('../services/enrollment.service');

// === GET /api/classes/:id ===
router.get('/api/classes/:id', asyncHandler(async (req, res) => {
  const ref = firestore.collection('classes').doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) {
    return res.status(404).json({ success: false, message: 'Class not found.' });
  }
  res.json({ success: true, class: { id: doc.id, classId: doc.id, ...doc.data() } });
}));

// === GET /api/classes (filterable) ===
// Optional query params: teacherId, schoolYear, semester
router.get('/api/classes', asyncHandler(async (req, res) => {
  let q = firestore.collection('classes');

  if (req.query.teacherId) q = q.where('teacherId', '==', req.query.teacherId);
  if (req.query.schoolYear) q = q.where('schoolYear', '==', req.query.schoolYear);
  if (req.query.semester) q = q.where('semester', '==', req.query.semester);

  q = q.orderBy('createdAt', 'desc');

  const snap = await q.get();
  const classes = snap.docs.map(doc => {
    const d = doc.data();
    return {
      id: doc.id,
      classId: d.classId || doc.id,
      name: d.name,
      gradeLevel: d.gradeLevel,
      section: d.section,
      schoolYear: d.schoolYear || null,
      semester: d.semester || null,
      students: d.students || 0,
      teacherId: d.teacherId,
      createdAt: d.createdAt
    };
  });

  res.json({ success: true, classes });
}));

// === POST /api/classes ===
// body: { name, gradeLevel, section, teacherId, schoolYear, semester }
router.post('/api/classes', asyncHandler(async (req, res) => {
  const { name, gradeLevel, section, teacherId, schoolYear, semester } = req.body;

  if (!name || !gradeLevel || !section || !teacherId) {
    return res.status(400).json({
      success: false,
      message: 'name, gradeLevel, section and teacherId are all required.'
    });
  }
  if (!isValidSchoolYear(schoolYear)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid schoolYear. Use YYYY-YYYY (e.g., 2025-2026).'
    });
  }
  if (!isValidSemester(semester)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid semester. Use "1st Semester" or "2nd Semester".'
    });
  }

  const payload = {
    name: String(name).trim(),
    gradeLevel: String(gradeLevel).trim(),
    section: String(section).trim(),
    teacherId: String(teacherId).trim(),
    schoolYear,
    semester,
    students: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const docRef = await firestore.collection('classes').add(payload);
  await docRef.update({ classId: docRef.id });

  const saved = await docRef.get();
  res.status(201).json({
    success: true,
    class: { id: docRef.id, classId: docRef.id, ...saved.data() }
  });
}));

// === PUT /api/classes/:id ===
// body: { name?, gradeLevel?, section?, schoolYear?, semester? }
router.put('/api/classes/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, gradeLevel, section, schoolYear, semester } = req.body;

  const classRef = firestore.collection('classes').doc(id);
  const classDoc = await classRef.get();
  if (!classDoc.exists) {
    return res.status(404).json({ success: false, message: 'Class not found.' });
  }

  const updates = {};
  if (name != null)       updates.name = String(name).trim();
  if (gradeLevel != null) updates.gradeLevel = String(gradeLevel).trim();
  if (section != null)    updates.section = String(section).trim();
  if (schoolYear != null) {
    if (!isValidSchoolYear(schoolYear)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid schoolYear. Use YYYY-YYYY (e.g., 2025-2026).'
      });
    }
    updates.schoolYear = schoolYear;
  }
  if (semester != null) {
    if (!isValidSemester(semester)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid semester. Use "1st Semester" or "2nd Semester".'
      });
    }
    updates.semester = semester;
  }

  await classRef.update(updates);
  res.json({ success: true });
}));

// === DELETE /api/classes/:id ===
// Optional query param: ?cascade=true  -> also deletes subcollections
router.delete('/api/classes/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cascade = String(req.query.cascade || '').toLowerCase() === 'true';

  const classRef = firestore.collection('classes').doc(id);
  const snap = await classRef.get();
  if (!snap.exists) {
    return res.status(404).json({ success: false, message: 'Class not found.' });
  }

  if (cascade) {
    const subcols = await classRef.listCollections();
    for (const col of subcols) {
      const subSnap = await col.get();
      const batchSize = 400;
      let docs = subSnap.docs;
      while (docs.length) {
        const batch = firestore.batch();
        docs.slice(0, batchSize).forEach(d => batch.delete(d.ref));
        await batch.commit();
        docs = docs.slice(batchSize);
      }
    }
  }

  await classRef.delete();
  return res.json({ success: true });
}));

// === ROSTER: GET /api/classes/:id/students ===
// Always reflect the *current* user.active from the users collection.
router.get('/api/classes/:id/students', asyncHandler(async (req, res) => {
  const rosterRef = firestore.collection('classes').doc(req.params.id).collection('roster');
  const snap = await rosterRef.get();

  const base = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Join each roster entry with its user doc (by studentId).
  const students = await Promise.all(base.map(async (row) => {
    let active = !!row.active; // fallback to what roster had
    let email = row.email || '';
    let fullName = row.fullName || '';
    let photoURL = row.photoURL || '';

    try {
      if (row.userId) {
        // Fast path if you store userId in roster
        const uDoc = await firestore.collection('users').doc(row.userId).get();
        if (uDoc.exists) {
          const u = uDoc.data();
          active = (u.active !== false); // default to true when missing
          email = email || u.email || '';
          fullName = fullName || `${u.firstName || ''} ${u.lastName || ''}`.trim();
          photoURL = photoURL || u.photoURL || '';
        }
      } else if (row.studentId) {
        // Fallback: look up by studentId
        const q = await firestore.collection('users')
          .where('studentId', '==', String(row.studentId))
          .limit(1)
          .get();

        if (!q.empty) {
          const u = q.docs[0].data();
          active = (u.active !== false);
          email = email || u.email || '';
          fullName = fullName || `${u.firstName || ''} ${u.lastName || ''}`.trim();
          photoURL = photoURL || u.photoURL || '';
        }
      }
    } catch (_) {
      // keep fallbacks
    }

    return {
      ...row,
      active,
      email,
      fullName,
      photoURL,
    };
  }));

  res.json({ success: true, students });
}));



// === ROSTER: POST /api/classes/:id/students (single enroll) ===
router.post('/api/classes/:id/students', asyncHandler(async (req, res) => {
  const classId = req.params.id;
  const { studentId } = req.body || {};
  if (!studentId) {
    return res.status(400).json({ success: false, message: 'studentId is required.' });
  }

  const result = await enrollStudentIdempotent(classId, studentId);
  if (!result.ok) {
    if (result.reason === 'not_found') return res.status(404).json({ success: false, message: 'Student not found.' });
    if (result.reason === 'class_not_found') return res.status(404).json({ success: false, message: 'Class not found.' });
    return res.status(400).json({ success: false, message: 'Unable to enroll student.' });
  }

  return res.json({
    success: true,
    alreadyEnrolled: !!result.alreadyEnrolled,
    message: result.alreadyEnrolled ? 'Student is already enrolled.' : 'Student enrolled.'
  });
}));

// === ROSTER: BULK ENROLL (xlsx/csv) ===
router.post(
  '/api/classes/:id/students/bulk',
  uploadBulk.single('file'),
  asyncHandler(async (req, res) => {
    const classId = req.params.id;
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    const preferredCol = String(req.body.column || 'studentId').trim().toLowerCase();

    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) return res.status(400).json({ success: false, message: 'No rows found in file.' });

    const headerKeys = Object.keys(rows[0] || {}).map(k => ({ raw: k, lower: k.toLowerCase().trim() }));
    const studentIdKey =
      (headerKeys.find(h => h.lower === preferredCol) ||
        headerKeys.find(h => h.lower === 'studentid') ||
        headerKeys.find(h => h.lower === 'student id'))?.raw;

    if (!studentIdKey) {
      return res.status(400).json({
        success: false,
        message: `Could not find a 'studentId' column. Add a header named '${preferredCol}'.`
      });
    }

    const seen = new Set();
    const studentIds = [];
    for (const r of rows) {
      const raw = String(r[studentIdKey] ?? '').trim();
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);
      studentIds.push(raw);
    }
    if (!studentIds.length) return res.status(400).json({ success: false, message: 'No studentId values found.' });

    const report = { total: studentIds.length, enrolled: 0, alreadyEnrolled: 0, notFound: 0, errors: 0, details: [] };

    for (const sid of studentIds) {
      try {
        const result = await enrollStudentIdempotent(classId, sid);
        if (result.ok && result.alreadyEnrolled) {
          report.alreadyEnrolled++; report.details.push({ studentId: sid, status: 'already' });
        } else if (result.ok) {
          report.enrolled++; report.details.push({ studentId: sid, status: 'enrolled' });
        } else if (result.reason === 'not_found') {
          report.notFound++; report.details.push({ studentId: sid, status: 'not_found' });
        } else if (result.reason === 'class_not_found') {
          return res.status(404).json({ success: false, message: 'Class not found.' });
        } else {
          report.errors++; report.details.push({ studentId: sid, status: 'error', error: result.reason || 'unknown' });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Bulk enroll error for', sid, e);
        report.errors++; report.details.push({ studentId: sid, status: 'error', error: 'exception' });
      }
    }

    return res.status(200).json({ success: true, report });
  })
);

// === ROSTER: DELETE /api/classes/:id/students/:studentId ===
router.delete('/api/classes/:id/students/:studentId', asyncHandler(async (req, res) => {
  const classId = req.params.id;
  const studentId = req.params.studentId;

  const classRef = firestore.collection('classes').doc(classId);

  // 1) Remove from roster
  await classRef.collection('roster').doc(studentId).delete();

  // 2) Decrement count
  await classRef.update({ students: admin.firestore.FieldValue.increment(-1) });

  // 3) Remove enrollment record from user's doc
  const userSnap = await firestore.collection('users').where('studentId', '==', studentId).limit(1).get();
  if (!userSnap.empty) {
    const userDocId = userSnap.docs[0].id;
    const enrollmentRef = firestore.collection('users').doc(userDocId).collection('enrollments').doc(classId);
    await enrollmentRef.delete().catch(() => {}); // ignore if not present
  }

  return res.json({ success: true });
}));

// === Student lookup (exact studentId) — legacy
router.get('/api/students/lookup', asyncHandler(async (req, res) => {
  const { studentId } = req.query;
  if (!studentId || String(studentId).trim() === '') {
    return res.status(400).json({ success: false, message: 'studentId is required.' });
  }
  const snap = await firestore.collection('users').where('studentId', '==', String(studentId).trim()).limit(1).get();
  if (snap.empty) return res.json({ success: true, found: false });
  const u = snap.docs[0].data();
  return res.json({
    success: true,
    found: true,
    student: {
      studentId: u.studentId || '',
      firstName: u.firstName || '',
      middleName: u.middleName || '',
      lastName:  u.lastName || '',
      email:     u.email || '',
      photoURL:  u.photoURL || ''
    }
  });
}));

// === Student SEARCH (by ID or name; resilient case handling) ===
router.get('/api/students/search', asyncHandler(async (req, res) => {
  const q = String(req.query.query || '').trim();
  if (!q) return res.status(400).json({ success: false, message: 'query is required.' });

  const usersCol = firestore.collection('users');
  const resultsMap = new Map(); // id -> user data

  // If it looks like an ID, try exact match first (supports several formats)
  const idLike =
    /^[A-Za-z]-?\d{4}-?\d{5}$/i.test(q) ||  // e.g., S-2025-00001 or A-2025-00001
    /^S-\d{4}-\d{5}$/i.test(q) ||           // strict S-YYYY-XXXXX
    /^S\d+$/i.test(q) ||                    // S12345
    /^\d{4}-\d{5}$/.test(q);                // 2025-00001

  if (idLike) {
    try {
      const idSnap = await usersCol.where('studentId', '==', q).limit(1).get();
      idSnap.forEach(d => resultsMap.set(d.id, d.data()));
    } catch { /* ignore */ }
  }

  // Helpers
  const lc = q.toLowerCase();
  const cap = lc.replace(/^\p{L}/u, ch => ch.toUpperCase()); // capitalize first letter (unicode-safe-ish)
  const candidates = Array.from(new Set([lc, cap, q]));      // try a few variants

  async function prefixRange(field, val, lim = 10) {
    try {
      const snap = await usersCol
        .where(field, '>=', val)
        .where(field, '<', val + '\uf8ff')
        .limit(lim)
        .get();
      snap.forEach(d => resultsMap.set(d.id, d.data()));
    } catch {
      // If the field/index doesn't exist, just ignore this attempt
    }
  }

  // Prefer lower-cased denormalized fields if present
  for (const p of candidates) {
    await Promise.all([
      prefixRange('firstNameLower', p.toLowerCase()),
      prefixRange('lastNameLower',  p.toLowerCase()),
    ]);
  }

  // Fallback to the original-cased fields (works if names are stored as "Juan", "Maria", etc.)
  for (const p of candidates) {
    await Promise.all([
      prefixRange('firstName', p),
      prefixRange('lastName',  p),
    ]);
  }

  // Build response
  const students = Array.from(resultsMap.values())
    .slice(0, 20)
    .map(u => ({
      studentId: u.studentId || '',
      firstName: u.firstName || '',
      lastName:  u.lastName  || '',
      email:     u.email     || ''
    }));

  return res.json({ success: true, students });
}));


// === STUDENT: GET ENROLLMENTS ===
// GET /api/students/:userId/enrollments?includeTeacher=true
router.get('/api/students/:userId/enrollments', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const includeTeacher = String(req.query.includeTeacher || '').toLowerCase() === 'true';

  const userRef = firestore.collection('users').doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    return res.status(404).json({ success: false, message: 'Student not found.' });
  }

  const snap = await userRef.collection('enrollments').get();
  let enrollments = snap.docs.map(d => ({ id: d.id, ...d.data() })); // id == classId

  if (includeTeacher) {
    const teacherIds = Array.from(new Set(enrollments.map(e => e.teacherId).filter(Boolean)));
    const teacherMap = {};
    await Promise.all(teacherIds.map(async tid => {
      try {
        const tdoc = await firestore.collection('users').doc(tid).get();
        if (tdoc.exists) {
          const t = tdoc.data();
          teacherMap[tid] = `${t.firstName || ''} ${t.lastName || ''}`.trim() || t.username || 'Teacher';
        }
      } catch {}
    }));
    enrollments = enrollments.map(e => ({
      ...e,
      teacherName: e.teacherId ? (teacherMap[e.teacherId] || 'Teacher') : '—'
    }));
  }

  return res.json({ success: true, enrollments });
}));

module.exports = router;
