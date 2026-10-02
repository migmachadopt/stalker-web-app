// ═══════════════════════════════════════════════════════════════════════════════
// 🔄 Guide Sync Service - Keeps the programme guide stored ahead of time
// ═══════════════════════════════════════════════════════════════════════════════
//
// Reading the guide from the portal is slow (ten programmes per request, and
// requests must be spaced out), so it is not left for when someone opens the
// recordings. While anyone is using the app, every GUIDE_SYNC_INTERVAL this
// reads, for the channels its users can see:
//   - today, again, so the day in progress stays current
//   - every past day still kept by the archive that is not stored yet
// Past days are read once (see archiveService.isFresh). The sync only uses the
// portal's guide calls, never a stream, so it does not interrupt viewing, and
// it steps aside whenever someone is waiting for a guide on screen.

const config = require('../config/constants');
const logger = require('../utils/logger');
const iptvService = require('./iptvService');
const archiveService = require('./archiveService');
const channelListService = require('./channelListService');
const userService = require('./userService');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Calendar day in the portal's timezone, `daysAgo` days back
const portalDate = (daysAgo = 0) => new Intl.DateTimeFormat('en-CA', {
  timeZone: config.GUIDE_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date(Date.now() - daysAgo * 86400000));

class GuideSyncService {
  constructor() {
    this.running = false;
    this.lastRun = new Map(); // portal -> time of the last complete pass

    // Look every few minutes; a portal is synced when its last pass is old enough
    setTimeout(() => this.tick(), 60 * 1000);
    setInterval(() => this.tick(), 5 * 60 * 1000);
  }

  // Portals in use right now, each with one of its sessions and the archived
  // channels its users can see
  portalsInUse() {
    const portals = new Map();

    for (const [sessionId, session] of iptvService.sessions.entries()) {
      const user = userService.findUserById(session.userId);
      const list = user && channelListService.load(user.id);
      if (!list) continue;

      const portal = iptvService.getPortalKey(sessionId);
      const entry = portals.get(portal) || { sessionId, channels: new Map() };

      channelListService.getVisible(user, list).channels
        .filter(channel => channel.archive)
        .forEach(channel => entry.channels.set(String(channel.id), channel));

      portals.set(portal, entry);
    }

    return portals;
  }

  async tick() {
    if (this.running) return;
    this.running = true;

    try {
      for (const [portal, { sessionId, channels }] of this.portalsInUse()) {
        const last = this.lastRun.get(portal) || 0;
        if (Date.now() - last < config.GUIDE_SYNC_INTERVAL) continue;

        await this.syncPortal(portal, sessionId, [...channels.values()]);
      }
    } catch (error) {
      logger.warn('iptv', 'Guide sync stopped', { error: error.message });
    } finally {
      this.running = false;
    }
  }

  async syncPortal(portal, sessionId, channels) {
    if (!channels.length) return;

    const started = Date.now();
    const fetchesBefore = archiveService.fetches;
    const deepest = Math.max(...channels.map(c => c.archiveHours || 0));
    const days = Array.from({ length: Math.ceil(deepest / 24) + 1 }, (_, i) => ({ date: portalDate(i), daysAgo: i }));

    for (const { date, daysAgo } of days) {
      for (const channel of channels) {
        // Only days this channel still keeps
        if (daysAgo > 0 && (daysAgo - 1) * 24 >= (channel.archiveHours || 0)) continue;

        // The session ended: whoever was using the app has left
        if (!iptvService.getSession(sessionId)) return;

        // Someone is waiting for a guide on screen: let it through first
        while (archiveService.foreground > 0) await sleep(1000);

        try {
          await archiveService.getEpg(sessionId, null, channel.id, date, { background: true });
        } catch (error) {
          // a single channel failing does not stop the sync
        }
      }
    }

    this.lastRun.set(portal, Date.now());

    const read = archiveService.fetches - fetchesBefore;
    if (read > 0) {
      logger.info('iptv', 'Programme guide synced', {
        portal,
        channels: channels.length,
        days: days.length,
        read,
        seconds: Math.round((Date.now() - started) / 1000)
      });
    }
  }
}

module.exports = new GuideSyncService();
