const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════════
// 🔐 SECURITY CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '902074ebb39f692c6aa615edcacb0636bffd1295ad5351e239255fbd77c5d2a8';
const JWT_SECRET = process.env.JWT_SECRET || '521b3586ca5e663b793ad71f9abc049a97caa2c3e5e419c3e7cad13a5ffba785f09696208c19edd861115f4e11eeb902ba380849dae78ce9f3e06b62dab8a09c';
const STREAM_SECRET = process.env.STREAM_SECRET || crypto.randomBytes(32).toString('hex');
const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

// Data file path
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.enc');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📊 PROFESSIONAL LOGGING SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

class Logger {
  constructor() {
    this.sessions = new Map();
  }

  // Format timestamp
  timestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }

  // Core log method
  log(level, category, message, data = {}) {
    const ts = this.timestamp();
    const dataStr = Object.keys(data).length > 0 
      ? ' | ' + Object.entries(data).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';
    
    console.log(`[${ts}] [${level.toUpperCase()}] [${category}] ${message}${dataStr}`);
  }

  // Level methods
  info(category, message, data) { this.log('info', category, message, data); }
  warn(category, message, data) { this.log('warn', category, message, data); }
  error(category, message, data) { this.log('error', category, message, data); }
  debug(category, message, data) { this.log('debug', category, message, data); }

  // Stream session tracking
  createStreamSession(sessionId, userId, username, channelId, channelName) {
    const session = {
      sessionId,
      userId,
      username,
      channelId,
      channelName,
      startTime: Date.now(),
      streamUrl: null,
      streamType: null,
      videoCodec: null,
      audioCodec: null,
      resolution: null,
      bitrate: null,
      status: 'initializing'
    };
    
    this.sessions.set(sessionId, session);
    
    this.info('stream', `Stream session created`, {
      sessionId: sessionId.substring(0, 8),
      user: username,
      channel: channelName
    });
    
    return session;
  }

  updateStreamSession(sessionId, updates) {
    const session = this.sessions.get(sessionId);
    if (session) {
      Object.assign(session, updates);
    }
  }

  getStreamSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  logStreamEvent(sessionId, event, data = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const elapsed = Math.round((Date.now() - session.startTime) / 1000);
    
    this.info('stream', `${event}`, {
      sessionId: sessionId.substring(0, 8),
      user: session.username,
      channel: session.channelName,
      elapsed: `${elapsed}s`,
      ...data
    });
  }

  // User activity logging
  logUserActivity(username, action, details = {}) {
    this.info('user', `${username} - ${action}`, details);
  }

  // Auth logging
  logAuth(event, username, ip, success = true) {
    const level = success ? 'info' : 'warn';
    this.log(level, 'auth', `${event} - ${username}`, { ip, success });
  }

  // IPTV connection logging
  logIPTVConnection(username, portalUrl, status, details = {}) {
    this.info('iptv', `${username} - ${status}`, { portal: portalUrl, ...details });
  }

  // FFmpeg logging with codec detection
  parseFFmpegOutput(sessionId, line) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Input stream detection
    if (line.includes('Input #0')) {
      this.logStreamEvent(sessionId, 'Input stream detected');
    }

    // Duration
    if (line.includes('Duration:')) {
      const match = line.match(/Duration: ([\d:.]+)/);
      if (match) {
        this.updateStreamSession(sessionId, { duration: match[1] });
      }
    }

    // Video codec
    if (line.includes('Stream #0') && line.includes('Video:')) {
      const codecMatch = line.match(/Video: ([^,]+)/);
      const resMatch = line.match(/(\d+x\d+)/);
      const fpsMatch = line.match(/([\d.]+) fps/);
      const bitrateMatch = line.match(/([\d.]+) kb\/s/);

      const videoInfo = {
        codec: codecMatch ? codecMatch[1].trim() : 'unknown',
        resolution: resMatch ? resMatch[1] : 'unknown',
        fps: fpsMatch ? fpsMatch[1] : 'unknown',
        bitrate: bitrateMatch ? bitrateMatch[1] + 'kbps' : 'unknown'
      };

      this.updateStreamSession(sessionId, {
        videoCodec: videoInfo.codec,
        resolution: videoInfo.resolution,
        status: 'video_detected'
      });

      this.logStreamEvent(sessionId, 'Video codec detected', {
        codec: videoInfo.codec,
        resolution: videoInfo.resolution,
        fps: videoInfo.fps,
        bitrate: videoInfo.bitrate
      });
    }

    // Audio codec
    if (line.includes('Stream #0') && line.includes('Audio:')) {
      const codecMatch = line.match(/Audio: ([^,]+)/);
      const sampleMatch = line.match(/(\d+) Hz/);
      const channelsMatch = line.match(/(mono|stereo|\d+ channels)/);
      const bitrateMatch = line.match(/([\d.]+) kb\/s/);

      const audioInfo = {
        codec: codecMatch ? codecMatch[1].trim() : 'unknown',
        sampleRate: sampleMatch ? sampleMatch[1] + 'Hz' : 'unknown',
        channels: channelsMatch ? channelsMatch[1] : 'unknown',
        bitrate: bitrateMatch ? bitrateMatch[1] + 'kbps' : 'unknown'
      };

      this.updateStreamSession(sessionId, {
        audioCodec: audioInfo.codec,
        status: 'audio_detected'
      });

      this.logStreamEvent(sessionId, 'Audio codec detected', {
        codec: audioInfo.codec,
        sampleRate: audioInfo.sampleRate,
        channels: audioInfo.channels,
        bitrate: audioInfo.bitrate
      });
    }

    // Output started
    if (line.includes('Output #0')) {
      this.updateStreamSession(sessionId, { status: 'encoding_started' });
      this.logStreamEvent(sessionId, 'Output encoding started');
    }

    // Encoding started (first frame)
    if (line.includes('frame=') && line.includes('fps=')) {
      if (session.status !== 'streaming') {
        this.updateStreamSession(sessionId, { status: 'streaming' });
        this.logStreamEvent(sessionId, 'Stream is LIVE');
      }
    }

    // Errors
    if (line.toLowerCase().includes('error') && !line.includes('Errorlog')) {
      this.logStreamEvent(sessionId, 'FFmpeg error', { error: line.trim() });
    }
  }

  // Cleanup old sessions
  cleanupOldSessions() {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.startTime > maxAge) {
        this.info('stream', 'Session expired and cleaned up', {
          sessionId: sessionId.substring(0, 8),
          user: session.username,
          duration: Math.round((now - session.startTime) / 1000) + 's'
        });
        this.sessions.delete(sessionId);
      }
    }
  }

  // Get active sessions summary
  getActiveSessions() {
    const sessions = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      sessions.push({
        sessionId: sessionId.substring(0, 8),
        user: session.username,
        channel: session.channelName,
        duration: Math.round((Date.now() - session.startTime) / 1000),
        status: session.status,
        codec: session.videoCodec || 'unknown'
      });
    }
    return sessions;
  }
}

