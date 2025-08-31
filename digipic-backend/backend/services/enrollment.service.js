// ==== services/enrollment.service.js ==== //
const { firestore, admin } = require('../config/firebase');

async function enrollStudentIdempotent(classId, studentId) {
  const sid = String(studentId).trim();

  const userSnap = await firestore.collection('users').where('studentId', '==', sid).limit(1).get();
  if (userSnap.empty) return { ok: false, reason: 'not_found' };

  const userDoc = userSnap.docs[0];
  const u = userDoc.data();
  const userDocId = userDoc.id;

  const classRef = firestore.collection('classes').doc(classId);
  const classDoc = await classRef.get();
  if (!classDoc.exists) return { ok: false, reason: 'class_not_found' };
  const c = classDoc.data();

  const rosterRef = classRef.collection('roster').doc(sid);
  const enrollmentRef = firestore.collection('users').doc(userDocId).collection('enrollments').doc(classId);

  let alreadyEnrolled = false;

  await firestore.runTransaction(async (tx) => {
    const rosterDoc = await tx.get(rosterRef);
    if (rosterDoc.exists) {
      alreadyEnrolled = true;
      return;
    }

    tx.set(
      rosterRef,
      {
        studentId: sid,
        fullName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
        email: u.email || '',
        photoURL: u.photoURL || '',
        active: u.active !== false,
        enrolledAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.update(classRef, { students: admin.firestore.FieldValue.increment(1) });

    tx.set(
      enrollmentRef,
      {
        classId,
        name: c.name || '',
        gradeLevel: c.gradeLevel || '',
        section: c.section || '',
        schoolYear: c.schoolYear || '',
        semester: c.semester || '',
        teacherId: c.teacherId || '',
        enrolledAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return { ok: true, alreadyEnrolled };
}

module.exports = { enrollStudentIdempotent };
