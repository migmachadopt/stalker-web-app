// ═══════════════════════════════════════════════════════════════════════════════
// 📂 Channel List Service - Per-user cached channel list & group visibility
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const config = require('../config/constants');
const encryption = require('./encryption');
const iptvService = require('./iptvService');
const logger = require('../utils/logger');

class ChannelListService {
  constructor() {
    this.memory = new Map();      // userId -> list
    this.refreshing = new Map();  // userId -> in-flight refresh promise
  }

  filePath(userId) {
    if (!/^[a-zA-Z0-9-]+$/.test(String(userId))) {
      throw new Error('Invalid user id');
    }
    return path.join(config.DATA_DIR, `channels-${userId}.enc`);
  }

  load(userId) {
    if (this.memory.has(userId)) {
      return this.memory.get(userId);
    }

    try {
      const file = this.filePath(userId);
      if (!fs.existsSync(file)) return null;

      const list = JSON.parse(encryption.decrypt(JSON.parse(fs.readFileSync(file, 'utf8'))));
      this.memory.set(userId, list);
      return list;
    } catch (error) {
      logger.error('data', 'Error loading channel list', { error: error.message });
      return null;
    }
  }

  save(userId, list) {
    fs.writeFileSync(this.filePath(userId), JSON.stringify(encryption.encrypt(JSON.stringify(list))));
    this.memory.set(userId, list);
  }

  remove(userId) {
    this.memory.delete(userId);
    try {
      const file = this.filePath(userId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
      logger.error('data', 'Error removing channel list', { error: error.message });
    }
  }

  isStale(list) {
    if (!list || !list.updatedAt) return true;
    if (list.version !== config.CHANNEL_LIST_VERSION) return true;
    return Date.now() - new Date(list.updatedAt).getTime() > config.CHANNEL_LIST_MAX_AGE;
  }

  // Fetch genres + channels from the portal and store them for the session's user
  async refresh(sessionId) {
    const session = iptvService.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    const userId = session.userId;
    if (this.refreshing.has(userId)) {
      return this.refreshing.get(userId);
    }

    const job = (async () => {
      let portalGenres = [];
      try {
        portalGenres = await iptvService.getGenres(sessionId, 'itv');
      } catch (error) {
        logger.warn('iptv', `${session.username} - Genres unavailable, using group ids`, { error: error.message });
      }

      const result = await iptvService.getChannels(sessionId);

      const channels = result.channels.map(ch => ({
        ...ch,
        tv_genre_id: String(ch.tv_genre_id || 0)
      }));

      const genreInfo = new Map(portalGenres.map(g => [String(g.id), g]));
      const groups = new Map();
      channels.forEach(ch => {
        if (!groups.has(ch.tv_genre_id)) {
          const info = genreInfo.get(ch.tv_genre_id);
          groups.set(ch.tv_genre_id, {
            id: ch.tv_genre_id,
            title: info?.title || `Group ${ch.tv_genre_id}`,
            number: info?.number ?? null,
            count: 0
          });
        }
        groups.get(ch.tv_genre_id).count++;
      });

      const list = {
        version: config.CHANNEL_LIST_VERSION,
        updatedAt: new Date().toISOString(),
        genres: Array.from(groups.values()),
        channels
      };

      this.save(userId, list);

      logger.info('iptv', `${session.username} - Channel list stored`, {
        groups: list.genres.length,
        channels: list.channels.length
      });

      return list;
    })();

    this.refreshing.set(userId, job);
    try {
      return await job;
    } finally {
      this.refreshing.delete(userId);
    }
  }

  // Cached list, refreshed when missing, older than CHANNEL_LIST_MAX_AGE or forced
  async getList(sessionId, userId, force = false) {
    const cached = this.load(userId);

    if (!force && !this.isStale(cached)) {
      return { list: cached, fromCache: true };
    }

    try {
      return { list: await this.refresh(sessionId), fromCache: false };
    } catch (error) {
      // An automatic refresh must not lock the user out of a list we already have
      if (!force && cached) {
        logger.warn('iptv', 'Channel list refresh failed, serving stored list', { error: error.message });
        return { list: cached, fromCache: true };
      }
      throw error;
    }
  }

  // Refresh a user's list from the admin area, reusing their live session if any
  async refreshForUser(user) {
    const existing = iptvService.findSessionIdByUserId(user.id);
    if (existing) {
      return this.refresh(existing);
    }

    const { sessionId } = await iptvService.connect(user);
    try {
      return await this.refresh(sessionId);
    } finally {
      iptvService.destroySession(sessionId);
    }
  }

  enabledSet(user) {
    return new Set((user.enabledGenres || []).map(String));
  }

  // What the user is allowed to see: only groups enabled by the admin
  getVisible(user, list) {
    const enabled = this.enabledSet(user);
    return {
      genres: list.genres.filter(g => enabled.has(g.id)),
      channels: list.channels
        .filter(ch => enabled.has(ch.tv_genre_id))
        .map(({ cmd, ...ch }) => ch),
      hiddenGroups: list.genres.filter(g => !enabled.has(g.id)).length
    };
  }

  findVisibleChannel(user, channelId) {
    const list = this.load(user.id);
    if (!list) return null;

    const channel = list.channels.find(ch => String(ch.id) === String(channelId));
    if (!channel || !this.enabledSet(user).has(channel.tv_genre_id)) return null;

    return channel;
  }

  // Admin view: every known group with its enabled flag
  getGroups(user) {
    const list = this.load(user.id);
    const enabled = this.enabledSet(user);

    return {
      updatedAt: list?.updatedAt || null,
      groups: (list?.genres || []).map(g => ({ ...g, enabled: enabled.has(g.id) }))
    };
  }
}

module.exports = new ChannelListService();
