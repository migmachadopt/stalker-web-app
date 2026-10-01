// ═══════════════════════════════════════════════════════════════════════════════
// ⏪ Archive Service - Programme guide & TV archive (catch-up) links
// ═══════════════════════════════════════════════════════════════════════════════

const config = require('../config/constants');
const iptvService = require('./iptvService');
const logger = require('../utils/logger');

// .../timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<stream>.ts
const TIMESHIFT_PATTERN = /(\/timeshift\/[^/]+\/[^/]+\/)(\d+)\/(\d{4})-(\d{2})-(\d{2}):(\d{2})-(\d{2})\//;

class ArchiveService {
  constructor() {
    this.epgCache = new Map(); // `${portal}:${channelId}:${date}` -> { at, programs }
  }

  // Programmes of one channel for one day (YYYY-MM-DD, portal timezone)
  async getEpg(sessionId, userId, channelId, date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      throw new Error('Invalid date');
    }

    // The guide is the same for every account of a portal
    const key = `${iptvService.getPortalKey(sessionId)}:${channelId}:${date}`;
    const cached = this.epgCache.get(key);

    // A finished day no longer changes; today's guide still does
    const today = new Date().toISOString().slice(0, 10);
    const ttl = date < today ? config.EPG_PAST_CACHE_TTL : config.EPG_CACHE_TTL;

    if (cached && Date.now() - cached.at < ttl) {
      return cached.programs;
    }

    const programs = await iptvService.getEpgDay(sessionId, channelId, date);

    if (this.epgCache.size > 3000) {
      this.epgCache.clear();
    }
    this.epgCache.set(key, { at: Date.now(), programs });

    return programs;
  }

  // Link for a time window of an archived channel. The portal only issues links
  // for whole programmes, so one programme of that day is used as the seed and
  // its link is re-pointed at the requested start/duration.
  async createWindowLink(sessionId, userId, channel, { date, programId, start, duration }) {
    if (!channel.archive) {
      throw new Error('This channel has no archive');
    }

    const programs = await this.getEpg(sessionId, userId, channel.id, date);
    const seed = programs.find(p => String(p.id) === String(programId) && p.archive);

    if (!seed) {
      throw new Error('Programme not available in the archive');
    }

    const now = Math.floor(Date.now() / 1000);
    const wantedStart = Number.isFinite(Number(start)) ? Math.floor(Number(start)) : seed.start;
    const wantedDuration = Number.isFinite(Number(duration)) ? Math.floor(Number(duration)) : seed.stop - seed.start;

    if (wantedDuration < 60 || wantedDuration > config.ARCHIVE_MAX_WINDOW) {
      throw new Error(`Interval must be between 1 minute and ${config.ARCHIVE_MAX_WINDOW / 3600} hours`);
    }

    if (wantedStart >= now) {
      throw new Error('Interval starts in the future');
    }

    if (channel.archiveHours && wantedStart < now - channel.archiveHours * 3600) {
      throw new Error(`This channel only keeps ${channel.archiveHours} hours of archive`);
    }

    const link = await iptvService.createArchiveLink(sessionId, seed.id);
    const isSeedWindow = wantedStart === seed.start && wantedDuration === seed.stop - seed.start;
    const match = TIMESHIFT_PATTERN.exec(link);

    if (!match) {
      if (isSeedWindow) {
        return { url: link, start: seed.start, duration: seed.stop - seed.start };
      }
      throw new Error('This portal does not support custom archive intervals');
    }

    // The link carries the seed start in the provider's clock; keep the same offset
    const linkStart = Date.UTC(+match[3], +match[4] - 1, +match[5], +match[6], +match[7]) / 1000;
    const clockOffset = linkStart - Math.floor(seed.start / 60) * 60;

    const windowStart = Math.floor(wantedStart / 60) * 60;
    const windowMinutes = Math.ceil((wantedStart + wantedDuration - windowStart) / 60);

    const d = new Date((windowStart + clockOffset) * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;

    logger.info('stream', 'Archive window link created', {
      channel: channel.name,
      minutes: windowMinutes
    });

    return {
      url: link.replace(TIMESHIFT_PATTERN, `$1${windowMinutes}/${stamp}/`),
      start: windowStart,
      duration: windowMinutes * 60
    };
  }
}

module.exports = new ArchiveService();
