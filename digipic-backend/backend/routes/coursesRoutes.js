// ==== routes/coursesRoutes.js ==== //
const router = require('express').Router();
const path = require('path');
const fs = require('fs/promises');

const { asyncHandler } = require('../middleware/asyncHandler');
const { firestore, admin } = require('../config/firebase');

/* ---------------------------------------
   Helpers
---------------------------------------- */

function tsToMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) {
    return ts._seconds * 1000 + (ts._nanoseconds ? Math.floor(ts._nanoseconds / 1e6) : 0);
  }
  const n = Number(ts);
  if (!Number.isNaN(n)) return n;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

async function getNextCourseNumber(uploadedBy) {
  try {
    const snap = await firestore
      .collection('courses')
      .where('uploadedBy', '==', uploadedBy)
      .orderBy('courseNumber', 'desc')
      .limit(1)
      .get();

    if (snap.empty) return 1;
    const max = Number(snap.docs[0].data().courseNumber || 0);
    return max + 1;
  } catch {
    // Fallback if composite index missing: count user's courses
    const snap = await firestore.collection('courses').where('uploadedBy', '==', uploadedBy).get();
    return (snap.size || 0) + 1;
  }
}

async function renumberUserCourses(uploadedBy) {
  const snap = await firestore.collection('courses').where('uploadedBy', '==', uploadedBy).get();
  if (snap.empty) return;

  const list = snap.docs
    .map(d => ({ ref: d.ref, id: d.id, data: d.data() }))
    .sort((a, b) => {
      const am = tsToMillis(a.data.createdAt);
      const bm = tsToMillis(b.data.createdAt);
      if (am !== bm) return am - bm;
      return a.id.localeCompare(b.id);
    });

  let n = 1;
  const chunkSize = 400;
  for (let i = 0; i < list.length; i += chunkSize) {
    const batch = firestore.batch();
    list.slice(i, i + chunkSize).forEach(item => batch.update(item.ref, { courseNumber: n++ }));
    await batch.commit();
  }
}

/**
 * Delete any local files referenced by a document's fields if they look like "/uploads/...".
 * Adjust the detection if your schema uses different fields.
 */
async function maybeDeleteLocalFilesFromDoc(docData) {
  if (!docData || typeof docData !== 'object') return;
  const candidates = [];

  // Scan all string fields for /uploads/ pattern
  for (const [k, v] of Object.entries(docData)) {
    if (typeof v === 'string' && /(^\/?uploads\/)/i.test(v)) {
      candidates.push(v);
    }
  }

  // Also scan common nested arrays/objects for file paths
  for (const [k, v] of Object.entries(docData)) {
    if (Array.isArray(v)) {
      v.forEach(item => {
        if (item && typeof item === 'object') {
          for (const val of Object.values(item)) {
            if (typeof val === 'string' && /(^\/?uploads\/)/i.test(val)) candidates.push(val);
          }
        }
      });
    } else if (v && typeof v === 'object') {
      for (const val of Object.values(v)) {
        if (typeof val === 'string' && /(^\/?uploads\/)/i.test(val)) candidates.push(val);
      }
    }
  }

  // Dedup and delete
  const unique = Array.from(new Set(candidates));
  for (const rel of unique) {
    const relClean = rel.replace(/^\/+/, ''); // strip leading slash
    const abs = path.join(__dirname, '..', relClean);
    try {
      await fs.unlink(abs);
      // eslint-disable-next-line no-console
      console.log('🗑️  Deleted file:', abs);
    } catch {
      // ignore missing files
    }
  }
}

/**
 * Recursively delete all subcollections for a given docRef.
 * Depth-first: delete subcollections (and their docs) first, then caller can delete the doc.
 */
