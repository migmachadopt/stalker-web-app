// ═══════════════════════════════════════════════════════════════════════════════
// ⚡ Debrid Service - Plays a Discover source through Real-Debrid
// ═══════════════════════════════════════════════════════════════════════════════
//
// The torrent is handed to Real-Debrid (with the token saved in the admin
// Settings), which downloads it on its own servers; when it already has it, it
// is ready at once. Only the video wanted is selected: the film (the largest
// video), or the episode inside a season pack.
//
// Once ready, Real-Debrid gives a direct link to the file, and a converted HLS
// version (H.264 and AAC) for files the browser cannot play.
//
// The source played is remembered (see historyService), and resume() plays it
// again: the same torrent while Real-Debrid still has it, or added again
// from its hash.
//
// The app polls state() while Real-Debrid prepares it:
//   { state: 'converting' | 'downloading' | 'ready', progress, speed, seeders,
//     url, hls, filename, size }

const axios = require('axios');
const config = require('../config/constants');
const logger = require('../utils/logger');
const settingsService = require('./settingsService');
const sourcesService = require('./sourcesService');

const TIMEOUT = 20000;
const READY_TTL = 60 * 60 * 1000; // links handed out are reused for a while
const VIDEO = /\.(mkv|mp4|m4v|avi|webm|mov|ts|wmv)$/i;

const LIST_TTL = 60 * 1000;

const RD_ERRORS = {
  7: 'Real-Debrid no longer has this torrent. Choose a source again.',
  8: 'Real-Debrid did not accept the token saved in Settings.',
  9: 'Real-Debrid refused: the account needs premium.',
  20: 'Real-Debrid refused: the account needs premium.',
  21: 'Real-Debrid has too many active downloads on this account. Remove some at real-debrid.com/torrents.',
  23: 'Real-Debrid has too many active downloads on this account. Remove some at real-debrid.com/torrents.',
  34: 'Real-Debrid is getting too many requests. Try again in a minute.',
  35: 'Real-Debrid refuses this torrent. Choose another source.'
};

class DebridService {
  constructor() {
    this.ready = new Map(); // torrent id + file -> { at, value }
    this.list = null;       // { at, torrents } of the account, for marking sources
  }

  token() {
    const token = settingsService.realDebridToken();
    if (!token) throw new Error('Add the Real-Debrid token in the admin Settings to play sources.');
    return token;
  }

