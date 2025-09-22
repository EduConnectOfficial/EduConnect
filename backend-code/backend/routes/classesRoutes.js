// backend/routes/classesRoutes.js
'use strict';

const router = require('express').Router();
const XLSX = require('xlsx');
const multer = require('multer');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');
const { isValidSchoolYear, isValidSemester } = require('../utils/validators');
const { enrollStudentIdempotent } = require('../services/enrollment.service');
const { safeDecrypt } = require('../utils/fieldCrypto');

// ===== In-memory uploader for bulk =====
const memoryStorage = multer.memoryStorage();
const SPREADSHEET_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
]);
const SPREADSHEET_EXT = /\.(xlsx|xls|csv)$/i;

function bulkFileFilter(_req, file, cb) {
  const okMime = SPREADSHEET_MIMES.has(file.mimetype);
  const okExt = SPREADSHEET_EXT.test(file.originalname || '');
  if (okMime || okExt) return cb(null, true);
  cb(new Error('Invalid file type. Please upload an .xlsx, .xls, or .csv file.'));
}

const uploadBulkMemory = multer({
  storage: memoryStorage,
  limits: { fileSize: parseInt(process.env.BULK_ENROLL_FILE_LIMIT_MB || '25', 10) * 1024 * 1024 },
  fileFilter: bulkFileFilter,
});

// --- helpers: role guards (strict students-only) ---
function isStudentUser(u = {}) {
  const role = String(u.role || u.userType || '').toLowerCase();
  const hasStudentId = typeof u.studentId === 'string' && u.studentId.trim() !== '';
  const isTeacherSignal =
    u.isTeacher === true ||
    role === 'teacher' ||
    (typeof u.teacherId === 'string' && u.teacherId.trim() !== '');
  return hasStudentId && !isTeacherSignal;
}

// ---------- FULL NAME FIRST: decrypt + split helpers ----------
function splitFullName(full = '') {
  const s = String(full || '').trim();
  if (!s) return { first: '', last: '' };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function fallbackNameFromEmail(email = '') {
  const m = String(email || '').match(/^[^@]+/);
  return m ? m[0] : '';
}

// Prefer: fullName -> decrypted first/last -> plaintext first/last -> username/email
function decryptNamesFromUser(u = {}) {
  const decFirst  = safeDecrypt(u.firstNameEnc,  u.firstName || '');
  const decMiddle = safeDecrypt(u.middleNameEnc, u.middleName || '');
  const decLast   = safeDecrypt(u.lastNameEnc,   u.lastName || '');
  const hasDec = (decFirst || decLast);

  const full = String(u.fullName || '').trim();
  if (full) {
    const { first, last } = splitFullName(full);
    return {
      firstName: first || decFirst || fallbackNameFromEmail(u.email) || u.username || '',
      middleName: decMiddle || '',
      lastName: last || decLast || '',
      fullName: full
    };
  }

  if (hasDec) {
    const built = `${decFirst} ${decMiddle ? decMiddle + ' ' : ''}${decLast}`.replace(/\s+/g,' ').trim();
    return { firstName: decFirst, middleName: decMiddle, lastName: decLast, fullName: built || '' };
  }

  // nothing decrypted/recorded — last-ditch from username/email
  const guessed = fallbackNameFromEmail(u.email) || u.username || 'Student';
  const { first, last } = splitFullName(guessed);
  return { firstName: first, middleName: '', lastName: last, fullName: guessed };
}

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
router.get('/api/classes', asyncHandler(async (req, res) => {
  let q = firestore.collection('classes');

  if (req.query.teacherId) q = q.where('teacherId', '==', req.query.teacherId);
  if (req.query.schoolYear) q = q.where('schoolYear', '==', req.query.schoolYear);
  if (req.query.semester) q = q.where('semester', '==', req.query.semester);

  const archivedParam = String(req.query.archived || 'exclude');
  if (archivedParam === 'exclude')      q = q.where('archived', '==', false);
  else if (archivedParam === 'only')    q = q.where('archived', '==', true);

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
      archived: !!d.archived,
      archivedAt: d.archivedAt || null,
      archivedBy: d.archivedBy || null,
      createdAt: d.createdAt
    };
  });

  res.json({ success: true, classes });
}));

