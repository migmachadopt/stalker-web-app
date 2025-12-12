// ═══════════════════════════════════════════════════════════════════════════════
// 👥 User Management Service
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const crypto = require('crypto');
const config = require('../config/constants');
const encryption = require('./encryption');
const logger = require('../utils/logger');

class UserService {
  constructor() {
    this.ensureDataDir();
  }

  ensureDataDir() {
    if (!fs.existsSync(config.DATA_DIR)) {
      fs.mkdirSync(config.DATA_DIR, { recursive: true });
    }
  }

  loadUsers() {
    try {
      if (!fs.existsSync(config.USERS_FILE)) {
        const defaultUsers = this.createDefaultAdmin();
        this.saveUsers(defaultUsers);
        return defaultUsers;
      }
      
      const encryptedData = JSON.parse(fs.readFileSync(config.USERS_FILE, 'utf8'));
      const decrypted = encryption.decrypt(encryptedData);
      return JSON.parse(decrypted);
    } catch (error) {
      logger.error('data', 'Error loading users', { error: error.message });
      const defaultUsers = this.createDefaultAdmin();
      this.saveUsers(defaultUsers);
      return defaultUsers;
    }
  }

  saveUsers(users) {
    const encrypted = encryption.encrypt(JSON.stringify(users));
    fs.writeFileSync(config.USERS_FILE, JSON.stringify(encrypted, null, 2));
  }

  createDefaultAdmin() {
    const { salt, hash } = encryption.hashPassword('admin123');
    return {
      users: [
        {
          id: crypto.randomUUID(),
          username: 'admin',
          passwordHash: hash,
          passwordSalt: salt,
          role: 'admin',
          portalUrl: '',
          macAddress: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastLogin: null,
          isActive: true
        }
      ]
    };
  }

  findUserById(userId) {
    const data = this.loadUsers();
    return data.users.find(u => u.id === userId);
  }

  findUserByUsername(username) {
    const data = this.loadUsers();
    return data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  }

  createUser(userData) {
    const data = this.loadUsers();
    
    // Check if username exists
    if (data.users.some(u => u.username.toLowerCase() === userData.username.toLowerCase())) {
      throw new Error('Username already exists');
    }
    
    const { salt, hash } = encryption.hashPassword(userData.password);
    
    const newUser = {
      id: crypto.randomUUID(),
      username: userData.username.trim(),
      passwordHash: hash,
      passwordSalt: salt,
      role: userData.role || 'user',
      portalUrl: userData.portalUrl || '',
      macAddress: userData.macAddress || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLogin: null,
      isActive: userData.isActive !== undefined ? userData.isActive : true
    };
    
    data.users.push(newUser);
    this.saveUsers(data);
    
    return newUser;
  }

  updateUser(userId, updates) {
    const data = this.loadUsers();
    const userIndex = data.users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      throw new Error('User not found');
    }
    
    const user = data.users[userIndex];
    
    // Update password if provided
    if (updates.password) {
      const { salt, hash } = encryption.hashPassword(updates.password);
      user.passwordHash = hash;
      user.passwordSalt = salt;
    }
    
    // Update other fields
    if (updates.username) user.username = updates.username.trim();
    if (updates.role) user.role = updates.role;
    if (updates.portalUrl !== undefined) user.portalUrl = updates.portalUrl;
    if (updates.macAddress !== undefined) user.macAddress = updates.macAddress;
    if (updates.isActive !== undefined) user.isActive = updates.isActive;
    
    user.updatedAt = new Date().toISOString();
    
    this.saveUsers(data);
    return user;
  }

  deleteUser(userId) {
    const data = this.loadUsers();
    const userIndex = data.users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      throw new Error('User not found');
    }
    
    data.users.splice(userIndex, 1);
    this.saveUsers(data);
  }

  updateLastLogin(userId) {
    const data = this.loadUsers();
    const user = data.users.find(u => u.id === userId);
    
    if (user) {
      user.lastLogin = new Date().toISOString();
      this.saveUsers(data);
    }
  }

  changePassword(userId, currentPassword, newPassword) {
    const user = this.findUserById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }
    
    if (!encryption.verifyPassword(currentPassword, user.passwordSalt, user.passwordHash)) {
      throw new Error('Current password is incorrect');
    }
    
    const { salt, hash } = encryption.hashPassword(newPassword);
    
    return this.updateUser(userId, {
      password: newPassword
    });
  }

  listUsers() {
    const data = this.loadUsers();
    return data.users.map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      hasPortalConfig: !!(u.portalUrl && u.macAddress),
      isActive: u.isActive,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin
    }));
  }
}

module.exports = new UserService();