  async request(method, path, { token = this.token(), form, data, headers = {}, params } = {}) {
    try {
      const response = await axios({
        method,
        url: `${config.REAL_DEBRID_API}${path}`,
        params,
        data: form ? new URLSearchParams(form).toString() : data,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...headers
        },
        timeout: TIMEOUT,
        maxBodyLength: 20 * 1024 * 1024
      });
      return response.data;
    } catch (error) {
      const body = (error.response && error.response.data) || {};
      const status = error.response && error.response.status;
      if (RD_ERRORS[body.error_code]) throw new Error(RD_ERRORS[body.error_code]);
      if (status === 401) throw new Error(RD_ERRORS[8]);
      if (status === 403) throw new Error(RD_ERRORS[9]);
      throw new Error(`Real-Debrid: ${body.error || status || error.code || error.message}`);
    }
  }

  // Tried before the token is saved: { username, premium, expiration }
  async check(token) {
    const user = await this.request('get', '/user', { token });
    return { username: user.username, premium: user.type === 'premium', expiration: user.expiration || '' };
  }

  // ── Starting ─────────────────────────────────────────────────────────────

  // Hands a source to Real-Debrid (or finds it there already): { torrent, hash }
  async start(sourceId, target) {
    return this.startRelease(sourcesService.release(sourceId), target);
  }

  async startRelease(release, target) {
    let hash = String(release.infoHash || '').toLowerCase();

    if (hash) {
      const reuse = await this.existing(hash, target);
      if (reuse) return { torrent: reuse, hash };
    }

    const torrent = await this.add(release, hash);
    this.list = null;
    logger.info('debrid', 'Torrent sent to Real-Debrid', { title: release.title, season: target && target.season, episode: target && target.episode });

    // Sources fetched as a .torrent file come without a hash: Real-Debrid knows it
    if (!hash) {
      try { hash = String((await this.request('get', `/torrents/info/${torrent}`)).hash || '').toLowerCase(); } catch (_) {}
    }
    return { torrent, hash };
  }

  // The source played before: the same torrent if Real-Debrid still has it,
  // or the same one added again from its hash
  async resume(entry, target) {
    if (entry.torrent) {
      try {
        const info = await this.request('get', `/torrents/info/${entry.torrent}`);
        const file = info.status === 'downloaded' ? this.chooseFile((info.files || []).filter(f => f.selected), target) : true;
        if (!/error|dead|virus/.test(info.status) && file) return { torrent: entry.torrent, hash: entry.hash };
      } catch (_) {}
    }
    if (!entry.hash) throw new Error('Real-Debrid no longer has this source. Choose a source again.');
    return this.startRelease({ infoHash: entry.hash, title: entry.title }, target);
  }

  // Torrents on the account (asked again after a minute)
  async torrents() {
    if (this.list && Date.now() - this.list.at < LIST_TTL) return this.list.torrents;
    const list = await this.request('get', '/torrents', { params: { limit: 500 } });
    this.list = { at: Date.now(), torrents: Array.isArray(list) ? list : [] };
    return this.list.torrents;
  }

  // Hashes Real-Debrid has downloaded, to mark the sources that play at once
  async downloadedHashes() {
    if (!settingsService.realDebridToken()) return new Set();
    try {
      return new Set((await this.torrents()).filter(t => t.status === 'downloaded').map(t => String(t.hash).toLowerCase()));
    } catch (error) {
      logger.warn('debrid', 'Could not read the Real-Debrid torrents', { error: error.message });
      return new Set();
    }
  }

  // The same torrent added before, with the file wanted (or not chosen yet)
  async existing(hash, target) {
    this.list = null;
    const same = (await this.torrents()).filter(t => String(t.hash).toLowerCase() === hash && !/error|dead|virus/.test(t.status));

    for (const torrent of same) {
      if (torrent.status === 'magnet_conversion' || torrent.status === 'waiting_files_selection') return torrent.id;
      const info = await this.request('get', `/torrents/info/${torrent.id}`);
      const file = this.chooseFile(info.files || [], target);
      if (file && file.selected) return torrent.id;
    }
    return null;
  }

  async add(release, hash) {
    let magnet = /^magnet:/i.test(release.magnetUrl || '') ? release.magnetUrl : '';
    if (!magnet && hash) magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(release.title || '')}`;

    let torrentFile = null;
    if (!magnet) {
      const link = await this.fetchLink(release.downloadUrl || release.magnetUrl);
      magnet = link.magnet || '';
      torrentFile = link.torrent || null;
    }

    const added = magnet
      ? await this.request('post', '/torrents/addMagnet', { form: { magnet } })
      : await this.request('put', '/torrents/addTorrent', { data: torrentFile, headers: { 'Content-Type': 'application/x-bittorrent' } });
    if (!added || !added.id) throw new Error('Real-Debrid did not take the torrent.');
    return added.id;
  }

  // Prowlarr's download link: a .torrent file, or a redirect to a magnet
  async fetchLink(url) {
    if (!url) throw new Error('This source has no download link.');
    let next = url;

    for (let hop = 0; hop < 5; hop++) {
      let response;
      try {
        response = await axios.get(next, { maxRedirects: 0, responseType: 'arraybuffer', validateStatus: () => true, timeout: 30000 });
      } catch (error) {
        throw new Error(`The torrent could not be fetched from Prowlarr (${error.code || error.message}).`);
      }

      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && location) {
        if (/^magnet:/i.test(location)) return { magnet: location };
        next = new URL(location, next).href;
        continue;
      }

      const body = Buffer.from(response.data || []);
      if (response.status === 200 && body[0] === 0x64) return { torrent: body }; // bencoded: "d..."
      const text = body.toString('utf8', 0, 4096).trim();
      if (/^magnet:/i.test(text)) return { magnet: text };
      throw new Error(`The indexer did not give a torrent for this source (${response.status}). Choose another.`);
    }
    throw new Error('Too many redirects fetching the torrent.');
  }

  // ── Files ────────────────────────────────────────────────────────────────

  // The video wanted: the largest for a film; the episode for a series
  chooseFile(files, target) {
    const name = (file) => String(file.path || '').split('/').pop();
    let videos = files.filter(file => VIDEO.test(name(file)) && !/\bsample\b/i.test(file.path));
    const big = videos.filter(file => file.bytes > 50 * 1024 * 1024);
    if (big.length) videos = big;
    if (!videos.length) return null;

    if (!target) return videos.reduce((a, b) => (b.bytes > a.bytes ? b : a));

    const { season, episode } = target;
    const exact = new RegExp(`(^|[^a-z0-9])(s0*${season}[ ._-]?e0*${episode}(?!\\d)|0*${season}x0*${episode}(?!\\d))`, 'i');
    const found = videos.find(file => exact.test(name(file)));
    if (found) return found;

    // Packs naming episodes without the season ("E03", "Episode 3", "03 - Title")
    const tagged = /s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{2}/i;
    if (videos.some(file => tagged.test(name(file)))) return null;
    const loose = new RegExp(`(^|[^a-z0-9])(e|ep|episode|episodio|episódio)[ ._-]?0*${episode}(?!\\d)`, 'i');
    const byNumber = new RegExp(`^0*${episode}(?!\\d)`);
    return videos.find(file => loose.test(name(file))) ||
      videos.find(file => byNumber.test(name(file))) ||
      (videos.length === 1 ? videos[0] : null);
  }

  // ── Progress ─────────────────────────────────────────────────────────────

  async state(torrentId, target) {
    const readyKey = `${torrentId}|${target ? `${target.season}x${target.episode}` : ''}`;
    const hit = this.ready.get(readyKey);
    if (hit && Date.now() - hit.at < READY_TTL) return hit.value;

    const info = await this.request('get', `/torrents/info/${torrentId}`);
    const files = info.files || [];

    switch (info.status) {
      case 'magnet_conversion':
        return { state: 'converting' };

      case 'waiting_files_selection': {
        const file = this.chooseFile(files, target);
        if (!file) {
          await this.remove(torrentId);
          throw new Error(target ? 'This torrent does not have that episode. Choose another source.' : 'This torrent has no video. Choose another source.');
        }
        await this.request('post', `/torrents/selectFiles/${torrentId}`, { form: { files: String(file.id) } });
        return { state: 'downloading', progress: 0 };
      }

      case 'queued':
      case 'downloading':
      case 'compressing':
      case 'uploading':
        return {
          state: 'downloading',
          progress: Math.round(info.progress || 0),
          speed: info.speed || 0,
          seeders: typeof info.seeders === 'number' ? info.seeders : null
        };

      case 'downloaded': {
        // Links follow the order of the files selected
        const selected = files.filter(file => file.selected);
        const file = this.chooseFile(selected, target);
        const index = file ? selected.indexOf(file) : -1;
        const link = index >= 0 && (info.links || [])[index];
        if (!link) throw new Error('Real-Debrid has this torrent without the video wanted. Choose another source.');

        const unrestricted = await this.request('post', '/unrestrict/link', { form: { link } });
        const value = {
          state: 'ready',
          url: unrestricted.download,
          filename: unrestricted.filename || '',
          size: unrestricted.filesize || file.bytes || 0,
          hls: await this.hls(unrestricted.id)
        };
        this.ready.set(readyKey, { at: Date.now(), value });
        for (const [key, entry] of this.ready) if (Date.now() - entry.at > READY_TTL) this.ready.delete(key);
        return value;
      }

      default:
        throw new Error(`Real-Debrid could not download this torrent (${info.status}). Choose another source.`);
    }
  }

  // Real-Debrid's converted version (H.264 + AAC, HLS), when it offers one
  async hls(downloadId) {
    if (!downloadId) return '';
    try {
      const streams = await this.request('get', `/streaming/transcode/${downloadId}`);
      const apple = streams && streams.apple;
      return (apple && (apple.full || Object.values(apple)[0])) || '';
    } catch (error) {
      logger.warn('debrid', 'No converted version from Real-Debrid', { error: error.message });
      return '';
    }
  }

  async remove(torrentId) {
    try {
      await this.request('delete', `/torrents/delete/${torrentId}`);
    } catch (_) {}
  }
}

module.exports = new DebridService();
