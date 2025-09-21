// backend/config/firebase.js
'use strict';

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

/* -------------------- credential loading -------------------- */
function loadCreds() {
  // Raw JSON in env (preferred on Railway/Vercel)
  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (raw) {
    try { return JSON.parse(raw); }
    catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON/GOOGLE_APPLICATION_CREDENTIALS_JSON is invalid JSON');
    }
  }

  // Path to a JSON file via GOOGLE_APPLICATION_CREDENTIALS
  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gacPath && fs.existsSync(gacPath)) {
    return JSON.parse(fs.readFileSync(gacPath, 'utf8'));
  }

  // Local fallback
  const localPath = path.join(__dirname, '../../firebase-key.json');
  if (fs.existsSync(localPath)) return require(localPath);

  throw new Error('No service account creds: set FIREBASE_SERVICE_ACCOUNT_JSON or provide firebase-key.json');
}

/* -------------------- initialize (unless skipped) -------------------- */
let initialized = false;
if (!admin.apps.length && process.env.SKIP_FIREBASE !== '1') {
  const creds = loadCreds();

  const storageBucket =
    process.env.FIREBASE_STORAGE_BUCKET ||
    process.env.FB_STORAGE_BUCKET ||
    (creds.project_id ? `${creds.project_id}.appspot.com` : undefined);

  admin.initializeApp({
    credential: admin.credential.cert(creds),
    ...(storageBucket ? { storageBucket } : {}),
  });

  // Helpful Firestore setting for Node backends
  try {
    admin.firestore().settings({ ignoreUndefinedProperties: true });
  } catch { /* older SDKs may throw if called twice; safe to ignore */ }

  initialized = true;
}

/* -------------------- exports -------------------- */
// If init was skipped, export safe stubs that error clearly on use
function requiredInit(fnName) {
  throw new Error(`[firebase] Attempted to use ${fnName} before Firebase was initialized. Set SKIP_FIREBASE!=1 and provide service account creds.`);
}

const firestore = initialized ? admin.firestore() : new Proxy({}, {
  get() { requiredInit('firestore'); }
});

const bucket = initialized
  ? admin.storage().bucket()
  : new Proxy({}, { get() { requiredInit('storage bucket'); } });

// Re-export some common helpers for convenience
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
