// ==== services/storageService.js ==== //
const path = require('path');
const { bucket } = require('../config/firebase');

// Sanitize file names lightly
function safeName(name) {
  return name.replace(/[^\w.\-]+/g, '_');
}

/**
 * Save a buffer from Multer memory to Cloud Storage.
 * @param {Buffer} buffer
 * @param {Object} opts
 * @param {String} opts.destPath - e.g., 'profiles/123/avatar.png'
 * @param {String} opts.contentType - MIME type
 * @param {Object} [opts.metadata] - Extra metadata
 * @returns {Promise<{gsUri: string, publicUrl: string, metadata: object}>}
 */
async function saveBufferToStorage(buffer, { destPath, contentType, metadata = {} }) {
  const file = bucket.file(destPath);

  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      metadata,
    },
  });

  // Option A: use Firebase download tokens (set in client SDK) – not needed for Admin uploads by default.
  // Option B: make public (for truly public assets only)
  // await file.makePublic();

  const [fileMeta] = await file.getMetadata();

  const gsUri = `gs://${bucket.name}/${destPath}`;
  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURI(destPath)}`;

  return { gsUri, publicUrl, metadata: fileMeta };
}

/**
 * Compose a Storage path that groups files by module/user.
 * Example: folderPrefix='profiles', id='user_123', original='avatar.png'
 */
function buildStoragePath(folderPrefix, id, originalName) {
  const ext = path.extname(originalName) || '';
  const base = path.basename(originalName, ext);
  const stamped = `${Date.now()}_${safeName(base)}${ext}`;
  return `${folderPrefix}/${id}/${stamped}`;
}

module.exports = { saveBufferToStorage, buildStoragePath, safeName };
