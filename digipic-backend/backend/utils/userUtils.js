// utils/userUtils.js
const { firestore } = require('../config/firebase');

/** Resolve users/{doc} by email → returns DocumentReference or null */
async function getUserRefByEmail(email) {
  if (!email) return null;
  const snap = await firestore
    .collection('users')
    .where('email', '==', String(email).trim())
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].ref;
}

module.exports = { getUserRefByEmail };
