// ═══════════════════════════════════════════════════════════════════════════════
// 📺 IPTV Service - Stalker Portal Integration
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/constants');
const logger = require('../utils/logger');

class IPTVService {
  constructor() {
    this.sessions = new Map();
    this.watchdogIntervals = new Map();
    
    // Cleanup old sessions periodically
    setInterval(() => this.cleanupSessions(), 5 * 60 * 1000);
  }

  getStalkerHeaders(token = '', macAddress = '') {
    const headers = { ...config.STALKER_HEADERS };
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    if (macAddress) {
      const encodedMac = encodeURIComponent(macAddress);
      headers['Cookie'] = `PHPSESSID=null; sn=0916082029478; mac=${encodedMac}; stb_lang=en; timezone=Europe%2FLisbon`;
    }
    
    return headers;
  }

  async discoverPortalPath(baseUrl, macAddress, username) {
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
          headers: this.getStalkerHeaders('', macAddress),
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

  async connect(user) {
    if (!user.portalUrl || !user.macAddress) {
      throw new Error('Portal URL and MAC address not configured');
    }

    logger.logIPTVConnection(user.username, user.portalUrl, 'connecting');

    // Clean base URL
    let baseUrl = user.portalUrl
      .replace(/\/$/, '')
      .replace(/\/portal\.php.*$/, '')
      .replace(/\/stalker_portal.*$/, '')
      .replace(/\/server.*$/, '')
      .replace(/\/c\/?$/, '');

    // Check for redirects
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

    // Discover portal path
    const discovery = await this.discoverPortalPath(baseUrl, user.macAddress, user.username);

    if (!discovery) {
      logger.logIPTVConnection(user.username, baseUrl, 'failed', { error: 'discovery_failed' });
      throw new Error('Could not connect to IPTV portal');
    }

    // Create session
    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = {
      baseUrl,
      portalUrl: discovery.fullUrl,
      portalPath: discovery.path,
      macAddress: user.macAddress,
      token: discovery.token,
      userId: user.id,
      username: user.username,
      createdAt: Date.now(),
    };
    
    this.sessions.set(sessionId, session);

    logger.logIPTVConnection(user.username, baseUrl, 'connected', { 
      sessionId: sessionId.substring(0, 8),
      path: discovery.path || '(root)'
    });

    return { sessionId, session };
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  // 🐛 FIX: Corrigido método getGenres
  async getGenres(sessionId, type = 'itv') {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    logger.logUserActivity(session.username, `fetching ${type} genres`);

    try {
      const url = `${session.portalUrl}?action=get_genres&type=${type}&JsHttpRequest=1-xml`;
      
      logger.info('iptv', `Genres request URL: ${url}`);

      const response = await axios.get(url, { 
        headers: this.getStalkerHeaders(session.token, session.macAddress),
        timeout: 15000,
        validateStatus: (status) => status < 500
      });

      logger.info('iptv', `Genres response status: ${response.status}`);
      logger.info('iptv', `Genres response data:`, response.data);

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const genres = response.data?.js || [];
      
      logger.info('iptv', `${session.username} - Loaded ${genres.length} ${type} genres`);

      return genres.map(g => ({
        id: g.id,
        title: g.title || g.name,
        alias: g.alias,
        censored: g.censored === "1"
      }));

    } catch (error) {
      logger.error('iptv', 'Genres fetch error', { 
        error: error.message,
        url: `${session.portalUrl}?action=get_genres&type=${type}`,
        response: error.response?.data,
        status: error.response?.status
      });
      
      throw new Error(`Failed to fetch genres: ${error.message}`);
    }
  }

  async getChannels(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    logger.logUserActivity(session.username, 'fetching channels');

    // Get profile first
    await axios.get(
      `${session.portalUrl}?type=stb&action=get_profile&JsHttpRequest=1-xml`,
      {
        headers: this.getStalkerHeaders(session.token, session.macAddress),
        timeout: 15000,
      }
    );

    let allChannels = [];
    let page = 1;
    let totalItems = 0;

    // First page
    const firstResponse = await axios.get(
      `${session.portalUrl}?type=itv&action=get_ordered_list&genre=*&force_ch_link_check=&fav=0&sortby=number&hd=0&p=${page}&JsHttpRequest=1-xml`,
      { 
        headers: this.getStalkerHeaders(session.token, session.macAddress), 
        timeout: 30000 
      }
    );

    totalItems = firstResponse.data?.js?.total_items || 0;
    allChannels = firstResponse.data?.js?.data || [];

    logger.info('iptv', `${session.username} - Loading channels`, { 
      total: totalItems,
      loaded: allChannels.length,
      page: 1
    });

    // Remaining pages
    page = 2;
    let hasMorePages = true;
    
    while (hasMorePages && allChannels.length < totalItems && page <= 100) {
      try {
        const pageResponse = await axios.get(
          `${session.portalUrl}?type=itv&action=get_ordered_list&genre=*&force_ch_link_check=&fav=0&sortby=number&hd=0&p=${page}&JsHttpRequest=1-xml`,
          { 
            headers: this.getStalkerHeaders(session.token, session.macAddress), 
            timeout: 30000 
          }
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

    return {
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
    };
  }

  async createStreamLink(sessionId, channelId, cmd, channelName) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    logger.logUserActivity(session.username, 'requesting stream', { channel: channelName });

    const response = await axios.get(
      `${session.portalUrl}?type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&series=&JsHttpRequest=1-xml`,
      { 
        headers: this.getStalkerHeaders(session.token, session.macAddress), 
        timeout: 15000 
      }
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

    logger.info('stream', `${session.username} - Stream URL generated`, {
      channel: channelName,
      type: streamType
    });

    return {
      streamUrl,
      streamType,
      channelId,
      channelName
    };
  }

  async watchdog(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    try {
      const response = await axios.get(
        `${session.portalUrl}?action=get_events&event_active_id=0&init=1&type=watchdog&cur_play_type=0&JsHttpRequest=1-xml`,
        {
          headers: this.getStalkerHeaders(session.token, session.macAddress),
          timeout: 10000,
        }
      );

      return response.data?.js || {};
    } catch (error) {
      logger.error('iptv', `${session.username} - Watchdog failed`, { error: error.message });
      throw error;
    }
  }

  destroySession(sessionId) {
    const session = this.getSession(sessionId);
    
    if (session) {
      // Stop watchdog if running
      if (this.watchdogIntervals.has(sessionId)) {
        clearInterval(this.watchdogIntervals.get(sessionId));
        this.watchdogIntervals.delete(sessionId);
      }
      
      this.sessions.delete(sessionId);
    }
  }

  cleanupSessions() {
    const now = Date.now();
    const MAX_SESSION_AGE = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.createdAt > MAX_SESSION_AGE) {
        logger.info('iptv', `Cleaning up old session`, { 
          username: session.username,
          age: Math.floor((now - session.createdAt) / 1000 / 60) + ' minutes'
        });
        this.destroySession(sessionId);
      }
    }
  }
}

module.exports = new IPTVService();
