// ═══════════════════════════════════════════════════════════════════════════════
// 🏠 Dashboard Service - Each user's favourites and last channels watched
// ═══════════════════════════════════════════════════════════════════════════════
//
// Kept in data/dashboard.json:
//   { [userId]: { favorites: [favourite], recentChannels: [{ id, at }] } }
//
// A favourite: { key, type, id, name, image, data, at }
//   type  'channel' | 'vod' | 'series' | 'discover'
//   key   type and id ('channel:123', 'discover:tv:136315'), one per title
//   data  what the app needs to open it again (the video club item, the
//         Discover kind and TMDB id)

const fs = require('fs');
const path = require('path');
const config = require('../config/constants');
const logger = require('../utils/logger');

const FILE = path.join(config.DATA_DIR, 'dashboard.json');
const MAX_FAVORITES = 200;
const MAX_RECENT = 20;
const TYPES = ['channel', 'vod', 'series', 'discover'];

class DashboardService {
  constructor() {
    try {
      this.data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (_) {
      this.data = {};
    }
  }

  mine(userId) {
    return { favorites: [], recentChannels: [], ...(this.data[userId] || {}) };
  }

  favorites(userId) {
    return this.mine(userId).favorites;
  }

  recentChannels(userId) {
    return this.mine(userId).recentChannels;
  }

  addFavorite(userId, input) {
    const type = String(input.type || '');
    const id = String(input.id || '').slice(0, 80);
    if (!TYPES.includes(type) || !id) throw new Error('Which favourite?');

    const favorite = {
      key: `${type}:${id}`,
      type,
      id,
      name: String(input.name || '').slice(0, 200),
      image: String(input.image || '').slice(0, 1000),
      data: this.small(input.data),
      at: new Date().toISOString()
    };

    const mine = this.mine(userId);
    mine.favorites = [favorite, ...mine.favorites.filter(f => f.key !== favorite.key)].slice(0, MAX_FAVORITES);
    this.data[userId] = mine;
    this.save();
    return mine.favorites;
  }

  removeFavorite(userId, key) {
    const mine = this.mine(userId);
    mine.favorites = mine.favorites.filter(f => f.key !== key);
    this.data[userId] = mine;
    this.save();
    return mine.favorites;
  }

  // Newest first, each channel once
  addRecentChannel(userId, channelId) {
    const id = String(channelId || '').slice(0, 40);
    if (!id) return this.recentChannels(userId);
    const mine = this.mine(userId);
    mine.recentChannels = [{ id, at: new Date().toISOString() }, ...mine.recentChannels.filter(c => c.id !== id)].slice(0, MAX_RECENT);
    this.data[userId] = mine;
    this.save();
    return mine.recentChannels;
  }

  // What is kept to open a favourite again: a small plain object
  small(data) {
    if (!data || typeof data !== 'object') return {};
    const text = JSON.stringify(data);
    return text.length > 4000 ? {} : JSON.parse(text);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.data));
    } catch (error) {
      logger.warn('server', 'Could not save the dashboard', { error: error.message });
    }
  }
}

module.exports = new DashboardService();
