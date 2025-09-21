// backend/config/corsConfig.js
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const RAILWAY_RE  = /^https?:\/\/([a-z0-9-]+\.)*up\.railway\.app$/i;

// Optional: comma-separated list from env (e.g., "https://myapp.com,https://admin.myapp.com")
const ALLOW_LIST = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAllowed(origin) {
  if (!origin || origin === 'null') return true;                 // same-origin, curl/postman, file://
  if (LOCALHOST_RE.test(origin)) return true;                     // localhost dev
  if (RAILWAY_RE.test(origin)) return true;                       // *.up.railway.app
  if (ALLOW_LIST.includes(origin)) return true;                   // explicit allow-list
  return false;
}

exports.corsOptions = {
  origin: (origin, cb) => isAllowed(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS: ' + origin)),
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept'],
  credentials: true,
  maxAge: 86400,
};
