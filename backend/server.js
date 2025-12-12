// ═══════════════════════════════════════════════════════════════════════════════
// 🚀 IPTV Backend Server - Refactored & Modular
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const config = require('./config/constants');
const logger = require('./utils/logger');
const encryption = require('./services/encryption');
const userService = require('./services/userService');
const iptvService = require('./services/iptvService');
const streamService = require('./services/streamService');
const { authMiddleware, adminMiddleware } = require('./middleware/auth');
const { rateLimitMiddleware, recordLoginAttempt } = require('./middleware/rateLimit');

const app = express();

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════════
// 🔐 AUTHENTICATION ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/login', rateLimitMiddleware, (req, res) => {
  try {
    const { username, password } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }
    
    const user = userService.findUserByUsername(username);
    
    if (!user || !user.isActive) {
      recordLoginAttempt(ip, username, false);
      logger.logAuth('Login failed', username, ip, false);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    if (!encryption.verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      recordLoginAttempt(ip, username, false);
      logger.logAuth('Login failed - wrong password', username, ip, false);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    recordLoginAttempt(ip, username, true);
    userService.updateLastLogin(user.id);
    
    const token = encryption.generateAuthToken(user.id, user.role);
    
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
    const user = userService.findUserById(req.user.userId);
    
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
    
    userService.changePassword(req.user.userId, currentPassword, newPassword);
    
    const user = userService.findUserById(req.user.userId);
    logger.logUserActivity(user.username, 'changed password');
    
    res.json({ success: true, message: 'Password changed successfully' });
    
  } catch (error) {
    res.status(error.message === 'Current password is incorrect' ? 401 : 500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 👥 ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const users = userService.listUsers();
    
    // Mask sensitive data
    const maskedUsers = users.map(u => ({
      ...u,
      portalUrl: u.portalUrl ? u.portalUrl.replace(/^(https?:\/\/[^\/]+).*/, '$1/***') : '',
      macAddress: u.macAddress ? u.macAddress.replace(/(.{2}:.{2}:.{2}:).+/, '$1**:**:**') : ''
    }));
    
    res.json({ success: true, users: maskedUsers });
    
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to list users' });
  }
});

app.post('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { username, password, role, portalUrl, macAddress, isActive } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    
    if (role && !['user', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
    }
    
    const newUser = userService.createUser({
      username,
      password,
      role,
      portalUrl,
      macAddress,
      isActive
    });
    
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
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Validation for last admin
    const user = userService.findUserById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    if (user.role === 'admin' && updates.isActive === false) {
      const allUsers = userService.listUsers();
      const activeAdmins = allUsers.filter(u => u.role === 'admin' && u.isActive && u.id !== id);
      if (activeAdmins.length === 0) {
        return res.status(400).json({ success: false, error: 'Cannot disable the last admin' });
      }
    }
    
    if (updates.password && updates.password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    
    const updatedUser = userService.updateUser(id, updates);
    
    logger.logUserActivity('admin', `updated user ${updatedUser.username}`);
    
    res.json({
      success: true,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        role: updatedUser.role,
        hasPortalConfig: !!(updatedUser.portalUrl && updatedUser.macAddress),
        isActive: updatedUser.isActive
      }
    });
    
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    
    const user = userService.findUserById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    if (user.role === 'admin') {
      const allUsers = userService.listUsers();
      const admins = allUsers.filter(u => u.role === 'admin');
      if (admins.length <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot delete the last admin' });
      }
    }
    
    if (id === req.user.userId) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
    }
    
    userService.deleteUser(id);
    
    logger.logUserActivity('admin', `deleted user ${user.username}`);
    
    res.json({ success: true, message: 'User deleted successfully' });
    
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const user = userService.findUserById(id);
    
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
// 📺 IPTV ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/iptv/connect', authMiddleware, async (req, res) => {
  try {
    const user = userService.findUserById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const { sessionId } = await iptvService.connect(user);
    
    // Start watchdog for session
    iptvService.startWatchdog(sessionId);
    
    res.json({
      success: true,
      sessionId,
      message: 'Connected to IPTV!'
    });
    
  } catch (error) {
    logger.error('iptv', 'Connection error', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/iptv/genres', authMiddleware, async (req, res) => {
  try {
    const { sessionId, type } = req.body;
    
    const session = iptvService.getSession(sessionId);
    
    if (!session) {
      return res.status(401).json({ success: false, error: 'Invalid IPTV session' });
    }
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    const genres = await iptvService.getGenres(sessionId, type || 'itv');
    
    res.json({
      success: true,
      type: type || 'itv',
      genres
    });
    
  } catch (error) {
    logger.error('iptv', 'Genres fetch error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to fetch genres' });
  }
});

