// ==== 1. IMPORTS & CONFIG ====
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const USERS_COL = 'users';
const XLSX = require('xlsx');
require('dotenv').config();

const app = express();
app.use(express.json());

app.use(cors({
   origin: ['http://127.0.0.1:5501', 'http://localhost:5501'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

// ==== 5. MULTER STORAGE CONFIG ====
const makeStorage = (folder) => multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = `./uploads/${folder}`;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const name = file.originalname.replace(/\s+/g, '_');
    cb(null, `${Date.now()}_${name}`);
  }
});

// Multer storage for modules
const moduleStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads', 'modules');
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitized = file.originalname.replace(/[^\w.\-]/g, '_');
    cb(null, `${timestamp}_${sanitized}`);
  }
});

// Configure multer with file size limits and error handling
const upload = multer({ 
  storage: moduleStorage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow common file types
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'image/jpeg',
      'image/png',
      'image/gif',
      'video/mp4',
      'video/webm',
      'video/ogg'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'), false);
    }
  }
});
const uploadQuiz = multer({ storage: makeStorage('quizzes') });
const uploadProfilePic = multer({ storage: makeStorage('profile_pics') });
const uploadBug = multer({ storage: makeStorage('bugs') });
const uploadProfile = multer({ storage: makeStorage('profiles') });
const uploadAssign = multer({ storage: makeStorage('assignments') });
const uploadSubmission = multer({ storage: makeStorage('assignment_submissions') });
const uploadBulk = multer({ storage: makeStorage('bulk_enrollments') });

// Test endpoint to verify server is working
app.get('/test', (req, res) => {
  res.json({ message: 'Server is running!' });
});

// Test file upload endpoint
app.post('/test-upload', upload.single('file'), (req, res) => {
  console.log("🧪 Test upload received");
  console.log("🧪 File:", req.file);
  console.log("🧪 Body:", req.body);
  
  res.json({ 
    success: true, 
    message: 'Test upload successful',
    file: req.file ? req.file.filename : null
  });
});

const verificationCodes = new Map();
const verificationStore = {};
const resetTokens = {};

const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const { v4: uuidv4 } = require('uuid');

// ---- Analytics helpers ----
async function chunkedQueryIn(colRef, field, values, size = 10) {
  const results = [];
  for (let i = 0; i < values.length; i += size) {
    const snap = await colRef.where(field, 'in', values.slice(i, i + size)).get();
    snap.forEach(d => results.push({ id: d.id, ...d.data() }));
  }
  return results;
}

const toMillis = (ts) => ts?.toMillis?.() ?? null;

async function buildTeacherAnalytics({ teacherId, classId = null, limitStudents = 500 }) {
  // 1) classes taught by teacher (optionally filtered)
  let clsQuery = firestore.collection('classes').where('teacherId', '==', teacherId).orderBy('createdAt', 'desc');
  const classesSnap = await clsQuery.get();
  let classes = classesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (classId) classes = classes.filter(c => c.id === classId);
  const classIds = classes.map(c => c.id);

  // 2) courses uploaded by teacher
  const coursesSnap = await firestore.collection('courses').where('uploadedBy', '==', teacherId).get();
  const courses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const courseIds = courses.map(c => c.id);
  const courseById = Object.fromEntries(courses.map(c => [c.id, c]));

  // map class -> courseIds assigned to that class
  const classToCourseIds = {};
  for (const c of courses) {
    (c.assignedClasses || []).forEach(cid => {
      if (classId && cid !== classId) return;
      (classToCourseIds[cid] ||= []).push(c.id);
    });
  }

  // 3) modules per course (for totals)
  const modulesByCourseId = {};
  for (let i = 0; i < courseIds.length; i += 10) {
    const snap = await firestore.collection('modules').where('courseId', 'in', courseIds.slice(i, i + 10)).get();
    snap.forEach(d => {
      const m = d.data();
      (modulesByCourseId[m.courseId] ||= []).push({ id: d.id, ...m });
    });
  }

  // 4) quizzes per course (for time-on-task & due)
  const quizzesByCourseId = {};
  for (let i = 0; i < courseIds.length; i += 10) {
    const snap = await firestore.collection('quizzes').where('courseId', 'in', courseIds.slice(i, i + 10)).get();
    snap.forEach(d => {
      const q = { id: d.id, ...d.data() };
      (quizzesByCourseId[q.courseId] ||= []).push(q);
    });
  }

  // 5) roster (studentId format like S-YYYY-xxxxx) and map to user docs
  const rosterByClass = {};
  let totalStudents = 0;
  for (const c of classes) {
    const rSnap = await firestore.collection('classes').doc(c.id).collection('roster').get();
    rosterByClass[c.id] = rSnap.docs.map(r => r.id);
    totalStudents += (typeof c.students === 'number' ? c.students : rSnap.size);
  }
  const rosterStudentIdsAll = Array.from(new Set(Object.values(rosterByClass).flat()));
  // map studentId -> user doc
  const studentIdToUser = {};
  for (let i = 0; i < rosterStudentIdsAll.length; i += 10) {
    const snap = await firestore.collection('users').where('studentId', 'in', rosterStudentIdsAll.slice(i, i + 10)).get();
    snap.forEach(d => {
      const u = d.data();
      if (u?.studentId) studentIdToUser[u.studentId] = { docId: d.id, data: u };
    });
  }

  // quick lookups
  const allStudents = rosterStudentIdsAll
    .map(sid => ({ sid, userDocId: studentIdToUser[sid]?.docId, user: studentIdToUser[sid]?.data }))
    .filter(u => !!u.userDocId)
    .slice(0, limitStudents);

  // 6) per-student metrics
  const studentsOut = [];
  let buckets = [0,0,0,0,0]; // 0-59,60-69,70-79,80-89,90-100
  const bump = (pct) => {
    if (pct == null || Number.isNaN(pct)) return;
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    if (v < 60) buckets[0]++; else
    if (v < 70) buckets[1]++; else
    if (v < 80) buckets[2]++; else
    if (v < 90) buckets[3]++; else buckets[4]++;
  };

  // cache completedModules counts per user across teacher's courses
  const allTeacherCourseIds = courseIds;
  for (const s of allStudents) {
    const u = s.user || {};
    const name = (u.fullName && u.fullName.trim()) ? u.fullName.trim()
                : `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || 'Student';

    // enrolled classes for the teacher (ids where roster contains this student)
    const myClassIds = classes.filter(c => (rosterByClass[c.id] || []).includes(s.sid)).map(c => c.id);

    // modulesTotal = sum of modules from teacher's courses assigned to the student's classes
    const myCourseIds = Array.from(new Set(myClassIds.flatMap(cid => classToCourseIds[cid] || [])));
    const modulesTotal = myCourseIds.reduce((acc, cid) => acc + (modulesByCourseId[cid]?.length || 0), 0);

    // completedModules for those courses
    let modulesCompleted = 0;
    if (myCourseIds.length) {
      for (let i = 0; i < myCourseIds.length; i += 10) {
        const snap = await firestore
          .collection('users').doc(s.userDocId)
          .collection('completedModules')
          .where('courseId', 'in', myCourseIds.slice(i, i + 10))
          .get();
        modulesCompleted += snap.size;
      }
    }

    // avgScore (prefer user.averageQuizScore, fallback to averageAssignmentGrade)
    const avgScore = (typeof u.averageQuizScore === 'number')
      ? u.averageQuizScore
      : (typeof u.averageAssignmentGrade === 'number' ? u.averageAssignmentGrade : 0);

    bump(avgScore);

    // timeOnTask: sum of timeTakenSeconds across attempts for teacher's quizzes (cap for performance)
    let secs = 0, cnt = 0;
    const myQuizIds = myCourseIds.flatMap(cid => (quizzesByCourseId[cid] || [])).map(q => q.id).slice(0, 12); // cap to 12 quizzes per student
    for (const qid of myQuizIds) {
      const attemptsSnap = await firestore
        .collection('users').doc(s.userDocId)
        .collection('quizAttempts').doc(qid)
        .collection('attempts')
        .get();
      attemptsSnap.forEach(a => {
        const t = a.data()?.timeTakenSeconds;
        if (typeof t === 'number' && t > 0) { secs += t; cnt += 1; }
      });
    }
    const timeOnTaskMin = Math.round((cnt ? secs / cnt : 0) / 60);

    // status rule
    const completionPct = modulesTotal ? Math.round((modulesCompleted / modulesTotal) * 100) : 0;
    const atRisk = avgScore < 75 || completionPct < 50;

    studentsOut.push({
      studentId: u.studentId || s.sid,
      userId: s.userDocId,
      name,
      avgScore,
      modulesCompleted,
      modulesTotal,
      timeOnTaskMin,
      status: atRisk ? 'At Risk' : 'On Track'
    });
  }

  // 7) summary
  const nonZeroScores = studentsOut.map(s => s.avgScore).filter(n => typeof n === 'number');
  const avgScoreOverall = nonZeroScores.length ? Math.round(nonZeroScores.reduce((a,b)=>a+b,0)/nonZeroScores.length) : 0;
  const totCompleted = studentsOut.reduce((a, s) => a + s.modulesCompleted, 0);
  const totAvailable = studentsOut.reduce((a, s) => a + s.modulesTotal, 0);
  const completionOverall = totAvailable ? Math.round((totCompleted / totAvailable) * 100) : 0;

  // 8) completion chart per class (percent with any completion in courses assigned to that class)
  const completionRateLabels = [];
  const completionRateData = [];
  for (const c of classes) {
    const roster = rosterByClass[c.id] || [];
    const myCourses = classToCourseIds[c.id] || [];
    let completedCount = 0;

    for (const sid of roster) {
      const udoc = studentIdToUser[sid];
      if (!udoc) continue;
      let has = false;
      for (let i = 0; i < myCourses.length; i += 10) {
        const snap = await firestore
          .collection('users').doc(udoc.docId)
          .collection('completedModules')
          .where('courseId', 'in', myCourses.slice(i, i + 10))
          .limit(1)
          .get();
        if (!snap.empty) { has = true; break; }
      }
      if (has) completedCount += 1;
    }
    completionRateLabels.push(c.name || `${c.gradeLevel || ''}${c.section ? '-' + c.section : ''}`.trim() || 'Class');
    completionRateData.push(roster.length ? Math.round((completedCount/roster.length)*100) : 0);
  }

  return {
    summary: { avgScore: avgScoreOverall, overallCompletion: completionOverall, totalStudents },
    charts: {
      gradeDistribution: { labels: ['0-59','60-69','70-79','80-89','90-100'], datasets: [{ label: 'Students', data: buckets }] },
      completionRate: { labels: completionRateLabels, datasets: [{ label: '% Completion', data: completionRateData }] }
    },
    students: studentsOut.sort((a,b)=>a.name.localeCompare(b.name))
  };
}


// ====== Idempotent enrollment helper (transaction) ======
async function enrollStudentIdempotent({ firestore, admin }, classId, studentId) {
  const sid = String(studentId).trim();

  const userSnap = await firestore.collection('users')
    .where('studentId', '==', sid)
    .limit(1)
    .get();
  if (userSnap.empty) return { ok: false, reason: 'not_found' };

  const userDoc = userSnap.docs[0];
  const u = userDoc.data();
  const userDocId = userDoc.id;

  const classRef = firestore.collection('classes').doc(classId);
  const classDoc = await classRef.get();
  if (!classDoc.exists) return { ok: false, reason: 'class_not_found' };
  const c = classDoc.data();

  const rosterRef = classRef.collection('roster').doc(sid);
  const enrollmentRef = firestore.collection('users').doc(userDocId)
    .collection('enrollments').doc(classId);

  let alreadyEnrolled = false;

  await firestore.runTransaction(async (tx) => {
    const rosterDoc = await tx.get(rosterRef);
    if (rosterDoc.exists) { alreadyEnrolled = true; return; }

    tx.set(rosterRef, {
      studentId: sid,
      fullName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      email: u.email || '',
      photoURL: u.photoURL || '',
      active: u.active !== false,
      enrolledAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    tx.update(classRef, { students: admin.firestore.FieldValue.increment(1) });

    tx.set(enrollmentRef, {
      classId,
      name: c.name || '',
      gradeLevel: c.gradeLevel || '',
      section: c.section || '',
      schoolYear: c.schoolYear || '',
      semester: c.semester || '',
      teacherId: c.teacherId || '',
      enrolledAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return { ok: true, alreadyEnrolled };
}
// ---------- Helpers ----------
function chunk(arr, size=10){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
function timeframeToStartMs(tf='all'){
  const now = Date.now();
  if (tf === 'week')  return now - 7*24*60*60*1000;
  if (tf === 'month') return now - 30*24*60*60*1000;
  return null; // all-time
}
async function getEnrollmentsClassIds(userId){
  const snap = await firestore.collection('users').doc(userId).collection('enrollments').get();
  return snap.docs.map(d => d.id);
}
async function getCoursesForClassIds(classIds){
  const out = [];
  const seen = new Set();
  for (const ids of chunk(classIds, 10)){
    const snap = await firestore.collection('courses')
      .where('assignedClasses','array-contains-any', ids)
      .get();
    snap.forEach(doc=>{
      if (!seen.has(doc.id)) { seen.add(doc.id); out.push({ id: doc.id, ...doc.data() }); }
    });
  }
  return out;
}
async function mapRosterIdsToUserIds(rosterIds){
  // rosterIds may be userId or studentId; resolve via your helper
  const results = [];
  await Promise.all(rosterIds.map(async rid=>{
    try {
      const ref = await getUserRefByAnyId(rid);
      if (ref) results.push(ref.id);
    } catch {}
  }));
  return Array.from(new Set(results));
}

// Compute points for a user with optional timeframe & course filter
// Rules (tweak as you like):
// - +10 per completed module
// - +bestPercent per quiz within timeframe (max attempt per quiz inside window)
// - +20 for each on-time assignment submission
async function computePointsForUser(userId, { startMs=null, courseFilterIds=null } = {}){
  const userRef = firestore.collection('users').doc(userId);
  const tMin = startMs ? admin.firestore.Timestamp.fromMillis(startMs) : null;
  const courseSet = courseFilterIds ? new Set(courseFilterIds) : null;

  let points = 0;

  // Modules completed
  try {
    let q = userRef.collection('completedModules');
    const snap = await q.get();
    snap.forEach(d=>{
      const x = d.data() || {};
      if (tMin && x.completedAt?.toMillis?.() < startMs) return;
      if (courseSet && x.courseId && !courseSet.has(x.courseId)) return;
      points += 10;
    });
  } catch {}

  // Quiz attempts: best percent per quiz inside timeframe
  try {
    const qaSnap = await userRef.collection('quizAttempts').get();
    const addPerQuiz = [];
    for (const qaDoc of qaSnap.docs){
      const meta = qaDoc.data() || {};
      if (courseSet && meta.courseId && !courseSet.has(meta.courseId)) continue;

      const attemptsSnap = await qaDoc.ref.collection('attempts').get();
      let best = null;
      attemptsSnap.forEach(at=>{
        const a = at.data() || {};
        const ts = a.submittedAt?.toMillis?.();
        if (tMin && (!ts || ts < startMs)) return;
        if (typeof a.percent === 'number') {
          best = (best == null) ? a.percent : Math.max(best, a.percent);
        }
      });
      if (typeof best === 'number') addPerQuiz.push(best); // add best per quiz
    }
    points += addPerQuiz.reduce((s,v)=>s+v,0);
  } catch {}

  // On-time assignment submissions (+20 each)
  try {
    // Need courseIds to check relevant assignments
    const courseIds = courseFilterIds
      ? courseFilterIds
      : (await getCoursesForClassIds(await getEnrollmentsClassIds(userId))).map(c=>c.id);

    for (const ids of chunk(courseIds, 10)){
      const aSnap = await firestore.collection('assignments')
        .where('courseId', 'in', ids)
        .orderBy('publishAt', 'desc')
        .limit(100) // guardrail
        .get();

      for (const doc of aSnap.docs){
        const a = doc.data() || {};
        const dueMs = a.dueAt?.toMillis?.() ?? null;

        // Filter by timeframe using submission time
        const subDoc = await firestore.collection('assignments').doc(doc.id)
          .collection('submissions').doc(userId).get();
        if (!subDoc.exists) continue;
        const s = subDoc.data() || {};
        const subMs = s.submittedAt?.toMillis?.();
        if (!subMs) continue;
        if (tMin && subMs < startMs) continue;

        if (dueMs && subMs <= dueMs) points += 20;
      }
    }
  } catch {}

  return points;
}

// Compute simple activity streak (consecutive days up to today with any activity)
async function computeStreakDays(userId){
  const userRef = firestore.collection('users').doc(userId);
  const days = new Set();

  const pushDay = (ms)=> {
    const d = new Date(ms);
    const key = d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
    days.add(key);
  };

  // completed modules
  try {
    const snap = await userRef.collection('completedModules').get();
    snap.forEach(d=>{
      const ms = d.data()?.completedAt?.toMillis?.();
      if (ms) pushDay(ms);
    });
  } catch {}

  // quiz attempts
  try {
    const qaSnap = await userRef.collection('quizAttempts').get();
    for (const r of qaSnap.docs){
      const atSnap = await r.ref.collection('attempts').get();
      atSnap.forEach(a=>{
        const ms = a.data()?.submittedAt?.toMillis?.();
        if (ms) pushDay(ms);
      });
    }
  } catch {}

  // assignment submissions
  try {
    // scan last 100 assignments across the student's courses
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    const courseIds = courses.map(c=>c.id);
    for (const ids of chunk(courseIds,10)){
      const aSnap = await firestore.collection('assignments')
        .where('courseId','in', ids)
        .orderBy('publishAt','desc')
        .limit(100)
        .get();
      for (const doc of aSnap.docs){
        const subDoc = await firestore.collection('assignments').doc(doc.id)
          .collection('submissions').doc(userId).get();
        if (subDoc.exists){
          const ms = subDoc.data()?.submittedAt?.toMillis?.();
          if (ms) pushDay(ms);
        }
      }
    }
  } catch {}

  // count consecutive days up to today
  let streak = 0;
  const today = new Date();
  today.setUTCHours(0,0,0,0);
  while (true) {
    const key = today.getUTCFullYear()+'-'+String(today.getUTCMonth()+1).padStart(2,'0')+'-'+String(today.getUTCDate()).padStart(2,'0');
    if (days.has(key)) {
      streak += 1;
      today.setUTCDate(today.getUTCDate()-1);
    } else {
      break;
    }
  }
  return streak;
}

// Reuse your badge logic (aligned with progress page)
async function computeBadges(userId){
  const userRef = firestore.collection('users').doc(userId);

  // Quiz Whiz: any best attempt >= 90%
  let quizWhiz = false;
  try {
    const qaSnap = await userRef.collection('quizAttempts').get();
    qaSnap.forEach(doc=>{
      const d = doc.data() || {};
      const best = typeof d.bestPercent === 'number'
        ? d.bestPercent
        : (d.bestScore?.percent ?? d.lastScore?.percent ?? 0);
      if (best >= 90) quizWhiz = true;
    });
  } catch {}

  // On-Time Achiever: at least 3 on-time assignment submissions
  let onTimeCount = 0;
  try {
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    const courseIds = courses.map(c=>c.id);
    for (const ids of chunk(courseIds,10)){
      const asSnap = await firestore.collection('assignments')
        .where('courseId','in', ids)
        .orderBy('publishAt','desc')
        .limit(100)
        .get();
      for (const aDoc of asSnap.docs){
        const a = aDoc.data() || {};
        const dueMs = a.dueAt?.toMillis?.() ?? null;
        const subDoc = await firestore.collection('assignments').doc(aDoc.id)
          .collection('submissions').doc(userId).get();
        if (subDoc.exists && dueMs){
          const sMs = subDoc.data()?.submittedAt?.toMillis?.();
          if (sMs && sMs <= dueMs) {
            onTimeCount++;
            if (onTimeCount >= 3) break;
          }
        }
      }
      if (onTimeCount >= 3) break;
    }
  } catch {}
  const onTimeAchiever = onTimeCount >= 3;

  // Module Master: overall completion >= 80% or >= 10 modules completed
  let totalModules = 0, completedModules = 0;
  try {
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    for (const c of courses){
      const [modSnap, doneSnap] = await Promise.all([
        firestore.collection('modules').where('courseId','==', c.id).get(),
        userRef.collection('completedModules').where('courseId','==', c.id).get()
      ]);
      totalModules += modSnap.size;
      completedModules += doneSnap.size;
    }
  } catch {}
  const overallPct = totalModules ? Math.round((completedModules/totalModules)*100) : 0;
  const moduleMaster = (overallPct >= 80) || (completedModules >= 10);

  const badges = [];
  if (onTimeAchiever) badges.push({ label:'On-Time Achiever', type:'success' });
  if (quizWhiz)       badges.push({ label:'Quiz Whiz',        type:'info' });
  if (moduleMaster)   badges.push({ label:'Module Master',    type:'warning' });
  return badges;
}


// ===== Helpers (skip if already defined earlier) =====
function chunk(arr, size=10){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
function ymd(d){ const z=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`; }
async function getEnrollmentsClassIds(userId){
  const snap = await firestore.collection('users').doc(userId).collection('enrollments').get();
  return snap.docs.map(d => d.id);
}
async function getCoursesForClassIds(classIds){
  const out = []; const seen = new Set();
  for (const ids of chunk(classIds, 10)){
    const snap = await firestore.collection('courses').where('assignedClasses','array-contains-any', ids).get();
    snap.forEach(doc=>{ if(!seen.has(doc.id)){ seen.add(doc.id); out.push({ id: doc.id, ...doc.data() }); } });
  }
  return out;
}
const courseTitleCache = new Map();
async function getCourseTitle(courseId){
  if (courseTitleCache.has(courseId)) return courseTitleCache.get(courseId);
  const d = await firestore.collection('courses').doc(courseId).get();
  const t = d.exists ? (d.data().title || 'Subject') : 'Subject';
  courseTitleCache.set(courseId, t);
  return t;
}


// ==== 2. FIREBASE INIT ====
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const firestore = admin.firestore();
const db = firestore;

// Resolve the *user document* by email (since doc IDs are UUIDs)
async function getUserRefByEmail(email) {
  const snap = await firestore.collection('users')
    .where('email', '==', email)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].ref;
}

