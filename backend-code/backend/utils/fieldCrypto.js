// backend/utils/fieldCrypto.js
'use strict';
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

/* ------------------------------------------------------------------ */
/*                       Key ring (Railway-friendly)                   */
/* ------------------------------------------------------------------ */

function parseKey(str) {
  const raw = (str || '').trim();
  if (!raw) return null;

  // hex (preferred)
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const b = Buffer.from(raw, 'hex');
    if ([16, 24, 32].includes(b.length)) return b;
  }

  // base64 (fallback)
  try {
    const b = Buffer.from(raw, 'base64');
    if ([16, 24, 32].includes(b.length)) return b;
  } catch (_) {}

  return null;
}

/** Load newest-first keys from env (PII_ENC_KEYS or fallback PII_ENC_KEY). */
function getKeyRing() {
  const raw = (process.env.PII_ENC_KEYS || process.env.PII_ENC_KEY || '').trim();
  if (!raw) {
    console.warn('[fieldCrypto] Missing PII_ENC_KEYS/PII_ENC_KEY');
    console.warn('[fieldCrypto] Missing PII_ENC_KEYS/PII_ENC_KEY');
    return [];
  }
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const keys = parts.map(parseKey).filter(Boolean);
  if (keys.length === 0) {
    console.warn('[fieldCrypto] No valid keys parsed (expect 16/24/32 bytes, hex or base64)');
  } else {
    console.log(`[fieldCrypto] key ring loaded: ${keys.length} key(s), first length=${keys[0].length} bytes`);
  }
  return keys;
}

const KEY_RING = getKeyRing();
const KEY_PRIMARY = KEY_RING[0] || crypto.randomBytes(32); // encrypt will still work, but use real keys in env
const KEY_BYTES = KEY_PRIMARY.length;

/* ------------------------------------------------------------------ */
/*                           Encrypt (current)                         */
/*   Stored format: "<enc||tag hex>:<iv hex>" (GCM tag is last 16B)    */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*                               Decrypt                               */
/*   Supports:                                                         */
/*   1) "<enc||tag hex>:<iv hex>"                                      */
/*   2) "<iv b64>:<ct b64>:<tag b64>"                                  */
/*   3) "<iv hex>:<ct hex>:<tag hex>"                                  */
/*   If token is not in any encrypted format, return it as plaintext.  */
/* ------------------------------------------------------------------ */

function decryptWithKey(bufEnc, bufTag, bufIv, key) {
  const d = crypto.createDecipheriv(ALGO, key, bufIv);
  d.setAuthTag(bufTag);
  return Buffer.concat([d.update(bufEnc), d.final()]);
}

const isHex = s => /^[0-9a-fA-F]+$/.test(s || '');

function decryptField(token) {
  if (!token) return '';
  const s = String(token).trim();
  const parts = s.split(':');

  // Case 1: current 2-part hex -> cipherAndTagHex : ivHex
  if (parts.length === 2 && isHex(parts[0]) && isHex(parts[1])) {
    const data = Buffer.from(parts[0], 'hex');
    const iv   = Buffer.from(parts[1], 'hex');
    if (iv.length !== 12) throw new Error('Invalid IV length (2-part hex)');
    if (data.length < 16) throw new Error('Cipher data too short (2-part hex)');
    const tag = data.slice(-16);
    const enc = data.slice(0, -16);

    let lastErr;
    for (const key of KEY_RING) {
      try { return decryptWithKey(enc, tag, iv, key).toString('utf8'); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No matching key (2-part hex)');
  }

  // Case 2: legacy 3-part base64 -> ivB64 : ctB64 : tagB64
  if (parts.length === 3 && !isHex(parts[0] + parts[1] + parts[2])) {
    const [ivB64, ctB64, tagB64] = parts;
    const iv  = Buffer.from(ivB64, 'base64');
    const enc = Buffer.from(ctB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== 12) throw new Error('Invalid IV length (3-part b64)');
    if (tag.length !== 16) throw new Error('Invalid tag length (3-part b64)');

    let lastErr;
    for (const key of KEY_RING) {
      try { return decryptWithKey(enc, tag, iv, key).toString('utf8'); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No matching key (3-part b64)');
  }

  // Case 3: legacy 3-part hex -> ivHex : ctHex : tagHex
  if (parts.length === 3 && isHex(parts[0]) && isHex(parts[1]) && isHex(parts[2])) {
    const [ivHex, ctHex, tagHex] = parts;
    const iv  = Buffer.from(ivHex,  'hex');
    const enc = Buffer.from(ctHex,  'hex');
    const tag = Buffer.from(tagHex, 'hex');
    if (iv.length !== 12) throw new Error('Invalid IV length (3-part hex)');
    if (tag.length !== 16) throw new Error('Invalid tag length (3-part hex)');

    let lastErr;
    for (const key of KEY_RING) {
      try { return decryptWithKey(enc, tag, iv, key).toString('utf8'); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No matching key (3-part hex)');
  }

  // Not recognized as encrypted -> treat as plaintext (older rows)
  return s;
}

/* ------------------------------------------------------------------ */
/*                         Safe + “smart” helpers                      */
/* ------------------------------------------------------------------ */

let warnCount = 0;
let suppressed = false;
const MAX_WARN = parseInt(process.env.PII_ENC_MAX_WARN || '10', 10);
const LOG_ENABLED = String(process.env.PII_ENC_LOG || '1') !== '0';

function safeDecrypt(token, fallback = '') {
  try {
    return decryptField(token);
  } catch (e) {
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

// Nice-to-have: derive readable names when decrypt is missing/impossible
function deriveNameFallback({ fullName, username, email } = {}) {
  const f = (fullName || '').trim();
  if (f) {
    const parts = f.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return { first: parts[0], last: parts[parts.length - 1] };
    return { first: parts[0] || '', last: '' };
  }
  if (username) return { first: String(username), last: '' };
  if (email)    return { first: String(email).split('@')[0], last: '' };
  return { first: '', last: '' };
}

function smartFirstName(token, ctx = {}) {
  const d = safeDecrypt(token, '');
  if (d) return d;
  if (ctx.plain) return String(ctx.plain);
  return deriveNameFallback(ctx).first;
}

function smartLastName(token, ctx = {}) {
  const d = safeDecrypt(token, '');
  if (d) return d;
  if (ctx.plain) return String(ctx.plain);
  return deriveNameFallback(ctx).last;
}

module.exports = {
  encryptField,
  decryptField,   // strict
  safeDecrypt,    // tolerant
  smartFirstName,
  smartLastName,
  KEY_BYTES,
};
