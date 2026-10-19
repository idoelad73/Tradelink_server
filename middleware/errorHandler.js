// Central error handler — must have 4 params for Express to treat it as an error handler
export function errorHandler(err, req, res, next) {
  let status  = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';

  // ── Translate common library errors into clean 4xx responses ────────────────
  // Without this they fall through as 500s whose body leaks internals: Mongoose
  // schema paths ("Path `phone` is required"), Mongo index names and the
  // offending duplicate value, or a raw stack. Intentional errors (those that
  // set err.statusCode) are left untouched.
  if (!err.statusCode) {
    if (err.name === 'ValidationError' && err.errors) {
      status  = 400;
      message = `Missing or invalid field(s): ${Object.keys(err.errors).join(', ')}`;
    } else if (err.name === 'CastError') {
      status  = 400;
      message = `Invalid value for '${err.path}'`;
    } else if (err.name === 'ZodError') {
      status  = 400;
      message = 'Invalid request data';
    } else if (err.code === 11000) {
      status  = 409;
      // Name the field, never the value — the value is often PII (e.g. an email).
      message = `That ${Object.keys(err.keyPattern ?? { value: 1 })[0]} is already in use`;
    }
  }

  if (status >= 500) {
    console.error(`\n[ERROR] ${req.method} ${req.originalUrl}`);
    console.error(`  message : ${err.message}`);
    console.error(`  stack   : ${err.stack}\n`);
    // Never leak internal error text or schema detail to the client on an
    // unexpected failure — it's logged above for us, not for them.
    message = 'Internal Server Error';
  }

  res.status(status).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}
