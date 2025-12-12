// ═══════════════════════════════════════════════════════════════════════════════
// 🚦 Rate Limiting Middleware
// ═══════════════════════════════════════════════════════════════════════════════

const config = require('../config/constants');

const loginAttempts = new Map();

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const key = `${ip}_${req.body.username || ''}`;
  
  const attempts = loginAttempts.get(key);
  
  if (attempts && attempts.count >= config.MAX_LOGIN_ATTEMPTS) {
    const timePassed = Date.now() - attempts.lastAttempt;
    if (timePassed < config.LOCKOUT_TIME) {
      const remainingTime = Math.ceil((config.LOCKOUT_TIME - timePassed) / 60000);
      return res.status(429).json({ 
        success: false, 
        error: `Too many login attempts. Try again in ${remainingTime} minutes.` 
      });
    } else {
      loginAttempts.delete(key);
    }
  }
  
  next();
}

function recordLoginAttempt(ip, username, success) {
  const key = `${ip}_${username}`;
  
  if (success) {
    loginAttempts.delete(key);
  } else {
    const attempts = loginAttempts.get(key) || { count: 0, lastAttempt: 0 };
    attempts.count++;
    attempts.lastAttempt = Date.now();
    loginAttempts.set(key, attempts);
  }
}

module.exports = {
  rateLimitMiddleware,
  recordLoginAttempt
};
