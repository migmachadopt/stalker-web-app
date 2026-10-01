// ═══════════════════════════════════════════════════════════════════════════════
// 🎬 Stream Service - HTTP Passthrough Proxy
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const config = require('../config/constants');
const encryption = require('./encryption');
const logger = require('../utils/logger');

const TS_PACKET_SIZE = 188;

class StreamService {
  constructor() {
    this.streamTokens = new Map();

    // Cleanup old tokens periodically
    setInterval(() => this.cleanupTokens(), 70000);
  }

  // `archive` (optional) turns the token into a seekable, downloadable archive
  // window: { duration (seconds), filename, relink (async () => fresh url) }
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
      logger.info('stream', `${token.username} - Client disconnected`, {
        channel: token.channelInfo.name
      });
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

  // Total size of the archive file, learned from a one-byte range request
  async probeArchiveSize(url) {
    const probe = await this.fetchUpstream(url, 'bytes=0-0');
    probe.data.destroy();

    const total = Number((probe.headers['content-range'] || '').split('/')[1]);

    if (probe.status >= 400 || !Number.isFinite(total) || total <= 0) {
      throw new Error(`Archive not available (upstream ${probe.status})`);
    }

    return total;
  }

  // Archive window: a fixed-size MPEG-TS file on the provider side.
  //   ?start=<seconds>  play from that position (mapped to a byte offset)
  //   ?download=1       send as a file attachment
  // Range requests from the client are honoured relative to the start offset.
  async handleArchive(token, req, res) {
    const archive = token.archive;
    let streamUrl = encryption.decryptStreamUrl(token.encryptedUrl, token.iv);

    if (!archive.totalBytes) {
      try {
        archive.totalBytes = await this.probeArchiveSize(streamUrl);
      } catch (error) {
        // The provider link may have expired - ask the portal for a new one, once
        if (!archive.relink) throw error;

        streamUrl = await archive.relink();
        const fresh = encryption.generateStreamToken(token.userId, streamUrl, token.channelInfo, token.username);
        token.encryptedUrl = fresh.encryptedUrl;
        token.iv = fresh.iv;
        archive.totalBytes = await this.probeArchiveSize(streamUrl);
      }
    }

    const total = archive.totalBytes;
    const startSeconds = Math.min(Math.max(Number(req.query.start) || 0, 0), archive.duration);

    // Bitrate is close to constant, so time maps to bytes; stay on a TS packet boundary
    const base = Math.min(
      Math.floor((startSeconds / archive.duration) * total / TS_PACKET_SIZE) * TS_PACKET_SIZE,
      Math.max(total - TS_PACKET_SIZE, 0)
    );
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

    logger.info('stream', `${token.username} - Starting archive proxy`, {
      channel: token.channelInfo.name,
      start: `${Math.round(startSeconds)}s`,
      download: req.query.download === '1'
    });

    const upstreamResponse = await this.fetchUpstream(streamUrl, `bytes=${base + from}-${base + to}`);

    if (upstreamResponse.status >= 400) {
      upstreamResponse.data.destroy();
      // Forget the size so the next request probes (and relinks) again
      archive.totalBytes = null;
      throw new Error(`Archive upstream responded ${upstreamResponse.status}`);
    }

    res.status(rangeMatch ? 206 : 200);
    res.set('Content-Type', 'video/mp2t');
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

    this.pipeToClient(upstreamResponse, req, res, token);
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
