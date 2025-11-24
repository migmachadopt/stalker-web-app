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

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
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

// Hash password with salt
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

// Verify password
function verifyPassword(password, salt, storedHash) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
}

// Generate JWT-like token
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

// Verify auth token
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
      return null; // Token expired
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
    console.error('Error loading users:', error.message);
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
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      recordLoginAttempt(ip, username, false);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    recordLoginAttempt(ip, username, true);
    
    user.lastLogin = new Date().toISOString();
    saveUsers(data);
    
    const token = generateAuthToken(user.id, user.role);
    
    console.log(`✅ User logged in: ${username} (${user.role})`);
    
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
    console.error('Login error:', error);
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
    
    console.log(`🔐 Password changed for user: ${user.username}`);
    
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
    
    console.log(`👤 New user created: ${username}`);
    
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
    
    console.log(`✏️ User updated: ${user.username}`);
    
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
    
    console.log(`🗑️ User deleted: ${user.username}`);
    
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

async function discoverPortalPath(baseUrl, macAddress) {
  console.log(`\n🔍 Discovering portal path for: ${baseUrl}`);
  
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
    
    console.log(`   🧪 Testing: ${baseUrl}${path}`);
    
    try {
      const response = await axios.get(testUrl, {
        headers: getStalkerHeaders('', macAddress),
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500,
      });

      if (response.status === 200 && response.data?.js?.token) {
        console.log(`   ✅ Found working path: ${path || '(root)'}`);
        return {
          path,
          fullUrl: `${baseUrl}${path}`,
          token: response.data.js.token,
          response: response.data
        };
      }
    } catch (error) {
      console.log(`   ❌ Failed: ${error.message}`);
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

    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║            IPTV CONNECTION REQUEST                     ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log(`👤 User: ${user.username}`);
    console.log(`📍 Portal: ${user.portalUrl}`);

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

    const discovery = await discoverPortalPath(baseUrl, user.macAddress);

    if (!discovery) {
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
      createdAt: Date.now(),
    });

    console.log(`✅ IPTV Connected for user: ${user.username}`);

    res.json({
      success: true,
      sessionId,
      message: 'Connected to IPTV!'
    });

  } catch (error) {
    console.error('❌ IPTV Connection Error:', error.message);
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
    
    console.log(`🔄 Getting profile...`);
    await axios.get(`${session.portalUrl}?type=stb&action=get_profile&JsHttpRequest=1-xml`, {
      headers: getStalkerHeaders(session.token, session.macAddress),
      timeout: 15000,
    });
    
    let allChannels = [];
    let page = 1;
    let totalItems = 0;
    let hasMorePages = true;
    
    const firstResponse = await axios.get(
      `${session.portalUrl}?type=itv&action=get_ordered_list&genre=*&force_ch_link_check=&fav=0&sortby=number&hd=0&p=${page}&JsHttpRequest=1-xml`,
      { headers: getStalkerHeaders(session.token, session.macAddress), timeout: 30000 }
    );
    
    totalItems = firstResponse.data?.js?.total_items || 0;
    allChannels = firstResponse.data?.js?.data || [];
    
    console.log(`📊 Total available: ${totalItems}, got ${allChannels.length} on page 1`);
    
    page = 2;
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
    
    console.log(`✅ Total channels loaded: ${allChannels.length}`);

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
    console.error('❌ Channels Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch channels' });
  }
});