app.post('/api/iptv/channels', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    const session = iptvService.getSession(sessionId);
    
    if (!session) {
      return res.status(401).json({ success: false, error: 'Invalid IPTV session' });
    }
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    const result = await iptvService.getChannels(sessionId);
    
    res.json({
      success: true,
      ...result
    });
    
  } catch (error) {
    logger.error('iptv', 'Channels fetch error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to fetch channels' });
  }
});

app.post('/api/iptv/stream', authMiddleware, async (req, res) => {
  try {
    const { sessionId, channelId, cmd, channelName } = req.body;
    
    const session = iptvService.getSession(sessionId);
    
    if (!session) {
      return res.status(401).json({ success: false, error: 'Invalid IPTV session' });
    }
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    const streamInfo = await iptvService.createStreamLink(sessionId, channelId, cmd, channelName);
    
    const channelInfo = {
      id: channelId,
      name: channelName || 'Unknown',
      type: streamInfo.streamType
    };
    
    const streamToken = streamService.generateStreamToken(
      req.user.userId,
      streamInfo.streamUrl,
      channelInfo,
      session.username
    );
    
    const proxyUrl = `/api/stream/${streamToken}`;
    
    res.json({
      success: true,
      streamUrl: proxyUrl,
      channelId,
      streamType: streamInfo.streamType
    });
    
  } catch (error) {
    logger.error('stream', 'Stream request error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get stream' });
  }
});

app.post('/api/iptv/watchdog', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    const session = iptvService.getSession(sessionId);
    
    if (!session) {
      return res.status(401).json({ success: false, error: 'Invalid IPTV session' });
    }
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    const result = await iptvService.watchdog(sessionId);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    logger.error('iptv', 'Watchdog error', { error: error.message });
    res.status(500).json({ success: false, error: 'Watchdog failed' });
  }
});

app.post('/api/iptv/disconnect', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    const session = iptvService.getSession(sessionId);
    
    if (session && session.userId === req.user.userId) {
      iptvService.destroySession(sessionId);
      logger.logUserActivity(session.username, 'disconnected from IPTV');
    }
    
    res.json({ success: true });
    
  } catch (error) {
    res.status(500).json({ success: false, error: 'Disconnect failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🎬 STREAM PROXY
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/stream/:tokenId', async (req, res) => {
  await streamService.handleStream(req.params.tokenId, req, res);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🏥 HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  const activeSessions = logger.getActiveSessions();
  
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.length,
    sessions: activeSessions
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════════════════════════════════════════

app.listen(config.PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  📺 IPTV Backend Server');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');
  logger.info('server', 'Backend started', { port: config.PORT });
  logger.info('server', 'Health endpoint', { url: `http://localhost:${config.PORT}/api/health` });
  logger.info('server', 'Default credentials', { username: 'admin', password: 'admin123' });
  console.log('');
  console.log('✨ New Features:');
  console.log('  • Custom portal paths support');
  console.log('  • Dynamic genres loading');
  console.log('  • Watchdog keep-alive');
  console.log('  • Modular architecture');
  console.log('');
});