async function getUserRefByAnyId(idOrStudentId) {
  if (!idOrStudentId) return null;

  // try direct doc id (userId)
  const directRef = firestore.collection('users').doc(idOrStudentId);
  const directSnap = await directRef.get();
  if (directSnap.exists) return directRef;

  // fall back to studentId lookup
  const q = await firestore.collection('users')
    .where('studentId', '==', idOrStudentId)
    .limit(1)
    .get();
  return q.empty ? null : q.docs[0].ref;
}

// ==== 3. EMAIL SETUP ====
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendVerificationEmail(email, code) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Your DigiPic Verification Code',
    text: `Your DigiPic verification code is: ${code}`,
  };

  await transporter.sendMail(mailOptions);
}

// ==== 4. STATIC FILE SERVING ====
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.webp')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// Atomic counter per role-year (e.g., counters/student-2025)
async function getNextSequence(role, year) {
  const docId = `${role}-${year}`;
  const counterRef = firestore.collection('counters').doc(docId);

  const nextVal = await firestore.runTransaction(async (t) => {
    const snap = await t.get(counterRef);
    const current = snap.exists ? (snap.data().value || 0) : 0;
    const updated = current + 1;
    t.set(counterRef, { value: updated, year }, { merge: true });
    return updated;
  });

  return nextVal;
}

// Build "S-YYYY-00001" or "T-YYYY-00001"
async function generateRoleId(role) {
  const year = new Date().getFullYear();
  const seq = await getNextSequence(role, year);
  const prefix = role === 'student' ? 'S' : role === 'teacher' ? 'T' : 'U';
  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

function parseDueAtToTimestamp(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  if (isNaN(d.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(d);
}

function normalizeAttemptsAllowed(v) {
  // Accept string or number.
  // 0 / '' / null => unlimited (store null)
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error('attemptsAllowed must be an integer ≥ 0');
  return n === 0 ? null : n;
}


// ==== AUTH: SIGNUP ====
app.post('/signup', async (req, res) => {
  try {
    const {
      firstName, middleName, lastName, username, email, password,
      isITsupport, isUser, isAdmin, isMobile, isTeacher, isStudent
    } = req.body;

    if (!firstName || !lastName || !username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Check if email or username already exists
    const emailSnapshot = await firestore.collection('users').where('email', '==', email).get();
    if (!emailSnapshot.empty) {
      return res.status(400).json({ error: 'Email already registered.' });
    }

    const usernameSnapshot = await firestore.collection('users').where('username', '==', username).get();
    if (!usernameSnapshot.empty) {
      return res.status(400).json({ error: 'Username already taken.' });
    }

    // === NEW: Generate role-based IDs (S-YYYY-xxxxx / T-YYYY-xxxxx) ===
    let studentId = null;
    let teacherId = null;

    if (isStudent) {
      studentId = await generateRoleId('student');
    }
    if (isTeacher) {
      teacherId = await generateRoleId('teacher');
    }

    const userId = uuidv4();
    const code = generateCode();

    // Keep pending user data in memory until they verify the code
    verificationStore[email] = {
      code,
      expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes
      userData: {
        userId,
        firstName,
        middleName,
        lastName,
        username,
        email,
        password,           // NOTE: hash this BEFORE writing to Firestore in your verification step
        active: true,
        isITsupport: !!isITsupport,
        isUser: isUser !== false,
        isAdmin: !!isAdmin,
        isMobile: !!isMobile,
        isTeacher: !!isTeacher,
        isStudent: !!isStudent,

        // Attach IDs so they get persisted after verification
        ...(studentId ? { studentId } : {}),
        ...(teacherId ? { teacherId } : {}),
        createdAt: new Date().toISOString(),
      },
    };

    await sendVerificationEmail(email, code);

    // Return the IDs so the frontend can show them right away
    res.json({
      message: 'Verification code sent to your email.',
      ...(studentId ? { studentId } : {}),
      ...(teacherId ? { teacherId } : {}),
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error during signup.' });
  }
});


// ==== VERIFY SIGNUP CODE ====
app.post('/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body;

    const record = verificationStore[email];
    if (!record) return res.status(400).json({ error: 'No verification code found.' });
    if (Date.now() > record.expiresAt) {
      delete verificationStore[email];
      return res.status(400).json({ error: 'Verification code expired.' });
    }
    if (record.code !== code) return res.status(400).json({ error: 'Incorrect verification code.' });

    const { userData } = record;
    const hashedPassword = await bcrypt.hash(userData.password, 10);

    delete userData.password;
    const userToStore = {
      ...userData,
      password: hashedPassword,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await firestore.collection('users').doc(userData.userId).set({ ...userToStore, email: userData.email, userId: userData.userId });
    delete verificationStore[email];

    res.json({ message: 'User verified and registered successfully.' });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Failed to verify and register user.' });
  }
});

// ==== RESEND VERIFICATION CODE ====
app.post('/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !verificationStore[email]) {
      return res.status(400).json({ error: 'No pending verification found for this email.' });
    }

    const code = generateCode();
    verificationStore[email].code = code;
    verificationStore[email].expiresAt = Date.now() + 15 * 60 * 1000;

    await sendVerificationEmail(email, code);
    res.json({ message: 'Verification code resent.' });
  } catch (err) {
    console.error('Resend code error:', err);
    res.status(500).json({ error: 'Failed to resend code.' });
  }
});

// GET /check-email?email=foo@bar.com
app.get('/check-email', async (req, res) => {
  const { email } = req.query;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  try {
    // since you key users by email (doc ID), just fetch that doc:
  const snapshot = await firestore.collection('users').where('email', '==', email).get();
  return res.json({ taken: !snapshot.empty });
  } catch (err) {
    console.error('Error checking email uniqueness:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /check-username?username=foo
app.get('/check-username', async (req, res) => {
  const { username } = req.query;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  try {
  const snapshot = await firestore.collection('users').where('username', '==', username).get();
  return res.json({ taken: !snapshot.empty });
  } catch (err) {
    console.error('Error checking username uniqueness:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


// ==== LOGIN ====
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

    const snapshot = await firestore.collection('users').where('username', '==', username).limit(1).get();
    if (snapshot.empty) return res.status(401).json({ error: 'Invalid username or password.' });

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();

    const passwordMatch = await bcrypt.compare(password, userData.password);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid username or password.' });
    if (userData.active === false) return res.status(403).json({ error: 'Account is deactivated. Please contact admin.' });

    res.json({
      message: 'Login successful!',
      user: {
        userId: userData.userId,
        username: userData.username,
        email: userData.email,
        fullName: `${userData.firstName} ${userData.lastName}`,
        isAdmin: !!userData.isAdmin,
        isITsupport: !!userData.isITsupport,
        isUser: !!userData.isUser,
        isTeacher: !!userData.isTeacher,
        isStudent: !!userData.isStudent,
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

// ==== PASSWORD RESET VIA LINK ====
app.post('/request-reset', async (req, res) => {
  const { email } = req.body;
  const usersRef = db.collection('users');
  const userQuery = await usersRef.where('email', '==', email).get();

  if (userQuery.empty) {
    return res.status(404).json({ message: 'User not found' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 15 * 60 * 1000;

  resetTokens[email] = { token, expires };

  const resetLink = `http://your-app/reset-password.html?email=${email}&token=${token}`;

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Password Reset',
    html: `<p>Click <a href="${resetLink}">here</a> to reset your password. Link expires in 15 minutes.</p>`
  });

  res.json({ message: 'Reset link sent' });
});

// ==== SEND RESET CODE (MOBILE VERSION) ====
app.post('/send-reset-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('email', '==', email).get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'No user found with that email' });
    }

    const code = generateCode();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    verificationCodes.set(email, { code, expiresAt });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'DigiPic Password Reset Code',
      text: `Your DigiPic verification code is: ${code}. It expires in 5 minutes.`
    });

    res.json({ success: true, message: 'Verification code sent' });
  } catch (err) {
    console.error('Error sending verification code:', err);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

// ==== VERIFY RESET CODE (MOBILE) ====
app.post('/verify-reset-code', async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const stored = verificationCodes.get(email);
  if (!stored || stored.code !== code || stored.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  try {
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('email', '==', email).get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userDoc = snapshot.docs[0];
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await usersRef.doc(userDoc.id).update({ password: hashedPassword });
    verificationCodes.delete(email);

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('Error resetting password:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ==== VERIFY RESET CODE (WEB VERSION) ====
app.post('/web-verify-reset', async (req, res) => {
  const { email, code, newPassword } = req.body;

  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const stored = verificationCodes.get(email);
  if (!stored || stored.code !== code || stored.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired code.' });
  }

  try {
    const snapshot = await firestore.collection('users').where('email', '==', email).get();
    if (snapshot.empty) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const userDoc = snapshot.docs[0];
    const userId = userDoc.id;
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await firestore.collection('users').doc(userId).update({ password: hashedPassword });
    verificationCodes.delete(email);

    console.log(`✅ Password updated for: ${email}`);
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    console.error('🔥 Web reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// ==== COURSE: CREATE ====
// ==== COURSE: CREATE ====
app.post("/upload-course", async (req, res) => {
  try {
    const { title, category, description, uploadedBy } = req.body;
    // NEW: accept assignedClasses array
    let { assignedClasses } = req.body;

    if (!title || !category || !description || !uploadedBy) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // normalize assignedClasses
    if (!Array.isArray(assignedClasses)) assignedClasses = [];
    assignedClasses = assignedClasses
      .filter(x => typeof x === 'string' && x.trim() !== '')
      .map(x => x.trim());

    // get next course number
    const snapshot = await firestore.collection("courses").orderBy("courseNumber", "desc").limit(1).get();
    let nextCourseNumber = 1;
    if (!snapshot.empty) {
      const lastCourse = snapshot.docs[0].data();
      nextCourseNumber = (lastCourse.courseNumber || 0) + 1;
    }

    const newCourse = {
      title,
      category,
      description,
      uploadedBy,                 // keep as provided (but see frontend change below)
      assignedClasses,            // ✅ store it!
      courseNumber: nextCourseNumber,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const newDoc = await firestore.collection("courses").add(newCourse);
    return res.status(200).json({
      success: true,
      id: newDoc.id,
      courseNumber: nextCourseNumber,
      assignedClasses
    });
  } catch (error) {
    console.error("🔥 Upload course error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


// ==== COURSES: LIST (optionally filter by uploadedBy) ====
app.get('/courses', async (req, res) => {
  try {
    const uploadedBy = String(req.query.uploadedBy || '').trim();

    // Build query
    let q = firestore.collection('courses');
    if (uploadedBy) q = q.where('uploadedBy', '==', uploadedBy);
    q = q.orderBy('createdAt', 'desc');

    let snapshot;
    try {
      snapshot = await q.get();
    } catch (err) {
      // If there's a composite index error (common when mixing where + orderBy),
      // fall back to the same query without ordering so we still return data.
      console.warn('GET /courses fallback (likely index needed):', err?.message || err);
      if (uploadedBy) {
        snapshot = await firestore
          .collection('courses')
          .where('uploadedBy', '==', uploadedBy)
          .get();
      } else {
        snapshot = await firestore.collection('courses').get();
      }
    }

    const courses = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title,
        category: data.category,
        description: data.description || '',
        courseNumber: data.courseNumber || null,
        // (optional) include for debugging/filter checks:
        // uploadedBy: data.uploadedBy || null,
        // createdAt: data.createdAt || null,
      };
    });

    res.json(courses);
  } catch (err) {
    console.error('🔥 Error fetching courses:', err);
    res.status(500).json({ error: 'Failed to fetch courses.' });
  }
});

// ==== COURSE: GET BY ID ====
app.get('/courses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await firestore.collection('courses').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Course not found.' });

    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    console.error("🔥 Error fetching course:", err);
    res.status(500).json({ error: 'Failed to fetch course.' });
  }
});

// ==== COURSE: UPDATE ====
app.put('/courses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, description, assignedClasses } = req.body;

    if (!title || !category) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // Build update object
    const updateData = { title, category, description };
    if (Array.isArray(assignedClasses)) {
      updateData.assignedClasses = assignedClasses;
    }

    await firestore.collection("courses").doc(id).update(updateData);
    res.json({ success: true });
  } catch (err) {
    console.error("🔥 Update course error:", err);
    res.status(500).json({ success: false, message: "Failed to update course" });
  }
});

app.delete('/courses/:id', async (req, res) => {
  const courseId = req.params.id;

  try {
    // Step 1: Delete the course document
    const courseRef = firestore.collection('courses').doc(courseId);
    const courseDoc = await courseRef.get();

    if (!courseDoc.exists) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    await courseRef.delete();

    // Step 2: Delete all modules under this course
    const modulesRef = firestore.collection('modules').where('courseId', '==', courseId);
    const modulesSnapshot = await modulesRef.get();

    const batch = firestore.batch();
    modulesSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    // Step 3: Re-number remaining courses
    const allCoursesSnapshot = await firestore.collection('courses').orderBy('createdAt').get();
    let courseNumber = 1;
    const renumberBatch = firestore.batch();
    allCoursesSnapshot.forEach(doc => {
      renumberBatch.update(doc.ref, { courseNumber });
      courseNumber++;
    });
    await renumberBatch.commit();

    res.json({ success: true, message: 'Course and associated modules deleted. Courses renumbered.' });

  } catch (err) {
    console.error('Error deleting course and modules:', err);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});


// ==== MODULE: UPLOAD ====
// Always use upload.array for attachments, fallback to single file if needed
app.post('/upload-module', (req, res, next) => {
  // Use upload.array for 'attachmentFiles', fallback to upload.single for legacy 'moduleFile'
  const multi = upload.array('attachmentFiles');
  const single = upload.single('moduleFile');
  multi(req, res, function (err) {
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
      // Try single file fallback
      return single(req, res, next);
    } else if (err) {
      return next(err);
    }
    next();
  });
}, async (req, res) => {
  const startTime = Date.now();
  console.log("🔍 Upload request received at:", new Date().toISOString());
  console.log("🔍 Request body:", req.body);
  console.log("🔍 Request files:", req.files);

  try {
    const { moduleTitle, moduleType, description, courseId } = req.body;
    // Accept videoUrls as array for text modules
    let videoUrls = req.body.videoUrls;
    if (videoUrls && !Array.isArray(videoUrls)) {
      videoUrls = [videoUrls];
    }
    // Always use req.files for attachments, fallback to req.file for legacy single upload
    let files = req.files;
    if ((!files || files.length === 0) && req.file) {
      files = [req.file];
    }

    // For multiple descriptions, req.body.attachmentDescs can be a string or array
    let attachmentDescs = req.body.attachmentDescs;
    if (attachmentDescs && !Array.isArray(attachmentDescs)) {
      attachmentDescs = [attachmentDescs];
    }

    console.log("📥 Incoming module upload:");
    console.log("🔸 Body:", req.body);
    console.log("🔸 Module Type:", moduleType);
    if (files && files.length) console.log("📎 Files:", files.map(f => f.filename));
    if (videoUrls && videoUrls.length) console.log("🔗 Attachment URLs:", videoUrls);

    // Validation
    if (!moduleTitle || !moduleType || !courseId) {
      console.log("❌ Missing required fields");
      return res.status(400).json({
        success: false,
        message: 'Missing required fields (title/type/course).'
      });
    }

    // For file type, at least one file is required
    if (moduleType === 'file' && (!files || files.length === 0)) {
      console.log("❌ At least one attachment file required");
      return res.status(400).json({
        success: false,
        message: 'At least one attachment file is required.'
      });
    }

    // For text type, at least one non-empty URL is required
    if (moduleType === 'text') {
      if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length === 0 || videoUrls.every(url => !url || url.trim() === '')) {
        console.log("❌ At least one video URL required for text type");
        return res.status(400).json({
          success: false,
          message: 'At least one video URL is required for text type module.'
        });
      }
    }

    // Determine next module number
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

    // Build module data
    // Collect sub titles and descriptions (arrays)
    let moduleSubTitles = req.body.moduleSubTitles || [];
    let moduleSubDescs = req.body.moduleSubDescs || [];
    if (typeof moduleSubTitles === 'string') moduleSubTitles = [moduleSubTitles];
    if (typeof moduleSubDescs === 'string') moduleSubDescs = [moduleSubDescs];

    const moduleData = {
      title: moduleTitle,
      type: moduleType,
      courseId,
      // description: description || '', // already removed from frontend
      moduleNumber: nextModuleNumber,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      moduleSubTitles,
      moduleSubDescs
    };

    // Attachments for file type
    if (moduleType === 'file' && files && files.length > 0) {
      // Store attachments as a flat array with lessonIdx property
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
        if (!isNaN(idx) && idx >= 0 && idx < lessonCount) {
          flatAttachments.push({
            filePath: `/uploads/modules/${file.filename}`,
            description: (attachmentDescs && attachmentDescs[i]) ? attachmentDescs[i] : '',
            lessonIdx: idx
          });
        }
      });
      moduleData.attachments = flatAttachments;
    }

    // For text type, store each video URL as an attachment with lessonIdx
    if (moduleType === 'text' && videoUrls && Array.isArray(videoUrls)) {
      // Also get videoDesc[] from body
      let videoDescs = req.body.videoDesc || req.body['videoDesc[]'] || req.body['videoDescs'] || [];
      if (typeof videoDescs === 'string') videoDescs = [videoDescs];
      moduleData.attachments = videoUrls
        .map((url, idx) => {
          if (url && url.trim()) {
            return {
              url: url.trim(),
              videoDesc: videoDescs && videoDescs[idx] ? videoDescs[idx] : '',
              lessonIdx: idx
            };
          }
          return null;
        })
        .filter(Boolean);
    }

    // Additional validation: ensure we have the required data for each type
    if (moduleType === 'file' && (!moduleData.attachments || moduleData.attachments.length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'File upload failed. Please try again.'
      });
    }

    if (moduleType === 'text' && (!moduleData.attachments || moduleData.attachments.length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'URL upload failed. Please provide at least one valid video URL.'
      });
    }

    console.log("✅ Module data prepared:", moduleData);

    // Save to Firestore
    console.log("💾 Saving to Firestore...");
    await firestore.collection('modules').add(moduleData);

    const processingTime = Date.now() - startTime;
    console.log("✅ Module uploaded and saved in", processingTime, "ms");
    console.log("📤 Sending success response...");
    
    const responseData = {
      success: true,
      message: 'Module uploaded successfully.',
      moduleNumber: nextModuleNumber,
      processingTime: processingTime
    };
    
    console.log("📤 Response data:", responseData);
    res.status(200).setHeader('Content-Type', 'application/json').json(responseData);
    console.log("📤 Response sent successfully at:", new Date().toISOString());

  } catch (err) {
    const processingTime = Date.now() - startTime;
    console.error('🔥 Module Upload Error after', processingTime, 'ms:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to upload module.',
      error: err.message
    });
  }
});

// Error handling middleware for multer errors
app.use((error, req, res, next) => {
  console.log("🔍 Error middleware triggered:", error);
  
  if (error instanceof multer.MulterError) {
    console.log("🚨 Multer error detected:", error.code, error.message);
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 50MB.'
      });
    }
    return res.status(400).json({
      success: false,
      message: 'File upload error: ' + error.message
    });
  }
  
  if (error && error.message === 'File type not allowed') {
    console.log("🚨 File type error detected");
    return res.status(400).json({
      success: false,
      message: 'File type not allowed. Please upload a supported file type.'
    });
  }
  
  // For any other errors
  console.error("🚨 General error:", error);
  res.status(500).json({
    success: false,
    message: 'Internal server error: ' + error.message
  });
});

// ==== MODULE: GET ALL FOR COURSE ====
app.get('/modules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await firestore.collection('modules').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Module not found.' });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    console.error('🔥 Error fetching module:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch module.' });
  }
});
// Existing endpoint for all modules in a course
app.get('/courses/:id/modules', async (req, res) => {
  try {
    const { id } = req.params;
    const snapshot = await firestore
      .collection('modules')
      .where('courseId', '==', id)
      .orderBy('moduleNumber', 'desc')   // ← sort by moduleNumber DESC
      .get();

    const modules = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return res.json(modules);
  } catch (err) {
    console.error("🔥 Error fetching modules:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch modules." });
  }
});

// ==== MODULE: UPDATE ====
app.put('/modules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, moduleSubTitles, moduleSubDescs } = req.body;

    if (!title || !description) {
      return res.status(400).json({ success: false, message: 'Title and description are required.' });
    }

    const moduleDoc = await firestore.collection('modules').doc(id).get();
    if (!moduleDoc.exists) {
      return res.status(404).json({ success: false, message: 'Module not found.' });
    }

    // Build update object
    const updateObj = {
      title,
      description,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (Array.isArray(moduleSubTitles)) updateObj.moduleSubTitles = moduleSubTitles;
    if (Array.isArray(moduleSubDescs)) updateObj.moduleSubDescs = moduleSubDescs;

    await firestore.collection('modules').doc(id).update(updateObj);

    res.json({ success: true, message: 'Module updated successfully.' });
  } catch (err) {
    console.error('🔥 Update module error:', err);
    res.status(500).json({ success: false, message: 'Failed to update module.' });
  }
});
// ==== MODULE: DELETE & RENUMBER ====
app.delete('/modules/:id', async (req, res) => {
  const moduleId = req.params.id;

  try {
    // Step 1: Get the module to find its courseId
    const moduleRef = firestore.collection('modules').doc(moduleId);
    const moduleDoc = await moduleRef.get();

    if (!moduleDoc.exists) {
      return res.status(404).json({ success: false, message: 'Module not found.' });
    }

    const { courseId } = moduleDoc.data();

    // Step 2: Delete the module
    await moduleRef.delete();

    // Step 3: Re-number remaining modules for this course (by moduleNumber ascending)
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
  } catch (err) {
    console.error('Error deleting module and renumbering:', err);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// ===== 3) HEALTH CHECK =====
app.get('/test', (req, res) => {
  res.json({ message: 'Quiz server up!' });
});

// ==== QUIZ: UPLOAD ====
app.post('/upload-quiz', async (req, res) => {
  try {
    const { courseId, moduleId, quiz, settings, title, description, dueAt, attemptsAllowed } = req.body;

    if (!courseId || !moduleId || !Array.isArray(quiz) || quiz.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing required fields or empty quiz array.' });
    }
    if (!title || String(title).trim() === '') {
      return res.status(400).json({ success: false, message: 'Quiz title is required.' });
    }

    let attempts = null;
    try { attempts = normalizeAttemptsAllowed(attemptsAllowed); }
    catch (e) { return res.status(400).json({ success:false, message:e.message }); }

    let normalizedSettings = { timerEnabled:false };
    if (settings && typeof settings === 'object') {
      if (settings.timerEnabled === true) {
        const mins = parseInt(settings.durationMinutes,10);
        const grace = settings.graceSeconds != null ? parseInt(settings.graceSeconds,10) : 0;
        if (!Number.isInteger(mins) || mins < 1) return res.status(400).json({ success:false, message:'Invalid durationMinutes (minimum 1).' });
        if (!Number.isInteger(grace) || grace < 0) return res.status(400).json({ success:false, message:'Invalid graceSeconds (>= 0).' });
        normalizedSettings = {
          timerEnabled:true,
          durationMinutes:mins,
          graceSeconds:grace,
          durationMs: mins*60*1000,
          graceMs: grace*1000
        };
      }
    }

    const dueAtTs = parseDueAtToTimestamp(dueAt);

    const validQuestions = quiz
      .filter(q=> q && q.question && q.choices && q.correct)
      .map(q=>({
        question:String(q.question),
        choices:q.choices,
        correctAnswer:q.correct,
        imageUrl:null
      }));
    if (!validQuestions.length) return res.status(400).json({ success:false, message:'No valid quiz questions provided.' });

    const quizRef = firestore.collection('quizzes').doc();
    const batch = firestore.batch();

    batch.set(quizRef, {
      title: String(title).trim(),
      description: description ? String(description).trim() : '',
      courseId, moduleId,
      totalQuestions: validQuestions.length,
      settings: normalizedSettings,
      attemptsAllowed: attempts, // null for unlimited
      dueAt: dueAtTs,            // Timestamp or null
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    validQuestions.forEach(q=> batch.set(quizRef.collection('questions').doc(), q));

    await batch.commit();
    res.json({ success:true, message:'Quiz uploaded successfully.', quizId: quizRef.id });
  } catch (err) {
    console.error('🔥 Quiz Upload Error:', err);
    res.status(500).json({ success:false, message:'Failed to upload quiz.' });
  }
});

// ==== QUIZ: GET ALL ====
app.get('/quizzes', async (req, res) => {
  try {
    const snapshot = await firestore.collection('quizzes').orderBy('createdAt','desc').get();
    const quizzes = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
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
        totalQuestions: data.totalQuestions ?? qs.size,
        settings: data.settings || { timerEnabled:false },
        questions: qs.docs.map(d=>d.data())
      });
    }
    res.json({ success:true, quizzes });
  } catch (err) {
    console.error('🔥 Error fetching quizzes:', err);
    res.status(500).json({ success:false, message:'Failed to fetch quizzes.' });
  }
});

// ==== QUIZ: GET ONE ====
app.get('/quizzes/:quizId', async (req, res) => {
  try {
    const quizRef = firestore.collection('quizzes').doc(req.params.quizId);
    const snap = await quizRef.get();
    if (!snap.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });
    const d = snap.data();
    const qs = await quizRef.collection('questions').get();
    return res.json({ success: true, quiz: {
      id: snap.id,
      title: d.title || '',
      description: d.description || '',
      dueAt: d.dueAt || null,
      attemptsAllowed: d.attemptsAllowed ?? null,
      courseId: d.courseId,
      moduleId: d.moduleId,
      createdAt: d.createdAt,
      totalQuestions: d.totalQuestions ?? qs.size,
      settings: d.settings || { timerEnabled: false },
      questions: qs.docs.map(dd => ({ id: dd.id, ...dd.data() }))
    }});
  } catch (err) {
    console.error('🔥 Error fetching quiz by id:', err);
    res.status(500).json({ success:false, message:'Failed to fetch quiz.' });
  }
});

// ==== QUIZ: UPDATE ====
app.put('/quizzes/:quizId', async (req, res) => {
  try {
    const { questions, settings, title, description, dueAt, attemptsAllowed } = req.body;
    if (!Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ success:false, message:'Invalid or empty question list.' });
    }

    const quizRef = firestore.collection('quizzes').doc(req.params.quizId);
    const doc = await quizRef.get();
    if (!doc.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });

    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (settings && typeof settings === 'object'){
      if (settings.timerEnabled === true){
        const mins = parseInt(settings.durationMinutes,10);
        const grace = settings.graceSeconds != null ? parseInt(settings.graceSeconds,10) : 0;
        if (!Number.isInteger(mins) || mins < 1)  return res.status(400).json({ success:false, message:'Invalid durationMinutes (minimum 1).' });
        if (!Number.isInteger(grace) || grace < 0) return res.status(400).json({ success:false, message:'Invalid graceSeconds (>= 0).' });
        updates.settings = {
          timerEnabled:true,
          durationMinutes:mins,
          graceSeconds:grace,
          durationMs: mins*60*1000,
          graceMs: grace*1000
        };
      } else updates.settings = { timerEnabled:false };
    }

    if (title !== undefined)       updates.title = String(title||'').trim();
    if (description !== undefined) updates.description = String(description||'').trim();
    if (dueAt !== undefined)       updates.dueAt = parseDueAtToTimestamp(dueAt);
    if (attemptsAllowed !== undefined) {
      try { updates.attemptsAllowed = normalizeAttemptsAllowed(attemptsAllowed); }
      catch (e) { return res.status(400).json({ success:false, message:e.message }); }
    }

    // Replace questions
    const existing = await quizRef.collection('questions').get();
    const delBatch = firestore.batch();
    existing.forEach(d=>delBatch.delete(d.ref));
    await delBatch.commit();

    const batch = firestore.batch();
    questions.forEach(q=>{
      batch.set(quizRef.collection('questions').doc(), {
        question: q.question,
        choices: q.choices,
        correctAnswer: q.correct,
        imageUrl: q.imageUrl ?? null
      });
    });
    updates.totalQuestions = questions.length;
    batch.set(quizRef, updates, { merge:true });

    await batch.commit();
    res.json({ success:true, message:'Quiz updated successfully.' });
  } catch (err) {
    console.error('🔥 Edit quiz error:', err);
    res.status(500).json({ success:false, message:'Failed to update quiz.' });
  }
});

