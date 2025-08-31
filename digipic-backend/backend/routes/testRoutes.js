// ==== routes/testRoutes.js ==== //
const router = require('express').Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const { commonUpload } = require('../config/multerConfig');

// Health check
router.get(
  '/test',
  asyncHandler(async (req, res) => {
    res.json({ message: 'Server is running!' });
  })
);

// Simple file upload test
router.post(
  '/test-upload',
  commonUpload.single('file'),
  asyncHandler(async (req, res) => {
    // eslint-disable-next-line no-console
    console.log('🧪 Test upload received', { file: req.file, body: req.body });
    res.json({
      success: true,
      message: 'Test upload successful',
      file: req.file ? req.file.filename : null,
    });
  })
);

module.exports = router;
