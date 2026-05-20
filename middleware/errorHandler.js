// Central error handler — must have 4 params for Express to treat it as an error handler
export function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  if (status >= 500) {
    console.error(`\n[ERROR] ${req.method} ${req.originalUrl}`);
    console.error(`  message : ${err.message}`);
    console.error(`  stack   : ${err.stack}\n`);
  }
  res.status(status).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}
