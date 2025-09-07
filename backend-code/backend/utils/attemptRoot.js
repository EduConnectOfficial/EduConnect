// utils/attemptRoot.js
const { firestore } = require('../config/firebase');

/**
 * Find the quizAttempts root doc for (user, quiz).
 * Prefer doc id = quizId; fall back to any legacy doc with { quizId }.
 */
async function locateAttemptRoot(userRef, quizId) {
  const direct = userRef.collection('quizAttempts').doc(quizId);
  const directSnap = await direct.get();
  if (directSnap.exists) return direct;

  const q = await userRef.collection('quizAttempts')
    .where('quizId', '==', quizId)
    .limit(1).get();
  if (!q.empty) return q.docs[0].ref;

  // nothing exists yet → use the new schema
  return direct;
}

module.exports = { locateAttemptRoot };
