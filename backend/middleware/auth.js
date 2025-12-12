// ═══════════════════════════════════════════════════════════════════════════════
// 🛡️ Authentication Middleware
// ═══════════════════════════════════════════════════════════════════════════════

const encryption = require('../services/encryption');
const logger = require('../utils/logger');

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  
  const token = authHeader.substring(7);
  const payload = encryption.verifyAuthToken(token);
  
  if (!payload) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
  
  req.user = payload;
  next();
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

module.exports = {
  authMiddleware,
  adminMiddleware
};
