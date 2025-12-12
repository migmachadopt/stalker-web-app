// ═══════════════════════════════════════════════════════════════════════════════
// ⚙️ Configuration Constants
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Server
  PORT: process.env.PORT || 3001,
  
  // Security
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '902074ebb39f692c6aa615edcacb0636bffd1295ad5351e239255fbd77c5d2a8',
  JWT_SECRET: process.env.JWT_SECRET || '521b3586ca5e663b793ad71f9abc049a97caa2c3e5e419c3e7cad13a5ffba785f09696208c19edd861115f4e11eeb902ba380849dae78ce9f3e06b62dab8a09c',
  STREAM_SECRET: process.env.STREAM_SECRET || require('crypto').randomBytes(32).toString('hex'),
  SALT_ROUNDS: 10,
  TOKEN_EXPIRY: 24 * 60 * 60 * 1000, // 24 hours
  
  // Rate Limiting
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_TIME: 15 * 60 * 1000, // 15 minutes
  
  // Data Paths
  DATA_DIR: require('path').join(__dirname, '..', 'data'),
  USERS_FILE: require('path').join(__dirname, '..', 'data', 'users.enc'),
  
  // IPTV
  STALKER_HEADERS: {
    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2738 Mobile Safari/533.3',
    'X-User-Agent': 'Model: MAG254; Link: Ethernet',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
  },
  
  // Session
  SESSION_TIMEOUT: 60 * 60 * 1000, // 1 hour
  WATCHDOG_INTERVAL: 60 * 1000, // 60 seconds
  
  // Stream
  STREAM_TOKEN_EXPIRY: 60000, // 60 seconds
  STREAM_TOKEN_MAX_USES: 5,
};
