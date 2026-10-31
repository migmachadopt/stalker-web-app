// ═══════════════════════════════════════════════════════════════════════════════
// 🔎 Sources Service - Torrents for a Discover film or episode, from Prowlarr
// ═══════════════════════════════════════════════════════════════════════════════
//
// The app does not search any site itself: it asks the Prowlarr the admin set
// up in Settings, which searches the indexers configured there.
//
// Each search asks by IMDb id (indexers that know ids answer exactly) and by
// name (the others), and keeps only what matches the film, or the episode and
// the packs of its season.
//
// Download links stay on the server (Prowlarr's carry its API key): the app
// gets an id per source and hands it back to use one (see release()).
//
// A source: { id, title, size, seeders, peers, indexer, date, pack,
//             quality: { resolution, source, codec, hdr, audio, languages, cam } }

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const settingsService = require('./settingsService');

const STATUS_TIMEOUT = 10000;
const SEARCH_TIMEOUT = 60000;       // Prowlarr waits for its slowest indexer
const SEARCH_CACHE_TTL = 10 * 60 * 1000;
const RELEASE_TTL = 6 * 60 * 60 * 1000;
const CATEGORIES = { movie: [2000], tv: [5000] };

// What may follow the title in a release name
const NEXT_WORD = /^(19\d{2}|20\d{2}|s\d{1,2}(e\d{1,3})?|\d{1,2}x\d{1,3}|seasons?|temporada|complete|completa|integral|\d{3,4}[pi]|4k|uhd|us|uk|extended|remastered|directors|unrated|imax|multi|dual|pt|web|bluray|hdtv)\b/;

const RESOLUTION_RANK ={ '4K': 4, '1080p': 3, '720p': 2, SD: 1 };

