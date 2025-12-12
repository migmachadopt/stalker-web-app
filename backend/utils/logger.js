// ═══════════════════════════════════════════════════════════════════════════════
// 📊 Professional Logging System
// ═══════════════════════════════════════════════════════════════════════════════

class Logger {
  constructor() {
    this.sessions = new Map();
  }

  timestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }

  log(level, category, message, data = {}) {
    const ts = this.timestamp();
    const dataStr = Object.keys(data).length > 0 
      ? ' | ' + Object.entries(data).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';
    
    console.log(`[${ts}] [${level.toUpperCase()}] [${category}] ${message}${dataStr}`);
  }

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
