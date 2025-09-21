// backend/config/firebase.js
'use strict';

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

/* -------------------- helpers -------------------- */
function parseCreds(raw) {
  const obj = JSON.parse(raw);
  // Fix escaped newlines in env-provided private_key
  if (obj.private_key && typeof obj.private_key === 'string') {
    obj.private_key = obj.private_key.replace(/\\n/g, '\n');
  }
  return obj;
}

/* -------------------- credential loading -------------------- */
function loadCreds() {
  const rawEnv =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (rawEnv) return parseCreds(rawEnv);

  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gacPath && fs.existsSync(gacPath)) {
    return parseCreds(fs.readFileSync(gacPath, 'utf8'));
  }

  const localPath = path.join(__dirname, '../../firebase-key.json');
  if (fs.existsSync(localPath)) {
    return parseCreds(fs.readFileSync(localPath, 'utf8'));
  }

  throw new Error('No service account creds: set FIREBASE_SERVICE_ACCOUNT_JSON or provide firebase-key.json');
}

/* -------------------- initialize (unless skipped) -------------------- */
let initialized = false;
let firestore, bucket;

if (!admin.apps.length && process.env.SKIP_FIREBASE !== '1') {
  const creds = loadCreds();

  // Force projectId explicitly (prevents UNAUTHENTICATED from ADC confusion)
  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    creds.project_id;

  if (!projectId) {
    throw new Error('Missing projectId for Firebase Admin initialization.');
  }

  const storageBucket =
    process.env.FIREBASE_STORAGE_BUCKET ||
    process.env.FB_STORAGE_BUCKET ||
    `${projectId}.appspot.com`;

  admin.initializeApp({
    credential: admin.credential.cert(creds),
    projectId,
    storageBucket,
  });

  try {
    admin.firestore().settings({ ignoreUndefinedProperties: true });
  } catch { /* older SDKs may throw if called twice; safe to ignore */ }

  firestore = admin.firestore();
  bucket = admin.storage().bucket();
  initialized = true;
} else {
  // If init was skipped, export stubs that clearly error on use
  firestore = new Proxy({}, { get() { throw new Error('[firebase] Not initialized'); } });
  bucket = new Proxy({}, { get() { throw new Error('[firebase] Not initialized'); } });
}

/* -------------------- exports -------------------- */
const FieldValue = admin.firestore.FieldValue;
const Timestamp  = admin.firestore.Timestamp;

module.exports = {
  admin,          // firebase-admin app & SDK
  firestore,      // Firestore INSTANCE (has .collection)
  bucket,         // Default Storage bucket
  FieldValue,
  Timestamp,
  initialized,
};
