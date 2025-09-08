// ==== config/firebase.js ==== //
const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require(path.join(__dirname, '../../firebase-key.json'));

// Prefer env var if set; otherwise default to <project-id>.appspot.com
const STORAGE_BUCKET =
  process.env.FB_STORAGE_BUCKET ||
  (serviceAccount.project_id ? `${serviceAccount.project_id}.appspot.com` : undefined);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    ...(STORAGE_BUCKET ? { storageBucket: STORAGE_BUCKET } : {}),
  });
}

const firestore = admin.firestore();
const storage = admin.storage();          // <— add this
const bucket = storage.bucket();          // <— handy export

module.exports = { admin, firestore, storage, bucket };
