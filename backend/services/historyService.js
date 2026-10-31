// ═══════════════════════════════════════════════════════════════════════════════
// 🕘 History Service - The source each user last played for a Discover title
// ═══════════════════════════════════════════════════════════════════════════════
//
// Kept in data/discover-history.json, per user and per film or episode, so a
// title can be continued with the same source (see debridService.resume), and
// from where it was left on any device:
//   { [userId]: { 'movie:693134' | 'tv:136315:2:3': {
//       torrent, hash, title, size, quality, at, position, finished } } }

const fs = require('fs');
const path = require('path');
const config = require('../config/constants');
const logger = require('../utils/logger');

const FILE = path.join(config.DATA_DIR, 'discover-history.json');
const MAX_PER_USER = 500;

class HistoryService {
  constructor() {
    try {
      this.data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (_) {
      this.data = {};
    }
  }

  key(kind, tmdbId, season, episode) {
    return kind === 'tv' ? `tv:${tmdbId}:${season}:${episode}` : `movie:${tmdbId}`;
  }

  get(userId, key) {
    return (this.data[userId] || {})[key] || null;
  }

  // Every entry of one film, or of every episode of one series
  forTitle(userId, kind, tmdbId) {
    const prefix = kind === 'tv' ? `tv:${tmdbId}:` : `movie:${tmdbId}`;
    return Object.fromEntries(Object.entries(this.data[userId] || {})
      .filter(([key]) => (kind === 'tv' ? key.startsWith(prefix) : key === prefix)));
  }

  remember(userId, key, entry) {
    const before = (this.data[userId] || {})[key] || {};
    const kept = { position: before.position || 0, finished: !!before.finished };
    const mine = { ...(this.data[userId] || {}), [key]: { ...kept, ...entry, at: new Date().toISOString() } };

    // The oldest go first
    const keys = Object.keys(mine);
    if (keys.length > MAX_PER_USER) {
      keys.sort((a, b) => String(mine[a].at).localeCompare(String(mine[b].at)));
      for (const old of keys.slice(0, keys.length - MAX_PER_USER)) delete mine[old];
    }

    this.data[userId] = mine;
    this.save();
  }

  // Seconds reached; near the end counts as watched (and starts over next time)
  setPosition(userId, key, position, duration) {
    const entry = (this.data[userId] || {})[key];
    if (!entry) return false;
    const finished = duration > 0 && position > duration - 90;
    entry.position = finished || position < 30 ? 0 : Math.floor(position);
    entry.finished = finished || (entry.finished && entry.position === 0);
    this.save();
    return true;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.data));
    } catch (error) {
      logger.warn('debrid', 'Could not save the Discover history', { error: error.message });
    }
  }
}

module.exports = new HistoryService();
