// utils/fieldCrypto.js
'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

/* =========================================================================
   KEY MANAGEMENT
   - Provide keys via:
       PII_ENC_KEYS = "<NEW_HEX>[, <OLDER_HEX>, ...]"
     or
       PII_ENC_KEY  = "<SINGLE_HEX>"
   - Keys may be HEX (preferred) or base64; length must be 16/24/32 bytes.
   - We DO NOT silently generate a random key for encryption (to avoid
     writing data that can never be decrypted on the next deploy).
=========================================================================== */

function parseKey(str) {
  const raw = (str || '').trim();
  if (!raw) return null;

  // HEX (preferred)
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const b = Buffer.from(raw, 'hex');
    if ([16, 24, 32].includes(b.length)) return b;
  }

  // base64 (fallback)
  try {
    const b = Buffer.from(raw, 'base64');
    if ([16, 24, 32].includes(b.length)) return b;
  } catch {
    /* ignore */
  }
  return null;
}

/** Parse env -> newest-first key ring */
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
const KEY_PRIMARY = KEY_RING[0] || null; // null => encrypt will throw (safer)

/* =========================================================================
   ENCRYPT (current format)
   Format:  "<enc||tag hex>:<iv hex>"
=========================================================================== */
function encryptField(v) {
  if (v === undefined || v === null) return '';
  if (!KEY_PRIMARY) {
    throw new Error('[fieldCrypto] No encryption key configured. Set PII_ENC_KEYS or PII_ENC_KEY.');
  }

  const plain = String(v);
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGO, KEY_PRIMARY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const outHex = Buffer.concat([enc, tag]).toString('hex'); // enc||tag
  return `${outHex}:${iv.toString('hex')}`;
}

/* =========================================================================
   DECRYPT (tries current format first, then legacy; tries all keys)
   - Current: "<cipher||tag hex>:<iv hex>"
   - Legacy : "<iv base64>:<ct base64>:<tag base64>"
=========================================================================== */
function decryptWithKey(bufEnc, bufTag, bufIv, key) {
  const d = crypto.createDecipheriv(ALGO, key, bufIv);
  d.setAuthTag(bufTag);
  return Buffer.concat([d.update(bufEnc), d.final()]);
}

/** STRICT decrypt. Throws on true decrypt failures; returns plaintext if token does not look encrypted. */
function decryptField(token) {
  if (!token) return '';
  const s = String(token);
  const parts = s.split(':');

  // Case 1: current hex format -> cipherHex:ivHex
  if (
    parts.length === 2 &&
    /^[0-9a-fA-F]+$/.test(parts[0]) &&
    /^[0-9a-fA-F]+$/.test(parts[1])
  ) {
    const data = Buffer.from(parts[0], 'hex');
    const iv = Buffer.from(parts[1], 'hex');
    if (iv.length !== 12) throw new Error('Invalid IV length for hex format (expected 12)');
    if (data.length < 16) throw new Error('Cipher data too short');

    const tag = data.slice(-16);
    const enc = data.slice(0, -16);

    let lastErr;
    for (const key of KEY_RING) {
      try {
        return decryptWithKey(enc, tag, iv, key).toString('utf8');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('No keys available for decrypt');
  }

  // Case 2: legacy base64 -> ivB64:ctB64:tagB64
  if (parts.length === 3) {
    const [ivB64, ctB64, tagB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const enc = Buffer.from(ctB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== 12) throw new Error('Invalid IV length for base64 format (expected 12)');
    if (tag.length !== 16) throw new Error('Invalid tag length for base64 format (expected 16)');

    let lastErr;
    for (const key of KEY_RING) {
      try {
        return decryptWithKey(enc, tag, iv, key).toString('utf8');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('No keys available for decrypt (legacy)');
  }

  // Not in any encrypted format => treat as plaintext (older rows)
  return s;
}

/* =========================================================================
   SAFE WRAPPER (doesn't throw; throttled logging)
=========================================================================== */
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
    return fallback;
  }
}

/* =========================================================================
   NAME FALLBACK HELPERS (for UI resilience)
=========================================================================== */
function deriveNameFallback({ fullName, username, email } = {}) {
  const f = (fullName || '').trim();
  if (f) {
    const parts = f.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return { first: parts[0], last: parts[parts.length - 1] };
    }
    return { first: parts[0] || '', last: '' };
  }
  if (username) return { first: String(username), last: '' };
  if (email)    return { first: String(email).split('@')[0], last: '' };
  return { first: '', last: '' };
}

/**
 * smartFirstName / smartLastName
 * - Try decrypt
 * - Else use provided plaintext (ctx.plain)
 * - Else derive from fullName → username → email
 */
function smartFirstName(encToken, ctx = {}) {
  const d = safeDecrypt(encToken, '');
  if (d) return d;
  if (ctx.plain) return String(ctx.plain);
  return deriveNameFallback(ctx).first;
}

function smartLastName(encToken, ctx = {}) {
  const d = safeDecrypt(encToken, '');
  if (d) return d;
  if (ctx.plain) return String(ctx.plain);
  return deriveNameFallback(ctx).last;
}

/* =========================================================================
   EXPORTS
=========================================================================== */
module.exports = {
  // crypto
  encryptField,
  decryptField,
  safeDecrypt,

  // name helpers
  smartFirstName,
  smartLastName,
  deriveNameFallback,

  // (optional) expose key info for diagnostics
  __hasPrimaryKey: !!KEY_PRIMARY,
  __keyCount: KEY_RING.length,
};
