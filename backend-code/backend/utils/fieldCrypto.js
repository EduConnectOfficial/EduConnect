// utils/fieldCrypto.js
'use strict';
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

// ---------- Logging (rate-limited) ----------
const LOG_LEVEL = (process.env.FIELDCRYPTO_LOG_LEVEL || 'warn').toLowerCase(); // 'silent'|'warn'|'error'
const WARN_LIMIT = Number(process.env.FIELDCRYPTO_WARN_LIMIT || 10);
let warnCount = 0;
function logWarn(msg)  { if (LOG_LEVEL === 'warn')  console.warn(msg); else if (LOG_LEVEL === 'error') console.error(msg); }
function logError(msg) { if (LOG_LEVEL !== 'silent') console.error(msg); }
function warnOnce(msg) {
  if (LOG_LEVEL === 'silent') return;
  if (warnCount < WARN_LIMIT) {
    warnCount++;
    logWarn(msg);
    if (warnCount === WARN_LIMIT) logWarn('[fieldCrypto] further decrypt warnings suppressed…');
  }
}

// ---------- Key handling (hex or base64) with key ring ----------
function parseKey(str) {
  const raw = (str || '').trim();
  if (!raw) return null;

  // hex (preferred)
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const b = Buffer.from(raw, 'hex');
    if ([16, 24, 32].includes(b.length)) return b;
  }

  // base64
  try {
    const b = Buffer.from(raw, 'base64');
    if ([16, 24, 32].includes(b.length)) return b;
  } catch { /* ignore */ }

  return null;
}

/** Returns newest-first keys. */
function getKeyRing() {
  const raw = (process.env.PII_ENC_KEYS || process.env.PII_ENC_KEY || '').trim();
  if (!raw) {
    logWarn('[fieldCrypto] Missing PII_ENC_KEYS/PII_ENC_KEY');
    return [];
  }
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const keys = parts.map(parseKey).filter(Boolean);
  if (keys.length === 0) {
    logWarn('[fieldCrypto] No valid keys parsed (expect 16/24/32 bytes in hex or base64)');
  }
  return keys;
}

const KEY_RING = getKeyRing();
const KEY_PRIMARY = KEY_RING[0] || crypto.randomBytes(32); // ⚠️ temp fallback; set a real key in env
const KEY_BYTES = KEY_PRIMARY.length;

// ---------- Format detectors ----------
function looksHex(s) { return typeof s === 'string' && /^[0-9a-fA-F]+$/.test(s); }
function looksB64(s) {
  if (typeof s !== 'string' || !s) return false;
  try { return Buffer.from(s, 'base64').length > 0; } catch { return false; }
}

// Current format: "<cipher+tag hex>:<iv hex>" (iv=12 bytes → 24 hex, tag=16 bytes)
function looksCurrentFormat(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split(':');
  if (parts.length !== 2) return false;
  const [dataHex, ivHex] = parts;
  if (!looksHex(dataHex) || !looksHex(ivHex)) return false;
  if (ivHex.length !== 24) return false;     // 12 bytes IV
  if (dataHex.length < 32) return false;     // at least 16-byte tag
  return true;
}

// Legacy format: "ivB64:ctB64:tagB64" (iv=12 bytes, tag=16 bytes)
function looksLegacyFormat(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split(':');
  if (parts.length !== 3) return false;
  const [ivB64, ctB64, tagB64] = parts;
  if (!looksB64(ivB64) || !looksB64(ctB64) || !looksB64(tagB64)) return false;
  try {
    const iv  = Buffer.from(ivB64,  'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== 12)  return false;
    if (tag.length !== 16) return false;
    return true;
  } catch { return false; }
}

/** Plaintext if it doesn't match any encrypted format. */
function looksPlaintext(token) {
  return !(looksCurrentFormat(token) || looksLegacyFormat(token));
}

// ---------- Encrypt (current format: enc||tag hex : iv hex) ----------
function encryptField(v) {
  if (v === undefined || v === null) return '';
  const plain = String(v);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY_PRIMARY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const outHex = Buffer.concat([enc, tag]).toString('hex'); // enc||tag
  return `${outHex}:${iv.toString('hex')}`;
}

// ---------- Decrypt (tries current format, then legacy; tries all keys) ----------
function decryptWithKey(bufEnc, bufTag, bufIv, key) {
  const d = crypto.createDecipheriv(ALGO, key, bufIv);
  d.setAuthTag(bufTag);
  return Buffer.concat([d.update(bufEnc), d.final()]);
}

/** Strict decrypt: throws on failure. Prefer safeDecrypt in routes. */
function decryptField(token) {
  if (!token) return '';
  const s = String(token);
  const parts = s.split(':');

  // Case 1: current format -> cipherHex:ivHex
  if (parts.length === 2 && looksHex(parts[0]) && looksHex(parts[1])) {
    const data = Buffer.from(parts[0], 'hex');
    const iv   = Buffer.from(parts[1], 'hex');
    if (iv.length !== 12) throw new Error('Invalid IV length for hex format (expected 12)');
    if (data.length < 16) throw new Error('Cipher data too short');

    const tag = data.slice(-16);
    const enc = data.slice(0, -16);

    let lastErr;
    for (const key of KEY_RING) {
      try {
        return decryptWithKey(enc, tag, iv, key).toString('utf8');
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No keys available for decrypt');
  }

  // Case 2: legacy format -> ivBase64:ctBase64:tagBase64
  if (parts.length === 3) {
    const [ivB64, ctB64, tagB64] = parts;
    const iv  = Buffer.from(ivB64,  'base64');
    const enc = Buffer.from(ctB64,  'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== 12)  throw new Error('Invalid IV length for base64 format (expected 12)');
    if (tag.length !== 16) throw new Error('Invalid tag length for base64 format (expected 16)');

    let lastErr;
    for (const key of KEY_RING) {
      try {
        return decryptWithKey(enc, tag, iv, key).toString('utf8');
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No keys available for decrypt (legacy)');
  }

  // Unknown format
  throw new Error('Unknown encrypted field format');
}

// ---------- Safe wrapper so routes don’t crash ----------
function safeDecrypt(token, fallback = '') {
  if (token == null || token === '') return fallback;

  // If it doesn't look encrypted, treat it as plaintext and return it directly (no logs).
  if (looksPlaintext(token)) return String(token);

  try {
    return decryptField(token);
  } catch (e) {
    warnOnce('[fieldCrypto] decrypt failed: ' + (e?.message || e));
    return fallback;
  }
}

module.exports = {
  encryptField,
  decryptField, // keep exported for rare cases; prefer safeDecrypt in routes
  safeDecrypt,
  KEY_BYTES,
};