app.post('/api/iptv/stream', authMiddleware, async (req, res) => {
  try {
    const { sessionId, channelId, cmd } = req.body;

    if (!sessionId || !stalkerSessions.has(sessionId)) {
      return res.status(401).json({ success: false, error: 'Invalid IPTV session' });
    }

    const session = stalkerSessions.get(sessionId);
    
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Session access denied' });
    }
    
    const response = await axios.get(
      `${session.portalUrl}?type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&series=&JsHttpRequest=1-xml`,
      { headers: getStalkerHeaders(session.token, session.macAddress), timeout: 15000 }
    );

    let streamUrl = response.data?.js?.cmd || response.data?.js || '';

    console.log('Stream response:', JSON.stringify(response.data));
    
    if (typeof streamUrl === 'string') {
      streamUrl = streamUrl.replace(/^ffmpeg\s+/i, '').replace(/^ffmpeg:/i, '').trim();
    }
    
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(streamUrl)}&transcode=1`;

    res.json({
      success: true,
      streamUrl: proxyUrl,
      originalUrl: streamUrl,
      channelId
    });

  } catch (error) {
    console.error('❌ Stream Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to get stream' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🔄 PROXY ENDPOINT COM TRANSCODING
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/proxy', async (req, res) => {
  try {
    const { url, transcode } = req.query;
    
    if (!url) {
      return res.status(400).send('URL parameter required');
    }

    // Ignorar range requests - sempre enviar stream completo
    delete req.headers.range;
    delete req.headers['if-range'];
    
    console.log(`📡 Proxy request: ${url.substring(0, 80)}...`);

    if (transcode === '1') {
      console.log(`🔄 Transcoding for: ${url}`);
      
      const ffmpeg = spawn('ffmpeg', [
        '-user_agent', 'Lavf/56.40.101',
        '-i', url,
        '-c:v', 'libx264',        // Re-encode vídeo
        '-preset', 'ultrafast',   // Mais rápido possível
        '-tune', 'zerolatency',   // Baixa latência
        '-profile:v', 'baseline', // Profile mais compatível
        '-level', '3.1',          // Level compatível
        '-c:a', 'aac',
        '-ac', '2',
        '-ar', '48000',
        '-b:a', '128k',
        '-f', 'flv',
        '-'
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      res.set('Content-Type', 'video/x-flv');
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-cache');
      res.set('Connection', 'keep-alive');
      res.set('Transfer-Encoding', 'chunked');

      ffmpeg.stdout.pipe(res);

      ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        // Log primeiras linhas e erros
        if (msg.includes('Input #') || msg.includes('Output #') || msg.includes('Stream mapping') || msg.includes('Error') || msg.includes('error')) {
          console.log(`FFmpeg: ${msg.substring(0, 200)}`);
        }
      });

      ffmpeg.on('error', (err) => {
        console.error(`❌ FFmpeg spawn error: ${err.message}`);
      });

      ffmpeg.on('close', (code) => {
        console.log(`FFmpeg closed with code ${code}`);
      });

      req.on('close', () => {
        console.log('Client disconnected, killing FFmpeg');
        ffmpeg.kill('SIGTERM');
      });

      return;
    }

    // Sem transcoding - proxy normal
    const playerHeaders = {
      'User-Agent': 'Lavf/56.40.101',
      'Icy-MetaData': '1',
      'Accept-Encoding': 'identity',
      'Connection': 'Keep-Alive',
    };

    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      timeout: 30000,
      maxRedirects: 10,
      headers: playerHeaders,
      validateStatus: (status) => status >= 200 && status < 300,
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
    });

    const finalUrl = response.request.res.responseUrl || url;
    const contentType = response.headers['content-type'] || '';
    
    console.log(`✅ Final URL: ${finalUrl.substring(0, 80)}...`);
    console.log(`📦 Content-Type: ${contentType}`);
    
    if (contentType.includes('mpegurl') || contentType.includes('m3u8') || finalUrl.includes('.m3u8')) {
      let content = '';
      response.data.on('data', chunk => content += chunk);
      await new Promise((resolve, reject) => {
        response.data.on('end', resolve);
        response.data.on('error', reject);
      });

      const baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
      
      content = content.replace(/(^[^#\n][^\n]*)/gm, (match) => {
        match = match.trim();
        if (!match || match.startsWith('#')) return match;
        
        if (match.startsWith('http')) {
          return `/api/proxy?url=${encodeURIComponent(match)}`;
        } else {
          return `/api/proxy?url=${encodeURIComponent(baseUrl + match)}`;
        }
      });

      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-cache');
      return res.send(content);
    } else {
      res.set('Content-Type', contentType || 'video/mp2t');
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-cache');
      res.set('Connection', 'keep-alive');
      res.set('Transfer-Encoding', 'chunked');
      
      response.data.pipe(res);
      
      req.on('close', () => {
        response.data.destroy();
      });
    }

  } catch (error) {
    console.error('❌ Proxy Error:', error.message);
    res.status(error.response?.status || 500).send('Proxy error: ' + error.message);
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Backend is running!',
    timestamp: new Date().toISOString()
  });
});

// Cleanup old sessions
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [sessionId, session] of stalkerSessions.entries()) {
    if (now - session.createdAt > oneHour) {
      stalkerSessions.delete(sessionId);
      console.log(`🧹 Cleaned expired IPTV session`);
    }
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║    🚀 Stalker IPTV Backend - WITH TRANSCODING 🔄      ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\n📡 Server: http://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/api/health`);
  console.log(`\n🔐 Default admin credentials:`);
  console.log(`   Username: admin`);
  console.log(`   Password: admin123`);
  console.log(`\n⚠️  IMPORTANT: Change the admin password after first login!\n`);
});
