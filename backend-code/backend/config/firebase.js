// ==== config/firebase.js ==== //
const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require(path.join(__dirname, '../../firebase-key.json'));

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const firestore = admin.firestore();

module.exports = { admin, firestore };
