import jwt from 'jsonwebtoken';
import TradePro from '../models/TradePro.js';
import Contractor from '../models/Contractor.js';

export async function protect(req, res, next) {
  try {
    let token = req.cookies?.token;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) return res.status(401).json({ message: 'Not authenticated' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const Model   = decoded.type === 'trade' ? TradePro : Contractor;
    const user    = await Model.findById(decoded.id);

    if (!user) return res.status(401).json({ message: 'User no longer exists' });

    req.user     = user;
    req.userId   = user._id;
    req.userType = decoded.type;
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

export function restrictTo(...types) {
  return (req, res, next) => {
    if (!types.includes(req.userType)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    next();
  };
}