// ==== QUIZ: DELETE ====
app.delete('/quizzes/:quizId', async (req, res) => {
  try {
    const quizRef = firestore.collection('quizzes').doc(req.params.quizId);
    const snap = await quizRef.get();
    if (!snap.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });
    const qs = await quizRef.collection('questions').get();
    const batch = firestore.batch();
    qs.forEach(d=>batch.delete(d.ref));
    batch.delete(quizRef);
    await batch.commit();
    res.json({ success:true, message:'Quiz deleted.' });
  } catch (err) {
    console.error('🔥 delete quiz error:', err);
    res.status(500).json({ success:false, message:'Failed to delete quiz.' });
  }
});

// ==== QUIZ: SUBMIT SCORE + ENFORCE ATTEMPTS ====
// ==== QUIZ: SUBMIT SCORE + ENFORCE ATTEMPTS (user-centric) ====
app.post('/submit-quiz-score', async (req, res) => {
  try {
    const {
      email,           // required
      quizId,          // required
      score,           // required number
      total,           // required number
      moduleId,        // optional (fallback from quiz)
      courseId,        // optional (fallback from quiz)
      reason,          // "manual" | "timeout"
      timeTakenSeconds,// optional
      answers          // optional (store only if you truly need it)
    } = req.body || {};

    if (!email || !quizId || typeof score !== 'number' || typeof total !== 'number') {
      return res.status(400).json({ success:false, message:'Missing or invalid fields.' });
    }

    // Find the *user doc* by email (your user doc IDs are UUIDs)
    const userRef = await getUserRefByEmail(email);
    if (!userRef) return res.status(404).json({ success:false, message:'User not found.' });

    // Load quiz for attempts + defaults
    const qRef = firestore.collection('quizzes').doc(quizId);
    const qDoc = await qRef.get();
    if (!qDoc.exists) return res.status(404).json({ success:false, message:'Quiz not found.' });

    const qData = qDoc.data() || {};
    // Treat 0 as unlimited
    const rawAllowed = qData.attemptsAllowed ?? null;
    const attemptsAllowed = rawAllowed === 0 ? null : rawAllowed;

    const resolvedCourseId = courseId || qData.courseId || null;
    const resolvedModuleId = moduleId || qData.moduleId || null;

    // Store attempts under the user:
    // users/{userId}/quizAttempts/{quizId}/attempts/{autoId}
    const attemptRoot = userRef.collection('quizAttempts').doc(quizId);
    const attemptsCol = attemptRoot.collection('attempts');

    // Enforce attempts
    const attemptsSnap = await attemptsCol.get();
    const used = attemptsSnap.size;
    if (attemptsAllowed !== null && used >= attemptsAllowed) {
      return res.status(403).json({
        success:false,
        message:`Attempt limit reached (${attemptsAllowed}).`,
        attempts:{ used, allowed:attemptsAllowed, left:0 }
      });
    }

    const percent = total ? Math.round((score / total) * 100) : 0;

    // Record this attempt
    const attemptDoc = await attemptsCol.add({
      score, total, percent,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      reason: reason || 'manual',
      timeTakenSeconds: timeTakenSeconds ?? null,
      // answers: answers ?? null, // <- keep only if you really need to store answers
    });

    // Summarize attempts + optionally mark module complete (pass threshold default 60%)
    const passingPercent = qData.passingPercent ?? 60;

    await firestore.runTransaction(async (tx) => {
      // Re-read all attempts inside txn for a correct count/best
      const all = await attemptsCol.get();
      let cnt = 0;
      let bestPercent = 0;
      all.forEach(d => {
        cnt++;
        const a = d.data();
        if (typeof a.percent === 'number' && a.percent > bestPercent) bestPercent = a.percent;
      });

      tx.set(
        attemptRoot,
        {
          quizId,
          courseId: resolvedCourseId,
          moduleId: resolvedModuleId,
          attemptsUsed: cnt,
          attemptsAllowed,
          lastScore: { score, total, percent },
          bestPercent,
          lastSubmittedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      // If passed, mark completedModules (idempotent)
      if (resolvedModuleId && percent >= passingPercent) {
        const cmRef = userRef.collection('completedModules').doc(resolvedModuleId);
        tx.set(
          cmRef,
          {
            moduleId: resolvedModuleId,
            courseId: resolvedCourseId,
            quizId,
            percent,
            completedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      }
    });

    // Recompute overall average from the user's quizAttempts summaries
    const qaSnap = await userRef.collection('quizAttempts').get();
    const bests = [];
    qaSnap.forEach(doc => {
      const d = doc.data();
      if (typeof d.bestPercent === 'number') bests.push(d.bestPercent);
      else if (d.bestScore?.percent != null) bests.push(d.bestScore.percent); // legacy fallback
      else if (d.lastScore?.percent != null) bests.push(d.lastScore.percent);
    });
    const averageQuizScore = bests.length
      ? Math.round(bests.reduce((a,b)=>a+b,0)/bests.length)
      : 0;
    await userRef.set({ averageQuizScore }, { merge: true });

    // Response matches your current frontend usage
    const finalCount = used + 1;
    const left = attemptsAllowed === null ? null : Math.max(0, attemptsAllowed - finalCount);

    return res.json({
      success: true,
      message: 'Quiz attempt recorded.',
      attemptId: attemptDoc.id,
      attempts: { used: finalCount, allowed: attemptsAllowed, left }
    });
  } catch (err) {
    console.error('Error storing quiz result:', err);
    res.status(500).json({ success:false, message:'Server error storing quiz result.' });
  }
});



// ==== USER: UPDATE PROFILE (TEXT + OPTIONAL PHOTO) ====
app.post('/users/:email/profile', uploadProfilePic.single('profilePic'), async (req, res) => {
  const userId = decodeURIComponent(req.params.email); // now userId
  const { firstName, middleName, lastName, username } = req.body;
  const file = req.file;

  try {
    const updateData = {
      firstName,
      middleName,
      lastName,
      username,
    };

    if (file) {
      updateData.photoURL = `/uploads/profile_pics/${file.filename}`;
    }

    await firestore.collection('users').doc(userId).update(updateData);
    res.json({ success: true, updatedUser: updateData });
  } catch (err) {
    console.error("🔥 Profile update error:", err);
    res.status(500).json({ success: false, message: "Failed to update profile." });
  }
});

// ==== USER: PATCH PROFILE TEXT + PASSWORD ====
app.patch('/users/:email', async (req, res) => {
  const userId = decodeURIComponent(req.params.email); // now userId
  const { firstName, middleName, lastName, username, password } = req.body;

  try {
    const updateData = {
      firstName,
      middleName,
      lastName,
      username
    };

    if (password && password.trim() !== "") {
      const hashedPassword = await bcrypt.hash(password, 10);
      updateData.password = hashedPassword;
    }

    await firestore.collection('users').doc(userId).update(updateData);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Update failed" });
  }
});

// ==== USER: DELETE ====
app.delete('/users/:email', async (req, res) => {
  try {
    const userId = req.params.email; // now userId
    await firestore.collection('users').doc(userId).delete();
    res.json({ success: true, message: 'User deleted successfully.' });
  } catch (err) {
    console.error('🔥 Delete user error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete user.' });
  }
});

// ==== USER: ACTIVATE / DEACTIVATE ====
app.patch('/users/:email/status', async (req, res) => {
  try {
    const userId = req.params.email; // now userId
    const { active } = req.body;

    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'Invalid active status.' });
    }

    await firestore.collection('users').doc(userId).update({ active });
    res.json({ success: true, message: `User ${active ? 'activated' : 'deactivated'} successfully.` });
  } catch (err) {
    console.error("🔥 Failed to update user status:", err);
    res.status(500).json({ error: 'Failed to update user status.' });
  }
});

