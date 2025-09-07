// backend/config/corsConfig.js
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Optionally add other dev hosts here:
const extraAllowed = new Set([
  // 'http://192.168.1.10:5500',
]);

const corsOptions = {
  origin: (origin, callback) => {
    // allow same-origin (no Origin header), file:// (“null”), curl/postman, and any localhost:* port
    if (!origin || origin === 'null' || LOCALHOST_RE.test(origin) || extraAllowed.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept'],
  credentials: true,
  maxAge: 86400,
};

module.exports = { corsOptions };