const logger = new Logger();

// Periodic cleanup
setInterval(() => {
  logger.cleanupOldSessions();
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// 🛡️ STREAM URL PROTECTION
// ═══════════════════════════════════════════════════════════════════════════════

const streamTokens = new Map();

function generateStreamToken(userId, streamUrl, channelInfo, username) {
  const tokenId = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + 60000; // 60 seconds
  
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(STREAM_SECRET.substring(0, 32)), iv);
  let encrypted = cipher.update(streamUrl, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  streamTokens.set(tokenId, {
    userId,
    username,
    encryptedUrl: encrypted,
    iv: iv.toString('hex'),
    expiresAt,
    usedCount: 0,
    maxUses: 5,
    channelInfo,
    createdAt: Date.now()
  });
  
  logger.info('token', 'Stream token generated', {
    tokenId: tokenId.substring(0, 8),
    user: username,
    channel: channelInfo.name,
    expiresIn: '60s'
  });
  
  setTimeout(() => {
    if (streamTokens.delete(tokenId)) {
      logger.debug('token', 'Token expired and removed', {
        tokenId: tokenId.substring(0, 8)
      });
    }
  }, 70000);
  
  return tokenId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 ENCRYPTION UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return {
    iv: iv.toString('hex'),
    encryptedData: encrypted,
    authTag: authTag.toString('hex')
  };
}

function decrypt(encryptedObj) {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const iv = Buffer.from(encryptedObj.iv, 'hex');
  const authTag = Buffer.from(encryptedObj.authTag, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedObj.encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, storedHash) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
}

function generateAuthToken(userId, role) {
  const payload = {
    userId,
    role,
    iat: Date.now(),
    exp: Date.now() + TOKEN_EXPIRY
  };
  
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadStr).toString('base64url');
  
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payloadB64)
    .digest('base64url');
  
  return `${payloadB64}.${signature}`;
}

