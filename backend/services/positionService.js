// ═══════════════════════════════════════════════════════════════════════════════
// ⏱️ Position Service - Where each user left each recording
// ═══════════════════════════════════════════════════════════════════════════════
//
// Kept in data/positions.json so a recording continues where it was left on
// any device:  { [userId]: { 'rec:<id>': { position, finished, at } } }
// (Discover titles keep theirs with the source played, in historyService.)

const fs = require('fs');
const path = require('path');
const config = require('../config/constants');
const logger = require('../utils/logger');

const FILE = path.join(config.DATA_DIR, 'positions.json');
const MAX_PER_USER = 2000;
const SAVE_DELAY = 2000; // several positions arriving together are written once

class PositionService {
  constructor() {
    try {
      this.data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (_) {
      this.data = {};
    }
    this.timer = null;
  }

  all(userId) {
    return this.data[userId] || {};
  }

  // Seconds reached; near the end counts as watched (and starts over next time)
  set(userId, key, position, duration) {
    const finished = duration > 0 && position > duration - 90;
    const mine = { ...(this.data[userId] || {}) };
    mine[key] = {
      position: finished || position < 30 ? 0 : Math.floor(position),
      finished: finished || (!!(mine[key] && mine[key].finished) && position < 30),
      at: new Date().toISOString()
    };

    const keys = Object.keys(mine);
    if (keys.length > MAX_PER_USER) {
      keys.sort((a, b) => String(mine[a].at).localeCompare(String(mine[b].at)));
      for (const old of keys.slice(0, keys.length - MAX_PER_USER)) delete mine[old];
    }

    this.data[userId] = mine;
    this.saveSoon();
    return mine[key];
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(this.data));
      } catch (error) {
        logger.warn('server', 'Could not save the positions', { error: error.message });
      }
    }, SAVE_DELAY);
  }
}

module.exports = new PositionService();
