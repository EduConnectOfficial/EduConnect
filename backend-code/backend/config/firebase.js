// backend/config/firebase.js
'use strict';

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

/* -------------------- helpers -------------------- */
function parseCreds(raw) {
  const obj = JSON.parse(raw);
  if (obj.private_key && typeof obj.private_key === 'string') {
    // Fix escaped newlines from environment variables
    obj.private_key = obj.private_key.replace(/\\n/g, '\n');
  }
  return obj;
}

/**
 * Build creds object from discrete env vars
 * (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)
 */
function credsFromDiscrete() {
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey    = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    // Handle \n in the env var representation
    privateKey = privateKey.replace(/\\n/g, '\n');
    return {
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey,
    };
  }
  return null;
}

/* -------------------- credential loading -------------------- */
function loadCreds() {
  // 0) Base64 blob (Railway-friendly)
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    const raw = Buffer.from(b64, 'base64').toString('utf8');
    return parseCreds(raw);
  }

  // 1) Full JSON as string env var
  const rawEnv =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (rawEnv) return parseCreds(rawEnv);

  // 2) Discrete env vars
  const discrete = credsFromDiscrete();
  if (discrete) return discrete;

  // 3) File path from GOOGLE_APPLICATION_CREDENTIALS
  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gacPath && fs.existsSync(gacPath)) {
    return parseCreds(fs.readFileSync(gacPath, 'utf8'));
  }

  // 4) Local dev file
  const localPath = path.join(__dirname, '../../firebase-key.json');
  if (fs.existsSync(localPath)) {
    return parseCreds(fs.readFileSync(localPath, 'utf8'));
  }

  throw new Error(
    'No service account creds found. Provide FIREBASE_SERVICE_ACCOUNT_B64, ' +
    'FIREBASE_SERVICE_ACCOUNT_JSON, discrete env vars, GOOGLE_APPLICATION_CREDENTIALS, or firebase-key.json'
  );
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
  } catch {
    // older SDKs may throw if called twice; safe to ignore
  }

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
  firestore,      // Firestore instance
  bucket,         // Default Storage bucket
  FieldValue,
  Timestamp,
  initialized,
};
