const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function loadCreds() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw) {
    try { return JSON.parse(raw); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON'); }
  }
  const p = path.join(__dirname, '../../firebase-key.json');
  if (fs.existsSync(p)) return require(p);
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing and firebase-key.json not found');
}

if (!admin.apps.length && process.env.SKIP_FIREBASE !== '1') {
  const creds = loadCreds();
  const bucket =
    process.env.FIREBASE_STORAGE_BUCKET ||
    process.env.FB_STORAGE_BUCKET ||
    (creds.project_id ? `${creds.project_id}.appspot.com` : undefined);

  admin.initializeApp({
    credential: admin.credential.cert(creds),
    ...(bucket ? { storageBucket: bucket } : {}),
  });
}

module.exports = admin;
