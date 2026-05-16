// Central error handler — must have 4 params for Express to treat it as an error handler
export function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  res.status(status).json({
    success: false,
    message: err.message || 'Internal Server Error',
    // stack only in development
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}
