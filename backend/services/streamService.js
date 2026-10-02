// ═══════════════════════════════════════════════════════════════════════════════
// 🎬 Stream Service - HTTP Passthrough Proxy
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const config = require('../config/constants');
const encryption = require('./encryption');
const logger = require('../utils/logger');
const subtitleService = require('./subtitleService');

const TS_PACKET_SIZE = 188;
const PROVIDER_NOTICE_MARK = Buffer.from('FFmpeg\tService01', 'latin1');
const PROVIDER_NOTICE_HEAD = Buffer.from([0x47, 0x40, 0x11]);

class StreamService {
  constructor() {
    this.streamTokens = new Map();

    // Cleanup old tokens periodically
    setInterval(() => this.cleanupTokens(), 70000);
  }

  // `archive` (optional) turns the token into a seekable, downloadable remote
  // file: { filename, relink (async () => fresh url), duration (seconds, archive
  // windows only), contentType (defaults to MPEG-TS) }
  generateStreamToken(userId, streamUrl, channelInfo, username, archive = null) {
    const token = encryption.generateStreamToken(userId, streamUrl, channelInfo, username);

    if (archive) {
      // Seeks and resumed downloads reuse the token long after it was issued
      token.archive = archive;
      token.expiresAt = Date.now() + config.ARCHIVE_TOKEN_EXPIRY;
    }

    this.streamTokens.set(token.tokenId, token);

    logger.info('token', 'Stream token generated', {
      tokenId: token.tokenId.substring(0, 8),
      user: username,
      channel: channelInfo.name,
      expiresIn: `${Math.round((token.expiresAt - Date.now()) / 1000)}s`
    });

    return token.tokenId;
  }

  validateStreamToken(tokenId) {
    const token = this.streamTokens.get(tokenId);

    if (!token) {
      logger.warn('token', 'Token not found or expired', { tokenId: tokenId.substring(0, 8) });
      return null;
    }

    if (Date.now() > token.expiresAt) {
      this.streamTokens.delete(tokenId);
      logger.warn('token', 'Token expired', { tokenId: tokenId.substring(0, 8) });
      return null;
    }

    token.usedCount++;
    return token;
  }

  fetchUpstream(url, range) {
    return axios({
      method: 'GET',
      url,
      responseType: 'stream',
      timeout: 15000,
      headers: {
        'User-Agent': config.STALKER_HEADERS['User-Agent'],
        ...(range ? { Range: range } : {})
      },
      maxRedirects: 5,
      validateStatus: () => true,
    });
  }

  // Pipe upstream to the client and make sure neither side leaks or crashes the process
  pipeToClient(upstreamResponse, req, res, token) {
    upstreamResponse.data.on('error', (error) => {
      logger.warn('stream', 'Upstream stream error', { error: error.message });
      res.destroy();
    });

    upstreamResponse.data.pipe(res);

    req.on('close', () => {
      // File playback opens and closes a connection per seek; only log live streams
      if (!token.archive) {
        logger.info('stream', `${token.username} - Client disconnected`, {
          channel: token.channelInfo.name
        });
      }
      // Keep the subtitle lines gathered during this stretch of playback
      if (token.archive?.subtitles?.dirty) subtitleService.save(token.archive.subtitles);
      upstreamResponse.data.destroy();
    });
  }

