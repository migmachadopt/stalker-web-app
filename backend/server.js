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
const channelListService = require('./services/channelListService');
const archiveService = require('./services/archiveService');
const vodService = require('./services/vodService');
const { authMiddleware, adminMiddleware } = require('./middleware/auth');
const { rateLimitMiddleware, recordLoginAttempt } = require('./middleware/rateLimit');

const app = express();

app.use(cors());
app.use(express.json());

// Any request that carries an IPTV session keeps that session alive
app.use('/api/iptv', (req, res, next) => {
  if (req.body?.sessionId) iptvService.touchSession(req.body.sessionId);
  next();
});

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
        hasPortalConfig: !!(user.portalUrl && user.macAddress),
        sections: vodService.getSections(user)
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
        sections: vodService.getSections(user),
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
    
    // A different portal/MAC means the stored channel list no longer applies
    const portalChanged = updates.portalUrl !== undefined && updates.portalUrl !== user.portalUrl;
    const macChanged = updates.macAddress !== undefined && updates.macAddress !== user.macAddress;
    if (portalChanged) updates.enabledGenres = [];

    const updatedUser = userService.updateUser(id, updates);

    if (portalChanged || macChanged) channelListService.remove(id);

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
    channelListService.remove(id);

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

// Channel groups visible to a user (groups are hidden until enabled here)
app.get('/api/admin/users/:id/groups', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const user = userService.findUserById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, ...channelListService.getGroups(user), sections: user.enabledSections || [] });

  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get channel groups' });
  }
});

