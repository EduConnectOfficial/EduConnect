// ==== backend/utils/fsUtils.js ==== //
const fs = require('fs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeName(name) {
  return String(name).replace(/[^\w.\-]/g, '_');
}

module.exports = { ensureDir, sanitizeName };
