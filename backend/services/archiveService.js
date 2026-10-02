// ═══════════════════════════════════════════════════════════════════════════════
// ⏪ Archive Service - Programme guide & TV archive (catch-up) links
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const config = require('../config/constants');
const iptvService = require('./iptvService');
const logger = require('../utils/logger');

// .../timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<stream>.ts
const TIMESHIFT_PATTERN = /(\/timeshift\/[^/]+\/[^/]+\/)(\d+)\/(\d{4})-(\d{2})-(\d{2}):(\d{2})-(\d{2})\//;

const GUIDE_DIR = path.join(config.DATA_DIR, 'epg');

// Lower case, no accents: "Notícias" matches "noticias"
const normalize = (text) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

class ArchiveService {
  constructor() {
    this.epgCache = new Map(); // `${portal}:${channelId}:now` -> { at, programs }
    this.days = new Map();     // `${portal}:${date}` -> { file, channels: { id: { at, programs } }, timer }
    this.foreground = 0;       // guide requests made for someone waiting on the screen
    this.fetches = 0;          // guide days read from the portal (for the sync's log)
  }

  // ── The guide is kept on disk, one file per portal and day. A finished day
  //    no longer changes and is read from the portal once; the day in progress
  //    is read again after a while. The background sync keeps both up to date.

  dayFile(portal, date) {
    return path.join(GUIDE_DIR, `${portal.replace(/[^a-zA-Z0-9.-]/g, '_')}_${date}.json`);
  }

  loadDay(portal, date, alias = null) {
    const key = `${portal}:${date}`;
    let day = this.days.get(key);

    if (!day) {
      const file = this.dayFile(portal, date);
      let channels = {};
      try {
        channels = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (_) {
        // not stored yet
      }

      // Days stored under the server a redirector sent us to, before the guide
      // was kept under the configured address
      if (alias && alias !== portal) {
        try {
          const old = JSON.parse(fs.readFileSync(this.dayFile(alias, date), 'utf8'));
          for (const [id, entry] of Object.entries(old)) {
            if (!channels[id] || channels[id].at < entry.at) channels[id] = entry;
          }
        } catch (_) {
          // nothing stored there either
        }
      }

      day = { file, channels, timer: null };
      this.days.set(key, day);
    }

    return day;
  }

  // Is a stored guide still good to use?
  isFresh(entry, date) {
    const age = Date.now() - entry.at;

    // Read at least two hours after the day ended: it will not change any more
    // (programmes aired late that day are then marked as recorded too)
    const dayEnd = Date.parse(`${date}T00:00:00Z`) + 24 * 3600 * 1000;
    const final = entry.at >= dayEnd + 2 * 3600 * 1000;

    if (final) {
      // An empty guide may only be one that arrived late: ask again now and then
      return entry.programs.length > 0 || age < config.EPG_EMPTY_RETRY;
    }

    return age < config.EPG_CACHE_TTL;
  }

  saveDay(day) {
    if (day.timer) return;

    // Many channels arrive in a row; write once they have settled
    day.timer = setTimeout(() => {
      day.timer = null;
      try {
        fs.mkdirSync(GUIDE_DIR, { recursive: true });
        fs.writeFileSync(day.file, JSON.stringify(day.channels));
        this.pruneGuide();
      } catch (error) {
        logger.warn('data', 'Programme guide could not be stored', { error: error.message });
      }
    }, 5000);
  }

  // Drop stored days older than any archive goes back
  pruneGuide() {
    const limit = new Date(Date.now() - config.GUIDE_KEEP_DAYS * 86400000).toISOString().slice(0, 10);

    for (const file of fs.readdirSync(GUIDE_DIR)) {
      const date = (/_(\d{4}-\d{2}-\d{2})\.json$/.exec(file) || [])[1];
      if (date && date < limit) fs.unlinkSync(path.join(GUIDE_DIR, file));
    }

    for (const [key, day] of this.days.entries()) {
      if (key.slice(-10) < limit) this.days.delete(key);
    }
  }

  // Programmes of one channel for one day (YYYY-MM-DD, portal timezone).
  // `background`: asked by the sync, which gives way to people waiting.
  async getEpg(sessionId, userId, channelId, date, { background = false } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      throw new Error('Invalid date');
    }

    // The guide is the same for every account of a portal
    const portal = iptvService.getPortalKey(sessionId);
    const day = this.loadDay(portal, date, iptvService.getServerKey(sessionId));
    const stored = day.channels[channelId];

    if (stored && this.isFresh(stored, date)) {
      return stored.programs;
    }

    if (!background) this.foreground++;
    let programs;
    try {
      programs = await iptvService.getEpgDay(sessionId, channelId, date);
    } finally {
      if (!background) this.foreground--;
    }

    this.fetches++;
    day.channels[channelId] = { at: Date.now(), programs };
    this.saveDay(day);

    return programs;
  }

  // Recorded programmes of the given channels, on one day, whose title or
  // description contains every word of the query
  async search(sessionId, userId, channels, date, query) {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    const now = Math.floor(Date.now() / 1000);
    const results = [];

    for (const channel of channels) {
      let programs;
      try {
        programs = await this.getEpg(sessionId, userId, channel.id, date);
      } catch (error) {
        if (error.message === 'Invalid date') throw error;
        continue; // one channel's guide failing must not end the search
      }

      const oldest = now - (channel.archiveHours || 0) * 3600;

      for (const program of programs) {
        // Only what can still be played back
        if (!program.archive || program.start > now || program.start < oldest) continue;

        const text = normalize(`${program.name} ${program.descr}`);
        if (words.every(word => text.includes(word))) {
          results.push({ channelId: channel.id, ...program });
        }
      }
    }

    return results;
  }

  // Current and next programmes of a channel, for the live player
  async getNow(sessionId, channelId) {
    const key = `${iptvService.getPortalKey(sessionId)}:${channelId}:now`;
    const cached = this.epgCache.get(key);

    if (cached && Date.now() - cached.at < config.EPG_NOW_CACHE_TTL) {
      return cached.programs;
    }

    const programs = await iptvService.getShortEpg(sessionId, channelId);
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
    let wantedDuration = Number.isFinite(Number(duration)) ? Math.floor(Number(duration)) : seed.stop - seed.start;
    const isSeedWindow = wantedStart === seed.start && wantedDuration === seed.stop - seed.start;

    if (wantedStart >= now) {
      throw new Error('Interval starts in the future');
    }

    // Nothing is recorded past this moment: a programme still on air, or a
    // margin after one that has just ended, stops at "now"
    if (wantedStart + wantedDuration > now) {
      wantedDuration = now - wantedStart;

      if (wantedDuration < 60) {
        throw new Error('This programme has only just started - try again in a minute');
      }
    }

    if (wantedDuration < 60 || wantedDuration > config.ARCHIVE_MAX_WINDOW) {
      throw new Error(`Interval must be between 1 minute and ${config.ARCHIVE_MAX_WINDOW / 3600} hours`);
    }

    if (channel.archiveHours && wantedStart < now - channel.archiveHours * 3600) {
      throw new Error(`This channel only keeps ${channel.archiveHours} hours of archive`);
    }

    const link = await iptvService.createArchiveLink(sessionId, seed.id);
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