// ==== USER: SET ROLE - ADMIN ====
app.patch('/users/:email/admin', async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.email); // now userId
    const { isAdmin } = req.body;

    if (typeof isAdmin !== 'boolean') {
      return res.status(400).json({ success: false, message: "Invalid admin status." });
    }

    await firestore.collection('users').doc(userId).update({ isAdmin });
    res.json({ success: true, message: `User admin access ${isAdmin ? 'granted' : 'revoked'}.` });
  } catch (err) {
    console.error("🔥 Failed to update admin status:", err);
    res.status(500).json({ success: false, message: 'Failed to update admin access.' });
  }
});

// ==== USER: SET ROLE - IT SUPPORT ====
app.patch('/users/:email/itsupport', async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.email); // now userId
    const { isITsupport } = req.body;

    if (typeof isITsupport !== 'boolean') {
      return res.status(400).json({ success: false, message: "Invalid IT Support status." });
    }

    await firestore.collection('users').doc(userId).update({ isITsupport });
    res.json({ success: true, message: `IT Support access ${isITsupport ? 'granted' : 'revoked'}.` });
  } catch (err) {
    console.error("🔥 Failed to update IT Support status:", err);
    res.status(500).json({ success: false, message: 'Failed to update IT Support access.' });
  }
});

// ==== USERS: FILTER BY ROLE OR MOBILE ====
app.get('/users', async (req, res) => {
  try {
    const role = req.query.role;
    const mobileOnly = req.query.mobileOnly === 'true';
    let query = firestore.collection('users');

    if (mobileOnly) {
      query = query.where('isMobile', '==', true);
    } else if (role === 'user') {
      query = query.where('isUser', '==', true).where('isMobile', '==', true);
    } else if (role === 'itsupport') {
      query = query.where('isITsupport', '==', true);
    } else if (role === 'admin') {
      query = query.where('isAdmin', '==', true);
    }

    const snapshot = await query.get();
    const users = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        userId: data.userId || doc.id,
        firstName: data.firstName || '',
        middleName: data.middleName || '',
        lastName: data.lastName || '',
        username: data.username || '',
        email: data.email || '',
        active: data.active ?? true,

        // existing flags
        isITsupport: data.isITsupport ?? false,
        isAdmin: data.isAdmin ?? false,
        isUser: data.isUser ?? false,
        isMobile: data.isMobile ?? false,

        // 👇 add these
        isTeacher: data.isTeacher ?? false,
        isStudent: data.isStudent ?? false,
        teacherId: data.teacherId || null,
        studentId: data.studentId || null,
      };
    });

    res.json(users);
  } catch (err) {
    console.error('🔥 Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// ==== USERS: GET ADMINS ONLY ====
app.get('/users/admins', async (req, res) => {
  try {
    const snapshot = await firestore.collection('users')
      .where('isAdmin', '==', true)
      .get();

    const admins = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        firstName: data.firstName || '',
        middleName: data.middleName || '',
        lastName: data.lastName || '',
        username: data.username || '',
        email: data.email || '',
        active: data.active ?? true,
        isAdmin: true
      };
    });

    res.json(admins);
  } catch (err) {
    console.error('🔥 Error fetching admin users:', err);
    res.status(500).json({ error: 'Failed to fetch admin users.' });
  }
});

// ==== USERS: GET IT SUPPORT ONLY ====
app.get('/users/itsupport', async (req, res) => {
  try {
    const snapshot = await firestore.collection('users')
      .where('isITsupport', '==', true)
      .get();

    const users = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        userId: data.userId || doc.id,
        firstName: data.firstName || '',
        middleName: data.middleName || '',
        lastName: data.lastName || '',
        username: data.username || '',
        email: data.email || '',
        isITsupport: data.isITsupport ?? false
      };
    });

    res.json(users);
  } catch (err) {
    console.error("🔥 Error fetching IT Support users:", err);
    res.status(500).json({ error: 'Failed to fetch IT Support users.' });
  }
});

// Grant/Revoke TEACHER
app.patch('/users/:id/teacher', async (req, res) => {
  const userId = req.params.id;
  const { isTeacher } = req.body || {};

  if (typeof isTeacher !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isTeacher must be boolean.' });
  }

  try {
    const ref = firestore.collection(USERS_COL).doc(userId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const data = snap.data() || {};
    const updates = { isTeacher };

    if (isTeacher) {
      // keep your S-/T-YYYY-xxxxx scheme
      updates.teacherId = data.teacherId || await generateRoleId('teacher');
      // optional: ensure baseline user flag exists
      if (data.isUser === undefined) updates.isUser = true;
    } else {
      updates.teacherId = admin.firestore.FieldValue.delete();
    }

    await ref.update(updates);
    const updated = (await ref.get()).data();

    return res.json({ success: true, user: { userId, ...updated } });
  } catch (err) {
    console.error('PATCH /users/:id/teacher error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update isTeacher.' });
  }
});

// Grant/Revoke STUDENT
app.patch('/users/:id/student', async (req, res) => {
  try {
    const userId = req.params.id;
    const { isStudent } = req.body;
    if (typeof isStudent !== 'boolean') return res.status(400).json({ success:false, message:'isStudent boolean required.' });

    const ref = firestore.collection('users').doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success:false, message:'User not found.' });

    const updates = { isStudent };
    if (isStudent && !snap.data().studentId) {
      updates.studentId = await generateRoleId('student'); // uses your counters
    }
    await ref.update(updates);
    res.json({ success:true, ...updates });
  } catch (e) {
    console.error('🔥 student role update error:', e);
    res.status(500).json({ success:false, message:'Failed to update student role.' });
  }
});

// ==== BUG REPORT: SUBMIT ====
app.post('/submit-bug', uploadBug.single('bugScreenshot'), async (req, res) => {
  try {
    const { bugTitle, bugSeverity, bugDescription, user } = req.body;
    const screenshot = req.file;

    const bugData = {
      bugTitle: bugTitle || "",
      severity: bugSeverity || "Bug",
      description: bugDescription || "",
      user: user || "Anonymous",
      createdAt: new Date().toISOString(),
      status: 'Pending',
    };

    if (screenshot && screenshot.filename) {
      // Always store as browser-accessible URL
      bugData.screenshotPath = `/uploads/bugs/${screenshot.filename}`;
    } else {
      bugData.screenshotPath = "";
    }

    await firestore.collection('bugReports').add(bugData);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Failed to submit bug report:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ==== BUG REPORT: GET ALL ====
app.get('/bugReports', async (req, res) => {
  try {
    const snapshot = await firestore.collection('bugReports').orderBy('createdAt', 'desc').get();
    const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(data);
  } catch (err) {
    console.error("🔥 Fetch bug reports error:", err);
    res.status(500).json({ message: "Failed to fetch bug reports." });
  }
});

// ==== BUG REPORT: UPDATE STATUS ====
app.patch('/bugReports/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, reply } = req.body;

  const update = {
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (reply !== undefined) update.reply = reply;

  try {
    await firestore.collection('bugReports').doc(id).update(update);
    res.json({ success: true });
  } catch (err) {
    console.error("🔥 Update bug status error:", err);
    res.status(500).json({ success: false, message: "Failed to update status." });
  }
});

// ==== DASHBOARD STATS ====
// ==== DASHBOARD MOBILE ANALYTICS (isMobile=true only) ====
app.get('/api/dashboard-mobile-analytics', async (req, res) => {
  try {
    const usersSnapshot = await firestore.collection('users').where('isMobile', '==', true).get();
    const users = usersSnapshot.docs.map(doc => doc.data());

    const totalUsers = users.length;
    const activeUsers = users.filter(u => u.active === true).length;
    const inactiveUsers = totalUsers - activeUsers;

    // You can later replace these with real calculated values:
    const topCourse = "Photography Basics";
    const mostCompletedModule = "Lighting & Composition";
    const averageQuizScore = 87;
    const dailyActiveUsers = 394;

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        inactiveUsers,
        topCourse,
        mostCompletedModule,
        averageQuizScore,
        dailyActiveUsers,
      }
    });
  } catch (err) {
    console.error("🔥 Error fetching dashboard mobile analytics:", err);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard mobile analytics.' });
  }
});

app.get('/api/dashboard-stats', async (req, res) => {
  try {
    const usersSnapshot = await firestore.collection('users').get();
    const users = usersSnapshot.docs.map(doc => doc.data());

    const totalUsers = users.length;
    const activeUsers = users.filter(u => u.active === true).length;
    const inactiveUsers = totalUsers - activeUsers;

    // You can later replace these with real calculated values:
    const topCourse = "Photography Basics";
    const mostCompletedModule = "Lighting & Composition";
    const averageQuizScore = 87;
    const dailyActiveUsers = 394;

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        inactiveUsers,
        topCourse,
        mostCompletedModule,
        averageQuizScore,
        dailyActiveUsers,
      }
    });
  } catch (err) {
    console.error("Error fetching dashboard stats:", err);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard stats' });
  }
});

// ==== MODULE: MARK AS COMPLETE ====
app.post('/mark-module-complete', async (req, res) => {
  try {
    const { email, moduleId } = req.body;

    if (!email || !moduleId) {
      return res.status(400).json({ success: false, message: 'Missing email or moduleId.' });
    }

    // Retrieve user by email
    const userSnapshot = await firestore.collection('users').where('email', '==', email).get();
    if (userSnapshot.empty) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const userId = userSnapshot.docs[0].id;
    const userRef = firestore.collection('users').doc(userId);

    // Check if the module is already marked as completed
    const completedModulesRef = userRef.collection('completedModules');
    const existingModuleDoc = await completedModulesRef.doc(moduleId).get();

    // Mark module complete if not already done
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

      // Mark course as completed if all modules are completed
      if (allCompleted) {
        const completedCoursesRef = userRef.collection('completedCourses');
        await completedCoursesRef.doc(courseId).set({
          courseId,
          completedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    res.json({ success: true, message: 'Module marked complete. Course updated if fully complete.' });

  } catch (err) {
    console.error("🔥 Error marking module complete:", err);
    res.status(500).json({ success: false, message: 'Server error marking module complete.' });
  }
});


// ==== MODULE: COMPLETED MODULE COUNT ====
app.get('/users/:email/completed-modules-count', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);

    // Find the user by email
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
  } catch (err) {
    console.error("Error fetching completed module count:", err);
    res.status(500).json({ count: 0 });
  }
});

// ==== MODULE: CHECK IF SPECIFIC MODULE IS COMPLETED ====
app.get('/users/:email/modules/:moduleId/isCompleted', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const moduleId = req.params.moduleId;

    // 1. Find user document by email
    const userSnapshot = await firestore.collection('users').where('email', '==', email).get();
    if (userSnapshot.empty) return res.json({ completed: false });

    const userId = userSnapshot.docs[0].id;

    // 2. Check if the module is in completedModules
    const moduleDoc = await firestore
      .collection('users')
      .doc(userId)
      .collection('completedModules')
      .doc(moduleId)
      .get();

    res.json({ completed: moduleDoc.exists });
  } catch (err) {
    console.error("🔥 Error checking module completion:", err);
    res.status(500).json({ completed: false });
  }
});



// ==== IT SUPPORT ROLE PATCH ENDPOINT (userId-based) ====
app.patch('/users/:id/itsupport', async (req, res) => {
  const userId = req.params.id;
  const { isITsupport } = req.body;
  if (typeof isITsupport !== 'boolean') {
    return res.status(400).json({ success: false, message: 'Missing isITsupport boolean.' });
  }
  try {
    const userRef = firestore.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    await userRef.update({ isITsupport });
    res.json({ success: true });
  } catch (err) {
    console.error('🔥 IT support role update error:', err);
    res.status(500).json({ success: false, message: 'Failed to update IT support role.' });
  }
});

// ==== MOBILE: UPLOAD PROFILE PHOTO ONLY ====
// POST /users/:email/mobile-profile-photo
app.post(
  '/users/:email/mobile-profile-photo',
  uploadProfilePic.single('profilePic'),
  async (req, res) => {
    const email  = decodeURIComponent(req.params.email);
    const file   = req.file;

    console.log(`📸 [mobile-profile-photo] called for ${email}`, file && file.filename);

    if (!file) {
      return res
        .status(400)
        .json({ success: false, message: 'No profile photo uploaded.' });
    }

    // Build the path your client will use
    const photoURL = `/uploads/profile_pics/${file.filename}`;

    try {
      // Merge just the photoURL field into the existing document (or create if missing)
      await firestore
        .collection('users')
        .doc(email)
        .set({ photoURL }, { merge: true });

      console.log(`✅ Firestore updated for ${email}: photoURL = ${photoURL}`);

      // Return the exact path so the client can verify
      res.json({ success: true, photoURL });
    } catch (err) {
      console.error('🔥 Mobile profile photo upload error:', err);
      res
        .status(500)
        .json({ success: false, message: 'Failed to update profile photo.' });
    }
  }
);

