// utils/fieldCrypto.js
'use strict';
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function parseKey(str) {
  const raw = (str || '').trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const b = Buffer.from(raw, 'hex');
    if ([16, 24, 32].includes(b.length)) return b;
  }
  try {
    const b = Buffer.from(raw, 'base64');
    if ([16, 24, 32].includes(b.length)) return b;
  } catch {}
  return null;
}

function getKeyRing() {
  const raw = (process.env.PII_ENC_KEYS || process.env.PII_ENC_KEY || '').trim();
  if (!raw) {
    console.warn('[fieldCrypto] Missing PII_ENC_KEYS / PII_ENC_KEY');
    return [];
  }
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const keys = parts.map(parseKey).filter(Boolean);
  if (keys.length === 0) {
    console.warn('[fieldCrypto] No valid keys parsed (need 16/24/32 bytes in hex or base64).');
  }
  return keys;
}

const KEY_RING = getKeyRing();
const KEY_PRIMARY = KEY_RING[0] || null; // encryption will throw if missing

function encryptField(v) {
  if (v === undefined || v === null) return '';
  if (!KEY_PRIMARY) throw new Error('[fieldCrypto] No encryption key configured.');
  const plain = String(v);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY_PRIMARY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const outHex = Buffer.concat([enc, tag]).toString('hex'); // enc||tag
  return `${outHex}:${iv.toString('hex')}`;
}

function decryptWithKey(bufEnc, bufTag, bufIv, key) {
  const d = crypto.createDecipheriv(ALGO, key, bufIv);
  d.setAuthTag(bufTag);
  return Buffer.concat([d.update(bufEnc), d.final()]);
}

/** Strict decrypt: returns plaintext if token doesn't *look* encrypted; throws on real failures. */
function decryptField(token) {
  if (!token) return '';
  const s = String(token);
  const parts = s.split(':');

  // current hex format
  if (parts.length === 2 && /^[0-9a-fA-F]+$/.test(parts[0]) && /^[0-9a-fA-F]+$/.test(parts[1])) {
    const data = Buffer.from(parts[0], 'hex');
    const iv   = Buffer.from(parts[1], 'hex');
    if (iv.length !== 12) throw new Error('Invalid IV length for hex format (expected 12)');
    if (data.length < 16) throw new Error('Cipher data too short');

    const tag = data.slice(-16);
    const enc = data.slice(0, -16);

    let lastErr;
    for (const key of KEY_RING) {
      try { return decryptWithKey(enc, tag, iv, key).toString('utf8'); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No keys available for decrypt');
  }

  // legacy base64 format
  if (parts.length === 3) {
    const [ivB64, ctB64, tagB64] = parts;
    const iv  = Buffer.from(ivB64, 'base64');
    const enc = Buffer.from(ctB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== 12)  throw new Error('Invalid IV length for base64 format (expected 12)');
    if (tag.length !== 16) throw new Error('Invalid tag length for base64 format (expected 16)');

    let lastErr;
    for (const key of KEY_RING) {
      try { return decryptWithKey(enc, tag, iv, key).toString('utf8'); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No keys available for decrypt (legacy)');
  }

  // plain string
  return s;
}

// throttled safe wrapper
let warnCount = 0;
let suppressed = false;
const MAX_WARN   = parseInt(process.env.PII_ENC_MAX_WARN || '10', 10);
const LOG_ENABLED = String(process.env.PII_ENC_LOG || '1') !== '0';

function safeDecrypt(token, fallback = '') {
  try { return decryptField(token); }
  catch (e) {
    if (LOG_ENABLED && !suppressed) {
      warnCount++;
      if (warnCount <= MAX_WARN) {
        console.warn('[fieldCrypto] decrypt failed:', e.message);
        if (warnCount === MAX_WARN) {
          suppressed = true;
          console.warn('[fieldCrypto] further decrypt warnings suppressed…');
        }
      }
    }
    return fallback;
  }
}

/**
 * 🔒 preferDecrypt(enc, plain='')
 * If an encrypted value is present, try to decrypt; on failure fall back to the separate
 * plaintext value. If no enc is present, just return the plaintext.
 */
function preferDecrypt(enc, plain = '') {
  if (enc) {
    const v = safeDecrypt(enc, null);
    if (v != null && v !== '') return v;
  }
  return String(plain || '');
}

/* Optional name convenience */
function deriveNameFallback({ fullName, username, email } = {}) {
  const f = (fullName || '').trim();
  if (f) {
    const parts = f.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return { first: parts[0], last: parts.slice(1).join(' ') };
    return { first: parts[0] || '', last: '' };
  }
  if (username) return { first: String(username), last: '' };
  if (email)    return { first: String(email).split('@')[0], last: '' };
  return { first: '', last: '' };
}

module.exports = {
  encryptField,
  decryptField,
  safeDecrypt,
  preferDecrypt,           // <<—— use this in routes
  deriveNameFallback,
  __hasPrimaryKey: !!KEY_PRIMARY,
  __keyCount: KEY_RING.length,
};
