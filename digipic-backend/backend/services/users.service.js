// ==== services/users.service.js ==== //
const { firestore } = require('../config/firebase');

async function getUserRefByEmail(email) {
  const snap = await firestore.collection('users').where('email', '==', email).limit(1).get();
  return snap.empty ? null : snap.docs[0].ref;
}

async function getUserRefByAnyId(idOrStudentId) {
  if (!idOrStudentId) return null;
  const directRef = firestore.collection('users').doc(idOrStudentId);
  const directSnap = await directRef.get();
  if (directSnap.exists) return directRef;

  const q = await firestore.collection('users').where('studentId', '==', idOrStudentId).limit(1).get();
  return q.empty ? null : q.docs[0].ref;
}

module.exports = { getUserRefByEmail, getUserRefByAnyId };