// Lower case, no accents, words only ("Amélie & Co." -> "amelie and co")
const words = (text) => String(text || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/'/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

class SourcesService {
  constructor() {
    this.searches = new Map(); // query -> { at, value }
    this.releases = new Map(); // source id -> { at, release }
  }

  // ── Connection ───────────────────────────────────────────────────────────

  connection() {
    const { url, key } = settingsService.prowlarr();
    if (!url || !key) throw new Error('Add the Prowlarr address and API key in the admin Settings to find sources.');
    return { url, key };
  }

  async request(url, key, path, params, timeout) {
    try {
      const response = await axios.get(`${url}${path}`, {
        params,
        paramsSerializer: { serialize: (p) => this.query(p) },
        headers: { 'X-Api-Key': key },
        timeout
      });
      return response.data;
    } catch (error) {
      const status = error.response && error.response.status;
      if (status === 401) throw new Error('Prowlarr did not accept the API key.');
      if (status === 404) throw new Error(`There is no Prowlarr at ${url}.`);
      if (error.code === 'ECONNABORTED') throw new Error('Prowlarr took too long to answer.');
      throw new Error(`Prowlarr could not be reached at ${url} (${status || error.code || error.message}).`);
    }
  }

  // Lists as repeated parameters (categories=2000&categories=5000), as Prowlarr expects
  query(params = {}) {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      for (const one of [].concat(value)) if (one !== undefined && one !== '') search.append(name, one);
    }
    return search.toString();
  }

  // Tried before the address and key are saved; returns Prowlarr's version
  async check(url, key) {
    const status = await this.request(url, key, '/api/v1/system/status', {}, STATUS_TIMEOUT);
    if (!status || !status.version) throw new Error(`The answer from ${url} is not from Prowlarr.`);
    return status.version;
  }

  // ── Searching ────────────────────────────────────────────────────────────

  async prowlarrSearch(query, type, kind) {
    const { url, key } = this.connection();
    const id = `${type}|${kind}|${query}`;
    const hit = this.searches.get(id);
    if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL) return hit.value;

    const value = await this.request(url, key, '/api/v1/search', {
      query, type, categories: CATEGORIES[kind], limit: 100
    }, SEARCH_TIMEOUT);
    const results = Array.isArray(value) ? value : [];

    this.searches.set(id, { at: Date.now(), value: results });
    for (const [old, entry] of this.searches) {
      if (Date.now() - entry.at > SEARCH_CACHE_TTL) this.searches.delete(old);
    }
    return results;
  }

  // title: { kind, imdbId, title, originalTitle, year }; episode only for series
  async search(title, season, episode) {
    const tv = title.kind === 'tv';
    const pad = (n) => String(n).padStart(2, '0');
    const names = [...new Set([title.title, title.originalTitle].filter(Boolean))];

    const searches = [];
    if (title.imdbId) {
      const ids = tv ? `{ImdbId:${title.imdbId}}{Season:${season}}{Episode:${episode}}` : `{ImdbId:${title.imdbId}}`;
      searches.push({ query: ids, type: tv ? 'tvsearch' : 'movie', exact: true });
    }
    for (const name of names) {
      if (tv) {
        searches.push({ query: `${name} S${pad(season)}E${pad(episode)}`, type: 'search' });
        searches.push({ query: `${name} S${pad(season)}`, type: 'search' });
      } else {
        searches.push({ query: `${name} ${title.year || ''}`.trim(), type: 'search' });
      }
    }

    // One search failing (an indexer without id searches, say) does not lose the others
    const answers = await Promise.allSettled(searches.map(s => this.prowlarrSearch(s.query, s.type, title.kind)));
    const failures = answers.filter(a => a.status === 'rejected');
    if (failures.length === answers.length) throw failures[0].reason;
    for (const failure of failures) logger.warn('sources', 'A Prowlarr search failed', { error: failure.reason.message });

    const found = new Map();
    answers.forEach((answer, i) => {
      if (answer.status !== 'fulfilled') return;
      for (const release of answer.value) {
        if (release.protocol && release.protocol !== 'torrent') continue;
        if (release.seeders === 0) continue;

        const match = tv
          ? this.matchesEpisode(release.title, names, season, episode, searches[i].exact)
          : this.matchesMovie(release.title, names, title.year, searches[i].exact) && { pack: false };
        if (!match) continue;

        const source = this.source(release, match.pack);
        const key = (release.infoHash || '').toLowerCase() || `${words(release.title)}|${release.size}`;
        const known = found.get(key);
        if (!known || (source.seeders || 0) > (known.seeders || 0)) found.set(key, source);
      }
    });

    logger.info('sources', 'Sources found', { title: title.title, season, episode, searches: searches.length, sources: found.size });
    return this.sorted([...found.values()]);
  }

  // Best picture first (camera copies last), then the most seeders
  sorted(sources) {
    return sources.sort((a, b) =>
      (a.quality.cam - b.quality.cam) ||
      ((RESOLUTION_RANK[b.quality.resolution] || 0) - (RESOLUTION_RANK[a.quality.resolution] || 0)) ||
      ((b.seeders || 0) - (a.seeders || 0)));
  }

  // ── Matching ─────────────────────────────────────────────────────────────

  // The release name is the title followed by its year, season or quality
  // (searches by name also return other titles that start the same way, like
  // "The Bear Necessities" for "The Bear")
  startsWithName(release, names) {
    const text = words(release);
    return names.some(name => {
      const wanted = words(name);
      if (!wanted || !(text === wanted || text.startsWith(`${wanted} `))) return false;
      const rest = text.slice(wanted.length + 1);
      return !rest || NEXT_WORD.test(rest);
    });
  }

  matchesMovie(release, names, year, exact) {
    const found = String(release).match(/\b(19\d{2}|20\d{2})\b/g) || [];
    const yearOk = !year || !found.length || found.some(y => Math.abs(+y - +year) <= 1);
    if (exact) return yearOk;
    return yearOk && this.startsWithName(release, names);
  }

  // The episode itself, several episodes including it, or a pack of its season
  // (or of several seasons including it). Returns { pack } or null.
  matchesEpisode(release, names, season, episode, exact) {
    if (!exact && !this.startsWithName(release, names)) return null;
    const text = String(release);

    const range = text.match(/\bS(\d{1,2})\s?E(\d{1,3})(?:\s?-?\s?E?(\d{1,3}))?\b/i);
    if (range) {
      const first = +range[2];
      const last = range[3] ? +range[3] : first;
      return +range[1] === season && episode >= first && episode <= last ? { pack: first !== last } : null;
    }

    const cross = text.match(/\b(\d{1,2})x(\d{1,3})\b/i);
    if (cross) return +cross[1] === season && +cross[2] === episode ? { pack: false } : null;

    const seasons = text.match(/\bS(\d{1,2})\s?-\s?S?(\d{1,2})\b/i) || text.match(/\bSeasons?\s?(\d{1,2})\s?-\s?(\d{1,2})\b/i);
    if (seasons) return season >= +seasons[1] && season <= +seasons[2] ? { pack: true } : null;

    const one = text.match(/\bS(\d{1,2})\b/i) || text.match(/\bSeason\s?(\d{1,2})\b/i) || text.match(/\bTemporada\s?(\d{1,2})\b/i);
    if (one) return +one[1] === season ? { pack: true } : null;

    // A whole series, without season numbers
    if (/\b(complete|completa|integral)\b/i.test(text)) return { pack: true };
    return exact ? { pack: false } : null;
  }

  // ── What a release name says ─────────────────────────────────────────────

  quality(name) {
    const t = ` ${String(name).replace(/[._\[\]()]/g, ' ')} `;
    const has = (re) => re.test(t);

    const resolution = has(/\b(2160p|4k|uhd)\b/i) ? '4K'
      : has(/\b1080[pi]\b/i) ? '1080p'
      : has(/\b720p\b/i) ? '720p'
      : has(/\b(576p|480p|360p|sd|dvdrip|xvid)\b/i) ? 'SD' : '';

    const cam = has(/\b(cam|camrip|hdcam|ts|hdts|telesync|tc|telecine)\b/i);
    const source = cam ? 'CAM'
      : has(/\bremux\b/i) ? 'REMUX'
      : has(/\b(blu-?ray|bdrip|brrip|bdremux|bd)\b/i) ? 'BluRay'
      : has(/\bweb-?dl\b/i) ? 'WEB-DL'
      : has(/\bweb-?rip\b/i) ? 'WEBRip'
      : has(/\bweb\b/i) ? 'WEB'
      : has(/\bhdtv\b/i) ? 'HDTV'
      : has(/\bdvd(rip)?\b/i) ? 'DVD' : '';

    const codec = has(/\b(x265|h-?265|hevc)\b/i) ? 'HEVC'
      : has(/\b(x264|h-?264|avc)\b/i) ? 'H.264'
      : has(/\bav1\b/i) ? 'AV1' : '';

    const hdr = has(/\b(dv|dovi|dolby\s?vision)\b/i) ? 'Dolby Vision'
      : has(/\bhdr10\+|hdr10plus\b/i) ? 'HDR10+'
      : has(/\bhdr(10)?\b/i) ? 'HDR' : '';

    const audio = has(/\batmos\b/i) ? 'Atmos'
      : has(/\btrue-?hd\b/i) ? 'TrueHD'
      : has(/\bdts(-?hd|-?x)?\b/i) ? 'DTS'
      : has(/\b(ddp|dd\+|e-?ac-?3)/i) ? 'DD+'
      : has(/\b(ac-?3|dd\s?5|dd2)/i) ? 'AC3'
      : has(/\baac/i) ? 'AAC' : '';

    const languages = [];
    if (has(/\b(pt-?br|brazilian|dublado|nacional)\b/i)) languages.push('PT-BR');
    if (has(/\b(pt-?pt|portugues|portuguese|port)\b/i) || (has(/\bpt\b/i) && !languages.length)) languages.push('PT');
    if (has(/\bmulti\b/i)) languages.push('MULTI');
    if (has(/\bdual\b/i)) languages.push('DUAL');

    return { resolution, source, codec, hdr, audio, languages, cam };
  }

  source(release, pack) {
    const id = crypto.createHash('sha1').update(`${release.indexerId}|${release.guid || release.downloadUrl || release.title}`).digest('hex').slice(0, 16);
    this.releases.set(id, { at: Date.now(), release });
    for (const [old, entry] of this.releases) {
      if (Date.now() - entry.at > RELEASE_TTL) this.releases.delete(old);
    }

    return {
      id,
      title: release.title || '',
      size: release.size || 0,
      seeders: typeof release.seeders === 'number' ? release.seeders : null,
      peers: typeof release.leechers === 'number' ? release.leechers : null,
      indexer: release.indexer || '',
      date: release.publishDate || '',
      pack: !!pack,
      quality: this.quality(release.title || '')
    };
  }

  // The Prowlarr release behind a source id (with its download links), for using it
  release(id) {
    const entry = this.releases.get(id);
    if (!entry) throw new Error('This source is no longer known. Search again.');
    return entry.release;
  }
}

module.exports = new SourcesService();
