// ==== backend/config/multerConfig.js ==== //
const multer = require('multer');
const path = require('path');
const { ensureDir, sanitizeName } = require('../utils/fsUtils');

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/ogg',
]);

const makeStorage = (folder) =>
  multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '..', 'uploads', folder);
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}_${sanitizeName(file.originalname)}`);
    },
  });

// “modules” upload with size limit + allowlist
const commonUpload = multer({
  storage: makeStorage('modules'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(null, true);
    cb(new Error('File type not allowed'), false);
  },
});

// Named uploaders you can plug into different routes
const uploadQuiz = multer({ storage: makeStorage('quizzes') });
const uploadProfilePic = multer({ storage: makeStorage('profile_pics') });
const uploadBug = multer({ storage: makeStorage('bugs') });
const uploadProfile = multer({ storage: makeStorage('profiles') });
const uploadAssign = multer({ storage: makeStorage('assignments') });
const uploadSubmission = multer({ storage: makeStorage('assignment_submissions') });
const uploadBulk = multer({ storage: makeStorage('bulk_enrollments') });

module.exports = {
  commonUpload,
  uploadQuiz,
  uploadProfilePic,
  uploadBug,
  uploadProfile,
  uploadAssign,
  uploadSubmission,
  uploadBulk,
  makeStorage,
};
