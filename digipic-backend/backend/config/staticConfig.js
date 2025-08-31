// ==== config/staticConfig.js ==== //
/**
 * Static handler for /uploads.
 * - Images: Cache-Control: no-store (so profile pics update immediately)
 * - Other files: public, short cache (default 1 hour)
 * - Security: no dotfiles, nosniff, etag enabled
 */
const express = require('express');

function staticUploads(rootPath, opts = {}) {
  const {
    imageNoStore = true,
    defaultMaxAgeMs = 60 * 60 * 1000, // 1 hour
  } = opts;

  return express.static(rootPath, {
    etag: true,               // enable ETag
    fallthrough: true,        // allow other middlewares to handle 404s, etc.
    dotfiles: 'ignore',       // do not serve hidden files
    maxAge: defaultMaxAgeMs,  // base max-age; we'll override per-file below
    setHeaders: (res, filePath) => {
      // Security hardening
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Caching rules
      if (imageNoStore && /\.(png|jpe?g|webp|gif|svg)$/i.test(filePath)) {
        // Prevent any caching for images (profile pics, etc.)
        res.setHeader('Cache-Control', 'no-store');
      } else {
        // Reasonable default for other assets (pdf, mp4, docs)
        const seconds = Math.floor(defaultMaxAgeMs / 1000);
        res.setHeader('Cache-Control', `public, max-age=${seconds}`);
      }
    },
  });
}

module.exports = { staticUploads };