// ==== TEACHER DASHBOARD STATS (real data) ====
app.get('/api/teacher/dashboard-stats', async (req, res) => {
  try {
    const teacherId = String(req.query.teacherId || '').trim();
    if (!teacherId) {
      return res.status(400).json({ success: false, message: 'Missing teacherId query parameter.' });
    }

    // --- helpers ---
    const chunk = (arr, size = 10) => {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };
    const toDateMs = (ts) => ts?.toMillis?.() ?? (typeof ts === 'number' ? ts : null);
    const safeName = (u) => (u?.fullName && u.fullName.trim())
      ? u.fullName.trim()
      : `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || u?.username || 'Student';
    const fmtDate = (ms) => (ms ? new Date(ms).toISOString().slice(0,10) : '—');

    // 1) TEACHER CLASSES
    const classesSnap = await firestore
      .collection('classes')
      .where('teacherId', '==', teacherId)
      .orderBy('createdAt', 'desc')
      .get();

    const classes = classesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const classIds = classes.map(c => c.id);

    // Gather roster studentIds per class (S-YYYY-xxxxx), and count students quickly
    const rosterByClass = {};
    let totalStudents = 0;

    await Promise.all(classes.map(async c => {
      const countField = typeof c.students === 'number' ? c.students : null;

      const rosterSnap = await firestore.collection('classes').doc(c.id).collection('roster').get();
      const roster = rosterSnap.docs.map(r => ({ id: r.id, ...(r.data() || {}) })); // id is studentId (usually S-YYYY-xxxxx)
      rosterByClass[c.id] = roster.map(r => r.id);

      // prefer the precomputed counter if available; fall back to roster size
      totalStudents += (countField != null ? countField : roster.length);
    }));

    // Build a unique set of student "identifiers" from rosters (class rosters use S-YYYY-xxxxx)
    const allRosterStudentIds = Array.from(new Set(Object.values(rosterByClass).flat()));

    // Map roster studentIds -> user docs (need user doc id for some queries)
    const studentIdToUserDoc = {};
    for (const ids of chunk(allRosterStudentIds, 10)) {
      const snap = await firestore.collection('users').where('studentId', 'in', ids).get();
      snap.forEach(doc => {
        const u = doc.data();
        if (u?.studentId) studentIdToUserDoc[u.studentId] = { docId: doc.id, data: u };
      });
    }

    // 2) TEACHER COURSES (author/owner)
    const coursesSnap = await firestore
      .collection('courses')
      .where('uploadedBy', '==', teacherId)
      .get();

    const courses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const courseIds = courses.map(c => c.id);
    const courseById = Object.fromEntries(courses.map(c => [c.id, c]));

    // 3) MODULES + QUIZZES COUNTS
    let modulesPublished = 0;
    for (const ids of chunk(courseIds, 10)) {
      const mSnap = await firestore.collection('modules').where('courseId', 'in', ids).get();
      modulesPublished += mSnap.size;
    }

    let quizzesCreated = 0;
    const quizzes = [];
    for (const ids of chunk(courseIds, 10)) {
      const qSnap = await firestore.collection('quizzes').where('courseId', 'in', ids).get();
      quizzesCreated += qSnap.size;
      qSnap.forEach(doc => quizzes.push({ id: doc.id, ...doc.data() }));
    }

    // 4) ASSIGNMENTS OWNED BY TEACHER (two possible owner fields in your code)
    const assignments = [];
    const seenAssign = new Set();

    const aByTeacher = await firestore.collection('assignments').where('teacherId', '==', teacherId).get();
    aByTeacher.forEach(d => { if (!seenAssign.has(d.id)) { seenAssign.add(d.id); assignments.push({ id: d.id, ...d.data() }); } });

    const aByCreated = await firestore.collection('assignments').where('createdBy', '==', teacherId).get();
    aByCreated.forEach(d => { if (!seenAssign.has(d.id)) { seenAssign.add(d.id); assignments.push({ id: d.id, ...d.data() }); } });

    // 5) PENDING SUBMISSIONS + RECENT SUBMISSIONS
    let pendingSubmissions = 0;
    const recentSubs = []; // collect, then sort by submittedAt desc and take top N
    const userCache = new Map(); // cache user data by either userId or studentId

    const getUserDataByAnyId = async (anyId) => {
      if (!anyId) return null;
      if (userCache.has(anyId)) return userCache.get(anyId);

      // Try direct doc id first (userId)
      let snap = await firestore.collection('users').doc(anyId).get();
      if (snap.exists) {
        const val = { id: snap.id, ...snap.data() };
        userCache.set(anyId, val);
        // also save by studentId for reverse lookup
        if (val.studentId) userCache.set(val.studentId, val);
        return val;
      }
      // fallback via studentId field
      const q = await firestore.collection('users').where('studentId', '==', anyId).limit(1).get();
      if (!q.empty) {
        const d = q.docs[0];
        const val = { id: d.id, ...d.data() };
        userCache.set(anyId, val);
        if (val.studentId) userCache.set(val.studentId, val);
        return val;
      }
      userCache.set(anyId, null);
      return null;
    };

    for (const a of assignments) {
      const subSnap = await firestore.collection('assignments').doc(a.id).collection('submissions').orderBy('submittedAt', 'desc').get();
      subSnap.forEach(s => {
        const data = s.data() || {};
        if (!data.graded) pendingSubmissions += 1;
        recentSubs.push({
          assignmentId: a.id,
          courseId: a.courseId || null,
          moduleId: a.moduleId || null,
          title: a.title || 'Assignment',
          studentKey: data.studentId, // could be userId OR studentId
          submittedAt: toDateMs(data.submittedAt) || 0,
          graded: !!data.graded
        });
      });
    }

    // decorate and pick top 6 most recent
    recentSubs.sort((x, y) => (y.submittedAt || 0) - (x.submittedAt || 0));
    const recentSubmissions = [];
    for (const item of recentSubs.slice(0, 6)) {
      const u = await getUserDataByAnyId(item.studentKey);
      // Find a className via the course's assigned classes (prefer a class taught by this teacher)
      let className = '—';
      if (item.courseId && courseById[item.courseId]?.assignedClasses?.length) {
        const cls = courseById[item.courseId].assignedClasses
          .map(id => classes.find(c => c.id === id))
          .filter(Boolean)[0];
        if (cls) className = cls.name || `${cls.gradeLevel || ''} ${cls.section || ''}`.trim() || 'Class';
      }
      recentSubmissions.push({
        studentName: u ? safeName(u) : 'Student',
        className,
        title: item.title,
        submittedAt: new Date(item.submittedAt || Date.now()).toISOString().replace('T',' ').slice(0,16),
        status: item.graded ? 'graded' : 'ungraded',
        assignmentId: item.assignmentId,
        courseId: item.courseId
      });
    }

    // 6) CLASS OVERVIEW (avg grade, completion %, next due)
    // Preindex assignments/quizzes by courseId for faster lookups
    const assignsByCourse = {};
    assignments.forEach(a => {
      const cid = a.courseId || '_';
      (assignsByCourse[cid] ||= []).push(a);
    });

    const quizzesByCourse = {};
    quizzes.forEach(q => {
      const cid = q.courseId || '_';
      (quizzesByCourse[cid] ||= []).push(q);
    });

    // For grade distribution we will use users.averageQuizScore
    const allUserDocs = Object.values(studentIdToUserDoc).map(x => x.data);
    const scoreBuckets = [0,0,0,0,0]; // 0-59, 60-69, 70-79, 80-89, 90-100
    const pushBucket = (pct) => {
      if (pct == null || Number.isNaN(pct)) return;
      const n = Math.max(0, Math.min(100, Math.round(pct)));
      if (n < 60) scoreBuckets[0]++; else
      if (n < 70) scoreBuckets[1]++; else
      if (n < 80) scoreBuckets[2]++; else
      if (n < 90) scoreBuckets[3]++; else scoreBuckets[4]++;
    };
    allUserDocs.forEach(u => {
      if (typeof u?.averageQuizScore === 'number') pushBucket(u.averageQuizScore);
      else if (typeof u?.averageAssignmentGrade === 'number') pushBucket(u.averageAssignmentGrade);
    });

    // Compute per-class metrics
    const classesOverview = [];
    for (const c of classes) {
      const rosterIds = rosterByClass[c.id] || [];
      const courseIdsForClass = courses
        .filter(co => Array.isArray(co.assignedClasses) && co.assignedClasses.includes(c.id))
        .map(co => co.id);

      // avg grade (mean of users' averageQuizScore | averageAssignmentGrade)
      let sum = 0, cnt = 0;
      for (const sid of rosterIds) {
        const u = studentIdToUserDoc[sid]?.data;
        const g = (typeof u?.averageQuizScore === 'number')
          ? u.averageQuizScore
          : (typeof u?.averageAssignmentGrade === 'number' ? u.averageAssignmentGrade : null);
        if (typeof g === 'number') { sum += g; cnt += 1; }
      }
      const avgGrade = cnt ? Math.round(sum / cnt) : 0;

      // completion % = percent of students having at least one completedModules doc with courseId in courseIdsForClass
      let completed = 0;
      for (const sid of rosterIds) {
        const userDocId = studentIdToUserDoc[sid]?.docId;
        if (!userDocId || !courseIdsForClass.length) continue;
        let hasAny = false;
        for (const ids of chunk(courseIdsForClass, 10)) {
          const cmSnap = await firestore
            .collection('users').doc(userDocId)
            .collection('completedModules')
            .where('courseId', 'in', ids)
            .limit(1)
            .get();
          if (!cmSnap.empty) { hasAny = true; break; }
        }
        if (hasAny) completed += 1;
      }
      const completionRate = (rosterIds.length ? Math.round((completed / rosterIds.length) * 100) : 0);

      // next due (assignments/quizzes)
      const nowMs = Date.now();
      const upcoming = [];

      courseIdsForClass.forEach(cid => {
        (assignsByCourse[cid] || []).forEach(a => {
          const due = toDateMs(a.dueAt);
          if (due && due >= nowMs) upcoming.push({ due, label: `Assignment: ${a.title || 'Untitled'}` });
        });
        (quizzesByCourse[cid] || []).forEach(q => {
          const due = toDateMs(q.dueAt);
          if (due && due >= nowMs) upcoming.push({ due, label: `Quiz: ${q.title || 'Quiz'}` });
        });
      });
      upcoming.sort((x, y) => x.due - y.due);
      const nextDue = upcoming.length ? `${fmtDate(upcoming[0].due)} – ${upcoming[0].label}` : '—';

      classesOverview.push({
        id: c.id,
        name: c.name || `${c.gradeLevel || ''}${c.section ? '-' + c.section : ''}`.trim() || 'Class',
        studentCount: typeof c.students === 'number' ? c.students : rosterIds.length,
        avgGrade,
        completionRate,
        nextDue
      });
    }

    // 7) UPCOMING SCHEDULE (top 6 across all teacher courses)
    const nowMs = Date.now();
    const schedulePool = [];
    assignments.forEach(a => {
      const due = toDateMs(a.dueAt);
      if (due && due >= nowMs) schedulePool.push({ date: fmtDate(due), title: `Assignment: ${a.title || 'Untitled'}`, due });
    });
    quizzes.forEach(q => {
      const due = toDateMs(q.dueAt);
      if (due && due >= nowMs) schedulePool.push({ date: fmtDate(due), title: `Quiz: ${q.title || 'Quiz'}`, due });
    });
    schedulePool.sort((x, y) => x.due - y.due);
    const schedule = schedulePool.slice(0, 6).map(x => ({ date: x.date, title: x.title }));

    // 8) ANNOUNCEMENTS (latest 5)
    const annSnap = await firestore
      .collection('announcements')
      .where('teacherId', '==', teacherId)
      .orderBy('publishAt', 'desc')
      .limit(5)
      .get();

    const announcements = [];
    for (const d of annSnap.docs) {
      const a = d.data() || {};
      let className = 'All Classes';
      if (Array.isArray(a.classIds) && a.classIds.length === 1) {
        try {
          const c = await firestore.collection('classes').doc(a.classIds[0]).get();
          if (c.exists) className = c.data().name || className;
        } catch {}
      } else if (Array.isArray(a.classIds) && a.classIds.length > 1) {
        className = 'Multiple Classes';
      }
      announcements.push({
        title: a.title || 'Announcement',
        className,
        publishedAt: fmtDate(toDateMs(a.publishAt))
      });
    }

    // 9) CHART DATA
    const chartsData = {
      gradeDistribution: {
        labels: ['0-59','60-69','70-79','80-89','90-100'],
        datasets: [{ label: 'Students', data: scoreBuckets }]
      },
      completionRate: {
        labels: classesOverview.map(c => c.name),
        datasets: [{ label: '% Completion', data: classesOverview.map(c => c.completionRate) }]
      },
      // Optional "time on task": based on quiz attempt timeTakenSeconds.
      // To keep this speedy, we average by course using whatever attempts exist.
      timeOnTask: await (async () => {
        const out = { labels: [], datasets: [{ label: 'Avg mins', data: [] }] };

        // try at most 3 courses with most quizzes
        const topCourses = [...(Object.entries(quizzesByCourse))]
          .sort((a, b) => (b[1]?.length || 0) - (a[1]?.length || 0))
          .slice(0, 3)
          .map(([cid]) => cid);

        for (const cid of topCourses) {
          const quizIds = (quizzesByCourse[cid] || []).map(q => q.id);
          if (!quizIds.length) continue;

          let sumSec = 0, cnt = 0;

          // For each student (limit: only those in classes that use this course)
          const relevantClassIds = (courseById[cid]?.assignedClasses || []).filter(id => classIds.includes(id));
          const rosterIdsForCourse = Array.from(new Set(relevantClassIds.flatMap(k => rosterByClass[k] || [])));

          // Convert roster studentId -> user doc id
          const userDocIds = rosterIdsForCourse
            .map(sid => studentIdToUserDoc[sid]?.docId)
            .filter(Boolean);

          // Walk users and fetch attempts for these quizIds
          // (lightweight; skip if large: cap to first 25 users)
          for (const uid of userDocIds.slice(0, 25)) {
            for (const qid of quizIds) {
              const attemptsSnap = await firestore
                .collection('users').doc(uid)
                .collection('quizAttempts').doc(qid)
                .collection('attempts')
                .get();
              attemptsSnap.forEach(at => {
                const t = at.data()?.timeTakenSeconds;
                if (typeof t === 'number' && t > 0) { sumSec += t; cnt += 1; }
              });
            }
          }

          const avgMin = cnt ? Math.round((sumSec / cnt) / 60) : 0;
          out.labels.push(courseById[cid]?.title || 'Course');
          out.datasets[0].data.push(avgMin);
        }
        return out;
      })()
    };

    // 10) SUMMARY STATS
    const stats = {
      totalClasses: classes.length,
      totalStudents,             // sum of class counts (like your example 32+28+18)
      modulesPublished,
      quizzesCreated,
      pendingSubmissions
    };

    return res.json({
      success: true,
      stats,
      classes: classesOverview,
      submissions: recentSubmissions,
      chartsData,
      schedule,
      announcements
    });
  } catch (err) {
    console.error('🔥 Error in /api/teacher/dashboard-stats:', err);
    return res.status(500).json({ success: false, message: 'Server error fetching dashboard stats.' });
  }
});



// ==== CLASSES: GET, CREATE, UPDATE ====

// Helpers
const isValidSchoolYear = (sy) =>
  typeof sy === 'string' &&
  /^\d{4}-\d{4}$/.test(sy) &&
  (parseInt(sy.slice(5), 10) - parseInt(sy.slice(0, 4), 10) === 1);

const isValidSemester = (s) => s === '1st Semester' || s === '2nd Semester';


// === GET /api/classes/:id ===
app.get('/api/classes/:id', async (req, res) => {
  try {
    const ref = firestore.collection('classes').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) {
      return res.status(404).json({ success:false, message:'Class not found.' });
    }
    res.json({ success:true, class: { id: doc.id, classId: doc.id, ...doc.data() } });
  } catch (err) {
    console.error('🔥 Error fetching class by id:', err);
    res.status(500).json({ success:false, message:'Failed to fetch class.' });
  }
});


// GET /api/classes
// Optional query params: teacherId, schoolYear, semester
app.get('/api/classes', async (req, res) => {
  try {
    let q = firestore.collection('classes');

    if (req.query.teacherId) {
      q = q.where('teacherId', '==', req.query.teacherId);
    }
    if (req.query.schoolYear) {
      q = q.where('schoolYear', '==', req.query.schoolYear);
    }
    if (req.query.semester) {
      q = q.where('semester', '==', req.query.semester);
    }

    // Keep your ordering
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
        schoolYear: d.schoolYear || null,     // ✅ include
        semester: d.semester || null,         // ✅ include
        students: d.students || 0,
        teacherId: d.teacherId,
        createdAt: d.createdAt
      };
    });

    res.json({ success: true, classes });
  } catch (err) {
    console.error('🔥 Error fetching classes:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch classes.' });
  }
});

// POST /api/classes
// body: { name, gradeLevel, section, teacherId, schoolYear, semester }
app.post('/api/classes', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('🔥 Error creating class:', err);
    res.status(500).json({ success: false, message: 'Failed to create class.' });
  }
});

// PUT /api/classes/:id
// body: { name?, gradeLevel?, section?, schoolYear?, semester? }
app.put('/api/classes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, gradeLevel, section, schoolYear, semester } = req.body;

    const classRef = firestore.collection('classes').doc(id);
    const classDoc = await classRef.get();
    if (!classDoc.exists) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    // Validate only provided fields
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
  } catch (err) {
    console.error('🔥 Error updating class:', err);
    res.status(500).json({ success: false, message: 'Failed to update class.' });
  }
});

// ==== DELETE /api/classes/:id ====
// Optional query param: ?cascade=true  -> also deletes subcollections
app.delete('/api/classes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cascade = String(req.query.cascade || '').toLowerCase() === 'true';

    const classRef = firestore.collection('classes').doc(id);
    const snap = await classRef.get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    if (cascade) {
      // --- Carefully delete all subcollections (if any) before deleting the document ---
      // This traverses first-level subcollections and deletes their docs.
      // (If you have nested collections, repeat or build a recursive helper.)
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
  } catch (err) {
    console.error('🔥 Error deleting class:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete class.' });
  }
});

// === ROSTER: GET /api/classes/:id/students ===
app.get('/api/classes/:id/students', async (req, res) => {
  try {
    const rosterRef = firestore.collection('classes').doc(req.params.id).collection('roster');
    const snap = await rosterRef.get();
    const students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, students });
  } catch (err) {
    console.error('🔥 Error getting roster:', err);
    res.status(500).json({ success:false, message:'Failed to load roster.' });
  }
});

// ====== SINGLE ENROLL route (uses helper) ======
app.post('/api/classes/:id/students', async (req, res) => {
  try {
    const classId = req.params.id;
    const { studentId } = req.body || {};
    if (!studentId) {
      return res.status(400).json({ success:false, message:'studentId is required.' });
    }

    const result = await enrollStudentIdempotent({ firestore, admin }, classId, studentId);
    if (!result.ok) {
      if (result.reason === 'not_found') return res.status(404).json({ success:false, message:'Student not found.' });
      if (result.reason === 'class_not_found') return res.status(404).json({ success:false, message:'Class not found.' });
      return res.status(400).json({ success:false, message:'Unable to enroll student.' });
    }

    return res.json({
      success: true,
      alreadyEnrolled: !!result.alreadyEnrolled,
      message: result.alreadyEnrolled ? 'Student is already enrolled.' : 'Student enrolled.'
    });
  } catch (err) {
    console.error('🔥 Error enrolling student:', err);
    return res.status(500).json({ success:false, message:'Failed to enroll student.' });
  }
});

// ====== BULK ENROLL route (xlsx/csv), always returns JSON ======
app.post('/api/classes/:id/students/bulk', uploadBulk.single('file'), async (req, res) => {
  try {
    const classId = req.params.id;
    if (!req.file) return res.status(400).json({ success:false, message:'No file uploaded.' });

    const preferredCol = String(req.body.column || 'studentId').trim().toLowerCase();

    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) return res.status(400).json({ success:false, message:'No rows found in file.' });

    const headerKeys = Object.keys(rows[0] || {}).map(k => ({ raw:k, lower:k.toLowerCase().trim() }));
    const studentIdKey = (headerKeys.find(h => h.lower === preferredCol)
      || headerKeys.find(h => h.lower === 'studentid')
      || headerKeys.find(h => h.lower === 'student id'))?.raw;

    if (!studentIdKey) {
      return res.status(400).json({
        success:false,
        message:`Could not find a 'studentId' column. Add a header named '${preferredCol}'.`
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
    if (!studentIds.length) return res.status(400).json({ success:false, message:'No studentId values found.' });

    const report = { total: studentIds.length, enrolled: 0, alreadyEnrolled: 0, notFound: 0, errors: 0, details: [] };

    for (const sid of studentIds) {
      try {
        const result = await enrollStudentIdempotent({ firestore, admin }, classId, sid);
        if (result.ok && result.alreadyEnrolled) {
          report.alreadyEnrolled++; report.details.push({ studentId: sid, status: 'already' });
        } else if (result.ok) {
          report.enrolled++; report.details.push({ studentId: sid, status: 'enrolled' });
        } else if (result.reason === 'not_found') {
          report.notFound++; report.details.push({ studentId: sid, status: 'not_found' });
        } else if (result.reason === 'class_not_found') {
          return res.status(404).json({ success:false, message:'Class not found.' });
        } else {
          report.errors++; report.details.push({ studentId: sid, status: 'error', error: result.reason || 'unknown' });
        }
      } catch (e) {
        console.error('Bulk enroll error for', sid, e);
        report.errors++; report.details.push({ studentId: sid, status: 'error', error: 'exception' });
      }
    }

    // ✅ Always JSON with success:true so the frontend treats it as success
    return res.status(200).json({ success: true, report });
  } catch (err) {
    console.error('🔥 Bulk enroll error:', err);
    return res.status(500).json({ success:false, message:'Failed to bulk enroll.' });
  }
});

// === ROSTER: DELETE /api/classes/:id/students/:studentId ===
// === ROSTER: DELETE /api/classes/:id/students/:studentId ===
app.delete('/api/classes/:id/students/:studentId', async (req, res) => {
  try {
    const classId = req.params.id;
    const studentId = req.params.studentId;

    const classRef = firestore.collection('classes').doc(classId);

    // 1) Remove from the class roster
    await classRef.collection('roster').doc(studentId).delete();

    // 2) Decrement students count on class
    await classRef.update({
      students: admin.firestore.FieldValue.increment(-1)
    });

    // 3) ALSO: remove the enrollment record from the student's doc
    const userSnap = await firestore.collection('users').where('studentId', '==', studentId).limit(1).get();
    if (!userSnap.empty) {
      const userDocId = userSnap.docs[0].id;
      const enrollmentRef = firestore
        .collection('users')
        .doc(userDocId)
        .collection('enrollments')
        .doc(classId);

      await enrollmentRef.delete().catch(() => {}); // ignore if not present
    }

    return res.json({ success:true });
  } catch (err) {
    console.error('🔥 Error removing student:', err);
    return res.status(500).json({ success:false, message:'Failed to remove student.' });
  }
});

// === Student lookup (exact by studentId) — legacy
app.get('/api/students/lookup', async (req, res) => {
  try {
    const { studentId } = req.query;
    if (!studentId || String(studentId).trim() === '') {
      return res.status(400).json({ success:false, message:'studentId is required.' });
    }
    const snap = await firestore.collection('users').where('studentId', '==', String(studentId).trim()).limit(1).get();
    if (snap.empty) return res.json({ success:true, found:false });
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
  } catch (err) {
    console.error('🔥 Student lookup error:', err);
    res.status(500).json({ success:false, message:'Failed to lookup student.' });
  }
});

// === Student SEARCH (by ID OR first/last name; case-insensitive prefix) ===
app.get('/api/students/search', async (req, res) => {
  try {
    const q = String(req.query.query || '').trim();
    if (!q) return res.status(400).json({ success:false, message:'query is required.' });

    const usersCol = firestore.collection('users');
    const results = [];

    // 1) If it looks like an ID, try exact studentId match first
    if (/^[A-Za-z]-?\d{4}-?\d{5}$/i.test(q) || /^S-\d{4}-\d{5}$/i.test(q) || /^S\d+$/.test(q)) {
      const idSnap = await usersCol.where('studentId', '==', q).limit(1).get();
      idSnap.forEach(d => results.push({ id:d.id, ...d.data() }));
    }

    // Helper for case-insensitive prefix search in Firestore
    async function prefixQuery(field, term) {
      // To make a case-insensitive prefix search, store an additional field like firstNameLower in your users docs.
      // If you don't have these yet, fallback to case-sensitive (less ideal).
      const lowerField = field + 'Lower';
      const hasLower = true; // turn to false if you haven't added these fields

      const val = term.toLowerCase();
      const end = val.replace(/.$/, c => String.fromCharCode(c.charCodeAt(0) + 1));

      const fieldName = hasLower ? lowerField : field;

      const snap = await usersCol
        .where(fieldName, '>=', hasLower ? val : term)
        .where(fieldName, '<', hasLower ? end : term + '\uf8ff')
        .limit(10)
        .get();

      const arr = [];
      snap.forEach(d => arr.push({ id:d.id, ...d.data() }));
      return arr;
    }

    // 2) Name prefix search (first + last)
    const nameMatches = [
      ...(await prefixQuery('firstName', q)),
      ...(await prefixQuery('lastName', q))
    ];

    // Combine & de-dupe by doc id
    const map = new Map();
    [...results, ...nameMatches].forEach(u => map.set(u.id, u));
    const students = Array.from(map.values()).map(u => ({
      studentId: u.studentId || '',
      firstName: u.firstName || '',
      lastName:  u.lastName || '',
      email:     u.email || ''
    }));

    return res.json({ success:true, students });
  } catch (err) {
    console.error('🔥 Student search error:', err);
    return res.status(500).json({ success:false, message:'Failed to search students.' });
  }
});

// === STUDENT: GET ENROLLMENTS ===
// GET /api/students/:userId/enrollments?includeTeacher=true
app.get('/api/students/:userId/enrollments', async (req, res) => {
  try {
    const { userId } = req.params;
    const includeTeacher = String(req.query.includeTeacher || '').toLowerCase() === 'true';

    const userRef = firestore.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const snap = await userRef.collection('enrollments').get();
    let enrollments = snap.docs.map(d => ({ id: d.id, ...d.data() })); // id == classId

    // Optionally attach the teacher name
    if (includeTeacher) {
      const teacherIds = Array.from(new Set(enrollments.map(e => e.teacherId).filter(Boolean)));
      const teacherMap = {};
      // Pull teacher docs in parallel (at most ~10 at a time)
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
  } catch (err) {
    console.error('🔥 Error fetching enrollments:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch enrollments.' });
  }
});


// === COURSES ASSIGNED TO A CLASS ===
// GET /api/classes/:id/courses
app.get('/api/classes/:id/courses', async (req, res) => {
  try {
    const classId = req.params.id;
    const snap = await firestore
      .collection('courses')
      .where('assignedClasses', 'array-contains', classId)
      .get();

    const courses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, courses });
  } catch (err) {
    console.error('🔥 Error fetching courses for class:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch class courses.' });
  }
});


// === COURSES FOR A STUDENT'S ENROLLED CLASSES ===
// GET /api/students/:userId/courses?includeTeacher=true
app.get('/api/students/:userId/courses', async (req, res) => {
  try {
    const { userId } = req.params;
    const includeTeacher = String(req.query.includeTeacher || '').toLowerCase() === 'true';

    // 1) Get the student's enrolled class IDs (from users/{userId}/enrollments)
    const enrollSnap = await firestore
      .collection('users')
      .doc(userId)
      .collection('enrollments')
      .get();

    const classIds = enrollSnap.docs.map(d => d.id);
    if (!classIds.length) return res.json({ success: true, courses: [] });

    // 2) Find courses that are assigned to any of these classes
    //    (array-contains-any supports up to 10 values, so chunk if needed)
    const chunks = [];
    for (let i = 0; i < classIds.length; i += 10) chunks.push(classIds.slice(i, i + 10));

    const seen = new Set();
    let courses = [];
    for (const chunk of chunks) {
      const snap = await firestore
        .collection('courses')
        .where('assignedClasses', 'array-contains-any', chunk)
        .get();

      snap.forEach(doc => {
        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          courses.push({ id: doc.id, ...doc.data() });
        }
      });
    }

    // 3) Optionally attach teacher name from uploadedBy
    if (includeTeacher) {
      const teacherIds = Array.from(new Set(courses.map(c => c.uploadedBy).filter(Boolean)));
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
      courses = courses.map(c => ({
        ...c,
        teacherName: c.uploadedBy ? (teacherMap[c.uploadedBy] || 'Teacher') : '—'
      }));
    }

    return res.json({ success: true, courses });
  } catch (err) {
    console.error('🔥 Error fetching student courses:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch student courses.' });
  }
});


// ==== ANNOUNCEMENTS HELPERS ====
function toTimestampOrNull(v) {
  if (!v) return null;
  // Accept ms epoch number or ISO-like string from <input type="datetime-local">
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  if (isNaN(d.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(d);
}

// Compute status at "now" for a single announcement doc data
function computeAnnouncementStatus(a, nowMs = Date.now()) {
  const pub = a.publishAt?.toMillis?.() ?? null;
  const exp = a.expiresAt?.toMillis?.() ?? null;

  if (pub && nowMs < pub) return 'scheduled';
  if (exp && nowMs > exp) return 'expired';
  return 'published'; // (includes no publishAt => treat as immediately published)
}

// ==== ANNOUNCEMENTS: CREATE ====
// POST /api/announcements
// body: { title, content, classes: [classId], publishAt, expiresAt?, important, teacherId }
app.post('/api/announcements', async (req, res) => {
  try {
    const { title, content, classes, publishAt, expiresAt, important, teacherId } = req.body;

    if (!title || !content || !teacherId || !Array.isArray(classes) || classes.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing fields: title, content, teacherId, classes[] are required.' });
    }

    const payload = {
      title: String(title).trim(),
      content: String(content).trim(),
      classIds: classes.map(String),
      teacherId: String(teacherId),
      important: !!important,
      publishAt: toTimestampOrNull(publishAt) || admin.firestore.Timestamp.now(),
      expiresAt: toTimestampOrNull(expiresAt) || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await firestore.collection('announcements').add(payload);
    const saved = await docRef.get();

    // (Optional) If important, you could notify students here (email/push).
    // You already have nodemailer configured; left as a TODO to avoid long loops.

    res.status(201).json({ success: true, id: docRef.id, announcement: { id: docRef.id, ...saved.data() } });
  } catch (err) {
    console.error('🔥 Create announcement error:', err);
    res.status(500).json({ success: false, message: 'Failed to create announcement.' });
  }
});

// ==== ANNOUNCEMENTS: LIST (TEACHER) ====
// GET /api/announcements?teacherId=...&classIds=ID1,ID2&status=published|scheduled|expired|important
app.get('/api/announcements', async (req, res) => {
  try {
    const teacherId = String(req.query.teacherId || '');
    if (!teacherId) {
      return res.status(400).json({ success: false, message: 'teacherId query parameter is required.' });
    }
    const status = (req.query.status || '').toString().toLowerCase(); // published/scheduled/expired/important
    const classIdsParam = (req.query.classIds || '').toString().trim();
    const classIds = classIdsParam ? classIdsParam.split(',').map(s => s.trim()).filter(Boolean) : [];

    let q = firestore.collection('announcements').where('teacherId', '==', teacherId);

    // Filter by classes if provided (array-contains-any supports up to 10 values)
    if (classIds.length > 0 && classIds.length <= 10) {
      q = q.where('classIds', 'array-contains-any', classIds);
    }
    // If >10, client should paginate or call multiple times. We keep it simple here.

    q = q.orderBy('publishAt', 'desc');

    const snap = await q.get();
    const now = Date.now();

    let items = snap.docs.map(d => {
      const data = d.data();
      const statusNow = computeAnnouncementStatus(data, now);
      return {
        id: d.id,
        ...data,
        status: statusNow
      };
    });

    if (status === 'important') {
      items = items.filter(a => !!a.important);
    } else if (['published', 'scheduled', 'expired'].includes(status)) {
      items = items.filter(a => a.status === status);
    }
    // If classIds > 10, do a client-side filter fallback (optional)
    if (classIds.length > 10) {
      const set = new Set(classIds);
      items = items.filter(a => Array.isArray(a.classIds) && a.classIds.some(id => set.has(id)));
    }

    res.json({ success: true, announcements: items });
  } catch (err) {
    console.error('🔥 List announcements error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch announcements.' });
  }
});

// ==== ANNOUNCEMENTS: UPDATE ====
// PUT /api/announcements/:id
// body (any subset): { title?, content?, classes?, publishAt?, expiresAt?, important? }
app.put('/api/announcements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const ref = firestore.collection('announcements').doc(id);
    const doc = await ref.get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Announcement not found.' });
    }

    const { title, content, classes, publishAt, expiresAt, important } = req.body;
    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (title != null)      updates.title = String(title).trim();
    if (content != null)    updates.content = String(content).trim();
    if (Array.isArray(classes)) updates.classIds = classes.map(String);
    if (publishAt !== undefined) updates.publishAt = toTimestampOrNull(publishAt);
    if (expiresAt !== undefined) updates.expiresAt = toTimestampOrNull(expiresAt);
    if (important !== undefined) updates.important = !!important;

    await ref.update(updates);
    res.json({ success: true });
  } catch (err) {
    console.error('🔥 Update announcement error:', err);
    res.status(500).json({ success: false, message: 'Failed to update announcement.' });
  }
});

// ==== ANNOUNCEMENTS: STUDENT FEED ====
// GET /api/students/:userId/announcements
// Returns announcements for any of the student's enrolled classes,
// where publishAt <= now and (no expiresAt or expiresAt >= now)
app.get('/api/students/:userId/announcements', async (req, res) => {
  try {
    const { userId } = req.params;
    const userRef = firestore.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    // Get student's enrolled classIds
    const enrollSnap = await userRef.collection('enrollments').get();
    const classIds = enrollSnap.docs.map(d => d.id);
    if (classIds.length === 0) {
      return res.json({ success: true, announcements: [] });
    }

    const now = Date.now();
    const results = [];

    // Firestore array-contains-any supports up to 10 values—chunk if needed
    const chunk = (arr, size) => arr.length ? [arr.slice(0, size), ...chunk(arr.slice(size), size)] : [];
    const chunks = chunk(classIds, 10);

    for (const ids of chunks) {
      let q = firestore.collection('announcements')
        .where('classIds', 'array-contains-any', ids)
        .orderBy('publishAt', 'desc');

      const snap = await q.get();
      snap.forEach(d => {
        const a = d.data();
        const status = computeAnnouncementStatus(a, now);
        if (status === 'published') {
          results.push({ id: d.id, ...a, status });
        }
      });
    }

    // De-dupe (if announcements match multiple classIds)
    const map = new Map();
    results.forEach(a => map.set(a.id, a));
    const deduped = Array.from(map.values()).sort((a, b) => {
      const ap = a.publishAt?.toMillis?.() ?? 0;
      const bp = b.publishAt?.toMillis?.() ?? 0;
      return bp - ap; // newest first
    });

    res.json({ success: true, announcements: deduped });
  } catch (err) {
    console.error('🔥 Student announcements error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch announcements.' });
  }
});

// GET /api/classes/:classId/announcements/visible
app.get('/api/classes/:classId/announcements/visible', async (req, res) => {
  try {
    const { classId } = req.params;
    const now = Date.now();

    const snap = await firestore
      .collection('announcements')
      .where('classIds', 'array-contains', classId)
      .orderBy('publishAt', 'desc')
      .get();

    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(a => computeAnnouncementStatus(a, now) === 'published');

    res.json({ success: true, announcements: items });
  } catch (err) {
    console.error('🔥 Visible announcements error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch announcements.' });
  }
});

// === ASSIGNMENTS ===
const uploadAssignmentFiles = multer({ storage: makeStorage('assignments') });

// POST /api/assignments
// multipart/form-data: teacherId, courseId, moduleId, title, content, points?, publishAt?, dueAt?, files[]
app.post('/api/assignments', uploadAssignmentFiles.array('files'), async (req, res) => {
  try {
    const { teacherId, courseId, moduleId, title, content } = req.body;
    let { points, publishAt, dueAt } = req.body;

    if (!teacherId || !courseId || !moduleId || !title || !content) {
      return res.status(400).json({ success:false, message:'Missing required fields.' });
    }

    points    = points ? parseInt(points, 10) : null;
    publishAt = publishAt ? admin.firestore.Timestamp.fromDate(new Date(Number(publishAt))) : admin.firestore.Timestamp.now();
    dueAt     = dueAt ? admin.firestore.Timestamp.fromDate(new Date(Number(dueAt))) : null;

    const files = (req.files || []).map(f => ({
      path: `/uploads/assignments/${f.filename}`,
      originalName: f.originalname,
      size: f.size,
      mime: f.mimetype
    }));

    const payload = {
      teacherId, courseId, moduleId,
      title, content,
      points: points ?? null,
      publishAt, dueAt,
      files,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await firestore.collection('assignments').add(payload);
    const doc = await ref.get();
    return res.status(201).json({ success:true, id: ref.id, assignment: { id: ref.id, ...doc.data() } });
  } catch (err) {
    console.error('🔥 Create assignment error:', err);
    res.status(500).json({ success:false, message:'Failed to create assignment.' });
  }
});

// (Optional) list per module
// GET /api/modules/:moduleId/assignments
app.get('/api/modules/:moduleId/assignments', async (req, res) => {
  try {
    const snap = await firestore.collection('assignments')
      .where('moduleId', '==', req.params.moduleId)
      .orderBy('publishAt', 'desc')
      .get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success:true, assignments: items });
  } catch (err) {
    console.error('🔥 List assignments error:', err);
    res.status(500).json({ success:false, message:'Failed to fetch assignments.' });
  }
});

app.post('/api/assignments', uploadAssign.array('files'), async (req, res) => {
  try {
    const {
      title,
      content,
      courseId,
      courseTitle,
      moduleId,
      publishAt,
      dueAt,
      points,
      teacherId
    } = req.body;

    if (!title || !content || !courseId || !teacherId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: title, content, courseId, teacherId.'
      });
    }

    // Collect file attachments
    const files = Array.isArray(req.files) ? req.files : [];
    const fileAttachments = files.map(f => ({
      filePath: `/uploads/assignments/${f.filename}`,
      originalName: f.originalname,
      size: f.size,
      mime: f.mimetype
    }));

    // Optional links[] from body
    let links = req.body.links || req.body['links[]'] || [];
    if (typeof links === 'string') links = [links];
    const linkAttachments = (links || [])
      .map(u => String(u).trim())
      .filter(u => u.length)
      .map(u => ({ url: u }));

    // Try to fetch moduleNumber if moduleId present
    let moduleNumber = null;
    if (moduleId) {
      try {
        const m = await firestore.collection('modules').doc(moduleId).get();
        if (m.exists) {
          moduleNumber = m.data().moduleNumber || null;
        }
      } catch {}
    }

    const payload = {
      title: String(title).trim(),
      content: String(content).trim(),
      courseId: String(courseId).trim(),
      courseTitle: courseTitle ? String(courseTitle).trim() : undefined,
      moduleId: moduleId ? String(moduleId).trim() : null,
      moduleNumber,
      points: points != null && points !== '' ? Number(points) : null,
      publishAt: toTimestampOrNull ? (toTimestampOrNull(publishAt) || admin.firestore.Timestamp.now()) : admin.firestore.Timestamp.now(),
      dueAt: toTimestampOrNull ? (toTimestampOrNull(dueAt) || null) : null,
      createdBy: String(teacherId).trim(),
      attachments: [...fileAttachments, ...linkAttachments],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Remove undefined keys (like courseTitle if not provided)
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    const ref = await firestore.collection('assignments').add(payload);
    const saved = await ref.get();

    return res.status(201).json({
      success: true,
      id: ref.id,
      assignment: { id: ref.id, ...saved.data() }
    });
  } catch (err) {
    console.error('🔥 Create assignment error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create assignment.' });
  }
});

app.patch('/api/assignments/:id/submissions/:studentId', async (req, res) => {
  try {
    const { id: assignmentId, studentId } = req.params;
    const { grade, feedback } = req.body;

    const aRef  = firestore.collection('assignments').doc(assignmentId);
    const subRef = aRef.collection('submissions').doc(studentId);

    // 1) Update the submission itself
    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (grade !== undefined) {
      updates.grade = Number(grade);
      updates.graded = true;
    }
    if (feedback !== undefined) {
      updates.feedback = String(feedback);
    }
    await subRef.set(updates, { merge: true });

    // 2) Read the latest assignment + submission snapshots (for metadata)
    const [aSnap, sSnap] = await Promise.all([aRef.get(), subRef.get()]);
    if (!aSnap.exists) return res.status(404).json({ success:false, message:'Assignment not found.' });

    const a = aSnap.data() || {};
    const s = sSnap.exists ? (sSnap.data() || {}) : {};

    // 3) Mirror the grade into the user's document
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
        grade: (grade !== undefined) ? Number(grade) : (typeof s.grade === 'number' ? s.grade : null),
        feedback: (feedback !== undefined) ? String(feedback) : (s.feedback ?? null)
      }, { merge: true });

      // 4) Recompute a simple average across all assignment grades
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
          grade: (grade !== undefined) ? Number(grade) : (typeof s.grade === 'number' ? s.grade : null),
          at: admin.firestore.FieldValue.serverTimestamp()
        }
      }, { merge: true });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('🔥 Grade submission error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update submission.' });
  }
});

// GET all submissions for a specific assignment
app.get('/api/assignments/:id/submissions', async (req, res) => {
  const assignmentId = req.params.id;
  try {
    const subsSnap = await firestore.collection('assignments').doc(assignmentId).collection('submissions').get();
    const submissions = [];
    for (const doc of subsSnap.docs) {
      const data = doc.data();
      const studentId = data.studentId || doc.id;
      let studentName = '';
      try {
        // Try direct userId lookup first
        let userSnap = await firestore.collection('users').doc(studentId).get();
        let user = null;
        if (userSnap.exists) {
          user = userSnap.data();
        } else {
          // Fallback to studentId field lookup
          const userQuery = await firestore.collection('users').where('studentId', '==', studentId).limit(1).get();
          if (!userQuery.empty) {
            user = userQuery.docs[0].data();
          }
        }
        if (user) {
          if (user.fullName && user.fullName.trim()) {
            studentName = user.fullName.trim();
          } else {
            const first = user.firstName || '';
            const last = user.lastName || '';
            studentName = `${first} ${last}`.trim();
          }
        } else {
          studentName = studentId;
        }
      } catch {
        studentName = studentId;
      }
      submissions.push({
        ...data,
        studentId,
        studentName,
        assignmentId,
      });
    }
    res.json({ success: true, submissions });
  } catch (err) {
    console.error('Error fetching assignment submissions:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch submissions.' });
  }
});

/* ====== TEACHER: LIST ASSIGNMENTS BY COURSE ======
   GET /api/courses/:courseId/assignments
   Returns: { success, assignments:[...] }
*/
app.get('/api/courses/:courseId/assignments', async (req, res) => {
  try {
    const { courseId } = req.params;
    const snap = await firestore
      .collection('assignments')
      .where('courseId', '==', courseId)
      .orderBy('publishAt', 'desc')
      .get();

    const assignments = snap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    return res.json({ success: true, assignments });
  } catch (err) {
    console.error('🔥 List course assignments error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch assignments.' });
  }
});

/* ====== STUDENT: CONSOLIDATED LIST ======
   GET /api/students/:userId/assignments
   1) Get student enrollments (class IDs) from users/{userId}/enrollments
   2) Find courses assigned to any of those classes (same logic as your /api/students/:userId/courses)
   3) Query assignments where courseId in chunked courseIds (<=10 per Firestore "in")
*/
app.get('/api/students/:userId/assignments', async (req, res) => {
  try {
    const { userId } = req.params;

    // Get student's enrolled classes
    const enrollSnap = await firestore
      .collection('users')
      .doc(userId)
      .collection('enrollments')
      .get();
    const classIds = enrollSnap.docs.map(d => d.id);
    if (!classIds.length) {
      return res.json({ success: true, assignments: [] });
    }

    // Resolve courses that are assigned to those classes
    // (reuse your /api/students/:userId/courses logic inline)
    const chunks = [];
    for (let i = 0; i < classIds.length; i += 10) chunks.push(classIds.slice(i, i + 10));

    const courseSeen = new Set();
    const courses = [];
    for (const chunk of chunks) {
      const snap = await firestore
        .collection('courses')
        .where('assignedClasses', 'array-contains-any', chunk)
        .get();
      snap.forEach(doc => {
        if (!courseSeen.has(doc.id)) {
          courseSeen.add(doc.id);
          courses.push({ id: doc.id, ...doc.data() });
        }
      });
    }

    if (!courses.length) {
      return res.json({ success: true, assignments: [] });
    }

    // Now pull assignments for these courses using "in" with chunk size 10
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

      for (const doc of snap.docs) {
        const a = doc.data();
        results.push({
          id: doc.id,
          ...a
        });
      }
    }

    // Optionally, attach "mySubmission" snapshot for each assignment (one per student)
    // Keep it light: do it in batches
    // submissions path: assignments/{id}/submissions/{studentId}
    await Promise.all(results.map(async (a, idx) => {
      try {
        const subDoc = await firestore
          .collection('assignments')
          .doc(a.id)
          .collection('submissions')
          .doc(userId)
          .get();
        if (subDoc.exists) {
          results[idx].mySubmission = subDoc.data();
        }
      } catch {}
    }));

    // Sort newest publishAt first
    results.sort((x, y) => {
      const xp = x.publishAt?.toMillis?.() ?? 0;
      const yp = y.publishAt?.toMillis?.() ?? 0;
      return yp - xp;
    });

    return res.json({ success: true, assignments: results });
  } catch (err) {
    console.error('🔥 Student assignments error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch assignments.' });
  }
});

/* ====== STUDENT: SUBMIT ASSIGNMENT ======
   POST /api/assignments/:id/submissions
   Form-data:
     - studentId (required)  // your stored userId
     - text (optional)
     - files (optional, multiple)
*/
app.post('/api/assignments/:id/submissions', uploadSubmission.array('files'), async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const { studentId } = req.body;

    if (!studentId) {
      return res.status(400).json({ success: false, message: 'studentId is required.' });
    }

    // Validate the assignment exists
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

    // Upsert (allow resubmission: overwrite text/files and update submittedAt)
    await subRef.set(payload, { merge: true });

    return res.json({ success: true, message: 'Submission saved.' });
  } catch (err) {
    console.error('🔥 Submit assignment error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit assignment.' });
  }
});

/* ====== STUDENT: VIEW OWN SUBMISSION ======
   GET /api/assignments/:id/submissions/:studentId
*/
app.get('/api/assignments/:id/submissions/:studentId', async (req, res) => {
  try {
    const { id, studentId } = { id: req.params.id, studentId: req.params.studentId };
    const snap = await firestore
      .collection('assignments')
      .doc(id)
      .collection('submissions')
      .doc(studentId)
      .get();

    if (!snap.exists) {
      return res.json({ success: true, submission: null });
    }
    return res.json({ success: true, submission: { id: snap.id, ...snap.data() } });
  } catch (err) {
    console.error('🔥 Get submission error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch submission.' });
  }
});

/* ====== (Optional) TEACHER: GRADE SUBMISSION ======
   PATCH /api/assignments/:id/submissions/:studentId
   Body: { grade?: number, feedback?: string }
*/
app.patch('/api/assignments/:id/submissions/:studentId', async (req, res) => {
  try {
    const { id, studentId } = req.params;
    const { grade, feedback } = req.body;

    const subRef = firestore
      .collection('assignments')
      .doc(id)
      .collection('submissions')
      .doc(studentId);

    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (grade !== undefined) {
      updates.grade = Number(grade);
      updates.graded = true;
    }
    if (feedback !== undefined) {
      updates.feedback = String(feedback);
    }

    await subRef.set(updates, { merge: true });
    return res.json({ success: true });
  } catch (err) {
    console.error('🔥 Grade submission error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update submission.' });
  }
});

// ==== TEACHER ANALYTICS (JSON) ====
// GET /api/teacher/analytics?teacherId=...&classId=...
app.get('/api/teacher/analytics', async (req, res) => {
  try {
    const teacherId = String(req.query.teacherId || '').trim();
    const classId = req.query.classId ? String(req.query.classId) : null;
    if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

    const data = await buildTeacherAnalytics({ teacherId, classId });
    return res.json({
      success: true,
      gradeDistribution: data.charts.gradeDistribution,
      completionRate: data.charts.completionRate,
      atRisk: data.students,
      summary: data.summary
    });
  } catch (err) {
    console.error('🔥 /api/teacher/analytics error:', err);
    res.status(500).json({ success:false, message:'Failed to load analytics' });
  }
});

// ==== TEACHER ANALYTICS CSV ====
// GET /api/teacher/analytics/csv?teacherId=...&classId=...
app.get('/api/teacher/analytics/csv', async (req, res) => {
  try {
    const teacherId = String(req.query.teacherId || '').trim();
    const classId = req.query.classId ? String(req.query.classId) : null;
    if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

    const { summary, students } = await buildTeacherAnalytics({ teacherId, classId });

    const rows = [];
    rows.push(['Student','Student ID','Avg Score','Modules Completed','Modules Total','Time on Task (min)','Status']);
    students.forEach(s => rows.push([
      s.name,
      s.studentId,
      `${s.avgScore}`,
      `${s.modulesCompleted}`,
      `${s.modulesTotal}`,
      `${s.timeOnTaskMin}`,
      s.status
    ]));

    const csv = rows.map(r => r.map(v => {
      const val = String(v ?? '');
      return /[",\n]/.test(val) ? `"${val.replace(/"/g,'""')}"` : val;
    }).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="teacher_analytics_${teacherId}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('🔥 /api/teacher/analytics/csv error:', err);
    res.status(500).json({ success:false, message:'Failed to export CSV' });
  }
});