function verifyAuthToken(token) {
  try {
    const [payloadB64, signature] = token.split('.');
    
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(payloadB64)
      .digest('base64url');
    
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return null;
    }
    
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    
    if (payload.exp < Date.now()) {
      return null;
    }
    
    return payload;
  } catch (error) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📁 USER DATA MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      const defaultUsers = createDefaultAdmin();
      saveUsers(defaultUsers);
      return defaultUsers;
    }
    
    const encryptedData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const decrypted = decrypt(encryptedData);
    return JSON.parse(decrypted);
  } catch (error) {
    logger.error('data', 'Error loading users', { error: error.message });
    const defaultUsers = createDefaultAdmin();
    saveUsers(defaultUsers);
    return defaultUsers;
  }
}

function saveUsers(users) {
  const encrypted = encrypt(JSON.stringify(users));
  fs.writeFileSync(USERS_FILE, JSON.stringify(encrypted, null, 2));
}

function createDefaultAdmin() {
  const { salt, hash } = hashPassword('admin123');
  return {
    users: [
      {
        id: crypto.randomUUID(),
        username: 'admin',
        passwordHash: hash,
        passwordSalt: salt,
        role: 'admin',
        portalUrl: '',
        macAddress: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastLogin: null,
        isActive: true
      }
    ]
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🛡️ MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  
  const token = authHeader.substring(7);
  const payload = verifyAuthToken(token);
  
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

const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000;

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const key = `${ip}_${req.body.username || ''}`;
  
  const attempts = loginAttempts.get(key);
  
  if (attempts && attempts.count >= MAX_LOGIN_ATTEMPTS) {
    const timePassed = Date.now() - attempts.lastAttempt;
    if (timePassed < LOCKOUT_TIME) {
      const remainingTime = Math.ceil((LOCKOUT_TIME - timePassed) / 60000);
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

// ═══════════════════════════════════════════════════════════════════════════════
// 🔐 AUTH ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/login', rateLimitMiddleware, (req, res) => {
  try {
    const { username, password } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }
    
    const data = loadUsers();
    const user = data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    
    if (!user || !user.isActive) {
      recordLoginAttempt(ip, username, false);
      logger.logAuth('Login failed', username, ip, false);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      recordLoginAttempt(ip, username, false);
      logger.logAuth('Login failed - wrong password', username, ip, false);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    recordLoginAttempt(ip, username, true);
    
    user.lastLogin = new Date().toISOString();
    saveUsers(data);
    
    const token = generateAuthToken(user.id, user.role);
    
    logger.logAuth('Login successful', username, ip, true);
    logger.logUserActivity(username, 'logged in', { role: user.role });
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        hasPortalConfig: !!(user.portalUrl && user.macAddress)
      }
    });
    
  } catch (error) {
    logger.error('auth', 'Login error', { error: error.message });
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  try {
    const data = loadUsers();
    const user = data.users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        hasPortalConfig: !!(user.portalUrl && user.macAddress),
        createdAt: user.createdAt,
        lastLogin: user.lastLogin
      }
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get user info' });
  }
});

app.post('/api/auth/change-password', authMiddleware, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Current and new password required' });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    
    const data = loadUsers();
    const user = data.users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    if (!verifyPassword(currentPassword, user.passwordSalt, user.passwordHash)) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }
    
    const { salt, hash } = hashPassword(newPassword);
    user.passwordHash = hash;
    user.passwordSalt = salt;
    user.updatedAt = new Date().toISOString();
    
    saveUsers(data);
    
    logger.logUserActivity(user.username, 'changed password');
    
    res.json({ success: true, message: 'Password changed successfully' });
    
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to change password' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 👥 ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const data = loadUsers();
    
    const users = data.users.map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      hasPortalConfig: !!(u.portalUrl && u.macAddress),
      portalUrl: u.portalUrl ? u.portalUrl.replace(/^(https?:\/\/[^\/]+).*/, '$1/***') : '',
      macAddress: u.macAddress ? u.macAddress.replace(/(.{2}:.{2}:.{2}:).+/, '$1**:**:**') : '',
      isActive: u.isActive,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin
    }));
    
    res.json({ success: true, users });
    
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to list users' });
  }
});