async function deleteAllSubcollections(docRef) {
  const subcols = await docRef.listCollections();
  for (const col of subcols) {
    // Delete all docs in this subcollection (and their subcollections) in chunks
    let after = null;
    const pageSize = 400;
    // We page through collection – no query constraints here
    while (true) {
      let q = col.limit(pageSize);
      if (after) q = q.startAfter(after);
      const snap = await q.get();
      if (snap.empty) break;

      for (const d of snap.docs) {
        // Recurse into sub-subcollections first
        await deleteAllSubcollections(d.ref);
        // Delete any local files referenced
        await maybeDeleteLocalFilesFromDoc(d.data());
      }

      const batch = firestore.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();

      after = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < pageSize) break;
    }
  }
}

/**
 * Delete all docs in a top-level collection where `field == value`, including:
 *  - every matched doc's subcollections (recursively)
 *  - local /uploads/... files referenced in those docs
 */
async function cascadeDeleteByQuery(collectionName, field, value) {
  const pageSize = 400;
  while (true) {
    const snap = await firestore
      .collection(collectionName)
      .where(field, '==', value)
      .limit(pageSize)
      .get();

    if (snap.empty) break;

    // Prepare: subcollections + any referenced local files
    for (const d of snap.docs) {
      await deleteAllSubcollections(d.ref);
      await maybeDeleteLocalFilesFromDoc(d.data());
    }

    const batch = firestore.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();

    if (snap.docs.length < pageSize) break;
  }
}

/**
 * Given classIds, returns { activeIds, archivedIds, missingIds }
 */
async function splitClassIdsByArchived(classIds) {
  const activeIds = [];
  const archivedIds = [];
  const missingIds = [];

  const chunk = (arr, size = 10) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  const classesCol = firestore.collection('classes');
  for (const ids of chunk(classIds, 10)) {
    const snap = await classesCol.where('__name__', 'in', ids).get();
    const found = new Set();
    snap.forEach(doc => {
      found.add(doc.id);
      const d = doc.data() || {};
      if (d.archived === true) archivedIds.push(doc.id);
      else activeIds.push(doc.id);
    });
    ids.forEach(id => {
      if (!found.has(id)) missingIds.push(id);
    });
  }

  return { activeIds, archivedIds, missingIds };
}

/* ---------------------------------------
   Routes
---------------------------------------- */

// ==== COURSE: CREATE (per-user numbering) ====
// POST /upload-course
router.post('/upload-course', asyncHandler(async (req, res) => {
  const { title, category, description, uploadedBy } = req.body;
  let { assignedClasses } = req.body;

  if (!title || !category || !description || !uploadedBy) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  if (!Array.isArray(assignedClasses)) assignedClasses = [];
  assignedClasses = assignedClasses
    .filter(x => typeof x === 'string' && x.trim() !== '')
    .map(x => x.trim());

    
// Filter out archived/missing classes
let skipped = { archived: [], missing: [] };
if (assignedClasses.length) {
  const { activeIds, archivedIds, missingIds } = await splitClassIdsByArchived(assignedClasses);
  skipped = { archived: archivedIds, missing: missingIds };
  assignedClasses = activeIds;
}

  const owner = String(uploadedBy).trim();
  const nextCourseNumber = await getNextCourseNumber(owner);

  const newCourse = {
    title: String(title).trim(),
    category: String(category).trim(),
    description: String(description).trim(),
    uploadedBy: owner,
    assignedClasses,
    courseNumber: nextCourseNumber,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const newDoc = await firestore.collection('courses').add(newCourse);
  return res.status(200).json({
    success: true,
    id: newDoc.id,
    courseNumber: nextCourseNumber,
    assignedClasses,
     skipped
  });
}));

// ==== COURSES: LIST (optionally filter by uploadedBy) ====
// GET /courses?uploadedBy=<userId>
router.get('/courses', asyncHandler(async (req, res) => {
  const uploadedBy = String(req.query.uploadedBy || '').trim();

  let q = firestore.collection('courses');
  if (uploadedBy) q = q.where('uploadedBy', '==', uploadedBy);
  q = q.orderBy('createdAt', 'desc');

  let snapshot;
  try {
    snapshot = await q.get();
  } catch {
    // fallback if index missing
    if (uploadedBy) {
      snapshot = await firestore.collection('courses').where('uploadedBy', '==', uploadedBy).get();
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
      assignedClasses: data.assignedClasses || [],
    };
  });

  res.json(courses);
}));

