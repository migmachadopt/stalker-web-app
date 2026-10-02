// ═══════════════════════════════════════════════════════════════════════════════
// 🌐 API Communication Module
// ═══════════════════════════════════════════════════════════════════════════════

const API_URL = window.API_URL || (
  window.location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:3001/api'
    : '/api'
);

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
  // The portal session id is kept here; when the server no longer has it
  // (restart, idle timeout) the call reconnects and is retried once.
  iptvSessionId: '',
  _connecting: null,
  
  async iptvConnect() {
    if (!this._connecting) {
      this._connecting = this.fetch('/iptv/connect', { method: 'POST' })
        .then(data => {
          if (data.success) this.iptvSessionId = data.sessionId;
          return data;
        })
        .finally(() => { this._connecting = null; });
    }
    return this._connecting;
  },
  
  async iptvCall(endpoint, body = {}) {
    const send = () => this.fetch(endpoint, { 
      method: 'POST', 
      body: JSON.stringify({ sessionId: this.iptvSessionId, ...body }) 
    });
    
    let data = await send();
    
    if (!data.success && data.error === 'Invalid IPTV session') {
      const connect = await this.iptvConnect();
      if (!connect.success) return connect;
      data = await send();
    }
    
    return data;
  },
  
  async iptvGetChannels(refresh = false) {
    return this.iptvCall('/iptv/channels', { refresh });
  },
  
  async iptvGetStream(channelId) {
    return this.iptvCall('/iptv/stream', { channelId });
  },
  
  async iptvGetEpg(channelId, date) {
    return this.iptvCall('/iptv/epg', { channelId, date });
  },
  
  // Recorded programmes matching `query`, for one day and up to 20 channels
  async iptvSearchEpg(query, date, channelIds) {
    return this.iptvCall('/iptv/epg/search', { query, date, channelIds });
  },
  
  // Programme on air (first) and the next ones
  async iptvGetNow(channelId) {
    return this.iptvCall('/iptv/epg/now', { channelId });
  },
  
  // window: { date, programId, start?, duration?, title }
  async iptvGetArchiveStream(channelId, window) {
    return this.iptvCall('/iptv/archive/stream', { channelId, ...window });
  },
  
  // Video club ('vod') and series ('series')
  async vodCategories(type) {
    return this.iptvCall('/iptv/vod/categories', { type });
  },
  
  // query: { category, page, search }
  async vodList(type, query) {
    return this.iptvCall('/iptv/vod/list', { type, ...query });
  },
  
  async vodSeasons(seriesId) {
    return this.iptvCall('/iptv/vod/seasons', { seriesId });
  },
  
  // title: { cmd, episode?, title }
  async vodStream(type, title) {
    return this.iptvCall('/iptv/vod/stream', { type, ...title });
  },
  
  async iptvWatchdog() {
    return this.iptvCall('/iptv/watchdog');
  },
  
  async iptvDisconnect() {
    const sessionId = this.iptvSessionId;
    this.iptvSessionId = '';
    if (!sessionId) return { success: true };
    return this.fetch('/iptv/disconnect', { 
      method: 'POST', 
      body: JSON.stringify({ sessionId }) 
    });
  }
};

// Export for use in HTML
window.api = api;
