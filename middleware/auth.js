import jwt from 'jsonwebtoken';

// Verify JWT and attach user to req.user
export function protect(req, res, next) {
  // functional code added later
}

// Restrict to specific roles e.g. protect, restrictTo('admin')
export function restrictTo(...roles) {
  return (req, res, next) => {
    // functional code added later
  };
}
