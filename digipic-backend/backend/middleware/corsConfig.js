// ==== config/corsConfig.js ==== //
const corsOptions = {
  origin: ['http://127.0.0.1:5501', 'http://localhost:5501'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
};
module.exports = { corsOptions };
