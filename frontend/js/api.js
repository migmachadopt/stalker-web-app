// ═══════════════════════════════════════════════════════════════════════════════
// 🌐 API Communication Module
// ═══════════════════════════════════════════════════════════════════════════════

const API_URL = window.API_URL || 'http://localhost:3001/api';

const api = {
  token: localStorage.getItem('authToken'),
  
  setToken(token) { 
    this.token = token; 
    token ? localStorage.setItem('authToken', token) : localStorage.removeItem('authToken'); 
  },
  
  async fetch(endpoint, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    
    try {
      const response = await fetch(`${API_URL}${endpoint}`, { ...options, headers });
      const data = await response.json();
      
      if (response.status === 401) { 
        this.setToken(null); 
        window.location.reload(); 
      }
      
      return data;
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  },
  
  // Auth
  async login(username, password) {
    return this.fetch('/auth/login', { 
      method: 'POST', 
      body: JSON.stringify({ username, password }) 
    });
  },
  
  async getMe() {
    return this.fetch('/auth/me');
  },
  
  async changePassword(currentPassword, newPassword) {
    return this.fetch('/auth/change-password', { 
      method: 'POST', 
      body: JSON.stringify({ currentPassword, newPassword }) 
    });
  },
  
  // IPTV
  async iptvConnect() {
    return this.fetch('/iptv/connect', { method: 'POST' });
  },
  
  async iptvGetGenres(sessionId, type = 'itv') {
    return this.fetch('/iptv/genres', { 
      method: 'POST', 
      body: JSON.stringify({ sessionId, type }) 
    });
  },
  
  async iptvGetChannels(sessionId) {
    return this.fetch('/iptv/channels', { 
      method: 'POST', 
      body: JSON.stringify({ sessionId }) 
    });
  },
  
  async iptvGetStream(sessionId, channelId, cmd, channelName) {
    return this.fetch('/iptv/stream', { 
      method: 'POST', 
      body: JSON.stringify({ sessionId, channelId, cmd, channelName }) 
    });
  },
  
  async iptvWatchdog(sessionId) {
    return this.fetch('/iptv/watchdog', { 
      method: 'POST', 
      body: JSON.stringify({ sessionId }) 
    });
  },
  
  async iptvDisconnect(sessionId) {
    return this.fetch('/iptv/disconnect', { 
      method: 'POST', 
      body: JSON.stringify({ sessionId }) 
    });
  }
};

// Export for use in HTML
window.api = api;