app.post('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { username, password, role, portalUrl, macAddress } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    
    if (role && !['user', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
    }
    
    const data = loadUsers();
    
    if (data.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Username already exists' });
    }
    
    const { salt, hash } = hashPassword(password);
    
    const newUser = {
      id: crypto.randomUUID(),
      username: username.trim(),
      passwordHash: hash,
      passwordSalt: salt,
      role: role || 'user',
      portalUrl: portalUrl || '',
      macAddress: macAddress || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLogin: null,
      isActive: true
    };
    
    data.users.push(newUser);
    saveUsers(data);
    
    logger.logUserActivity('admin', `created user ${username}`, { role: newUser.role });
    
    res.json({
      success: true,
      user: {
        id: newUser.id,
        username: newUser.username,
        role: newUser.role,
        hasPortalConfig: !!(newUser.portalUrl && newUser.macAddress)
      }
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

app.put('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { username, password, role, portalUrl, macAddress, isActive } = req.body;
    
    const data = loadUsers();
    const userIndex = data.users.findIndex(u => u.id === id);
    
    if (userIndex === -1) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const user = data.users[userIndex];
    
    if (user.role === 'admin' && isActive === false) {
      const activeAdmins = data.users.filter(u => u.role === 'admin' && u.isActive && u.id !== id);
      if (activeAdmins.length === 0) {
        return res.status(400).json({ success: false, error: 'Cannot disable the last admin' });
      }
    }
    
    if (username && username !== user.username) {
      if (data.users.some(u => u.id !== id && u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ success: false, error: 'Username already exists' });
      }
      user.username = username.trim();
    }
    
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
      }
      const { salt, hash } = hashPassword(password);
      user.passwordHash = hash;
      user.passwordSalt = salt;
    }
    
    if (role && ['user', 'admin'].includes(role)) user.role = role;
    if (portalUrl !== undefined) user.portalUrl = portalUrl;
    if (macAddress !== undefined) user.macAddress = macAddress;
    if (isActive !== undefined) user.isActive = isActive;
    
    user.updatedAt = new Date().toISOString();
    saveUsers(data);
    
    logger.logUserActivity('admin', `updated user ${user.username}`);
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        hasPortalConfig: !!(user.portalUrl && user.macAddress),
        isActive: user.isActive
      }
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    
    const data = loadUsers();
    const userIndex = data.users.findIndex(u => u.id === id);
    
    if (userIndex === -1) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const user = data.users[userIndex];
    
    if (user.role === 'admin') {
      const admins = data.users.filter(u => u.role === 'admin');
      if (admins.length <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot delete the last admin' });
      }
    }
    
    if (id === req.user.userId) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
    }
    
    data.users.splice(userIndex, 1);
    saveUsers(data);
    
    logger.logUserActivity('admin', `deleted user ${user.username}`);
    
    res.json({ success: true, message: 'User deleted successfully' });
    
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

app.get('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    
    const data = loadUsers();
    const user = data.users.find(u => u.id === id);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        portalUrl: user.portalUrl,
        macAddress: user.macAddress,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLogin: user.lastLogin
      }
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get user details' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 📺 IPTV ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

const stalkerSessions = new Map();

function getStalkerHeaders(token = '', macAddress = '') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2738 Mobile Safari/533.3',
    'X-User-Agent': 'Model: MAG254; Link: Ethernet',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
  };

  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (macAddress) {
    headers['Cookie'] = `PHPSESSID=null; sn=93200916082029478; mac=${macAddress}; timezone=Europe/Lisbon; stb_lang=en`;
  }

  return headers;
}