// ==== TEACHER ANALYTICS PDF ====
// GET /api/teacher/analytics/pdf?teacherId=...&classId=...
app.get('/api/teacher/analytics/pdf', async (req, res) => {
  try {
    const teacherId = String(req.query.teacherId || '').trim();
    const classId = req.query.classId ? String(req.query.classId) : null;
    if (!teacherId) return res.status(400).json({ success:false, message:'teacherId is required' });

    const { summary, students, charts } = await buildTeacherAnalytics({ teacherId, classId });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="teacher_analytics_${teacherId}.pdf"`);

    const doc = new PDFDocument({ size:'A4', margin: 36 });
    doc.pipe(res);

    // Header
    doc.fontSize(18).text('Analytics & Reporting', { align:'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#666').text(`Teacher: ${teacherId}`, { align:'left' });
    doc.moveDown();

    // Summary
    doc.fillColor('#000').fontSize(12).text('Summary', { underline:true });
    doc.moveDown(0.3);
    doc.text(`Average Score: ${summary.avgScore}%`);
    doc.text(`Overall Completion: ${summary.overallCompletion}%`);
    doc.text(`Total Students: ${summary.totalStudents}`);
    doc.moveDown();

    // Grade distribution
    const gd = charts.gradeDistribution;
    doc.fontSize(12).text('Grade Distribution', { underline:true });
    doc.fontSize(10);
    gd.labels.forEach((label, i) => {
      doc.text(`${label}: ${gd.datasets[0].data[i]}`);
    });
    doc.moveDown();

    // Table header
    const cols = ['Student','ID','Avg','Done/Total','Time (min)','Status'];
    doc.fontSize(12).text('Student Progress', { underline:true });
    doc.moveDown(0.2);
    doc.fontSize(9);
    doc.text(cols.join(' | '));
    doc.moveDown(0.2);
    doc.moveTo(doc.x, doc.y).lineTo(559, doc.y).stroke();

    // Rows (cap to keep it tidy)
    students.slice(0, 150).forEach(s => {
      doc.text(`${s.name} | ${s.studentId} | ${s.avgScore}% | ${s.modulesCompleted}/${s.modulesTotal} | ${s.timeOnTaskMin} | ${s.status}`);
    });

    doc.end();
  } catch (err) {
    console.error('🔥 /api/teacher/analytics/pdf error:', err);
    res.status(500).json({ success:false, message:'Failed to export PDF' });
  }
});

// ===== STUDENT PROGRESS (overall + per-course) =====
app.get('/api/students/:userId/progress', async (req, res) => {
  try {
    const { userId } = req.params;
    const userRef = firestore.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ success:false, message: 'Student not found.' });
    }

    // 1) Enrolled class IDs
    const enrollSnap = await userRef.collection('enrollments').get();
    const classIds = enrollSnap.docs.map(d => d.id);
    if (!classIds.length) {
      return res.json({ success:true, overall:{completed:0,total:0,percent:0}, subjects:[] });
    }

    // 2) Courses assigned to any of those classes (chunked by 10)
    const chunks = [];
    for (let i=0; i<classIds.length; i+=10) chunks.push(classIds.slice(i, i+10));

    const seenCourses = new Set();
    const courses = [];
    for (const ch of chunks) {
      const snap = await firestore.collection('courses')
        .where('assignedClasses', 'array-contains-any', ch)
        .get();
      snap.forEach(doc => {
        if (!seenCourses.has(doc.id)) {
          seenCourses.add(doc.id);
          const d = doc.data();
          courses.push({ id: doc.id, name: d.title || 'Course' });
        }
      });
    }

    if (!courses.length) {
      return res.json({ success:true, overall:{completed:0,total:0,percent:0}, subjects:[] });
    }

    // 3) For each course, count modules & student's completed modules
    let overallTotal = 0;
    let overallCompleted = 0;
    const subjects = [];

    await Promise.all(courses.map(async (c) => {
      const [modSnap, doneSnap] = await Promise.all([
        firestore.collection('modules').where('courseId','==', c.id).get(),
        userRef.collection('completedModules').where('courseId','==', c.id).get()
      ]);

      const total = modSnap.size;
      const completed = doneSnap.size;
      const percent = total ? Math.round((completed/total)*100) : 0;

      overallTotal += total;
      overallCompleted += completed;

      subjects.push({
        courseId: c.id,
        name: c.name,
        completed,
        total,
        percent
      });
    }));

    const overallPercent = overallTotal ? Math.round((overallCompleted/overallTotal)*100) : 0;

    return res.json({
      success: true,
      overall: { completed: overallCompleted, total: overallTotal, percent: overallPercent },
      subjects
    });
  } catch (err) {
    console.error('🔥 /api/students/:userId/progress error:', err);
    return res.status(500).json({ success:false, message:'Failed to compute progress.' });
  }
});

// ===== STUDENT BADGES =====
app.get('/api/students/:userId/badges', async (req, res) => {
  try {
    const { userId } = req.params;
    const userRef = firestore.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ success:false, message:'Student not found.' });
    }

    // Helper: get student's courses via enrollments -> assigned courses
    const enrollSnap = await userRef.collection('enrollments').get();
    const classIds = enrollSnap.docs.map(d => d.id);

    const chunks = [];
    for (let i=0; i<classIds.length; i+=10) chunks.push(classIds.slice(i, i+10));

    const courseIds = [];
    const seen = new Set();
    for (const ch of chunks) {
      const snap = await firestore.collection('courses')
        .where('assignedClasses', 'array-contains-any', ch)
        .get();
      snap.forEach(doc => { if (!seen.has(doc.id)) { seen.add(doc.id); courseIds.push(doc.id); } });
    }

    // ---- Badge: Quiz Whiz (best quiz >= 90%) ----
    let quizWhiz = false;
    try {
      const qaSnap = await userRef.collection('quizAttempts').get();
      qaSnap.forEach(doc => {
        const d = doc.data() || {};
        const best = typeof d.bestPercent === 'number'
          ? d.bestPercent
          : (d.bestScore?.percent ?? d.lastScore?.percent ?? 0);
        if (best >= 90) quizWhiz = true;
      });
    } catch {}

    // ---- Badge: On-Time Achiever (>=3 on-time assignment submissions) ----
    let onTimeCount = 0;
    if (courseIds.length) {
      const aChunks = [];
      for (let i=0; i<courseIds.length; i+=10) aChunks.push(courseIds.slice(i, i+10));

      for (const ids of aChunks) {
        const asSnap = await firestore.collection('assignments')
          .where('courseId', 'in', ids)
          .orderBy('publishAt', 'desc')
          .limit(50) // limit for perf
          .get();

        // Check student's submission vs dueAt
        for (const aDoc of asSnap.docs) {
          const a = aDoc.data() || {};
          const dueAtMs = a.dueAt?.toMillis?.() ?? null;
          const subDoc = await firestore
            .collection('assignments')
            .doc(aDoc.id)
            .collection('submissions')
            .doc(userId)
            .get();
          if (subDoc.exists && dueAtMs) {
            const sub = subDoc.data() || {};
            const submittedMs = sub.submittedAt?.toMillis?.() ?? null;
            if (submittedMs && submittedMs <= dueAtMs) onTimeCount++;
            if (onTimeCount >= 3) break; // early exit
          }
        }
        if (onTimeCount >= 3) break;
      }
    }
    const onTimeAchiever = onTimeCount >= 3;

    // ---- Badge: Module Master (overall completion >= 80% or >=10 modules) ----
    // Reuse the same logic as progress calculation quickly
    let totalModules = 0, completedModules = 0;
    if (courseIds.length) {
      await Promise.all(courseIds.map(async cid => {
        const [modSnap, doneSnap] = await Promise.all([
          firestore.collection('modules').where('courseId','==', cid).get(),
          userRef.collection('completedModules').where('courseId','==', cid).get()
        ]);
        totalModules += modSnap.size;
        completedModules += doneSnap.size;
      }));
    }
    const overallPct = totalModules ? Math.round((completedModules/totalModules)*100) : 0;
    const moduleMaster = (overallPct >= 80) || (completedModules >= 10);

    // Build badges list with your UI types
    const badges = [];
    if (onTimeAchiever) badges.push({ label: 'On-Time Achiever', type:'success' });
    if (quizWhiz)       badges.push({ label: 'Quiz Whiz',        type:'info' });
    if (moduleMaster)   badges.push({ label: 'Module Master',    type:'warning' });

    return res.json({ success:true, badges });
  } catch (err) {
    console.error('🔥 /api/students/:userId/badges error:', err);
    return res.status(500).json({ success:false, message:'Failed to compute badges.' });
  }
});

// ---------- API: Rewards summary ----------
app.get('/api/students/:userId/rewards', async (req, res) => {
  try {
    const { userId } = req.params;
    const userRef = firestore.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ success:false, message:'Student not found.' });

    // All-time points by default for profile header
    const totalPoints = await computePointsForUser(userId, { startMs: null, courseFilterIds: null });
    const streakDays = await computeStreakDays(userId);
    const recentBadges = await computeBadges(userId);
    const optIn = doc.data()?.leaderboardOptIn !== false;

    return res.json({ success:true, totalPoints, streakDays, recentBadges, optIn });
  } catch (err) {
    console.error('🔥 /api/students/:userId/rewards error:', err);
    return res.status(500).json({ success:false, message:'Failed to load rewards.' });
  }
});

// ---------- API: Opt-in/out for leaderboard ----------
app.patch('/api/students/:userId/leaderboard-optin', async (req, res) => {
  try {
    const { userId } = req.params;
    const { optIn } = req.body;
    if (typeof optIn !== 'boolean') {
      return res.status(400).json({ success:false, message:'optIn boolean is required.' });
    }
    await firestore.collection('users').doc(userId).set({ leaderboardOptIn: optIn }, { merge:true });
    return res.json({ success:true });
  } catch (err) {
    console.error('🔥 leaderboard opt-in error:', err);
    return res.status(500).json({ success:false, message:'Failed to update opt-in.' });
  }
});

// ---------- API: Leaderboard ----------
/*
  GET /api/leaderboard?userId=...&scope=class|subject&timeframe=all|month|week&subject=ICT
  Returns: { success, entries:[{ userId, name, points, topBadge }] }
*/
app.get('/api/leaderboard', async (req, res) => {
  try {
    const userId = String(req.query.userId || '');
    const scope = (req.query.scope || 'class').toString();
    const timeframe = (req.query.timeframe || 'all').toString();
    const subjectTitle = (req.query.subject || '').toString().trim();

    if (!userId) return res.status(400).json({ success:false, message:'userId required' });
    const startMs = timeframeToStartMs(timeframe);

    // 1) Determine peer set + optional course filter
    const classIds = await getEnrollmentsClassIds(userId);
    if (!classIds.length) return res.json({ success:true, entries: [] });

    let courseFilterIds = null;
    let peerClassIds = classIds.slice();

    if (scope === 'subject' && subjectTitle) {
      // courses with matching title attached to any of the student's classes
      const allCourses = await getCoursesForClassIds(classIds);
      const targetCourses = allCourses.filter(c => (c.title || '').toLowerCase() === subjectTitle.toLowerCase());
      courseFilterIds = targetCourses.map(c => c.id);

      // peers = students in any class that these courses are assigned to
      const classSet = new Set();
      targetCourses.forEach(c => (c.assignedClasses || []).forEach(id => classSet.add(id)));
      if (classSet.size) peerClassIds = Array.from(classSet);
    }

    // 2) Build peer userIds from class rosters
    const peerUserIdsSet = new Set();
    for (const cid of peerClassIds){
      const rosterSnap = await firestore.collection('classes').doc(cid).collection('roster').get();
      const rosterIds = rosterSnap.docs.map(d => d.id); // stored as studentId
      const mapped = await mapRosterIdsToUserIds(rosterIds);
      mapped.forEach(id => peerUserIdsSet.add(id));
    }
    // ensure current user included
    peerUserIdsSet.add(userId);
    const peerUserIds = Array.from(peerUserIdsSet);

    // 3) Compute points per user (respect opt-in)
    const entries = [];
    for (const uid of peerUserIds){
      try {
        const uDoc = await firestore.collection('users').doc(uid).get();
        if (!uDoc.exists) continue;
        const u = uDoc.data() || {};
        const optIn = u.leaderboardOptIn !== false;
        if (!optIn && uid !== userId) continue; // hide non-opt-in peers (always show self)

        const points = await computePointsForUser(uid, { startMs, courseFilterIds });
        // simple "top badge" indicator using same rules
        const badges = await computeBadges(uid);
        const topBadge = badges[0]?.label || '-';

        const name = (u.fullName && u.fullName.trim())
          ? u.fullName.trim()
          : `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || u.email || 'Student';

        entries.push({ userId: uid, name, points, topBadge });
      } catch {}
    }

    // 4) Sort and limit
    entries.sort((a,b)=> (b.points||0) - (a.points||0));
    return res.json({ success:true, entries: entries.slice(0, 50) });
  } catch (err) {
    console.error('🔥 /api/leaderboard error:', err);
    return res.status(500).json({ success:false, message:'Failed to build leaderboard.' });
  }
});

