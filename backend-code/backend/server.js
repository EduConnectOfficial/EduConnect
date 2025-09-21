// ==== server.js ====
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const { corsOptions } = require('./config/corsConfig');
const { staticUploads } = require('./config/staticConfig');
require('./config/firebase');

const testRoutes = require('./routes/testRoutes');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

/* ===== Behind proxy (Railway) ===== */
app.set('trust proxy', 1);

/* ===== CORS (Express 5 safe) ===== */
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions)); // preflight

/* ===== Parsers ===== */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* ===== Serve frontend (same service) ===== */
const ROOT = path.join(__dirname, '..', '..'); // repo root
app.use('/ADMIN',      express.static(path.join(ROOT, 'ADMIN')));
app.use('/STUDENT',    express.static(path.join(ROOT, 'STUDENT')));
app.use('/TEACHER',    express.static(path.join(ROOT, 'TEACHER')));
app.use('/assets',     express.static(path.join(ROOT, 'assets')));
app.use('/components', express.static(path.join(ROOT, 'components')));

/* ===== Static uploads (dev note: Railway disk is ephemeral) ===== */
app.use('/uploads', staticUploads(path.join(__dirname, 'uploads')));

/* ===== Healthcheck ===== */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* ===== Routes ===== */
app.use('/', testRoutes);
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

const studentGradesRoutes = require('./routes/studentGradesRoutes');
app.use('/api', studentGradesRoutes);
app.use('/api/teacher', require('./routes/studentAnalyticsRoutes'));

/* ===== 404 ===== */
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

/* ===== Errors ===== */
app.use(errorHandler);

/* ===== Start ===== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Hello! Server running on port ${PORT}`);
});

module.exports = app;
