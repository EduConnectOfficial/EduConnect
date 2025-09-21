// ==== config/firebase.js ====
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function loadServiceAccount() {
  // Prefer env var (Railway)
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw) {
    try { return JSON.parse(raw); }
    catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  }

  // Fallback for local dev: read ./firebase-key.json if present
  const filePath = path.join(__dirname, '../../firebase-key.json');
  if (fs.existsSync(filePath)) {
    return require(filePath);
  }

  throw new Error('No Firebase credentials found (set FIREBASE_SERVICE_ACCOUNT_JSON or add firebase-key.json)');
}

const creds = loadServiceAccount();

// Choose storage bucket: env wins, else derive from project_id
const STORAGE_BUCKET =
  process.env.FIREBASE_STORAGE_BUCKET ||
  process.env.FB_STORAGE_BUCKET ||
  (creds.project_id ? `${creds.project_id}.appspot.com` : undefined);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(creds),
    ...(STORAGE_BUCKET ? { storageBucket: STORAGE_BUCKET } : {}),
  });
}

const firestore = admin.firestore();
const storage = admin.storage();
const bucket = storage.bucket();

module.exports = { admin, firestore, storage, bucket };
