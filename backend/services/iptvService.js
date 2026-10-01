// ═══════════════════════════════════════════════════════════════════════════════
// 📺 IPTV Service - Stalker Portal Integration
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/constants');
const staticGenres = require('../config/genres');
const logger = require('../utils/logger');

class IPTVService {
  constructor() {
    this.sessions = new Map();
    this.watchdogIntervals = new Map();
    
    // Cleanup old sessions periodically
    setInterval(() => this.cleanupSessions(), 60 * 1000);
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
          // Capture the final URL after redirects (may include dynamic subpath e.g. /xxxx/portal.php)
          const finalUrl = response.request?.res?.responseUrl 
            || response.request?._redirectable?._currentUrl 
            || testUrl;
          let cleanPath = path || '(root)';
          let fullUrl = `${baseUrl}${path}`;
          try {
            const parsed = new URL(finalUrl);
            fullUrl = `${parsed.origin}${parsed.pathname}`;
            cleanPath = parsed.pathname || cleanPath;
          } catch (_) {
            // fallback to original testUrl
          }

          logger.info('iptv', `${username} - Portal path discovered`, { path: cleanPath });
          return {
            path: cleanPath,
            fullUrl,
            token: response.data.js.token,
            response: response.data
          };
        }
        logger.info('iptv', `${username} - Path tried without token`, {
          path: path || '(root)',
          status: response.status,
          location: response.headers?.location
        });
      } catch (error) {
        logger.warn('iptv', `${username} - Path probe failed`, {
          path: path || '(root)',
          error: error.message,
          status: error.response?.status,
          location: error.response?.headers?.location
        });
      }
    }

    return null;
  }

  // A redirector (e.g. the address given to STB apps) lands on the portal's
  // loader page under a sub-path, while the API lives at the root of that host.
  // Probe the host root first, then the sub-path itself.
  async discoverPortal(baseUrl, macAddress, username) {
    const bases = [baseUrl];
    try {
      const origin = new URL(baseUrl).origin;
      if (origin !== baseUrl) bases.unshift(origin);
    } catch (_) {
      // keep baseUrl only
    }

    for (const base of bases) {
      const discovery = await this.discoverPortalPath(base, macAddress, username);
      if (discovery) return discovery;
    }

    return null;
  }

  async resolveBaseUrl(baseUrl, username) {
    try {
      // Redirectors send non-STB clients elsewhere, so identify as a set-top box
      const response = await axios.get(baseUrl, {
        headers: this.getStalkerHeaders(),
        maxRedirects: 5,
        timeout: 10000,
        validateStatus: (status) => status < 400
      });

      // Axios follows redirects; final URL may be on response.request.res
      const finalUrl = response.request?.res?.responseUrl || baseUrl;
      const cleaned = finalUrl.replace(/\/$/, '');

      if (cleaned !== baseUrl.replace(/\/$/, '')) {
        logger.info('iptv', `${username} - Base URL redirected`, { from: baseUrl, to: cleaned });
      }

      return cleaned;
    } catch (error) {
      logger.warn('iptv', `${username} - Base URL probe failed`, {
        baseUrl,
        error: error.message,
        status: error.response?.status,
        location: error.response?.headers?.location
      });
      return baseUrl;
    }
  }

  async connect(user) {
    if (!user.portalUrl || !user.macAddress) {
      throw new Error('Portal URL and MAC address not configured');
    }

    // One portal session per user, like a single set-top box: every tab and
    // device of that user shares it instead of competing with new handshakes
    const existingId = this.findSessionIdByUserId(user.id);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing.configuredPortal === user.portalUrl && existing.macAddress === user.macAddress) {
        existing.lastUsed = Date.now();
        logger.info('iptv', `${user.username} - Reusing portal session`, { sessionId: existingId.substring(0, 8) });
        return { sessionId: existingId, session: existing };
      }
      this.destroySession(existingId);
    }

    logger.logIPTVConnection(user.username, user.portalUrl, 'connecting');

    // Clean base URL
    let baseUrl = user.portalUrl
      .replace(/\/$/, '')
      .replace(/\/portal\.php.*$/, '')
      .replace(/\/stalker_portal.*$/, '')
      .replace(/\/server.*$/, '')
      .replace(/\/c\/?$/, '');

    // Ensure protocol; many users enter only host
    if (!/^https?:\/\//i.test(baseUrl)) {
      baseUrl = `http://${baseUrl}`;
      logger.info('iptv', `${user.username} - Added protocol to base URL`, { baseUrl });
    }

    // Follow redirects and log them
    baseUrl = await this.resolveBaseUrl(baseUrl, user.username);

    let discovery = await this.discoverPortal(baseUrl, user.macAddress, user.username);

    if (!discovery && baseUrl.startsWith('http://')) {
      const httpsBase = baseUrl.replace(/^http:\/\//i, 'https://');
      logger.info('iptv', `${user.username} - Retrying with HTTPS`, { from: baseUrl, to: httpsBase });
      const resolvedHttps = await this.resolveBaseUrl(httpsBase, user.username);
      discovery = await this.discoverPortal(resolvedHttps, user.macAddress, user.username);
      if (discovery) {
        baseUrl = resolvedHttps;
      }
    }

    if (!discovery) {
      logger.logIPTVConnection(user.username, baseUrl, 'failed', { error: 'discovery_failed' });
      throw new Error('Could not connect to IPTV portal');
    }

    // The portal only authorizes a token after get_profile, and it must be the
    // first call after the handshake - otherwise create_link returns no stream
    await axios.get(
      `${discovery.fullUrl}?type=stb&action=get_profile&JsHttpRequest=1-xml`,
      {
        headers: this.getStalkerHeaders(discovery.token, user.macAddress),
        timeout: 15000,
      }
    );

    // Create session
    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = {
      baseUrl,
      portalUrl: discovery.fullUrl,
      portalPath: discovery.path,
      configuredPortal: user.portalUrl,
      macAddress: user.macAddress,
      token: discovery.token,
      userId: user.id,
      username: user.username,
      createdAt: Date.now(),
      lastUsed: Date.now(),
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

  // Called for every client request, so idle sessions can be told apart
  touchSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) session.lastUsed = Date.now();
  }

  // The portal drops a token after a while; a set-top box then simply
  // handshakes again. Do the same and keep the session id the client holds.
  async reauthorize(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    if (!session.reauthorizing) {
      session.reauthorizing = (async () => {
        const handshake = await axios.get(
          `${session.portalUrl}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`,
          { headers: this.getStalkerHeaders('', session.macAddress), timeout: 10000 }
        );

        const token = handshake.data?.js?.token;
        if (!token) throw new Error('Portal refused a new handshake');

        session.token = token;

        await axios.get(
          `${session.portalUrl}?type=stb&action=get_profile&JsHttpRequest=1-xml`,
          { headers: this.getStalkerHeaders(session.token, session.macAddress), timeout: 15000 }
        );

        logger.info('iptv', `${session.username} - Portal session renewed`, { sessionId: sessionId.substring(0, 8) });
      })().finally(() => { session.reauthorizing = null; });
    }

    return session.reauthorizing;
  }

  // Ask the portal for a link; when it returns none the token was dropped,
  // so renew the session and ask once more
  async requestLink(sessionId, query) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    const ask = async () => {
      const response = await axios.get(
        `${session.portalUrl}?${query}&JsHttpRequest=1-xml`,
        {
          headers: this.getStalkerHeaders(session.token, session.macAddress),
          timeout: 15000
        }
      );
      const link = response.data?.js?.cmd;
      return typeof link === 'string' && link ? link : null;
    };

    let link = await ask();

    if (!link) {
      logger.warn('iptv', `${session.username} - Portal returned no link, renewing session`);
      await this.reauthorize(sessionId);
      link = await ask();
    }

    return link;
  }

  findSessionIdByUserId(userId) {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.userId === userId) return sessionId;
    }
    return null;
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

      const rawGenres = response.data?.js;
      let genres = Array.isArray(rawGenres) ? rawGenres : [];

      if (!Array.isArray(rawGenres)) {
        logger.warn('iptv', `${session.username} - Genres not array, falling back to static config`, {
          rawType: typeof rawGenres
        });
        genres = staticGenres;
      }
      
      logger.info('iptv', `${session.username} - Loaded ${genres.length} ${type} genres`, {
        rawType: typeof rawGenres,
        isArray: Array.isArray(rawGenres)
      });

      return genres.map(g => ({
        id: g.id,
        title: g.title || g.name,
        alias: g.alias || (g.title || g.name || '').toLowerCase(),
        censored: g.censored === "1" || g.censored === 1 || false,
        number: g.number
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

    // Log unknown genre IDs
    const knownGenreIds = new Set(staticGenres.map(g => g.id));
    const unknownIds = new Set();
    allChannels.forEach(ch => {
      const gid = ch.tv_genre_id || 0;
      if (gid && !knownGenreIds.has(gid)) {
        unknownIds.add(gid);
      }
    });
    if (unknownIds.size > 0) {
      logger.error('iptv', `${session.username} - Unknown genre IDs encountered`, { ids: Array.from(unknownIds).join(',') });
    }

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
        archive: Number(ch.enable_tv_archive) === 1 || Number(ch.archive) === 1,
        archiveHours: Number(ch.tv_archive_duration) || 0,
      }))
    };
  }

  async createStreamLink(sessionId, channelId, cmd, channelName) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    logger.logUserActivity(session.username, 'requesting stream', { channel: channelName });

    let streamUrl = await this.requestLink(
      sessionId,
      `type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&series=`
    );

    if (!streamUrl) {
      throw new Error('Portal did not return a stream link');
    }

    streamUrl = streamUrl.replace(/^ffmpeg\s+/i, '').replace(/^ffmpeg:/i, '').trim();

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

  // Programme guide of one channel for one day, all pages
  async getEpgDay(sessionId, channelId, date) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    const fetchPage = async (page) => {
      const response = await axios.get(
        `${session.portalUrl}?type=epg&action=get_simple_data_table&ch_id=${encodeURIComponent(channelId)}&date=${date}&p=${page}&JsHttpRequest=1-xml`,
        {
          headers: this.getStalkerHeaders(session.token, session.macAddress),
          timeout: 15000
        }
      );
      return response.data?.js || {};
    };

    let first = await fetchPage(1);

    if (!Array.isArray(first.data)) {
      await this.reauthorize(sessionId);
      first = await fetchPage(1);
    }

    let items = first.data || [];

    const total = Number(first.total_items) || 0;
    const pageSize = Number(first.max_page_items) || items.length || 1;
    const pages = Math.min(Math.ceil(total / pageSize), 30);

    if (pages > 1) {
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) => fetchPage(i + 2))
      );
      rest.forEach(page => { items = items.concat(page.data || []); });
    }

    return items
      .map(item => ({
        id: item.id,
        name: item.name || '',
        descr: item.descr || '',
        start: Number(item.start_timestamp),
        stop: Number(item.stop_timestamp),
        archive: Number(item.mark_archive) === 1
      }))
      .filter(item => item.start && item.stop > item.start)
      .sort((a, b) => a.start - b.start);
  }

  // Provider link for an archived programme (EPG item id)
  async createArchiveLink(sessionId, programId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    const cmd = `auto /media/${programId}.mpg`;
    const link = await this.requestLink(
      sessionId,
      `type=tv_archive&action=create_link&cmd=${encodeURIComponent(cmd)}&series=&forced_storage=&disable_ad=0&download=0`
    );

    if (!link) {
      throw new Error('Portal did not return an archive link');
    }

    return link.replace(/^(ffmpeg|auto)\s+/i, '').trim();
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

  startWatchdog(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('Invalid session');
    }

    // Clear any existing interval for this session
    if (this.watchdogIntervals.has(sessionId)) {
      clearInterval(this.watchdogIntervals.get(sessionId));
    }

    const interval = setInterval(() => {
      this.watchdog(sessionId).catch((error) => {
        logger.warn('iptv', `${session.username} - Watchdog tick failed`, { error: error.message });
      });
    }, config.WATCHDOG_INTERVAL);

    this.watchdogIntervals.set(sessionId, interval);
    logger.info('iptv', `${session.username} - Watchdog started`, { sessionId: sessionId.substring(0, 8) });
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
      const idle = now - (session.lastUsed || session.createdAt);
      
      // Open players ping every minute; a silent session has no client left
      if (now - session.createdAt > MAX_SESSION_AGE || idle > config.SESSION_IDLE_TIMEOUT) {
        logger.info('iptv', `Cleaning up session`, { 
          username: session.username,
          age: Math.floor((now - session.createdAt) / 1000 / 60) + ' minutes',
          idle: Math.floor(idle / 1000 / 60) + ' minutes'
        });
        this.destroySession(sessionId);
      }
    }
  }
}

module.exports = new IPTVService();