  async handleStream(tokenId, req, res) {
    let upstreamResponse = null;

    try {
      const token = this.validateStreamToken(tokenId);

      if (!token) {
        return res.status(401).send('Unauthorized');
      }

      if (token.archive) {
        return await this.handleArchive(token, req, res);
      }

      // Decrypt real stream URL
      const streamUrl = encryption.decryptStreamUrl(token.encryptedUrl, token.iv);
      const channelInfo = token.channelInfo;

      logger.info('stream', `${token.username} - Starting passthrough proxy`, {
        channel: channelInfo.name,
        url: streamUrl.substring(0, 60) + '...'
      });

      // Fetch stream from upstream without transcoding
      upstreamResponse = await this.fetchUpstream(streamUrl);

      if (upstreamResponse.status >= 400) {
        upstreamResponse.data.destroy();
        throw new Error(`Upstream responded ${upstreamResponse.status}`);
      }

      const contentType = upstreamResponse.headers['content-type'] || 'video/mp2t';

      res.set('Content-Type', contentType);
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Connection', 'keep-alive');

      if (upstreamResponse.headers['content-length']) {
        res.set('Content-Length', upstreamResponse.headers['content-length']);
      }

      // Pipe raw bytes directly to the browser — no transcoding
      this.pipeToClient(upstreamResponse, req, res, token);

    } catch (error) {
      logger.error('stream', 'Stream proxy error', { error: error.message });

      if (upstreamResponse) {
        upstreamResponse.data.destroy();
      }

      if (!res.headersSent) {
        res.status(502).send('Stream unavailable');
      }
    }
  }

  // Total size of the remote file, learned from a one-byte range request
  async probeArchiveSize(url) {
    const probe = await this.fetchUpstream(url, 'bytes=0-0');
    probe.data.destroy();

    const total = Number((probe.headers['content-range'] || '').split('/')[1]);

    if (probe.status >= 400 || !Number.isFinite(total) || total <= 0) {
      throw new Error(`File not available (upstream ${probe.status})`);
    }

    return total;
  }

  // The provider link may have expired - ask the portal for a new one
  async relinkArchive(token) {
    const archive = token.archive;
    if (!archive.relink) throw new Error('Link expired');

    const streamUrl = await archive.relink();
    const fresh = encryption.generateStreamToken(token.userId, streamUrl, token.channelInfo, token.username);
    token.encryptedUrl = fresh.encryptedUrl;
    token.iv = fresh.iv;
    archive.totalBytes = null;

    return streamUrl;
  }