app.put('/api/admin/users/:id/groups', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { enabledGenres, enabledSections } = req.body;

    if (!Array.isArray(enabledGenres)) {
      return res.status(400).json({ success: false, error: 'enabledGenres must be an array' });
    }

    const updatedUser = userService.updateUser(req.params.id, { enabledGenres, enabledSections });

    logger.logUserActivity('admin', `updated channel groups of ${updatedUser.username}`, {
      enabled: updatedUser.enabledGenres.length
    });

    res.json({ success: true, ...channelListService.getGroups(updatedUser), sections: updatedUser.enabledSections || [] });

  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/users/:id/groups/refresh', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const user = userService.findUserById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    await channelListService.refreshForUser(user);

    logger.logUserActivity('admin', `refreshed channel list of ${user.username}`);

    res.json({ success: true, ...channelListService.getGroups(user), sections: user.enabledSections || [] });

  } catch (error) {
    logger.error('iptv', 'Admin channel list refresh error', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
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
    
    // Start watchdog for session (restarts cleanly when the session is reused)
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

app.post('/api/iptv/channels', authMiddleware, async (req, res) => {
  try {
    const { sessionId, refresh } = req.body;
    
    const session = iptvService.getSession(sessionId);
    
    if (!session) {
      return res.status(410).json({ success: false, error: 'Invalid IPTV session' });
    }
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    const user = userService.findUserById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    // Stored list is reused; the portal is only read when it is older than 24h or on demand
    const { list, fromCache } = await channelListService.getList(sessionId, user.id, refresh === true);
    
    res.json({
      success: true,
      updatedAt: list.updatedAt,
      fromCache,
      ...channelListService.getVisible(user, list)
    });
    
  } catch (error) {
    logger.error('iptv', 'Channels fetch error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to fetch channels' });
  }
});

app.post('/api/iptv/stream', authMiddleware, async (req, res) => {
  try {
    const { sessionId, channelId } = req.body;
    
    const session = iptvService.getSession(sessionId);
    
    if (!session) {
      return res.status(410).json({ success: false, error: 'Invalid IPTV session' });
    }
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    // Only channels from groups enabled for this user can be played
    const user = userService.findUserById(req.user.userId);
    const channel = user && channelListService.findVisibleChannel(user, channelId);
    
    if (!channel) {
      return res.status(403).json({ success: false, error: 'Channel not available' });
    }
    
    const channelName = channel.name;
    const streamInfo = await iptvService.createStreamLink(sessionId, channel.id, channel.cmd, channelName);
    
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

// Programme guide of one channel for one day (used by the archive browser)
app.post('/api/iptv/epg', authMiddleware, async (req, res) => {
  try {
    const { sessionId, channelId, date } = req.body;
    
    const session = iptvService.getSession(sessionId);
    
    if (!session) {
      return res.status(410).json({ success: false, error: 'Invalid IPTV session' });
    }
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    const user = userService.findUserById(req.user.userId);
    const channel = user && channelListService.findVisibleChannel(user, channelId);
    
    if (!channel) {
      return res.status(403).json({ success: false, error: 'Channel not available' });
    }
    
    const programs = await archiveService.getEpg(sessionId, user.id, channel.id, date);
    
    res.json({
      success: true,
      channelId: channel.id,
      date,
      archive: !!channel.archive,
      archiveHours: channel.archiveHours || 0,
      programs
    });
    
  } catch (error) {
    logger.error('iptv', 'EPG fetch error', { error: error.message });
    res.status(error.message === 'Invalid date' ? 400 : 500).json({ success: false, error: 'Failed to fetch programme guide' });
  }
});

// Archive (catch-up) stream for a programme or a custom interval of a channel
app.post('/api/iptv/archive/stream', authMiddleware, async (req, res) => {
  try {
    const { sessionId, channelId, date, programId, start, duration, title } = req.body;
    
    const session = iptvService.getSession(sessionId);
    
    if (!session) {
      return res.status(410).json({ success: false, error: 'Invalid IPTV session' });
    }
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    const user = userService.findUserById(req.user.userId);
    const channel = user && channelListService.findVisibleChannel(user, channelId);
    
    if (!channel) {
      return res.status(403).json({ success: false, error: 'Channel not available' });
    }
    
    const request = { date, programId, start, duration };
    let window;
    
    try {
      window = await archiveService.createWindowLink(sessionId, user.id, channel, request);
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    
    const safeTitle = String(title || 'archive').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    
    const streamToken = streamService.generateStreamToken(
      req.user.userId,
      window.url,
      { id: channel.id, name: channel.name, type: 'ARCHIVE' },
      session.username,
      {
        duration: window.duration,
        filename: `${channel.name} - ${safeTitle}.ts`,
        relink: async () => (await archiveService.createWindowLink(sessionId, user.id, channel, request)).url
      }
    );
    
    logger.logUserActivity(session.username, 'requesting archive', {
      channel: channel.name,
      minutes: Math.round(window.duration / 60)
    });
    
    res.json({
      success: true,
      streamUrl: `/api/stream/${streamToken}`,
      start: window.start,
      duration: window.duration
    });
    
  } catch (error) {
    logger.error('stream', 'Archive request error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get archive stream' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Video club & series
// ─────────────────────────────────────────────────────────────────────────────

// Resolves the session and checks the user may use that section ('vod' | 'series')
function vodContext(req, res) {
  const { sessionId, type } = req.body;
  const session = iptvService.getSession(sessionId);
  
  if (!session) {
    res.status(410).json({ success: false, error: 'Invalid IPTV session' });
    return null;
  }
  
  if (session.userId !== req.user.userId) {
    res.status(403).json({ success: false, error: 'Session access denied' });
    return null;
  }
  
  const user = userService.findUserById(req.user.userId);
  
  if (!user || !vodService.canAccess(user, type)) {
    res.status(403).json({ success: false, error: 'This section is not enabled for your account' });
    return null;
  }
  
  return { sessionId, session, user, type };
}

app.post('/api/iptv/vod/categories', authMiddleware, async (req, res) => {
  try {
    const ctx = vodContext(req, res);
    if (!ctx) return;
    
    const categories = await vodService.getCategories(ctx.sessionId, ctx.type);
    
    res.json({ success: true, type: ctx.type, categories });
    
  } catch (error) {
    logger.error('iptv', 'VOD categories error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to load categories' });
  }
});

app.post('/api/iptv/vod/list', authMiddleware, async (req, res) => {
  try {
    const ctx = vodContext(req, res);
    if (!ctx) return;
    
    const { category, page, search } = req.body;
    const result = await vodService.getList(ctx.sessionId, ctx.type, { category, page, search });
    
    res.json({ success: true, type: ctx.type, ...result });
    
  } catch (error) {
    logger.error('iptv', 'VOD list error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to load titles' });
  }
});

app.post('/api/iptv/vod/seasons', authMiddleware, async (req, res) => {
  try {
    req.body.type = 'series';
    const ctx = vodContext(req, res);
    if (!ctx) return;
    
    const seasons = await vodService.getSeasons(ctx.sessionId, String(req.body.seriesId || ''));
    
    res.json({ success: true, seasons });
    
  } catch (error) {
    logger.error('iptv', 'Series seasons error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to load seasons' });
  }
});

// Film (cmd) or episode (season cmd + episode number) as a seekable, downloadable file
app.post('/api/iptv/vod/stream', authMiddleware, async (req, res) => {
  try {
    const ctx = vodContext(req, res);
    if (!ctx) return;
    
    const { cmd, episode, title } = req.body;
    
    if (typeof cmd !== 'string' || !cmd || cmd.length > 2000) {
      return res.status(400).json({ success: false, error: 'Missing title reference' });
    }
    
    const episodeNumber = ctx.type === 'series' ? String(parseInt(episode, 10) || '') : '';
    
    if (ctx.type === 'series' && !episodeNumber) {
      return res.status(400).json({ success: false, error: 'Missing episode number' });
    }
    
    const link = await iptvService.createVodLink(ctx.sessionId, cmd, episodeNumber);
    const { extension, contentType } = vodService.describeLink(link);
    const safeTitle = String(title || 'video').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'video';
    
    const streamToken = streamService.generateStreamToken(
      req.user.userId,
      link,
      { id: cmd.slice(0, 24), name: safeTitle, type: 'VOD' },
      ctx.session.username,
      {
        contentType,
        filename: `${safeTitle}.${extension}`,
        relink: () => iptvService.createVodLink(ctx.sessionId, cmd, episodeNumber)
      }
    );
    
    logger.logUserActivity(ctx.session.username, `requesting ${ctx.type}`, { title: safeTitle });
    
    res.json({
      success: true,
      streamUrl: `/api/stream/${streamToken}`,
      contentType
    });
    
  } catch (error) {
    logger.error('stream', 'VOD stream request error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get this title' });
  }
});

app.post('/api/iptv/watchdog', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    const session = iptvService.getSession(sessionId);
    
    if (!session) {
      return res.status(410).json({ success: false, error: 'Invalid IPTV session' });
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