// ==== COURSE: GET BY ID ====
// GET /courses/:id
router.get('/courses/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await firestore.collection('courses').doc(id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Course not found.' });
  res.json({ id: doc.id, ...doc.data() });
}));

// ==== COURSE: UPDATE ====
// PUT /courses/:id
// body: { title, category, description, assignedClasses? }
router.put('/courses/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, category, description, assignedClasses, uploadedBy } = req.body;

  if (uploadedBy != null) {
    return res.status(400).json({ success: false, message: 'uploadedBy cannot be changed.' });
  }
  if (!title || !category) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  const updateData = {
    title: String(title).trim(),
    category: String(category).trim(),
    description: (description ?? '').toString(),
  };

  if (Array.isArray(assignedClasses)) {
    updateData.assignedClasses = assignedClasses
      .filter(x => typeof x === 'string' && x.trim() !== '')
      .map(x => x.trim());
  }

  await firestore.collection('courses').doc(id).update(updateData);
  res.json({ success: true });
}));

// ==== COURSE: DELETE (deep cascade + renumber owner) ====
// DELETE /courses/:id
router.delete('/courses/:id', asyncHandler(async (req, res) => {
  const courseId = req.params.id;

  // 0) Load course and remember owner
  const courseRef = firestore.collection('courses').doc(courseId);
  const courseDoc = await courseRef.get();
  if (!courseDoc.exists) {
    return res.status(404).json({ success: false, message: 'Course not found.' });
  }
  const owner = String(courseDoc.data().uploadedBy || '').trim();

  // 1) Define all top-level collections that reference courseId
  //    Add or remove items here to match your app’s data model.
  const CASCADING_COLLECTIONS = [
    { name: 'modules',      field: 'courseId' },
    { name: 'quizzes',      field: 'courseId' },
    { name: 'assignments',  field: 'courseId' },
    { name: 'resources',    field: 'courseId' },
    { name: 'announcements',field: 'courseId' },
    { name: 'discussions',  field: 'courseId' },
    { name: 'submissions',  field: 'courseId' },
    { name: 'grades',       field: 'courseId' },
    // add any other collections that carry courseId
  ];

  // 2) For each related collection:
  //    - delete subcollections for each matched doc
  //    - delete any local /uploads/... files referenced
  //    - delete the docs in batches
  for (const { name, field } of CASCADING_COLLECTIONS) {
    await cascadeDeleteByQuery(name, field, courseId);
  }

  // 3) Delete subcollections that live directly under the course doc (if any),
  //    plus any local files referenced on the course doc itself.
  await deleteAllSubcollections(courseRef);
  await maybeDeleteLocalFilesFromDoc(courseDoc.data());

  // 4) Finally delete the course document
  await courseRef.delete();

  // 5) Renumber ONLY this user's courses
  if (owner) {
    await renumberUserCourses(owner);
  }

  res.json({ success: true, message: 'Course and all related data deleted. User courses renumbered.' });
}));

// ==== COURSES ASSIGNED TO A CLASS ====
// GET /api/classes/:id/courses
router.get('/api/classes/:id/courses', asyncHandler(async (req, res) => {
  const classId = req.params.id;
  const includeArchived = String(req.query.archived || '').toLowerCase() === 'include';

  const classDoc = await firestore.collection('classes').doc(classId).get();
  if (!classDoc.exists) {
    return res.status(404).json({ success: false, message: 'Class not found.' });
  }
  if (classDoc.data().archived === true && !includeArchived) {
    return res.status(403).json({ success: false, message: 'Class is archived.' });
  }

  const snap = await firestore
    .collection('courses')
    .where('assignedClasses', 'array-contains', classId)
    .get();

  const courses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return res.json({ success: true, courses });
}));


module.exports = router;