// ===== To-Do: assignments & quizzes due soon =====
app.get('/api/students/:userId/todo', async (req, res) => {
  try {
    const { userId } = req.params;
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    const courseIds = courses.map(c=>c.id);
    const now = Date.now();
    const soonMs = now + 14*24*60*60*1000; // next 2 weeks

    const items = [];

    // Assignments due
    for (const ids of chunk(courseIds, 10)){
      const aSnap = await firestore.collection('assignments')
        .where('courseId','in', ids)
        .orderBy('publishAt','desc')
        .limit(200)
        .get();
      for (const doc of aSnap.docs){
        const a = doc.data() || {};
        const due = a.dueAt?.toMillis?.() ?? null;
        if (!due || due < now || due > soonMs) continue;
        // skip if already submitted
        const mySub = await firestore.collection('assignments').doc(doc.id)
          .collection('submissions').doc(userId).get();
        if (mySub.exists) continue;

        const courseTitle = await getCourseTitle(a.courseId);
        const dueDate = new Date(due);
        const tag = (ymd(dueDate) === ymd(new Date())) ? 'Due Today'
                  : (ymd(dueDate) === ymd(new Date(Date.now()+86400000))) ? 'Tomorrow'
                  : dueDate.toLocaleDateString();
        items.push({
          type:'assignment',
          text:`${courseTitle}: ${a.title}`,
          dueAt: due,
          tag,
          tagClass: tag==='Due Today'?'warning':(tag==='Tomorrow'?'primary':'secondary')
        });
      }
    }

    // Quizzes due
    for (const ids of chunk(courseIds, 10)){
      const qSnap = await firestore.collection('quizzes')
        .where('courseId','in', ids)
        .orderBy('createdAt','desc')
        .limit(200)
        .get();
      for (const doc of qSnap.docs){
        const q = doc.data() || {};
        const due = q.dueAt?.toMillis?.() ?? null;
        if (!due || due < now || due > soonMs) continue;
        const courseTitle = await getCourseTitle(q.courseId);
        const dueDate = new Date(due);
        const tag = (ymd(dueDate) === ymd(new Date())) ? 'Due Today'
                  : (ymd(dueDate) === ymd(new Date(Date.now()+86400000))) ? 'Tomorrow'
                  : dueDate.toLocaleDateString();
        items.push({
          type:'quiz',
          text:`${courseTitle}: ${q.title}`,
          dueAt: due,
          tag,
          tagClass: tag==='Due Today'?'warning':(tag==='Tomorrow'?'primary':'secondary')
        });
      }
    }

    items.sort((a,b)=> (a.dueAt||0) - (b.dueAt||0));
    res.json({ success:true, items: items.slice(0, 20) });
  } catch (err) {
    console.error('🔥 /todo error:', err);
    res.status(500).json({ success:false, items:[] });
  }
});

