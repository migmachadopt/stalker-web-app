// ═══════════════════════════════════════════════════════════════════════════════
// 🎬 VOD Service - Video club & series catalogue (cached) and access rules
// ═══════════════════════════════════════════════════════════════════════════════

const config = require('../config/constants');
const iptvService = require('./iptvService');

const TYPES = ['vod', 'series'];

const CONTENT_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  webm: 'video/webm'
};

class VodService {
  constructor() {
    this.cache = new Map(); // key -> { at, value }
  }

  isType(type) {
    return TYPES.includes(type);
  }

  // Admins always have both sections; other users need them enabled
  getSections(user) {
    const enabled = user.enabledSections || [];
    return {
      vod: user.role === 'admin' || enabled.includes('vod'),
      series: user.role === 'admin' || enabled.includes('series')
    };
  }

  canAccess(user, type) {
    return this.isType(type) && this.getSections(user)[type];
  }

  // The catalogue is the same for every account of a portal, so cache it per portal
  async cached(sessionId, parts, load) {
    const key = [iptvService.getPortalKey(sessionId), ...parts].join('|');
    const hit = this.cache.get(key);

    if (hit && Date.now() - hit.at < config.VOD_CACHE_TTL) {
      return hit.value;
    }

    const value = await load();

    if (this.cache.size > 1000) {
      this.cache.clear();
    }
    this.cache.set(key, { at: Date.now(), value });

    return value;
  }

  getCategories(sessionId, type) {
    return this.cached(sessionId, [type, 'categories'], () => iptvService.getVodCategories(sessionId, type));
  }

  getList(sessionId, type, { category, page, search }) {
    const safePage = Math.min(Math.max(parseInt(page, 10) || 1, 1), 2000);
    const safeSearch = String(search || '').trim().slice(0, 80);
    const safeCategory = safeSearch ? '*' : String(category || '*').slice(0, 20);

    return this.cached(
      sessionId,
      [type, 'list', safeCategory, safePage, safeSearch.toLowerCase()],
      () => iptvService.getVodList(sessionId, type, { category: safeCategory, page: safePage, search: safeSearch })
    );
  }

  getSeasons(sessionId, seriesId) {
    return this.cached(sessionId, ['series', 'seasons', seriesId], () => iptvService.getSeriesSeasons(sessionId, seriesId));
  }

  // Container of the provider file, from its extension
  describeLink(link) {
    const extension = ((/\.([a-z0-9]{2,4})(?:\?|$)/i.exec(link) || [])[1] || 'mp4').toLowerCase();
    return { extension, contentType: CONTENT_TYPES[extension] || 'application/octet-stream' };
  }
}

module.exports = new VodService();
