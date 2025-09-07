// ==== middleware/errorHandler.js ==== //
function errorHandler(err, req, res, next) {
  // eslint-disable-next-line no-console
  console.error('❌ Error:', err);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
}
module.exports = { errorHandler };
