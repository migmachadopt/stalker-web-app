// ═══════════════════════════════════════════════════════════════════════════════
// 📊 Logging - console (PM2) and a searchable file per day
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const config = require('../config/constants');

// Every entry also goes to a file per day (one JSON object per line), so the
// admin area can search the last days (see search()). Values that could give
// access to the provider or the app are hidden before anything is written.
const LOG_DIR = path.join(config.DATA_DIR, 'logs');
const SECRET_KEYS = /^(password|pass|token|cookie|authorization|auth|secret|key|api_key|mac|macaddress)$/i;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

class Logger {
  constructor() {
    this.sessions = new Map();
    this.server = process.env.SERVER_NAME || os.hostname();
    this.pending = [];
    this.written = new Map(); // day -> bytes written (to respect LOG_MAX_DAY_BYTES)

    setInterval(() => this.flush(), 2000).unref();
    setInterval(() => this.prune(), 6 * 60 * 60 * 1000).unref();
    setTimeout(() => this.prune(), 10000).unref();
    process.on('exit', () => this.flush(true));
  }

  timestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }

  // ── Hiding secrets ───────────────────────────────────────────────────────

  // Addresses keep their server and path, without the query (tokens, MAC)
  // and without the account in paths like /timeshift/<user>/<password>/...
  maskText(text) {
    return String(text)
      .replace(/\b(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, '$1?…')
      .replace(/\/(timeshift|live|movie|series|play)\/[^\/\s]+\/[^\/\s]+\//gi, '/$1/…/…/')
      .replace(/\b([0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}):[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}\b/gi, '$1:…');
  }

  mask(data) {
    const out = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (value === undefined) continue;
      if (SECRET_KEYS.test(key)) out[key] = '***';
      else if (value !== null && typeof value === 'object') out[key] = this.maskText(JSON.stringify(value));
      else out[key] = typeof value === 'string' ? this.maskText(value) : value;
    }
    return out;
  }

  log(level, category, message, data = {}) {
    const ts = this.timestamp();
    const msg = this.maskText(message);
    const fields = this.mask(data);
    const dataStr = Object.keys(fields).length > 0
      ? ' | ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';

    console.log(`[${ts}] [${level.toUpperCase()}] [${category}] ${msg}${dataStr}`);

    this.pending.push({ t: new Date().toISOString(), level, cat: category, msg, data: fields, server: this.server });
    if (this.pending.length >= 500) this.flush();
  }

  info(category, message, data) { this.log('info', category, message, data); }
  warn(category, message, data) { this.log('warn', category, message, data); }
  error(category, message, data) { this.log('error', category, message, data); }
  debug(category, message, data) { this.log('debug', category, message, data); }

  // ── Files ────────────────────────────────────────────────────────────────

  dayFile(day) {
    return path.join(LOG_DIR, `${day}.jsonl`);
  }

  // Entries are written in batches, so the disk (an SD card on a Raspberry
  // Pi) is not touched for every line
  flush(sync = false) {
    if (!this.pending.length) return;
    const entries = this.pending;
    this.pending = [];

    const byDay = new Map();
    for (const entry of entries) {
      const day = entry.t.slice(0, 10);
      // A very busy day keeps its warnings and errors once the size is reached
      const size = this.sizeOf(day);
      if (size > config.LOG_MAX_DAY_BYTES && entry.level !== 'warn' && entry.level !== 'error') continue;
      const line = JSON.stringify(entry) + '\n';
      this.written.set(day, size + line.length);
      byDay.set(day, (byDay.get(day) || '') + line);
    }

    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      for (const [day, text] of byDay) {
        if (sync) fs.appendFileSync(this.dayFile(day), text);
        else fs.appendFile(this.dayFile(day), text, () => {});
      }
    } catch (_) {
      // Logging must never stop the app
    }
  }

  sizeOf(day) {
    if (!this.written.has(day)) {
      try { this.written.set(day, fs.statSync(this.dayFile(day)).size); } catch (_) { this.written.set(day, 0); }
    }
    return this.written.get(day);
  }

  days() {
    try {
      return fs.readdirSync(LOG_DIR)
        .map(name => (name.match(DAY_FILE) || [])[1])
        .filter(Boolean)
        .sort()
        .reverse();
    } catch (_) {
      return [];
    }
  }

  prune() {
    for (const day of this.days().slice(config.LOG_KEEP_DAYS)) {
      try { fs.unlinkSync(this.dayFile(day)); } catch (_) {}
      this.written.delete(day);
    }
  }

  // Entries of one day, newest first.
  //   query     words that must all appear (message, category or any value)
  //   levels    e.g. ['warn', 'error']; empty for all
  //   category  one category, or empty
  //   before    only entries older than this ISO time (to load older pages)
  async search({ day, query = '', levels = [], category = '', before = '', limit = 300 }) {
    this.flush(true);
    const file = this.dayFile(day);
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [];
    const categories = new Set();
    let total = 0;

    if (!DAY_FILE.test(`${day}.jsonl`) || !fs.existsSync(file)) return { entries: [], categories: [], total: 0, more: false };

    const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch (_) { continue; }
      categories.add(entry.cat);
      if (before && entry.t >= before) continue;
      if (levels.length && !levels.includes(entry.level)) continue;
      if (category && entry.cat !== category) continue;
      if (words.length) {
        const text = line.toLowerCase();
        if (!words.every(word => text.includes(word))) continue;
      }
      total++;
      matches.push(entry);
      if (matches.length > limit) matches.shift(); // keep only the newest
    }

    return {
      entries: matches.reverse(),
      categories: [...categories].sort(),
      total,
      more: total > matches.length
    };
  }

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

  logUserActivity(username, action, details = {}) {
    this.info('user', `${username} - ${action}`, details);
  }

  logAuth(event, username, ip, success = true) {
    const level = success ? 'info' : 'warn';
    this.log(level, 'auth', `${event} - ${username}`, { ip, success });
  }

  logIPTVConnection(username, portalUrl, status, details = {}) {
    this.info('iptv', `${username} - ${status}`, { portal: portalUrl, ...details });
  }

  parseFFmpegOutput(sessionId, line) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (line.includes('Input #0')) {
      this.logStreamEvent(sessionId, 'Input stream detected');
    }

    if (line.includes('Stream #0') && line.includes('Video:')) {
      const codecMatch = line.match(/Video: ([^,]+)/);
      const resMatch = line.match(/(\d+x\d+)/);
      
      if (codecMatch) {
        this.updateStreamSession(sessionId, {
          videoCodec: codecMatch[1].trim(),
          resolution: resMatch ? resMatch[1] : 'unknown',
          status: 'video_detected'
        });
        
        this.logStreamEvent(sessionId, 'Video codec detected', {
          codec: codecMatch[1].trim(),
          resolution: resMatch ? resMatch[1] : 'unknown'
        });
      }
    }

    if (line.includes('Stream #0') && line.includes('Audio:')) {
      const codecMatch = line.match(/Audio: ([^,]+)/);
      if (codecMatch) {
        this.updateStreamSession(sessionId, {
          audioCodec: codecMatch[1].trim(),
          status: 'audio_detected'
        });
        
        this.logStreamEvent(sessionId, 'Audio codec detected', {
          codec: codecMatch[1].trim()
        });
      }
    }

    if (line.includes('Output #0')) {
      this.updateStreamSession(sessionId, { status: 'encoding_started' });
      this.logStreamEvent(sessionId, 'Output encoding started');
    }

    if (line.includes('frame=') && line.includes('fps=')) {
      if (session.status !== 'streaming') {
        this.updateStreamSession(sessionId, { status: 'streaming' });
        this.logStreamEvent(sessionId, 'Stream is LIVE');
      }
    }

    if (line.toLowerCase().includes('error') && !line.includes('Errorlog')) {
      this.logStreamEvent(sessionId, 'FFmpeg error', { error: line.trim() });
    }
  }

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

module.exports = new Logger();