async function discoverPortalPath(baseUrl, macAddress, username) {
  logger.info('iptv', `${username} - Discovering portal path`, { baseUrl });
  
  const possiblePaths = [
    '/portal.php',
    '/stalker_portal/server/load.php',
    '/server/load.php',
    '/stalker_portal/c/portal.php',
    '/c/portal.php',
    '',
  ];

  for (const path of possiblePaths) {
    const testUrl = `${baseUrl}${path}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`;
    
    try {
      const response = await axios.get(testUrl, {
        headers: getStalkerHeaders('', macAddress),
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500,
      });

      if (response.status === 200 && response.data?.js?.token) {
        logger.info('iptv', `${username} - Portal path discovered`, { path: path || '(root)' });
        return {
          path,
          fullUrl: `${baseUrl}${path}`,
          token: response.data.js.token,
          response: response.data
        };
      }
    } catch (error) {
      // Silent fail, try next path
    }
  }

  return null;
}

app.post('/api/iptv/connect', authMiddleware, async (req, res) => {
  try {
    const data = loadUsers();
    const user = data.users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    if (!user.portalUrl || !user.macAddress) {
      return res.status(400).json({ 
        success: false, 
        error: 'Portal URL and MAC address not configured. Contact admin.' 
      });
    }

    logger.logIPTVConnection(user.username, user.portalUrl, 'connecting');

    let baseUrl = user.portalUrl
      .replace(/\/$/, '')
      .replace(/\/portal\.php.*$/, '')
      .replace(/\/stalker_portal.*$/, '')
      .replace(/\/server.*$/, '')
      .replace(/\/c\/?$/, '');

    try {
      const checkRedirect = await axios.get(baseUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status < 400,
        timeout: 10000,
      });

      if (checkRedirect.status === 301 || checkRedirect.status === 302) {
        const redirectUrl = checkRedirect.headers.location;
        if (redirectUrl) baseUrl = redirectUrl.replace(/\/$/, '');
      }
    } catch (error) {
      if (error.response?.status === 301 || error.response?.status === 302) {
        const redirectUrl = error.response.headers.location;
        if (redirectUrl) baseUrl = redirectUrl.replace(/\/$/, '');
      }
    }

    const discovery = await discoverPortalPath(baseUrl, user.macAddress, user.username);

    if (!discovery) {
      logger.logIPTVConnection(user.username, baseUrl, 'failed', { error: 'discovery_failed' });
      return res.status(500).json({
        success: false,
        error: 'Could not connect to IPTV portal'
      });
    }

    const sessionId = crypto.randomBytes(16).toString('hex');
    stalkerSessions.set(sessionId, {
      baseUrl,
      portalUrl: discovery.fullUrl,
      portalPath: discovery.path,
      macAddress: user.macAddress,
      token: discovery.token,
      userId: user.id,
      username: user.username,
      createdAt: Date.now(),
    });

    logger.logIPTVConnection(user.username, baseUrl, 'connected', { sessionId: sessionId.substring(0, 8) });

    res.json({
      success: true,
      sessionId,
      message: 'Connected to IPTV!'
    });

  } catch (error) {
    logger.error('iptv', 'Connection error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to connect to IPTV' });
  }
});

