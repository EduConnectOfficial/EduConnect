// utils/fieldCrypto.js
const crypto = require('crypto');

/**
 * AES-256-GCM with per-field random IV.
 * Stored format: cipherHex:ivHex
 */
const KEY_HEX = process.env.PII_ENC_KEY; // 64 hex chars (32 bytes)
if (!KEY_HEX || KEY_HEX.length !== 64) {
  console.warn('[fieldCrypto] Missing/invalid PII_ENC_KEY (expect 64 hex chars). Encryption will throw if used.');
}
const KEY = KEY_HEX ? Buffer.from(KEY_HEX, 'hex') : Buffer.alloc(32, 0);

/** @param {string} v */
function encryptField(v) {
  if (v === undefined || v === null) return '';
  const plain = String(v);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([enc, tag]).toString('hex'); // enc||tag
  return `${out}:${iv.toString('hex')}`;
}

/** @param {string} token cipherHex:ivHex */
function decryptField(token) {
  if (!token) return '';
  const parts = String(token).split(':');
  if (parts.length !== 2) return '';
  const data = Buffer.from(parts[0], 'hex');
  const iv = Buffer.from(parts[1], 'hex');
  if (data.length < 16) return '';

  // split data into enc and tag (last 16 bytes is GCM tag)
  const tag = data.slice(data.length - 16);
  const enc = data.slice(0, data.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

module.exports = { encryptField, decryptField };
