// utils/fieldCrypto.js
'use strict';
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

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
  } catch {}

  return null;
}

/** Returns newest-first keys. */
function getKeyRing() {
  const raw = (process.env.PII_ENC_KEYS || process.env.PII_ENC_KEY || '').trim();
  if (!raw) {
    console.warn('[fieldCrypto] Missing PII_ENC_KEYS/PII_ENC_KEY');
    return [];
  }
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const keys = parts.map(parseKey).filter(Boolean);
  if (keys.length === 0) {
    console.warn('[fieldCrypto] No valid keys parsed (expect 16/24/32 bytes in hex or base64)');
  }
  return keys;
}

const KEY_RING = getKeyRing();
const KEY_PRIMARY = KEY_RING[0] || crypto.randomBytes(32); // avoids crashes on encrypt; you should set a real key.
const KEY_BYTES = KEY_PRIMARY.length;

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

/** @param {string} token */
function decryptField(token) {
  if (!token) return '';
  const s = String(token);
  const parts = s.split(':');

  // Case 1: current format -> cipherHex:ivHex
  if (parts.length === 2 && /^[0-9a-fA-F]+$/.test(parts[0]) && /^[0-9a-fA-F]+$/.test(parts[1])) {
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
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No keys available for decrypt');
  }

  // Case 2: legacy format -> ivBase64:ctBase64:tagBase64
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
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No keys available for decrypt (legacy)');
  }

  throw new Error('Unknown encrypted field format');
}

// ---------- Safe wrapper so routes don’t crash ----------
function safeDecrypt(token, fallback = '') {
  try { return decryptField(token); }
  catch (e) {
    console.warn('[fieldCrypto] decrypt failed:', e.message);
    return fallback;
  }
}

module.exports = {
  encryptField,
  decryptField,
  safeDecrypt,
  KEY_BYTES,
};
