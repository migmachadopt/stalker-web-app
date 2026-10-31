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
  
  // convert: 'audio' or 'full' asks the server to convert a channel the browser cannot play
  async iptvGetStream(channelId, convert = null) {
    return this.iptvCall('/iptv/stream', { channelId, ...(convert ? { convert } : {}) });
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
  
  // Library: recordings saved on the server, trimmed and converted to MP4
  async recordings() {
    return this.fetch('/recordings');
  },
  
  // window: { date, programId, start?, duration?, title }
  async recordingAdd(channelId, window) {
    return this.fetch('/recordings', { method: 'POST', body: JSON.stringify({ channelId, ...window }) });
  },
  
  // First and last frame to keep
  async recordingCut(id, startFrame, endFrame) {
    return this.fetch(`/recordings/${id}/cut`, { method: 'POST', body: JSON.stringify({ startFrame, endFrame }) });
  },
  
  async recordingCancel(id) {
    return this.fetch(`/recordings/${id}/cancel`, { method: 'POST' });
  },
  
  async recordingRetry(id) {
    return this.fetch(`/recordings/${id}/retry`, { method: 'POST' });
  },
  
  async recordingRemove(id) {
    return this.fetch(`/recordings/${id}`, { method: 'DELETE' });
  },
  
  // Discover: films and series from TMDB (lang: 'en' or 'pt')
  async discoverHome(lang) {
    return this.fetch(`/discover/home?lang=${lang}`);
  },
  
  async discoverList(id, page, lang) {
    return this.fetch(`/discover/list/${id}?page=${page}&lang=${lang}`);
  },
  
  async discoverSearch(query, page, lang, kind = '') {
    return this.fetch(`/discover/search?q=${encodeURIComponent(query)}&page=${page}&lang=${lang}${kind ? `&kind=${kind}` : ''}`);
  },
  
  async discoverTitle(kind, id, lang) {
    return this.fetch(`/discover/${kind === 'tv' ? 'tv' : 'movie'}/${id}?lang=${lang}`);
  },
  
  async discoverSeason(id, number, lang) {
    return this.fetch(`/discover/tv/${id}/season/${number}?lang=${lang}`);
  },
  
  // Torrents from Prowlarr for a film, or for one episode of a series
  async discoverSources(kind, id, season, episode) {
    const episodePart = kind === 'tv' ? `&season=${season}&episode=${episode}` : '';
    return this.fetch(`/discover/sources?kind=${kind}&id=${id}${episodePart}`);
  },
  
  // Hands a source to Real-Debrid; then ask how it is going until it is ready
  // (request: { kind, tmdbId, season, episode })
  async discoverPlay(source, request) {
    return this.fetch('/discover/play', {
      method: 'POST',
      body: JSON.stringify({ source, kind: request.kind, tmdbId: request.tmdbId, season: request.season, episode: request.episode })
    });
  },
  
  // The source played last for this film or episode, again
  async discoverContinue(request) {
    return this.fetch('/discover/continue', {
      method: 'POST',
      body: JSON.stringify({ kind: request.kind, tmdbId: request.tmdbId, season: request.season, episode: request.episode })
    });
  },
  
  // Seconds reached in a film or episode (kept on the server, for any device)
  async discoverPosition(request, position, duration) {
    return this.fetch('/discover/position', {
      method: 'PUT',
      body: JSON.stringify({ kind: request.kind, tmdbId: request.tmdbId, season: request.season, episode: request.episode, position, duration })
    });
  },
  
  // Subtitles for a film or episode (torrent: the one playing, to find those in sync)
  async discoverSubtitles(request, torrent, lang) {
    const episodePart = request.kind === 'tv' ? `&season=${request.season}&episode=${request.episode}` : '';
    return this.fetch(`/discover/subtitles?kind=${request.kind}&tmdbId=${request.tmdbId}${episodePart}&lang=${lang}${torrent ? `&torrent=${torrent}` : ''}`);
  },
  
  // Downloads one subtitle to the server; answers its address
  async discoverSubtitle(fileId) {
    return this.fetch(`/discover/subtitles/${fileId}`, { method: 'POST' });
  },
  
  // Sources played for a film, or for each episode of a series
  async discoverHistory(kind, id) {
    return this.fetch(`/discover/history/${kind}/${id}`);
  },
  
  async discoverPlayState(torrent, request) {
    const episodePart = request.kind === 'tv' ? `&season=${request.season}&episode=${request.episode}` : '';
    return this.fetch(`/discover/play/${torrent}?kind=${request.kind}${episodePart}`);
  },
  
  // Film or episode a recording is, from its IMDb or TMDB link
  async recordingLink(id, link) {
    return this.fetch(`/recordings/${id}/metadata`, { method: 'PUT', body: JSON.stringify({ link }) });
  },

  async recordingUnlink(id) {
    return this.fetch(`/recordings/${id}/metadata`, { method: 'DELETE' });
  },

  async recordingTicket(id) {
    return this.fetch(`/recordings/${id}/ticket`, { method: 'POST' });
  },
  
  // One frame of a downloaded recording (by frame number), as an object URL for an <img>
  async recordingFrame(id, frame) {
    const response = await fetch(`${API_URL}/recordings/${id}/frame?f=${Math.floor(frame)}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    if (!response.ok) throw new Error('Frame not available');
    return URL.createObjectURL(await response.blob());
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
