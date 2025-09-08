// ==== services/storageService.js ====
'use strict';

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { bucket } = require('../config/firebase');

/** Sanitize filenames lightly (safe for Content-Disposition) */
function safeName(name) {
  return String(name || '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Build a firebase token URL from bucket + storagePath + token */
function buildTokenUrl(bucketName, storagePath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
}

/**
 * Ensure an object has a firebase token in its custom metadata and return it.
 * If missing, mint a new one and PATCH the metadata.
 *
 * @param {string} storagePath - path within the bucket
 * @returns {Promise<{meta: object, token: string, downloadUrl: string}>}
 */
async function ensureTokenForObject(storagePath) {
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    const err = new Error(`Object not found at: ${storagePath}`);
    err.code = 'ENOENT';
    throw err;
  }

  // Read current metadata
  let [meta] = await file.getMetadata();

  // Pull token from either well-known key or fallback spots
  let token =
    meta?.metadata?.firebaseStorageDownloadTokens ||
    meta?.metadata?.firebase_storage_download_tokens || // older casing sometimes seen
    null;

  // If multiple tokens are present (comma-separated), take first
  if (token && token.includes(',')) token = token.split(',').map(s => s.trim()).filter(Boolean)[0] || null;

  // Mint a new token if absent
  if (!token) {
    token = uuidv4();
    const newMeta = {
      metadata: {
        ...(meta.metadata || {}),
        firebaseStorageDownloadTokens: token,
      },
    };
    // Only patch metadata; don’t touch contentType/disposition unless required
    await file.setMetadata(newMeta);
    [meta] = await file.getMetadata();
  }

  return {
    meta,
    token,
    downloadUrl: buildTokenUrl(bucket.name, storagePath, token),
  };
}

/**
 * Save a buffer from Multer memory to Cloud Storage.
 * Forces inline preview via `Content-Disposition: inline` and returns a token download URL.
 *
 * @param {Buffer} buffer
 * @param {Object} opts
 * @param {String} opts.destPath - e.g., 'profiles/123/avatar.png'
 * @param {String} opts.contentType - MIME type
 * @param {Object} [opts.metadata] - Extra metadata (stored under object.metadata)
 * @param {String} [opts.filenameForDisposition] - Pretty filename for Content-Disposition
 * @returns {Promise<{
 *   gsUri: string,
 *   storagePath: string,
 *   publicUrl: string,
 *   downloadUrl: string,
 *   metadata: object,
 *   token: string
 * }>}
 */
async function saveBufferToStorage(
  buffer,
  { destPath, contentType, metadata = {}, filenameForDisposition }
) {
  const storagePath = destPath; // keep consistent naming outward
  const file = bucket.file(storagePath);

  const fname = safeName(filenameForDisposition || metadata.originalName || path.basename(storagePath));
  const downloadToken = uuidv4();

  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType: contentType || 'application/octet-stream',
      cacheControl: 'public, max-age=3600',
      // forces browsers to render inline where possible (PDF, images, video)
      contentDisposition: `inline; filename="${fname}"`,
      metadata: {
        ...metadata,
        // token URL for client access without signed URLs
        firebaseStorageDownloadTokens: downloadToken,
      },
    },
  });

  const [fileMeta] = await file.getMetadata();

  const gsUri = `gs://${bucket.name}/${storagePath}`;
  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURI(storagePath)}`;
  const downloadUrl = buildTokenUrl(bucket.name, storagePath, downloadToken);

  return {
    gsUri,
    storagePath,          // 👈 NEW: always return this
    publicUrl,
    downloadUrl,
    metadata: fileMeta,
    token: downloadToken,
  };
}

/**
 * Compose a Storage path that groups files by module/user/etc.
 * Example: folderPrefix='modules', id='<moduleId>', original='Lesson.pdf'
 */
function buildStoragePath(folderPrefix, id, originalName) {
  const ext = path.extname(originalName || '') || '';
  const base = path.basename(originalName || 'file', ext);
  const stamped = `${Date.now()}_${safeName(base)}${ext}`;
  return `${folderPrefix}/${id}/${stamped}`;
}

module.exports = {
  safeName,
  buildTokenUrl,
  ensureTokenForObject,   // 👈 helper to backfill token + get guaranteed downloadUrl
  saveBufferToStorage,
  buildStoragePath,
};