// === POST /api/classes ===
router.post('/api/classes', asyncHandler(async (req, res) => {
  const { name, gradeLevel, section, teacherId, schoolYear, semester } = req.body;

  if (!name || !gradeLevel || !section || !teacherId) {
    return res.status(400).json({ success: false, message: 'name, gradeLevel, section and teacherId are all required.' });
  }
  if (!isValidSchoolYear(schoolYear)) {
    return res.status(400).json({ success: false, message: 'Invalid schoolYear. Use YYYY-YYYY (e.g., 2025-2026).' });
  }
  if (!isValidSemester(semester)) {
    return res.status(400).json({ success: false, message: 'Invalid semester. Use "1st Semester" or "2nd Semester".' });
  }

  const payload = {
    name: String(name).trim(),
    gradeLevel: String(gradeLevel).trim(),
    section: String(section).trim(),
    teacherId: String(teacherId).trim(),
    schoolYear,
    semester,
    students: 0,
    archived: false,
    archivedAt: null,
    archivedBy: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const docRef = await firestore.collection('classes').add(payload);
  await docRef.update({ classId: docRef.id });

  const saved = await docRef.get();
  res.status(201).json({ success: true, class: { id: docRef.id, classId: docRef.id, ...saved.data() } });
}));

// === PUT /api/classes/:id ===
router.put('/api/classes/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, gradeLevel, section, schoolYear, semester } = req.body;

  const classRef = firestore.collection('classes').doc(id);
  const classDoc = await classRef.get();
  if (!classDoc.exists) return res.status(404).json({ success: false, message: 'Class not found.' });

  const updates = {};
  if (name != null)       updates.name = String(name).trim();
  if (gradeLevel != null) updates.gradeLevel = String(gradeLevel).trim();
  if (section != null)    updates.section = String(section).trim();
  if (schoolYear != null) {
    if (!isValidSchoolYear(schoolYear)) {
      return res.status(400).json({ success: false, message: 'Invalid schoolYear. Use YYYY-YYYY (e.g., 2025-2026).' });
    }
    updates.schoolYear = schoolYear;
  }
  if (semester != null) {
    if (!isValidSemester(semester)) {
      return res.status(400).json({ success: false, message: 'Invalid semester. Use "1st Semester" or "2nd Semester".' });
    }
    updates.semester = semester;
  }

  await classRef.update(updates);
  res.json({ success: true });
}));

// === ARCHIVE ===
router.patch('/api/classes/:id/archive', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { by } = req.body || {};
  const ref = firestore.collection('classes').doc(id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Class not found.' });

  const d = doc.data();
  if (d.archived === true) return res.json({ success: true, already: true, message: 'Class already archived.' });

  await ref.update({
    archived: true,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
    archivedBy: by || d.teacherId || null
  });

  return res.json({ success: true, message: 'Class archived.' });
}));

// === UNARCHIVE ===
router.patch('/api/classes/:id/unarchive', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const ref = firestore.collection('classes').doc(id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Class not found.' });

  const d = doc.data();
  if (d.archived !== true) return res.json({ success: true, already: true, message: 'Class is not archived.' });

  await ref.update({ archived: false, archivedAt: null, archivedBy: null });
  return res.json({ success: true, message: 'Class unarchived.' });
}));