  // Fixed-size file on the provider side: an archive window (MPEG-TS) or a
  // video club title (MP4).
  //   ?start=<seconds>  archive only: play from that position (mapped to a byte offset)
  //   ?download=1       send as a file attachment
  // Range requests from the client are honoured relative to the start offset.
  async handleArchive(token, req, res) {
    const archive = token.archive;
    let streamUrl = encryption.decryptStreamUrl(token.encryptedUrl, token.iv);

    if (!archive.totalBytes) {
      try {
        archive.totalBytes = await this.probeArchiveSize(streamUrl);
      } catch (error) {
        streamUrl = await this.relinkArchive(token);
        archive.totalBytes = await this.probeArchiveSize(streamUrl);
      }
    }

    let total = archive.totalBytes;
    const startSeconds = archive.duration
      ? Math.min(Math.max(Number(req.query.start) || 0, 0), archive.duration)
      : 0;

    // Bitrate is close to constant, so time maps to bytes; stay on a TS packet boundary
    const base = startSeconds
      ? Math.min(
          Math.floor((startSeconds / archive.duration) * total / TS_PACKET_SIZE) * TS_PACKET_SIZE,
          Math.max(total - TS_PACKET_SIZE, 0)
        )
      : 0;
    const available = total - base;

    let from = 0;
    let to = available - 1;
    const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');

    if (rangeMatch) {
      from = Number(rangeMatch[1]);
      if (rangeMatch[2]) to = Math.min(Number(rangeMatch[2]), available - 1);

      if (from > to) {
        res.set('Content-Range', `bytes */${available}`);
        return res.status(416).end();
      }
    }

    // Seeking in a film produces many range requests; only log the first of each kind
    if (!rangeMatch || from === 0) {
      logger.info('stream', `${token.username} - Starting file proxy`, {
        channel: token.channelInfo.name,
        start: `${Math.round(startSeconds)}s`,
        download: req.query.download === '1'
      });
    }

    const upstreamResponse = await this.openFile(token, base + from, base + to);

    res.status(rangeMatch ? 206 : 200);
    res.set('Content-Type', archive.contentType || 'video/mp2t');
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Length', String(to - from + 1));
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (rangeMatch) {
      res.set('Content-Range', `bytes ${from}-${to}/${available}`);
    }

    if (req.query.download === '1') {
      const ascii = archive.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
      res.set(
        'Content-Disposition',
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(archive.filename)}`
      );
    }

    this.pipeFile(token, req, res, upstreamResponse, base + from, base + to);
  }

  // Open a byte range of the provider file. A link stops working once the
  // provider has closed its connection (it then answers 404), so a refusal is
  // answered with a fresh link from the portal, and one more try after a pause.
  async openFile(token, first, last) {
    const range = `bytes=${first}-${last}`;
    let status = 0;

    for (let attempt = 1; attempt <= 3; attempt++) {
      let url = encryption.decryptStreamUrl(token.encryptedUrl, token.iv);

      if (attempt > 1) {
        if (attempt === 3) await new Promise(resolve => setTimeout(resolve, 1500));

        const size = token.archive.totalBytes;
        url = await this.relinkArchive(token);
        token.archive.totalBytes = size;
      }

      const response = await this.fetchUpstream(url, range);
      const contentRange = response.headers['content-range'] || '';

      // Only accept exactly the bytes asked for: anything else would corrupt the file
      if (response.status === 206 && contentRange.startsWith(`bytes ${first}-`)) return response;

      status = response.status;
      response.data.destroy();
      logger.warn('stream', 'File request refused by the provider', { status, attempt, contentRange });
    }

    throw new Error(`File upstream responded ${status}`);
  }

  // When the provider closes a connection because the account opened another
  // one, it first injects a short "Connection Closed" MPEG-TS clip in place of
  // the file's bytes. Returns where that clip starts in `buffer`, or -1.
  findProviderNotice(buffer) {
    const mark = buffer.indexOf(PROVIDER_NOTICE_MARK);
    if (mark < 0) return -1;

    // The mark sits in the clip's first packet (an SDT packet: 47 40 11 ...),
    // so the clip starts at the packet header just before it
    const start = buffer.lastIndexOf(PROVIDER_NOTICE_HEAD, mark);
    return start >= 0 && mark - start < TS_PACKET_SIZE ? start : Math.max(0, mark - 25);
  }

  // Send a byte range to the client. The newest bytes are held back for a
  // moment: if the provider cuts the connection, its closing clip is removed
  // from them and the transfer carries on from the last good byte, so the
  // player never receives foreign data and never notices the interruption.
  pipeFile(token, req, res, firstResponse, first, last) {
    let received = first;   // next file byte expected from the provider
    let sent = first;       // next file byte to hand to the client
    let held = [];
    let heldBytes = 0;
    let current = null;
    let clientClosed = false;
    let clientBusy = false;      // the player has not taken what was sent yet
    let pendingResume = null;    // interruption to recover from once it has
    let resumes = 0;

    const forward = (chunk) => {
      // Embedded subtitles are picked out of the bytes on their way to the player
      if (token.archive.subtitles) subtitleService.feed(token.archive.subtitles, sent, chunk);
      sent += chunk.length;
      if (!res.write(chunk)) clientBusy = true;
    };

    // Forward held chunks while at least `keep` bytes stay behind
    const release = (keep) => {
      while (held.length && heldBytes - held[0].length >= keep) {
        const chunk = held.shift();
        heldBytes -= chunk.length;
        forward(chunk);
      }
    };

    // `expected`: the provider connection lapsed while the player was not
    // reading (buffer full, paused, tab left open) - not a failure
    const resume = async (reason, expected = false) => {
      if (clientClosed) return;

      if (!expected) {
        if (++resumes > 5) {
          logger.error('stream', 'File stream lost', { channel: token.channelInfo.name, reason });
          return res.destroy();
        }

        logger.warn('stream', 'File stream interrupted, resuming', {
          channel: token.channelInfo.name,
          reason,
          at: received
        });
      }

      try {
        const next = await this.openFile(token, received, last);
        if (clientClosed) return next.data.destroy();
        attach(next);
      } catch (error) {
        logger.error('stream', 'File stream could not be resumed', { error: error.message });
        res.destroy();
      }
    };

    const attach = (response) => {
      current = response;
      let finished = false;

      const finish = (reason) => {
        if (finished || clientClosed) return;
        finished = true;

        if (received > last) {
          release(0);
          return res.end();
        }

        // Cut short: keep only the bytes that really belong to the file
        const tail = Buffer.concat(held);
        held = [];
        heldBytes = 0;

        const notice = this.findProviderNotice(tail);
        const valid = notice >= 0 ? tail.subarray(0, notice) : tail;

        received -= tail.length - valid.length;
        if (valid.length) forward(valid);

        if (notice >= 0) {
          return resume('provider closed the connection (account in use elsewhere)');
        }

        // The player is not reading: do not hold a provider connection for it.
        // The transfer continues when it asks for more.
        if (clientBusy) {
          pendingResume = reason;
          return;
        }

        resume(reason);
      };

      response.data.on('data', (chunk) => {
        held.push(chunk);
        heldBytes += chunk.length;
        received += chunk.length;
        resumes = 0;

        release(config.FILE_HOLD_BYTES);

        // Respect a slow client: stop reading until it has taken what was sent
        if (clientBusy && !response.data.isPaused()) response.data.pause();
      });
      response.data.on('end', () => finish('ended early'));
      response.data.on('error', (error) => finish(error.message));
    };

    // The player took what was sent: read on, or pick the transfer back up
    res.on('drain', () => {
      clientBusy = false;

      if (pendingResume !== null) {
        pendingResume = null;
        return resume('player idle', true);
      }

      if (current && current.data.isPaused()) current.data.resume();
    });

    // The player closing the connection (seek, pause, close) is normal
    req.on('close', () => {
      clientClosed = true;
      if (token.archive.subtitles?.dirty) subtitleService.save(token.archive.subtitles);
      if (current) current.data.destroy();
    });

    attach(firstResponse);
  }

  // Save a provider file to disk with the same protection as playback: retries,
  // a fresh link when needed, and the provider's closing clip removed.
  // Returns { done: Promise<bytes>, cancel(), progress() }.
  downloadToFile({ url, relink, name, username, userId }, filePath) {
    const fs = require('fs');
    const { EventEmitter } = require('events');

    const token = encryption.generateStreamToken(userId, url, { id: 'recording', name, type: 'ARCHIVE' }, username);
    token.archive = { relink, filename: name };

    const control = new EventEmitter(); // stands in for the client connection
    let total = 0;
    let out = null;

    const done = (async () => {
      try {
        total = await this.probeArchiveSize(url);
      } catch (error) {
        total = await this.probeArchiveSize(await this.relinkArchive(token));
      }
      token.archive.totalBytes = total;

      const first = await this.openFile(token, 0, total - 1);

      return new Promise((resolve, reject) => {
        out = fs.createWriteStream(filePath);
        let finished = false;

        out.on('finish', () => { finished = true; resolve(total); });
        out.on('close', () => { if (!finished) reject(new Error('Download interrupted')); });
        out.on('error', (error) => reject(error));

        this.pipeFile(token, control, out, first, 0, total - 1);
      });
    })();

    return {
      done,
      progress: () => ({ total, written: out ? out.bytesWritten : 0 }),
      cancel: () => {
        control.emit('close');
        if (out) out.destroy();
      }
    };
  }

  // Subtitle lines gathered so far for a file token, from line number `after`
  getCues(tokenId, after = 0) {
    const token = this.streamTokens.get(tokenId);

    if (!token || Date.now() > token.expiresAt || !token.archive) return null;

    const subtitles = token.archive.subtitles || { status: 'none', cues: [] };
    const from = Math.max(0, parseInt(after, 10) || 0);

    return {
      status: subtitles.status,
      language: subtitles.language || null,
      total: subtitles.cues.length,
      complete: !!subtitles.complete,
      cues: subtitles.cues.slice(from)
    };
  }

  cleanupTokens() {
    const now = Date.now();

    for (const [tokenId, token] of this.streamTokens.entries()) {
      if (now > token.expiresAt) {
        this.streamTokens.delete(tokenId);
      }
    }
  }
}

module.exports = new StreamService();
