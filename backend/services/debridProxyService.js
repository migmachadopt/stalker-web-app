// ═══════════════════════════════════════════════════════════════════════════════
// 🔁 Debrid Proxy Service - Real-Debrid videos passed through this server
// ═══════════════════════════════════════════════════════════════════════════════
//
// Real-Debrid allows one IP at a time per account. With "Play through this
// server" on (admin Settings), the browser and the Chromecast fetch the video
// from here and this server fetches it from Real-Debrid, so Real-Debrid always
// sees this server's IP, wherever the viewer is.
//
// The player cannot send a sign-in, so each video gets a ticket in its address
// (random, valid for a while). The converted HLS version has its playlists
// rewritten so every segment also comes through here.

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

const TICKET_TTL = 12 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT = 30000;
const PASSED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

class DebridProxyService {
  constructor() {
    this.tickets = new Map(); // ticket -> { url, at }
  }

  ticket(url) {
    const ticket = crypto.randomBytes(18).toString('base64url');
    this.tickets.set(ticket, { url, at: Date.now() });
    for (const [old, entry] of this.tickets) if (Date.now() - entry.at > TICKET_TTL) this.tickets.delete(old);
    return ticket;
  }

  resolve(ticket) {
    const entry = this.tickets.get(ticket);
    return entry && Date.now() - entry.at < TICKET_TTL ? entry : null;
  }

  // A ready state with addresses on this server in place of Real-Debrid's
  wrap(ready) {
    return {
      ...ready,
      url: `/api/debrid/stream/${this.ticket(ready.url)}`,
      hls: ready.hls ? `/api/debrid/hls/${this.ticket(ready.hls)}/index.m3u8` : '',
      proxied: true
    };
  }

  // Addresses inside a playlist may only lead to the same site as the playlist
  sameSite(a, b) {
    const site = (url) => new URL(url).hostname.split('.').slice(-2).join('.');
    try { return site(a) === site(b); } catch (_) { return false; }
  }

  // ── Passing bytes ────────────────────────────────────────────────────────

  async pipe(url, req, res) {
    const headers = req.headers.range ? { Range: req.headers.range } : {};
    let upstream;
    try {
      upstream = await axios.get(url, {
        headers, responseType: 'stream', validateStatus: () => true, timeout: UPSTREAM_TIMEOUT, decompress: false
      });
    } catch (error) {
      logger.warn('debrid', 'Real-Debrid video could not be fetched', { error: error.message });
      return res.status(502).end();
    }

    res.status(upstream.status);
    for (const name of PASSED_HEADERS) if (upstream.headers[name]) res.set(name, upstream.headers[name]);
    res.on('close', () => upstream.data.destroy());
    upstream.data.on('error', () => res.destroy());
    upstream.data.pipe(res);
  }

  // A playlist, with every address in it pointing back here
  async playlist(ticket, url, res) {
    let text;
    try {
      const response = await axios.get(url, { responseType: 'text', timeout: UPSTREAM_TIMEOUT });
      text = String(response.data);
    } catch (error) {
      logger.warn('debrid', 'Real-Debrid playlist could not be fetched', { error: error.message });
      return res.status(502).end();
    }

    const local = (address) => {
      const absolute = new URL(address, url).href;
      const kind = /\.m3u8?$/i.test(new URL(absolute).pathname) ? 'p' : 's';
      return `/api/debrid/hls/${ticket}/${kind}?u=${encodeURIComponent(absolute)}`;
    };

    const rewritten = text.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, address) => `URI="${local(address)}"`);
      return local(trimmed);
    }).join('\n');

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store');
    res.send(rewritten);
  }
}

module.exports = new DebridProxyService();
