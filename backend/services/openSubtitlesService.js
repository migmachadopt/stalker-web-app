// ═══════════════════════════════════════════════════════════════════════════════
// 💬 OpenSubtitles Service - Subtitles for Discover films and episodes
// ═══════════════════════════════════════════════════════════════════════════════
//
// Uses the official API of opensubtitles.com with the key saved in the admin
// Settings (and the account, when given: it allows more downloads a day).
//
// Subtitles are found by the TMDB id of the film (or of the series, with the
// season and episode) and, when the file is known, by its OpenSubtitles hash:
// those were made for that very release and are in sync.
//
// Downloads count against a daily limit, so each subtitle is downloaded once,
// converted to WebVTT and kept in data/subtitles/opensubtitles.
//
// A subtitle in a list: { id, language, release, hashMatch, downloads,
//                         hearingImpaired, machine }

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/constants');
const logger = require('../utils/logger');
const settingsService = require('./settingsService');

const AGENT = 'StalkerWebApp v1.0';
const TIMEOUT = 20000;
const LOGIN_TTL = 23 * 60 * 60 * 1000; // tokens last a day
const SEARCH_CACHE_TTL = 30 * 60 * 1000;
const HASH_CHUNK = 64 * 1024;

// App language -> OpenSubtitles languages, best first
const LANGUAGES = { pt: ['pt-PT', 'pt-BR', 'en'], en: ['en', 'pt-PT', 'pt-BR'] };

class OpenSubtitlesService {
  constructor() {
    this.login = null;          // { key, user, token, at }
    this.searches = new Map();  // query -> { at, value }
    this.hashes = new Map();    // file address -> hash
  }

  key() {
    const { key } = settingsService.openSubtitles();
    if (!key) throw new Error('Add the OpenSubtitles API key in the admin Settings to find subtitles.');
    return key;
  }

