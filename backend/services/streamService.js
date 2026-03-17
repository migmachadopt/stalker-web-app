// ═══════════════════════════════════════════════════════════════════════════════
// 🎬 Stream Service - HTTP Passthrough Proxy
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const config = require('../config/constants');
const encryption = require('./encryption');
const logger = require('../utils/logger');

class StreamService {
  constructor() {
    this.streamTokens = new Map();

    // Cleanup old tokens periodically
    setInterval(() => this.cleanupTokens(), 70000);
  }

  generateStreamToken(userId, streamUrl, channelInfo, username) {
    const token = encryption.generateStreamToken(userId, streamUrl, channelInfo, username);

    this.streamTokens.set(token.tokenId, token);

    logger.info('token', 'Stream token generated', {
      tokenId: token.tokenId.substring(0, 8),
      user: username,
      channel: channelInfo.name,
      expiresIn: '60s'
    });

    // Auto-cleanup after expiry
    setTimeout(() => {
      if (this.streamTokens.delete(token.tokenId)) {
        logger.debug('token', 'Token expired and removed', {
          tokenId: token.tokenId.substring(0, 8)
        });
      }
    }, 70000);

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

  async handleStream(tokenId, req, res) {
    let upstreamResponse = null;

    try {
      const token = this.validateStreamToken(tokenId);

      if (!token) {
        return res.status(401).send('Unauthorized');
      }

      // Decrypt real stream URL
      const streamUrl = encryption.decryptStreamUrl(token.encryptedUrl, token.iv);
      const channelInfo = token.channelInfo;

      logger.info('stream', `${token.username} - Starting passthrough proxy`, {
        channel: channelInfo.name,
        url: streamUrl.substring(0, 60) + '...'
      });

      // Fetch stream from upstream without transcoding
      upstreamResponse = await axios({
        method: 'GET',
        url: streamUrl,
        responseType: 'stream',
        timeout: 15000,
        headers: {
          'User-Agent': config.STALKER_HEADERS['User-Agent'],
        },
        maxRedirects: 5,
      });

      const contentType = upstreamResponse.headers['content-type'] || 'video/mp2t';

      res.set('Content-Type', contentType);
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Connection', 'keep-alive');

      if (upstreamResponse.headers['content-length']) {
        res.set('Content-Length', upstreamResponse.headers['content-length']);
      }

      // Pipe raw bytes directly to the browser — no transcoding
      upstreamResponse.data.pipe(res);

      // Cleanup when client disconnects
      req.on('close', () => {
        logger.info('stream', `${token.username} - Client disconnected`, {
          channel: channelInfo.name
        });
        upstreamResponse.data.destroy();
      });

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
