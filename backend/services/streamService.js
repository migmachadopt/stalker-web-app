// ═══════════════════════════════════════════════════════════════════════════════
// 🎬 Stream Service - FFmpeg Video Streaming
// ═══════════════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
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
    
    if (token.usedCount >= token.maxUses) {
      logger.warn('token', 'Token max uses reached', { 
        tokenId: tokenId.substring(0, 8),
        uses: `${token.usedCount}/${token.maxUses}`
      });
    }
    
    token.usedCount++;
    return token;
  }

  async testStreamUrl(streamUrl) {
    try {
      const response = await axios.head(streamUrl, {
        timeout: 5000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500
      });
      
      return {
        accessible: true,
        status: response.status,
        contentType: response.headers['content-type']
      };
    } catch (error) {
      return {
        accessible: false,
        error: error.message
      };
    }
  }

  createFFmpegProcess(streamUrl) {
    return spawn('ffmpeg', [
      '-user_agent', 'Lavf/56.40.101',
      '-i', streamUrl,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-c:a', 'aac',
      '-ac', '2',
      '-ar', '48000',
      '-b:a', '128k',
      '-f', 'flv',
      '-'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  async handleStream(tokenId, req, res) {
    let ffmpegProcess = null;
    let streamSessionId = null;
    
    try {
      const token = this.validateStreamToken(tokenId);
      
      if (!token) {
        return res.status(401).send('Unauthorized');
      }
      
      // Decrypt stream URL
      const streamUrl = encryption.decryptStreamUrl(token.encryptedUrl, token.iv);
      const channelInfo = token.channelInfo;
      
      // Create stream session for logging
      streamSessionId = `${tokenId}_${Date.now()}`;
      const streamSession = logger.createStreamSession(
        streamSessionId,
        token.userId,
        token.username,
        channelInfo.id,
        channelInfo.name
      );
      
      logger.updateStreamSession(streamSessionId, {
        streamUrl: streamUrl.substring(0, 60) + '...',
        streamType: channelInfo.type
      });
      
      // Test URL accessibility
      const urlTest = await this.testStreamUrl(streamUrl);
      
      if (!urlTest.accessible) {
        logger.logStreamEvent(streamSessionId, 'Source not accessible', {
          error: urlTest.error
        });
        return res.status(502).send('Source unavailable');
      }
      
      logger.logStreamEvent(streamSessionId, 'Source accessible', {
        status: urlTest.status,
        contentType: urlTest.contentType
      });
      
      // Start FFmpeg
      logger.logStreamEvent(streamSessionId, 'Starting FFmpeg transcoding');
      
      ffmpegProcess = this.createFFmpegProcess(streamUrl);
      
      // FFmpeg stderr parsing
      let ffmpegStarted = false;
      
      ffmpegProcess.stderr.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
          line = line.trim();
          if (!line) return;
          logger.parseFFmpegOutput(streamSessionId, line);
          
          if (!ffmpegStarted && line.includes('frame=') && line.includes('fps=')) {
            ffmpegStarted = true;
          }
        });
      });
      
      // Response headers
      res.set('Content-Type', 'video/x-flv');
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.set('Connection', 'keep-alive');
      res.set('Transfer-Encoding', 'chunked');
      
      logger.logStreamEvent(streamSessionId, 'Response headers sent');
      
      // Pipe output
      ffmpegProcess.stdout.pipe(res);
      
      // FFmpeg process events
      ffmpegProcess.on('error', (err) => {
        logger.logStreamEvent(streamSessionId, 'FFmpeg spawn error', { error: err.message });
      });
      
      ffmpegProcess.on('close', (code) => {
        const duration = Math.round((Date.now() - streamSession.startTime) / 1000);
        logger.logStreamEvent(streamSessionId, 'FFmpeg closed', { 
          code,
          duration: `${duration}s`
        });
      });
      
      // Client disconnect
      req.on('close', () => {
        logger.logStreamEvent(streamSessionId, 'Client disconnected');
        if (ffmpegProcess && !ffmpegProcess.killed) {
          ffmpegProcess.kill('SIGTERM');
          setTimeout(() => {
            if (!ffmpegProcess.killed) {
              ffmpegProcess.kill('SIGKILL');
            }
          }, 2000);
        }
      });
      
    } catch (error) {
      if (streamSessionId) {
        logger.logStreamEvent(streamSessionId, 'Stream error', { error: error.message });
      } else {
        logger.error('stream', 'Stream error', { error: error.message });
      }
      
      if (ffmpegProcess && !ffmpegProcess.killed) {
        ffmpegProcess.kill('SIGTERM');
      }
      
      if (!res.headersSent) {
        res.status(500).send('Stream error');
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
