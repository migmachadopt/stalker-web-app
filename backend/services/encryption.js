// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 Encryption & Security Service
// ═══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const config = require('../config/constants');

class EncryptionService {
  encrypt(text) {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(config.ENCRYPTION_KEY, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      iv: iv.toString('hex'),
      encryptedData: encrypted,
      authTag: authTag.toString('hex')
    };
  }

  decrypt(encryptedObj) {
    const key = crypto.scryptSync(config.ENCRYPTION_KEY, 'salt', 32);
    const iv = Buffer.from(encryptedObj.iv, 'hex');
    const authTag = Buffer.from(encryptedObj.authTag, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedObj.encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { salt, hash };
  }

  verifyPassword(password, salt, storedHash) {
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
  }

  generateAuthToken(userId, role) {
    const payload = {
      userId,
      role,
      iat: Date.now(),
      exp: Date.now() + config.TOKEN_EXPIRY
    };
    
    const payloadStr = JSON.stringify(payload);
    const payloadB64 = Buffer.from(payloadStr).toString('base64url');
    
    const signature = crypto
      .createHmac('sha256', config.JWT_SECRET)
      .update(payloadB64)
      .digest('base64url');
    
    return `${payloadB64}.${signature}`;
  }

  verifyAuthToken(token) {
    try {
      const [payloadB64, signature] = token.split('.');
      
      const expectedSignature = crypto
        .createHmac('sha256', config.JWT_SECRET)
        .update(payloadB64)
        .digest('base64url');
      
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        return null;
      }
      
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
      
      if (payload.exp < Date.now()) {
        return null;
      }
      
      return payload;
    } catch (error) {
      return null;
    }
  }

  generateStreamToken(userId, streamUrl, channelInfo, username) {
    const tokenId = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + config.STREAM_TOKEN_EXPIRY;
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(config.STREAM_SECRET.substring(0, 32)), iv);
    let encrypted = cipher.update(streamUrl, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return {
      tokenId,
      userId,
      username,
      encryptedUrl: encrypted,
      iv: iv.toString('hex'),
      expiresAt,
      usedCount: 0,
      maxUses: config.STREAM_TOKEN_MAX_USES,
      channelInfo,
      createdAt: Date.now()
    };
  }

  decryptStreamUrl(encryptedUrl, iv) {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(config.STREAM_SECRET.substring(0, 32)),
      Buffer.from(iv, 'hex')
    );
    
    let streamUrl = decipher.update(encryptedUrl, 'hex', 'utf8');
    streamUrl += decipher.final('utf8');
    
    return streamUrl;
  }
}

module.exports = new EncryptionService();