  headers(key, token) {
    return {
      'Api-Key': key,
      'User-Agent': AGENT,
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  }

  failure(error) {
    const status = error.response && error.response.status;
    const body = (error.response && error.response.data) || {};
    if (status === 401 || status === 403) return new Error('OpenSubtitles did not accept the API key or the account.');
    if (status === 406 || status === 429 || /quota|limit|allowed/i.test(body.message || '')) {
      const reset = body.reset_time ? ` It resets in ${body.reset_time}.` : '';
      return new Error(`The daily OpenSubtitles downloads are used up.${reset}`);
    }
    return new Error(`OpenSubtitles: ${body.message || status || error.code || error.message}`);
  }

  // Parameters in alphabetical order and lower case, as the API asks
  query(params) {
    return Object.keys(params).sort()
      .filter(name => params[name] !== undefined && params[name] !== '')
      .map(name => `${name}=${encodeURIComponent(String(params[name]).toLowerCase()).replace(/%2C/g, ',')}`)
      .join('&');
  }

  // Signed in with the account saved, when there is one (more downloads a day)
  async token(key) {
    const { user, password } = settingsService.openSubtitles();
    if (!user || !password) return '';
    if (this.login && this.login.key === key && this.login.user === user && Date.now() - this.login.at < LOGIN_TTL) {
      return this.login.token;
    }
    try {
      const response = await axios.post(`${config.OPENSUBTITLES_API}/login`, { username: user, password }, {
        headers: { ...this.headers(key), 'Content-Type': 'application/json' }, timeout: TIMEOUT
      });
      this.login = { key, user, token: response.data.token, at: Date.now() };
      return this.login.token;
    } catch (error) {
      throw this.failure(error);
    }
  }

  // Tried before the key (and account) are saved
  async check(key, user, password) {
    try {
      await axios.get(`${config.OPENSUBTITLES_API}/infos/formats`, { headers: this.headers(key), timeout: TIMEOUT });
      if (user && password) {
        const response = await axios.post(`${config.OPENSUBTITLES_API}/login`, { username: user, password }, {
          headers: { ...this.headers(key), 'Content-Type': 'application/json' }, timeout: TIMEOUT
        });
        const info = response.data.user || {};
        return { user, allowedDownloads: info.allowed_downloads || null, vip: !!info.vip };
      }
      return { user: '', allowedDownloads: null, vip: false };
    } catch (error) {
      throw this.failure(error);
    }
  }

  // ── Hash of the file (OpenSubtitles' own: size + first and last 64 KB) ──

  async hash(url, size) {
    if (!url || !(size > HASH_CHUNK * 2)) return '';
    if (this.hashes.has(url)) return this.hashes.get(url);

    const range = async (start, end) => {
      const response = await axios.get(url, {
        headers: { Range: `bytes=${start}-${end}` }, responseType: 'arraybuffer', timeout: TIMEOUT, maxContentLength: HASH_CHUNK * 2
      });
      if (response.status !== 206) throw new Error('No ranges');
      return Buffer.from(response.data);
    };

    try {
      const [head, tail] = await Promise.all([range(0, HASH_CHUNK - 1), range(size - HASH_CHUNK, size - 1)]);
      let sum = BigInt(size);
      for (const chunk of [head, tail]) {
        for (let i = 0; i + 8 <= chunk.length; i += 8) sum = (sum + chunk.readBigUInt64LE(i)) & 0xFFFFFFFFFFFFFFFFn;
      }
      const value = sum.toString(16).padStart(16, '0');
      this.hashes.set(url, value);
      if (this.hashes.size > 200) this.hashes.delete(this.hashes.keys().next().value);
      return value;
    } catch (error) {
      logger.warn('subtitles', 'Could not read the file hash', { error: error.message });
      return '';
    }
  }

  // ── Searching ────────────────────────────────────────────────────────────

  // title: { kind, tmdbId, season, episode }; file: { url, size } when known
  async search(title, lang, file) {
    const key = this.key();
    const languages = LANGUAGES[lang] || LANGUAGES.en;
    const moviehash = file ? await this.hash(file.url, file.size) : '';

    const params = title.kind === 'tv'
      ? { parent_tmdb_id: title.tmdbId, season_number: title.season, episode_number: title.episode }
      : { tmdb_id: title.tmdbId };
    const query = this.query({ ...params, languages: [...languages].sort().join(','), moviehash });

    const hit = this.searches.get(query);
    let data = hit && Date.now() - hit.at < SEARCH_CACHE_TTL ? hit.value : null;
    if (!data) {
      try {
        const response = await axios.get(`${config.OPENSUBTITLES_API}/subtitles?${query}`, { headers: this.headers(key), timeout: TIMEOUT });
        data = response.data.data || [];
      } catch (error) {
        throw this.failure(error);
      }
      this.searches.set(query, { at: Date.now(), value: data });
      for (const [old, entry] of this.searches) if (Date.now() - entry.at > SEARCH_CACHE_TTL) this.searches.delete(old);
    }

    const rank = (language) => {
      const i = languages.findIndex(l => l.toLowerCase() === String(language).toLowerCase());
      return i < 0 ? languages.length : i;
    };

    return data
      .map(entry => {
        const a = entry.attributes || {};
        const one = (a.files || [])[0];
        return one && {
          id: one.file_id,
          language: a.language || '',
          release: a.release || one.file_name || '',
          hashMatch: !!a.moviehash_match,
          downloads: a.download_count || 0,
          hearingImpaired: !!a.hearing_impaired,
          machine: !!(a.machine_translated || a.ai_translated)
        };
      })
      .filter(Boolean)
      .sort((a, b) =>
        (rank(a.language) - rank(b.language)) ||
        (b.hashMatch - a.hashMatch) ||
        (a.machine - b.machine) ||
        (b.downloads - a.downloads))
      .slice(0, 40);
  }

  // ── Files ────────────────────────────────────────────────────────────────

  file(fileId) {
    return path.join(config.SUBTITLES_DIR, `${parseInt(fileId, 10)}.vtt`);
  }

  // The file of a subtitle already downloaded, or null
  saved(fileId) {
    const target = this.file(fileId);
    return fs.existsSync(target) ? target : null;
  }

  // Downloaded once (it counts against the daily limit), then kept
  async download(fileId) {
    const target = this.file(fileId);
    if (fs.existsSync(target)) return target;

    const key = this.key();
    const token = await this.token(key);
    let text;
    try {
      const response = await axios.post(`${config.OPENSUBTITLES_API}/download`, { file_id: parseInt(fileId, 10), sub_format: 'webvtt' }, {
        headers: { ...this.headers(key, token), 'Content-Type': 'application/json' }, timeout: TIMEOUT
      });
      const file = await axios.get(response.data.link, { responseType: 'arraybuffer', timeout: TIMEOUT });
      text = this.toVtt(Buffer.from(file.data));
      logger.info('subtitles', 'Subtitle downloaded', { fileId, remaining: response.data.remaining });
    } catch (error) {
      throw this.failure(error);
    }

    fs.mkdirSync(config.SUBTITLES_DIR, { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  }

  // WebVTT, from WebVTT or SRT; text in UTF-8 (older files come in Latin-1)
  toVtt(bytes) {
    let text = bytes.toString('utf8');
    if (text.includes('�')) text = bytes.toString('latin1');
    text = text.replace(/^﻿/, '').replace(/\r/g, '');
    if (/^WEBVTT/.test(text)) return text;
    return `WEBVTT\n\n${text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
  }

  // Address that needs no sign-in (a <track> and a Chromecast cannot send one)
  signature(fileId) {
    return crypto.createHmac('sha256', config.STREAM_SECRET).update(`subtitle:${parseInt(fileId, 10)}`).digest('hex').slice(0, 24);
  }

  publicPath(fileId) {
    return `/api/subtitles/opensubtitles/${parseInt(fileId, 10)}.vtt?t=${this.signature(fileId)}`;
  }
}

module.exports = new OpenSubtitlesService();
