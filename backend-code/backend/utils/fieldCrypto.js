// utils/fieldCrypto.js
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const CURRENT_FORMAT = 'hex_concat_iv'; // enc||tag (hex) : iv (hex)

function getKey() {
  const raw = (process.env.PII_ENC_KEY || '').trim();
  if (!raw) throw new Error('PII_ENC_KEY missing');

  // try hex (64 hex chars => 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // try base64 (common pitfall)
  try {
    const b = Buffer.from(raw, 'base64');
    if ([16, 24, 32].includes(b.length)) return b;
  } catch {}

  throw new Error(
    'PII_ENC_KEY must be 64 hex chars (preferred) or base64 yielding 16/24/32 bytes'
  );
}

const KEY = getKey();

/** Encrypts string -> "enc||tag (hex) : iv (hex)" */
function encryptField(v) {
  if (v === undefined || v === null) return '';
  const plain = String(v);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const outHex = Buffer.concat([enc, tag]).toString('hex'); // enc||tag
  return `${outHex}:${iv.toString('hex')}`;
}

/** Tries decrypt in current format; falls back to a legacy 3-part base64 if needed */
function decryptField(token) {
  if (!token) return '';

  // ---- Current format: "cipherHex:ivHex" where cipherHex = enc||tag ----
  const parts = String(token).split(':');
  if (parts.length === 2 && /^[0-9a-fA-F]+$/.test(parts[0]) && /^[0-9a-fA-F]+$/.test(parts[1])) {
    const data = Buffer.from(parts[0], 'hex');
    const iv = Buffer.from(parts[1], 'hex');

    if (iv.length !== 12) throw new Error(`Invalid IV length ${iv.length}, expected 12`);
    if (data.length < 16) throw new Error('Cipher data too short');

    const tag = data.slice(-16);
    const enc = data.slice(0, -16);

    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }

  // ---- Optional legacy fallback: "iv.ct.tag" (all base64) ----
  // Remove this block if you never stored data in this format.
  if (parts.length === 3) {
    try {
      const [ivB64, ctB64, tagB64] = parts;
      const iv = Buffer.from(ivB64, 'base64');
      const enc = Buffer.from(ctB64, 'base64');
      const tag = Buffer.from(tagB64, 'base64');
      if (iv.length !== 12) throw new Error(`Legacy IV len ${iv.length} != 12`);
      if (tag.length !== 16) throw new Error(`Legacy tag len ${tag.length} != 16`);
      const d = crypto.createDecipheriv(ALGO, KEY, iv);
      d.setAuthTag(tag);
      const dec = Buffer.concat([d.update(enc), d.final()]);
      return dec.toString('utf8');
    } catch (e) {
      // fall through to error
    }
  }

  throw new Error('Encrypted field has unknown format');
}

module.exports = { encryptField, decryptField, KEY_BYTES: KEY.length, FORMAT: CURRENT_FORMAT };