// === DELETE ===
router.delete('/api/classes/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cascade = String(req.query.cascade || '').toLowerCase() === 'true';

  const classRef = firestore.collection('classes').doc(id);
  const snap = await classRef.get();
  if (!snap.exists) return res.status(404).json({ success: false, message: 'Class not found.' });

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

// === ROSTER: GET students ===
router.get('/api/classes/:id/students', asyncHandler(async (req, res) => {
  const classRef = firestore.collection('classes').doc(req.params.id);
  const classDoc = await classRef.get();
  if (!classDoc.exists) return res.status(404).json({ success: false, message: 'Class not found.' });

  const includeArchived = String(req.query.archived || '').toLowerCase() === 'include';
  if (classDoc.data().archived === true && !includeArchived) {
    return res.status(403).json({ success: false, message: 'Class is archived.' });
  }

  const rosterRef = classRef.collection('roster');
  const snap = await rosterRef.get();

  const base = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const students = await Promise.all(base.map(async (row) => {
    let active = !!row.active;
    let email = row.email || '';
    let fullName = row.fullName || '';
    let photoURL = row.photoURL || '';

    try {
      if (row.userId) {
        const uDoc = await firestore.collection('users').doc(row.userId).get();
        if (uDoc.exists) {
          const u = uDoc.data() || {};
          const names = decryptNamesFromUser(u);
          active = (u.active !== false);
          email = email || u.email || '';
          // ---------- FULL NAME FIRST ----------
          const candidate = names.fullName || `${names.firstName || ''} ${names.lastName || ''}`.trim();
          fullName = fullName || candidate || u.username || fullName || '';
          photoURL = photoURL || u.photoURL || '';
        }
      } else if (row.studentId) {
        const q = await firestore.collection('users')
          .where('studentId', '==', String(row.studentId))
          .limit(1)
          .get();
        if (!q.empty) {
          const u = q.docs[0].data() || {};
          const names = decryptNamesFromUser(u);
          active = (u.active !== false);
          email = email || u.email || '';
          const candidate = names.fullName || `${names.firstName || ''} ${names.lastName || ''}`.trim();
          fullName = fullName || candidate || u.username || fullName || '';
          photoURL = photoURL || u.photoURL || '';
        }
      }
    } catch {
      // keep fallbacks
    }

    return { ...row, active, email, fullName, photoURL };
  }));

  res.json({ success: true, students });
}));

// === ROSTER: POST single enroll ===
router.post('/api/classes/:id/students', asyncHandler(async (req, res) => {
  const classId = req.params.id;

  const classDoc = await firestore.collection('classes').doc(classId).get();
  if (!classDoc.exists) return res.status(404).json({ success: false, message: 'Class not found.' });
  if (classDoc.data().archived === true) {
    return res.status(403).json({ success: false, message: 'Class is archived; enrollments are disabled.' });
  }

  const { studentId } = req.body || {};
  if (!studentId) return res.status(400).json({ success: false, message: 'studentId is required.' });

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

// === ROSTER: BULK ENROLL ===
router.post('/api/classes/:id/students/bulk',
  uploadBulkMemory.single('file'),
  asyncHandler(async (req, res) => {
    const classId = req.params.id;

    const classDoc = await firestore.collection('classes').doc(classId).get();
    if (!classDoc.exists) return res.status(404).json({ success: false, message: 'Class not found.' });
    if (classDoc.data().archived === true) {
      return res.status(403).json({ success: false, message: 'Class is archived; bulk enrollment is disabled.' });
    }

    if (!req.file || !req.file.buffer || !req.file.originalname) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const preferredCol = String(req.body.column || 'studentId').trim().toLowerCase();

    let rows = [];
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    } catch {
      return res.status(400).json({ success: false, message: 'Failed to parse spreadsheet. Ensure it is a valid .xlsx, .xls, or .csv file.' });
    }

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
        console.error('Bulk enroll error for', sid, e);
        report.errors++; report.details.push({ studentId: sid, status: 'error', error: 'exception' });
      }
    }

    return res.status(200).json({ success: true, report });
  })
);

// === DELETE student from class ===
router.delete('/api/classes/:id/students/:studentId', asyncHandler(async (req, res) => {
  const classId = req.params.id;
  const studentId = req.params.studentId;

  const classRef = firestore.collection('classes').doc(classId);
  const classDoc = await classRef.get();
  if (!classDoc.exists) return res.status(404).json({ success: false, message: 'Class not found.' });
  if (classDoc.data().archived === true) {
    return res.status(403).json({ success: false, message: 'Class is archived; modifications are disabled.' });
  }

  await classRef.collection('roster').doc(studentId).delete();
  await classRef.update({ students: admin.firestore.FieldValue.increment(-1) });

  const userSnap = await firestore.collection('users').where('studentId', '==', studentId).limit(1).get();
  if (!userSnap.empty) {
    const userDocId = userSnap.docs[0].id;
    const enrollmentRef = firestore.collection('users').doc(userDocId).collection('enrollments').doc(classId);
    await enrollmentRef.delete().catch(() => {});
  }

  return res.json({ success: true });
}));

// === Student lookup ===
router.get('/api/students/lookup', asyncHandler(async (req, res) => {
  const { studentId } = req.query;
  if (!studentId || String(studentId).trim() === '') {
    return res.status(400).json({ success: false, message: 'studentId is required.' });
  }
  const snap = await firestore.collection('users').where('studentId', '==', String(studentId).trim()).limit(1).get();
  if (snap.empty) return res.json({ success: true, found: false });
  const u = snap.docs[0].data() || {};

  if (!isStudentUser(u)) return res.json({ success: true, found: false });

  const names = decryptNamesFromUser(u);

  return res.json({
    success: true,
    found: true,
    student: {
      studentId: u.studentId || '',
      firstName: names.firstName || '',
      middleName: names.middleName || '',
      lastName:  names.lastName  || '',
      fullName:  names.fullName  || '',   // optional extra
      email:     u.email || '',
      photoURL:  u.photoURL || ''
    }
  });
}));

// === Student search (returns fullName too) ===
router.get('/api/students/search', asyncHandler(async (req, res) => {
  const qRaw = String(req.query.query || '').trim();
  if (!qRaw) return res.status(400).json({ success: false, message: 'query is required.' });
  if (qRaw.length < 2) return res.json({ success: true, students: [] });

  const usersCol = firestore.collection('users');
  const qLower = qRaw.toLowerCase();

  const buildDecrypted = (u = {}) => {
    const names = decryptNamesFromUser(u);
    const studentId = u.studentId || '';
    // ensure first/last are set even if only fullName is known
    const first = names.firstName || splitFullName(names.fullName).first || '';
    const last  = names.lastName  || splitFullName(names.fullName).last  || '';
    return {
      studentId,
      firstName: first,
      middleName: names.middleName || '',
      lastName:  last,
      fullName:  names.fullName || `${first} ${last}`.trim(),
      email:     u.email || '',
      active:    u.active !== false
    };
  };

  const idLike =
    /^[A-Za-z]-?\d{4}-?\d{5}$/i.test(qRaw) ||
    /^S-\d{4}-\d{5}$/i.test(qRaw)        ||
    /^S\d+$/i.test(qRaw)                 ||
    /^\d{4}-\d{5}$/.test(qRaw);

  if (idLike) {
    try {
      const exactSnap = await usersCol.where('studentId', '==', qRaw).limit(1).get();
      if (!exactSnap.empty) {
        const u = exactSnap.docs[0].data() || {};
        if (isStudentUser(u)) {
          const stu = buildDecrypted(u);
          if (stu.studentId) return res.json({ success: true, students: [stu] });
        }
      }
    } catch {}
  }

  const LIMIT = 500;
  const snap = await usersCol.where('isStudent', '==', true).limit(LIMIT).get();

  const matches = [];
  for (const doc of snap.docs) {
    const u = doc.data() || {};
    if (!isStudentUser(u)) continue;
    if (!u.studentId || String(u.studentId).trim() === '') continue;

    const stu = buildDecrypted(u);
    const fn = String(stu.firstName || '').toLowerCase();
    const mn = String(stu.middleName || '').toLowerCase();
    const ln = String(stu.lastName  || '').toLowerCase();
    const full = String(stu.fullName || `${stu.firstName} ${stu.lastName}`).toLowerCase().trim();
    const em = String(stu.email || '').toLowerCase();
    const sid = String(stu.studentId || '').toLowerCase();

    if (sid.includes(qLower) || fn.includes(qLower) || mn.includes(qLower) || ln.includes(qLower) || full.includes(qLower) || em.includes(qLower)) {
      matches.push({
        studentId: stu.studentId,
        firstName: stu.firstName,
        lastName:  stu.lastName,
        fullName:  stu.fullName,
        email:     stu.email
      });
    }
  }

  return res.json({ success: true, students: matches.slice(0, 25) });
}));

// === STUDENT: GET ENROLLMENTS ===
router.get('/api/students/:userId/enrollments', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const includeTeacher = String(req.query.includeTeacher || '').toLowerCase() === 'true';

  const userRef = firestore.collection('users').doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return res.status(404).json({ success: false, message: 'Student not found.' });

  const snap = await userRef.collection('enrollments').get();
  let enrollments = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (includeTeacher) {
    const teacherIds = Array.from(new Set(enrollments.map(e => e.teacherId).filter(Boolean)));
    const teacherMap = {};
    await Promise.all(teacherIds.map(async tid => {
      try {
        const tdoc = await firestore.collection('users').doc(tid).get();
        if (tdoc.exists) {
          const t = tdoc.data() || {};
          const names = decryptNamesFromUser(t);
          const full = names.fullName || `${names.firstName || ''} ${names.lastName || ''}`.trim();
          teacherMap[tid] = full || t.username || 'Teacher';
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
