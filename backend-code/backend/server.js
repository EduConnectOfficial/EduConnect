// ==== server.js ====
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const { corsOptions } = require('./config/corsConfig');
const { staticUploads } = require('./config/staticConfig');

const app = express();
app.set('trust proxy', 1);

/* Put healthcheck FIRST so Railway can ping it even if other stuff fails */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* Try Firebase init, but never crash the server */
try {
  if (process.env.SKIP_FIREBASE === '1') {
    console.warn('⚠️  SKIPPING Firebase init (SKIP_FIREBASE=1)');
  } else {
    require('./config/firebase');
    console.log('✅ Firebase initialized');
  }
} catch (e) {
  console.error('❌ Firebase init failed:', e.message);
  // keep running so healthcheck works and we can see logs
}

/* CORS + parsers */
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* Static uploads */
app.use('/uploads', staticUploads(path.join(__dirname, 'uploads')));

/* Your routes (unchanged) */
app.use('/', require('./routes/testRoutes'));
app.use('/', require('./routes/authRoutes'));
app.use('/', require('./routes/classesRoutes'));

const coursesRoutes = require('./routes/coursesRoutes');
app.use('/', coursesRoutes);
app.use('/api', coursesRoutes);

const modulesRoutes = require('./routes/modulesRoutes');
app.use('/', modulesRoutes);
app.use('/api', modulesRoutes);

app.use('/api', require('./routes/assignmentsRoutes'));
app.use('/', require('./routes/quizRoutes'));
app.use('/api/announcements', require('./routes/announcementRoutes'));
app.use('/api/teacher', require('./routes/teacherDashboardRoutes'));
app.use('/api/teacher', require('./routes/teacherAnalyticsRoutes'));
app.use('/api/users', require('./routes/usersRoutes'));
app.use('/api', require('./routes/studentDashboardRoutes'));
app.use('/api', require('./routes/studentCoursesRoutes'));
app.use('/api', require('./routes/studentProgressRoutes'));
app.use('/api', require('./routes/adminDashboardRoutes'));
app.use('/', require('./routes/usersCompatRoutes'));
app.use('/api', require('./routes/bugReportRoutes'));
app.use('/api/teacher', require('./routes/teacherEssayRoutes'));
app.use('/api/forum', require('./routes/forumRoutes'));
app.use('/api', require('./routes/studentGradesRoutes'));
app.use('/api/teacher', require('./routes/studentAnalyticsRoutes'));

/* 404 + errors */
app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));
const { errorHandler } = require('./middleware/errorHandler');
app.use(errorHandler);

/* Start */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));

module.exports = app;