// ===== Calendar: events between dates =====
app.get('/api/students/:userId/calendar', async (req, res) => {
  try {
    const { userId } = req.params;
    const start = new Date(String(req.query.start));
    const end   = new Date(String(req.query.end));
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ success:false, events:[] });
    }
    const startMs = start.getTime(), endMs = end.getTime() + 86399999;
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    const courseIds = courses.map(c=>c.id);

    const events = [];

    // Assignments (publish/due)
    for (const ids of chunk(courseIds,10)){
      const aSnap = await firestore.collection('assignments')
        .where('courseId','in', ids)
        .orderBy('publishAt','desc')
        .limit(200).get();
      for (const d of aSnap.docs){
        const a = d.data() || {};
        const title = `${await getCourseTitle(a.courseId)}: ${a.title}`;
        const pMs = a.publishAt?.toMillis?.(); if (pMs && pMs>=startMs && pMs<=endMs) events.push({ date: ymd(new Date(pMs)), label:'Release', title });
        const due = a.dueAt?.toMillis?.();     if (due && due>=startMs && due<=endMs) events.push({ date: ymd(new Date(due)), label:'Due', title });
      }
    }

    // Quizzes (due)
    for (const ids of chunk(courseIds,10)){
      const qSnap = await firestore.collection('quizzes')
        .where('courseId','in', ids)
        .orderBy('createdAt','desc')
        .limit(200).get();
      for (const d of qSnap.docs){
        const q = d.data() || {};
        const due = q.dueAt?.toMillis?.();
        if (due && due>=startMs && due<=endMs) {
          const title = `${await getCourseTitle(q.courseId)}: ${q.title}`;
          events.push({ date: ymd(new Date(due)), label:'Quiz', title });
        }
      }
    }

    res.json({ success:true, events });
  } catch (err) {
    console.error('🔥 /calendar error:', err);
    res.status(500).json({ success:false, events:[] });
  }
});

// ===== Notifications + preferences =====
app.get('/api/students/:userId/notifications', async (req, res) => {
  try {
    const { userId } = req.params;
    const userDoc = await firestore.collection('users').doc(userId).get();
    const prefs = {
      email: !!userDoc.data()?.notifyEmail,
      sms:   !!userDoc.data()?.notifySMS
    };
    const items = [];

    // recent announcements (already published)
    try {
      const enrollSnap = await firestore.collection('users').doc(userId).collection('enrollments').get();
      const classIds = enrollSnap.docs.map(d => d.id);
      for (const ids of chunk(classIds,10)){
        const snap = await firestore.collection('announcements')
          .where('classIds','array-contains-any', ids)
          .orderBy('publishAt','desc').limit(10).get();
        snap.forEach(d=>{
          const a = d.data() || {};
          const pub = a.publishAt?.toMillis?.();
          // published & not expired
          const now = Date.now();
          if (pub && pub <= now && (!a.expiresAt || a.expiresAt.toMillis() >= now)) {
            items.push({ icon:'bi-megaphone', text:`Announcement: ${a.title}`, at: pub });
          }
        });
      }
    } catch {}

    // recent grades (assignments)
    try {
      const gSnap = await firestore.collection('users').doc(userId).collection('assignmentGrades')
        .orderBy('gradedAt','desc').limit(10).get();
      gSnap.forEach(d=>{
        const g = d.data() || {};
        if (g.grade != null) items.push({ icon:'bi-star-fill', cls:'text-warning', text:`Grade posted: ${g.assignmentTitle} – ${g.grade}%`, at: g.gradedAt?.toMillis?.() || Date.now() });
      });
    } catch {}

    // recent quiz attempts
    try {
      const qaSnap = await firestore.collection('users').doc(userId).collection('quizAttempts').get();
      qaSnap.forEach(d=>{
        const q = d.data() || {};
        if (q.lastScore?.percent != null){
          items.push({ icon:'bi-patch-check', text:`Quiz submitted: ${q.lastScore.percent}%`, at: q.lastSubmittedAt?.toMillis?.() || Date.now() });
        }
      });
    } catch {}

    items.sort((a,b)=>(b.at||0)-(a.at||0));
    res.json({ success:true, items: items.slice(0,12), prefs });
  } catch (err) {
    console.error('🔥 /notifications error:', err);
    res.status(500).json({ success:false, items:[], prefs:{ email:false, sms:false }});
  }
});

app.patch('/api/students/:userId/notification-preferences', async (req, res) => {
  try {
    const { userId } = req.params;
    const { email, sms } = req.body || {};
    await firestore.collection('users').doc(userId).set({
      notifyEmail: !!email,
      notifySMS: !!sms
    }, { merge:true });
    res.json({ success:true });
  } catch (err) {
    console.error('🔥 /notification-preferences error:', err);
    res.status(500).json({ success:false });
  }
});

// ===== Library: modules across enrolled courses (search) =====
app.get('/api/students/:userId/library', async (req, res) => {
  try {
    const { userId } = req.params;
    const q = (req.query.query || '').toString().toLowerCase();
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    const courseIds = courses.map(c=>c.id);
    const courseMap = Object.fromEntries(courses.map(c=>[c.id, c.title || 'Subject']));

    const out = [];
    for (const ids of chunk(courseIds,10)){
      const snap = await firestore.collection('modules')
        .where('courseId','in', ids)
        .orderBy('moduleNumber','asc')
        .limit(200).get();
      snap.forEach(d=>{
        const m = d.data() || {};
        const title = m.title || `Module ${m.moduleNumber || ''}`;
        if (q && !title.toLowerCase().includes(q)) return;

        // provide a simple preview/download for file attachments (first one)
        let previewUrl = null, downloadUrl = null;
        if (Array.isArray(m.attachments) && m.attachments.length){
          const a0 = m.attachments[0];
          if (a0.filePath) {
            previewUrl = a0.filePath;
            downloadUrl = a0.filePath;
          } else if (a0.url) {
            previewUrl = a0.url;
          }
        }

        out.push({
          id: d.id,
          title,
          courseId: m.courseId,
          courseTitle: courseMap[m.courseId] || 'Subject',
          createdAt: m.createdAt?.toMillis?.() || null,
          isNew: (Date.now() - (m.createdAt?.toMillis?.() || 0)) < 7*24*60*60*1000,
          previewUrl,
          downloadUrl
        });
      });
    }
    res.json({ success:true, modules: out.slice(0, 100) });
  } catch (err) {
    console.error('🔥 /library error:', err);
    res.status(500).json({ success:false, modules:[] });
  }
});

// ===== Quizzes (upcoming list) =====
app.get('/api/students/:userId/quizzes-upcoming', async (req, res) => {
  try {
    const { userId } = req.params;
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    const courseIds = courses.map(c=>c.id);
    const now = Date.now();
    const out = [];
    for (const ids of chunk(courseIds,10)){
      const snap = await firestore.collection('quizzes')
        .where('courseId','in', ids)
        .orderBy('createdAt','desc')
        .limit(200).get();
      snap.forEach(d=>{
        const q = d.data() || {};
        const due = q.dueAt?.toMillis?.() ?? null;
        if (due && due < now) return; // show only upcoming or undated
        out.push({ id:d.id, title:q.title || 'Quiz', settings: q.settings || { timerEnabled:false } });
      });
    }
    res.json({ success:true, quizzes: out.slice(0, 50) });
  } catch (err) {
    console.error('🔥 /quizzes-upcoming error:', err);
    res.status(500).json({ success:false, quizzes:[] });
  }
});

// ===== Open assignments for quick submit select =====
app.get('/api/students/:userId/assignments-open', async (req, res) => {
  try {
    const { userId } = req.params;
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    const courseIds = courses.map(c=>c.id);
    const courseMap = Object.fromEntries(courses.map(c=>[c.id, c.title || 'Subject']));
    const now = Date.now();
    const out = [];

    for (const ids of chunk(courseIds,10)){
      const snap = await firestore.collection('assignments')
        .where('courseId','in', ids)
        .orderBy('publishAt','desc').limit(200).get();

      for (const d of snap.docs){
        const a = d.data() || {};
        const due = a.dueAt?.toMillis?.() ?? null;
        if (due && due < now) continue;
        const sub = await firestore.collection('assignments').doc(d.id)
          .collection('submissions').doc(userId).get();
        if (sub.exists) continue;
        out.push({ id:d.id, title:a.title || 'Assignment', courseTitle: courseMap[a.courseId] });
      }
    }
    res.json({ success:true, assignments: out.slice(0, 50) });
  } catch (err) {
    console.error('🔥 /assignments-open error:', err);
    res.status(500).json({ success:false, assignments:[] });
  }
});

// ===== Recent feedback snippet =====
app.get('/api/students/:userId/recent-feedback', async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await firestore.collection('users').doc(userId)
      .collection('assignmentGrades').orderBy('gradedAt','desc').limit(5).get();
    const items = snap.docs.map(d=>{
      const x = d.data() || {};
      return { title: x.assignmentTitle || 'Assignment', feedback: x.feedback || '' };
    });
    res.json({ success:true, items });
  } catch (err) {
    console.error('🔥 /recent-feedback error:', err);
    res.status(500).json({ success:false, items:[] });
  }
});

// ===== Grades feed (quiz + assignment) =====
app.get('/api/students/:userId/grades', async (req, res) => {
  try {
    const { userId } = req.params;
    const days = Math.max(1, parseInt(req.query.days || '30', 10));
    const subjectFilter = (req.query.subject || 'All').toString().toLowerCase();
    const cutoff = Date.now() - days*24*60*60*1000;

    // build course map
    const classIds = await getEnrollmentsClassIds(userId);
    const courses = await getCoursesForClassIds(classIds);
    const courseMap = Object.fromEntries(courses.map(c=>[c.id, c.title || 'Subject']));

    const items = [];

    // assignment grades
    try {
      const gSnap = await firestore.collection('users').doc(userId)
        .collection('assignmentGrades')
        .orderBy('gradedAt','desc').limit(300).get();
      gSnap.forEach(d=>{
        const g = d.data() || {};
        const at = g.gradedAt?.toMillis?.() || g.dueAt?.toMillis?.() || Date.now();
        if (at < cutoff) return;
        const subject = courseMap[g.courseId] || 'Subject';
        if (subjectFilter !== 'all' && subject.toLowerCase() !== subjectFilter) return;
        if (typeof g.grade === 'number') {
          items.push({ date: new Date(at).toISOString(), subject, activity: g.assignmentTitle || 'Assignment', score: Math.round(g.grade) });
        }
      });
    } catch {}

    // quiz attempts: use lastSubmittedAt + percent
    try {
      const qaSnap = await firestore.collection('users').doc(userId).collection('quizAttempts').get();
      qaSnap.forEach(d=>{
        const q = d.data() || {};
        const at = q.lastSubmittedAt?.toMillis?.() || 0;
        if (!at || at < cutoff) return;
        const subject = courseMap[q.courseId] || 'Subject';
        if (subjectFilter !== 'all' && subject.toLowerCase() !== subjectFilter) return;
        const pct = q.lastScore?.percent ?? q.bestPercent ?? null;
        if (pct != null) items.push({ date: new Date(at).toISOString(), subject, activity: 'Quiz', score: Math.round(pct) });
      });
    } catch {}

    // collect subject list
    const subjects = Array.from(new Set(Object.values(courseMap)));

    // sort by date desc & clip
    items.sort((a,b)=> new Date(b.date) - new Date(a.date));
    res.json({ success:true, items: items.slice(0, 200), subjects });
  } catch (err) {
    console.error('🔥 /grades error:', err);
    res.status(500).json({ success:false, items:[], subjects:[] });
  }
});

// ==== START SERVER ====
app.listen(process.env.PORT || 5000, () => {
  console.log(`🚀 Server running on port ${process.env.PORT || 5000}`);
});