app.post('/api/iptv/channels', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId || !stalkerSessions.has(sessionId)) {
      return res.status(401).json({ success: false, error: 'Invalid IPTV session' });
    }

    const session = stalkerSessions.get(sessionId);
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    logger.logUserActivity(session.username, 'fetching channels');
    
    await axios.get(`${session.portalUrl}?type=stb&action=get_profile&JsHttpRequest=1-xml`, {
      headers: getStalkerHeaders(session.token, session.macAddress),
      timeout: 15000,
    });
    
    let allChannels = [];
    let page = 1;
    let totalItems = 0;
    
    const firstResponse = await axios.get(
      `${session.portalUrl}?type=itv&action=get_ordered_list&genre=*&force_ch_link_check=&fav=0&sortby=number&hd=0&p=${page}&JsHttpRequest=1-xml`,
      { headers: getStalkerHeaders(session.token, session.macAddress), timeout: 30000 }
    );
    
    totalItems = firstResponse.data?.js?.total_items || 0;
    allChannels = firstResponse.data?.js?.data || [];
    
    logger.info('iptv', `${session.username} - Loading channels`, { 
      total: totalItems,
      loaded: allChannels.length,
      page: 1
    });
    
    page = 2;
    let hasMorePages = true;
    while (hasMorePages && allChannels.length < totalItems && page <= 100) {
      try {
        const pageResponse = await axios.get(
          `${session.portalUrl}?type=itv&action=get_ordered_list&genre=*&force_ch_link_check=&fav=0&sortby=number&hd=0&p=${page}&JsHttpRequest=1-xml`,
          { headers: getStalkerHeaders(session.token, session.macAddress), timeout: 30000 }
        );
        
        const pageChannels = pageResponse.data?.js?.data || [];
        if (pageChannels.length === 0) {
          hasMorePages = false;
        } else {
          allChannels = allChannels.concat(pageChannels);
          page++;
        }
      } catch {
        hasMorePages = false;
      }
    }
    
    logger.info('iptv', `${session.username} - Channels loaded`, { 
      total: totalItems,
      loaded: allChannels.length
    });

    res.json({
      success: true,
      total: totalItems,
      loaded: allChannels.length,
      channels: allChannels.map(ch => ({
        id: ch.id,
        name: ch.name,
        number: ch.number,
        logo: ch.logo,
        cmd: ch.cmd,
        tv_genre_id: ch.tv_genre_id,
        genres_str: ch.genres_str || '',
        hd: ch.hd === "1" || ch.hd === 1,
      }))
    });

  } catch (error) {
    logger.error('iptv', 'Channels fetch error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to fetch channels' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 PROTECTED STREAM ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/iptv/stream', authMiddleware, async (req, res) => {
  try {
    const { sessionId, channelId, cmd, channelName } = req.body;

    if (!sessionId || !stalkerSessions.has(sessionId)) {
      return res.status(401).json({ success: false, error: 'Invalid IPTV session' });
    }

    const session = stalkerSessions.get(sessionId);
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    logger.logUserActivity(session.username, 'requesting stream', { channel: channelName });
    
    const response = await axios.get(
      `${session.portalUrl}?type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&series=&JsHttpRequest=1-xml`,
      { headers: getStalkerHeaders(session.token, session.macAddress), timeout: 15000 }
    );

    let streamUrl = response.data?.js?.cmd || response.data?.js || '';
    
    if (typeof streamUrl === 'string') {
      streamUrl = streamUrl.replace(/^ffmpeg\s+/i, '').replace(/^ffmpeg:/i, '').trim();
    }
    
    const urlLower = streamUrl.toLowerCase();
    let streamType = 'unknown';
    if (urlLower.includes('.m3u8')) streamType = 'HLS';
    else if (urlLower.includes('.mpd')) streamType = 'DASH';
    else if (urlLower.includes('.ts')) streamType = 'MPEG-TS';
    else if (urlLower.includes('.flv')) streamType = 'FLV';
    else if (urlLower.includes('http')) streamType = 'HTTP';
    
    const channelInfo = {
      id: channelId,
      name: channelName || 'Unknown',
      type: streamType
    };
    
    const streamToken = generateStreamToken(req.user.userId, streamUrl, channelInfo, session.username);
    const proxyUrl = `/api/stream/${streamToken}`;
    
    logger.info('stream', `${session.username} - Stream URL generated`, {
      channel: channelName,
      type: streamType,
      tokenId: streamToken.substring(0, 8)
    });

    res.json({
      success: true,
      streamUrl: proxyUrl,
      channelId,
      streamType
    });

  } catch (error) {
    logger.error('stream', 'Stream request error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get stream' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🔄 PROTECTED PROXY
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/stream/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  let ffmpegProcess = null;
  let streamSessionId = null;
  
  try {
    const token = streamTokens.get(tokenId);
    
    if (!token) {
      logger.warn('token', 'Token not found or expired', { tokenId: tokenId.substring(0, 8) });
      return res.status(401).send('Unauthorized');
    }
    
    if (Date.now() > token.expiresAt) {
      streamTokens.delete(tokenId);
      logger.warn('token', 'Token expired', { tokenId: tokenId.substring(0, 8) });
      return res.status(401).send('Unauthorized');
    }
    
    if (token.usedCount >= token.maxUses) {
      logger.warn('token', 'Token max uses reached', { 
        tokenId: tokenId.substring(0, 8),
        uses: `${token.usedCount}/${token.maxUses}`
      });
    }
    
    token.usedCount++;
    
    const iv = Buffer.from(token.iv, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(STREAM_SECRET.substring(0, 32)), iv);
    let streamUrl = decipher.update(token.encryptedUrl, 'hex', 'utf8');
    streamUrl += decipher.final('utf8');
    
    const channelInfo = token.channelInfo;
    
    // Create stream session
    streamSessionId = `${tokenId}_${Date.now()}`;
    const streamSession = logger.createStreamSession(
      streamSessionId,
      token.userId,
      token.username,
      channelInfo.id,
      channelInfo.name
    );
    
    logger.updateStreamSession(streamSessionId, {
      streamUrl: streamUrl.substring(0, 60) + '...',
      streamType: channelInfo.type
    });
    
    // Test URL accessibility
    try {
      const testResponse = await axios.head(streamUrl, {
        timeout: 5000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500
      });
      
      logger.logStreamEvent(streamSessionId, 'Source accessible', {
        status: testResponse.status,
        contentType: testResponse.headers['content-type']
      });
      
    } catch (testError) {
      logger.logStreamEvent(streamSessionId, 'Source not accessible', {
        error: testError.message
      });
      return res.status(502).send('Source unavailable');
    }
    
    // Start FFmpeg
    logger.logStreamEvent(streamSessionId, 'Starting FFmpeg transcoding');
    
    ffmpegProcess = spawn('ffmpeg', [
      '-user_agent', 'Lavf/56.40.101',
      '-i', streamUrl,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-c:a', 'aac',
      '-ac', '2',
      '-ar', '48000',
      '-b:a', '128k',
      '-f', 'flv',
      '-'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    // FFmpeg stderr parsing
    let ffmpegStarted = false;
    
    ffmpegProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        logger.parseFFmpegOutput(streamSessionId, line);
        
        // Detect first frame
        if (!ffmpegStarted && line.includes('frame=') && line.includes('fps=')) {
          ffmpegStarted = true;
        }
      });
    });
    
    // Response headers
    res.set('Content-Type', 'video/x-flv');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Connection', 'keep-alive');
    res.set('Transfer-Encoding', 'chunked');
    
    logger.logStreamEvent(streamSessionId, 'Response headers sent');
    
    // Pipe output
    ffmpegProcess.stdout.pipe(res);
    
    // FFmpeg process events
    ffmpegProcess.on('error', (err) => {
      logger.logStreamEvent(streamSessionId, 'FFmpeg spawn error', { error: err.message });
    });
    
    ffmpegProcess.on('close', (code) => {
      const duration = Math.round((Date.now() - streamSession.startTime) / 1000);
      logger.logStreamEvent(streamSessionId, 'FFmpeg closed', { 
        code,
        duration: `${duration}s`
      });
    });
    
    // Client disconnect
    req.on('close', () => {
      logger.logStreamEvent(streamSessionId, 'Client disconnected');
      if (ffmpegProcess && !ffmpegProcess.killed) {
        ffmpegProcess.kill('SIGTERM');
        setTimeout(() => {
          if (!ffmpegProcess.killed) {
            ffmpegProcess.kill('SIGKILL');
          }
        }, 2000);
      }
    });
    
  } catch (error) {
    if (streamSessionId) {
      logger.logStreamEvent(streamSessionId, 'Stream error', { error: error.message });
    } else {
      logger.error('stream', 'Stream error', { error: error.message });
    }
    
    if (ffmpegProcess && !ffmpegProcess.killed) {
      ffmpegProcess.kill('SIGTERM');
    }
    
    if (!res.headersSent) {
      res.status(500).send('Stream error');
    }
  }
});

// Health check
app.get('/api/health', (req, res) => {
  const activeSessions = logger.getActiveSessions();
  
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.length,
    sessions: activeSessions
  });
});

// Cleanup
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [sessionId, session] of stalkerSessions.entries()) {
    if (now - session.createdAt > oneHour) {
      logger.debug('iptv', 'Session expired', { 
        sessionId: sessionId.substring(0, 8),
        user: session.username
      });
      stalkerSessions.delete(sessionId);
    }
  }
  
  for (const [tokenId, token] of streamTokens.entries()) {
    if (now > token.expiresAt) {
      streamTokens.delete(tokenId);
    }
  }
}, 5 * 60 * 1000);

// Server startup
app.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  IPTV Backend Server');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');
  logger.info('server', 'Backend started', { port: PORT });
  logger.info('server', 'Health endpoint', { url: `http://localhost:${PORT}/api/health` });
  logger.info('server', 'Default credentials', { username: 'admin', password: 'admin123' });
  console.log('');
});