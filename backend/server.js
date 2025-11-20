const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function getStalkerHeaders(token = '', macAddress = '') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2738 Mobile Safari/533.3',
    'X-User-Agent': 'Model: MAG254; Link: Ethernet',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (macAddress) {
    // Gerar um serial number único baseado no MAC
    const sn = '93200916082029478'; // Pode ser fixo ou gerado
    headers['Cookie'] = `PHPSESSID=null; sn=${sn}; mac=${macAddress}; timezone=Europe/Lisbon; stb_lang=en`;
  }

  return headers;
}

async function discoverPortalPath(baseUrl, macAddress) {
  console.log(`\n🔍 Discovering portal path for: ${baseUrl}`);
  
  const possiblePaths = [
    '/portal.php',
    '/stalker_portal/server/load.php',
    '/server/load.php',
    '/stalker_portal/c/portal.php',
    '/c/portal.php',
    '',
  ];

  // Primeiro tentar paths comuns
  for (const path of possiblePaths) {
    const testUrl = `${baseUrl}${path}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`;
    
    console.log(`   🧪 Testing: ${baseUrl}${path}`);
    
    try {
      const response = await axios.get(testUrl, {
        headers: getStalkerHeaders('', macAddress),
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500,
      });

      if (response.status === 200 && response.data && response.data.js && response.data.js.token) {
        console.log(`   ✅ Found working path: ${path || '(root)'}`);
        return {
          path: path,
          fullUrl: `${baseUrl}${path}`,
          token: response.data.js.token,
          response: response.data
        };
      }
    } catch (error) {
      console.log(`   ❌ Failed: ${error.message}`);
    }
  }

  // Se não encontrou, tentar descobrir path com hash (ex: /rbyo067ta9ov/portal.php)
  console.log(`   🔍 Trying to discover hashed path...`);
  try {
    // Fazer request à raiz e procurar por redirects ou hints
    const rootResponse = await axios.get(baseUrl, {
      headers: getStalkerHeaders('', macAddress),
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: () => true,
    });

    // Verificar se há redirect com path
    const location = rootResponse.headers.location || rootResponse.headers.Location;
    if (location && location.includes('portal.php')) {
      const match = location.match(/\/([^\/]+\/portal\.php)/);
      if (match) {
        const discoveredPath = '/' + match[1];
        console.log(`   🔍 Discovered hashed path: ${discoveredPath}`);
        
        const testUrl = `${baseUrl}${discoveredPath}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`;
        const testResponse = await axios.get(testUrl, {
          headers: getStalkerHeaders('', macAddress),
          timeout: 10000,
        });

        if (testResponse.data && testResponse.data.js && testResponse.data.js.token) {
          console.log(`   ✅ Hashed path works!`);
          return {
            path: discoveredPath,
            fullUrl: `${baseUrl}${discoveredPath}`,
            token: testResponse.data.js.token,
            response: testResponse.data
          };
        }
      }
    }
  } catch (error) {
    console.log(`   ⚠️  Could not discover hashed path: ${error.message}`);
  }

  return null;
}

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Backend is running!',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/handshake', async (req, res) => {
  try {
    let { portalUrl, macAddress } = req.body;

    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║            NEW HANDSHAKE REQUEST                       ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log(`📍 Base URL (input): ${portalUrl}`);
    console.log(`🔑 MAC Address: ${macAddress}`);

    if (!portalUrl || !macAddress) {
      return res.status(400).json({ 
        success: false,
        error: 'Portal URL and MAC address are required' 
      });
    }

    const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
    if (!macRegex.test(macAddress)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid MAC address format' 
      });
    }

    let baseUrl = portalUrl
      .replace(/\/$/, '')
      .replace(/\/portal\.php.*$/, '')
      .replace(/\/stalker_portal.*$/, '')
      .replace(/\/server.*$/, '')
      .replace(/\/c\/?$/, '');

    console.log(`🧹 Cleaned base URL: ${baseUrl}`);

    console.log('\n🔄 Checking for redirects...');
    try {
      const checkRedirect = await axios.get(baseUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status < 400,
        timeout: 10000,
      });

      if (checkRedirect.status === 301 || checkRedirect.status === 302) {
        const redirectUrl = checkRedirect.headers.location || checkRedirect.headers.Location;
        if (redirectUrl) {
          baseUrl = redirectUrl.replace(/\/$/, '');
          console.log(`🔄 Redirect: ${portalUrl} → ${baseUrl}`);
        }
      }
    } catch (error) {
      if (error.response && (error.response.status === 301 || error.response.status === 302)) {
        const redirectUrl = error.response.headers.location || error.response.headers.Location;
        if (redirectUrl) {
          baseUrl = redirectUrl.replace(/\/$/, '');
          console.log(`🔄 Redirect: ${portalUrl} → ${baseUrl}`);
        }
      }
    }

    console.log(`✅ Final base URL: ${baseUrl}`);

    const discovery = await discoverPortalPath(baseUrl, macAddress);

    if (!discovery) {
      return res.status(500).json({
        success: false,
        error: 'Could not find working portal endpoint',
        suggestions: [
          'Verify the base URL is correct',
          'Check if your MAC address is registered',
          'Contact your IPTV provider'
        ]
      });
    }

    const fullPortalUrl = discovery.fullUrl;
    const token = discovery.token;

    console.log(`✅ Portal: ${discovery.path || '(root)'}`);
    console.log(`✅ Token: ${token.substring(0, 30)}...`);

    const sessionId = generateToken();
    sessions.set(sessionId, {
      baseUrl: baseUrl,
      portalUrl: fullPortalUrl,
      portalPath: discovery.path,
      macAddress,
      token,
      createdAt: Date.now(),
    });

    console.log(`💾 Session: ${sessionId.substring(0, 20)}...`);
    
    // 🆕 Buscar géneros/categorias - tentar vários endpoints
    console.log(`🔄 Fetching channel genres...`);
    let genres = [];
    
    const genreEndpoints = [
      `${fullPortalUrl}?type=itv&action=get_genres&JsHttpRequest=1-xml`,
      `${fullPortalUrl}?type=itv&action=get_all_genres&JsHttpRequest=1-xml`,
      `${fullPortalUrl}?type=stb&action=get_genres&JsHttpRequest=1-xml`,
    ];
    
    for (const genresUrl of genreEndpoints) {
      try {
        console.log(`   🧪 Trying: ${genresUrl.split('?')[1]?.substring(0, 50)}...`);
        const genresResponse = await axios.get(genresUrl, {
          headers: getStalkerHeaders(token, macAddress),
          timeout: 10000,
        });
        
        const genresData = genresResponse.data?.js;
        
        // Debug: ver estrutura da resposta
        console.log(`   📋 Response type: ${typeof genresData}, isArray: ${Array.isArray(genresData)}`);
        
        if (Array.isArray(genresData) && genresData.length > 0) {
          genres = genresData;
          console.log(`   ✅ Found ${genres.length} genres!`);
          break;
        } else if (genresData && typeof genresData === 'object' && !Array.isArray(genresData) && genresData !== true) {
          // Pode ser objeto com dados
          if (genresData.data && Array.isArray(genresData.data)) {
            genres = genresData.data;
            console.log(`   ✅ Found ${genres.length} genres in .data!`);
            break;
          }
          // Tentar converter objeto para array
          const values = Object.values(genresData);
          if (values.length > 0 && typeof values[0] === 'object') {
            genres = values;
            console.log(`   ✅ Found ${genres.length} genres from object values!`);
            break;
          }
        }
      } catch (error) {
        console.log(`   ❌ Failed: ${error.message}`);
      }
    }
    
    if (genres.length > 0) {
      console.log(`📋 Genres found:`);
      genres.slice(0, 20).forEach(g => {
        const id = g?.id || g?.genre_id || g?.gid;
        const title = g?.title || g?.name || g?.genre_name;
        if (id && title) console.log(`   - ${id}: ${title}`);
      });
    } else {
      console.log(`⚠️ No genres found - will extract from channels later`);
    }
    
    // Guardar na sessão
    sessions.get(sessionId).genres = genres;
    
    console.log('✅ AUTHENTICATION SUCCESSFUL!\n');

    res.json({
      success: true,
      sessionId,
      message: 'Successfully connected!',
      portalInfo: {
        baseUrl: baseUrl,
        fullUrl: fullPortalUrl,
        detectedPath: discovery.path || '(root)'
      },
      genres: Array.isArray(genres) ? genres.map(g => ({
        id: g?.id || g?.genre_id,
        title: g?.title || g?.name || 'Unknown',
        alias: g?.alias || '',
      })) : []
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Unexpected Error',
      details: error.message
    });
  }
});

// 🆕 Get channel genres/groups
app.post('/api/genres', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(401).json({ success: false, error: 'Invalid session' });
    }

    const session = sessions.get(sessionId);
    
    console.log(`🔄 Fetching channel genres/groups...`);
    
    const genresUrl = `${session.portalUrl}?type=itv&action=get_genres&JsHttpRequest=1-xml`;
    
    const response = await axios.get(genresUrl, {
      headers: getStalkerHeaders(session.token, session.macAddress),
      timeout: 30000,
      maxRedirects: 5,
    });

    const genres = response.data?.js || [];
    
    console.log(`📋 Genres response:`);
    console.log(JSON.stringify(genres, null, 2));
    
    res.json({
      success: true,
      genres: genres
    });

  } catch (error) {
    console.error('❌ Genres Error:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch genres',
      details: error.message 
    });
  }
});

app.post('/api/channels', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(401).json({ success: false, error: 'Invalid session' });
    }

    const session = sessions.get(sessionId);
    
    // ⭐ STEP 1: Get Profile (CRITICAL!)
    console.log(`🔄 Step 1: Getting profile...`);
    const profileUrl = `${session.portalUrl}?type=stb&action=get_profile&JsHttpRequest=1-xml`;
    
    const profileResponse = await axios.get(profileUrl, {
      headers: getStalkerHeaders(session.token, session.macAddress),
      timeout: 15000,
      maxRedirects: 5,
    });
    
    const profileId = profileResponse.data?.js?.id;
    console.log(`✅ Profile ID: ${profileId}`);
    
    // ⭐ STEP 2: Get ALL channels with pagination
    console.log(`🔄 Step 2: Getting channels...`);
    
    let allChannels = [];
    let page = 1;
    let totalItems = 0;
    let hasMorePages = true;
    
    // Buscar primeira página para saber o total
    const firstPageUrl = `${session.portalUrl}?type=itv&action=get_ordered_list&genre=*&force_ch_link_check=&fav=0&sortby=number&hd=0&p=${page}&JsHttpRequest=1-xml`;
    
    const firstResponse = await axios.get(firstPageUrl, {
      headers: getStalkerHeaders(session.token, session.macAddress),
      timeout: 30000,
      maxRedirects: 5,
    });
    
    totalItems = firstResponse.data?.js?.total_items || 0;
    const firstPageChannels = firstResponse.data?.js?.data || [];
    allChannels = firstPageChannels;
    
    console.log(`📊 Total available: ${totalItems}, got ${allChannels.length} on page 1`);
    
    // Log estrutura completa do primeiro canal para debug
    if (firstPageChannels.length > 0) {
      console.log(`\n📋 ═══════════════════════════════════════════════════════`);
      console.log(`📋 ESTRUTURA COMPLETA DO PRIMEIRO CANAL:`);
      console.log(`📋 ═══════════════════════════════════════════════════════`);
      console.log(JSON.stringify(firstPageChannels[0], null, 2));
      console.log(`\n📋 CAMPOS DISPONÍVEIS: ${Object.keys(firstPageChannels[0]).join(', ')}`);
      console.log(`📋 ═══════════════════════════════════════════════════════\n`);
    }
    
    // Log estrutura da resposta completa
    const responseKeys = Object.keys(firstResponse.data?.js || {});
    console.log(`📋 Response keys: ${responseKeys.join(', ')}`);
    
    // Continuar buscando enquanto houver canais E não tivermos todos
    page = 2;
    const maxPages = 100; // Aumentado para suportar mais canais (100 * 14 = 1400)
    
    while (hasMorePages && allChannels.length < totalItems && page <= maxPages) {
      console.log(`📄 Fetching page ${page}... (current: ${allChannels.length}/${totalItems})`);
      
      const pageUrl = `${session.portalUrl}?type=itv&action=get_ordered_list&genre=*&force_ch_link_check=&fav=0&sortby=number&hd=0&p=${page}&JsHttpRequest=1-xml`;
      
      try {
        const pageResponse = await axios.get(pageUrl, {
          headers: getStalkerHeaders(session.token, session.macAddress),
          timeout: 30000,
          maxRedirects: 5,
        });
        
        const pageChannels = pageResponse.data?.js?.data || [];
        
        if (pageChannels.length === 0) {
          console.log(`   ⚠️  No more channels on page ${page}, stopping`);
          hasMorePages = false;
        } else {
          allChannels = allChannels.concat(pageChannels);
          console.log(`   ✅ Page ${page}: +${pageChannels.length} channels (total: ${allChannels.length}/${totalItems})`);
          page++;
        }
      } catch (error) {
        console.error(`   ❌ Error on page ${page}:`, error.message);
        hasMorePages = false;
      }
    }
    
    console.log(`✅ Total channels loaded: ${allChannels.length} / ${totalItems}`);

    // 🆕 Extrair géneros únicos dos canais
    const genreIds = [...new Set(allChannels.map(ch => ch.tv_genre_id).filter(id => id !== undefined && id !== null))];
    console.log(`📋 Unique genre IDs found: ${genreIds.join(', ')}`);
    
    // Contar canais por género
    const genreCounts = {};
    allChannels.forEach(ch => {
      const gid = ch.tv_genre_id || 'unknown';
      genreCounts[gid] = (genreCounts[gid] || 0) + 1;
    });
    console.log(`📋 Channels per genre:`, genreCounts);

    res.json({
      success: true,
      total: totalItems,
      loaded: allChannels.length,
      channels: allChannels.map(ch => ({
        id: ch.id,
        name: ch.name,
        number: ch.number,
        logo: ch.logo,
        cmd: ch.cmd,
        tv_genre_id: ch.tv_genre_id,
        genres_str: ch.genres_str || '',
        hd: ch.hd === "1" || ch.hd === 1,
        archive: ch.archive === 1 || ch.enable_tv_archive === 1,
        archive_duration: ch.tv_archive_duration || 0,
      }))
    });

  } catch (error) {
    console.error('❌ Channels Error:', error.message);
    console.error('Full error:', error.response?.data || error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch channels',
      details: error.message 
    });
  }
});

app.post('/api/stream', async (req, res) => {
  try {
    const { sessionId, channelId, cmd } = req.body;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(401).json({ success: false, error: 'Invalid session' });
    }

    const session = sessions.get(sessionId);
    const createLinkUrl = `${session.portalUrl}?type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&series=&JsHttpRequest=1-xml`;

    console.log(`🔄 Creating stream link for channel ${channelId}...`);

    const response = await axios.get(createLinkUrl, {
      headers: getStalkerHeaders(session.token, session.macAddress),
      timeout: 15000,
      maxRedirects: 5,
    });

    let streamUrl = response.data?.js?.cmd || response.data?.js || '';
    
    // 🧹 Limpar prefixos indesejados (ffmpeg, etc)
    if (typeof streamUrl === 'string') {
      streamUrl = streamUrl
        .replace(/^ffmpeg\s+/i, '')
        .replace(/^ffmpeg:/i, '')
        .replace(/^ffprobe\s+/i, '')
        .replace(/^vlc\s+/i, '')
        .trim();
    }
    
    console.log(`✅ Stream URL: ${streamUrl.substring(0, 100)}...`);

    // 🔄 NÃO converter .ts para .m3u8!
    // O servidor faz redirect 302 automaticamente
    const proxyUrl = `http://localhost:3001/api/proxy?url=${encodeURIComponent(streamUrl)}`;

    res.json({
      success: true,
      streamUrl: proxyUrl,
      originalUrl: streamUrl,
      channelId
    });

  } catch (error) {
    console.error('❌ Stream Error:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get stream',
      details: error.message 
    });
  }
});

// 🆕 Proxy endpoint para contornar CORS
app.get('/api/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).send('URL parameter required');
    }

    console.log(`🔄 Proxying: ${url.substring(0, 100)}...`);

    // Headers para simular player real (FFmpeg/Lavf)
    const playerHeaders = {
      'User-Agent': 'Lavf/56.40.101',
      'Icy-MetaData': '1',
      'Accept-Encoding': 'identity',
      'Connection': 'Keep-Alive',
    };

    try {
      console.log(`   🧪 Trying original URL (will follow 302 redirects)...`);

      // Configurar axios para capturar URL final após redirects
      let finalUrl = url;
      const axiosConfig = {
        responseType: 'stream',
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: (status) => status === 200,
        headers: playerHeaders,
        beforeRedirect: (options, responseDetails) => {
          // Capturar URL final após redirect
          finalUrl = options.href || options.url;
          console.log(`   🔄 Redirected to: ${finalUrl.substring(0, 100)}...`);
        }
      };

      const response = await axios.get(url, axiosConfig);

      console.log(`   ✅ Success! Final URL: ${finalUrl.substring(0, 100)}...`);
      console.log(`   📋 Response Headers:`, {
        'content-type': response.headers['content-type'],
        'content-length': response.headers['content-length'],
        'location': response.headers['location']
      });
      
      // Verificar se é m3u8
      const contentType = response.headers['content-type'] || '';
      
      if (contentType.includes('mpegurl') || contentType.includes('m3u8') || finalUrl.includes('.m3u8')) {
        console.log(`   📋 It's an M3U8 playlist, processing...`);
        
        // Ler todo o conteúdo
        let content = '';
        response.data.on('data', chunk => content += chunk);
        await new Promise((resolve, reject) => {
          response.data.on('end', resolve);
          response.data.on('error', reject);
        });

        // Usar finalUrl (após redirect) como base
        const baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
        
        content = content.replace(/(^[^#\n][^\n]*)/gm, (match) => {
          match = match.trim();
          if (!match || match.startsWith('#')) return match;
          
          if (match.startsWith('http')) {
            return `http://localhost:3001/api/proxy?url=${encodeURIComponent(match)}`;
          } else {
            const fullUrl = baseUrl + match;
            return `http://localhost:3001/api/proxy?url=${encodeURIComponent(fullUrl)}`;
          }
        });

        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Headers', '*');
        res.set('Cache-Control', 'no-cache'); // Não cachear playlists
        return res.send(content);
      } else {
        // ⭐ Stream MPEG-TS contínuo - fazer pipe direto
        console.log(`   🎬 Streaming MPEG-TS data directly...`);
        res.set('Content-Type', 'video/mp2t');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Headers', '*');
        res.set('Cache-Control', 'no-cache');
        res.set('Connection', 'keep-alive');
        res.set('Transfer-Encoding', 'chunked');
        return response.data.pipe(res);
      }

    } catch (error) {
      console.error(`   ❌ Failed: ${error.message}`);
      
      // Se o URL original falhou com 404, pode ser que o token expirou
      if (error.response?.status === 404) {
        console.error(`   ⚠️  Token may have expired (404). Original URL no longer valid.`);
      }
      
      throw error;
    }

  } catch (error) {
    console.error('❌ Proxy Error:', error.message);
    console.error('   This usually means the play_token expired or is single-use only.');
    res.status(error.response?.status || 500).send('Proxy error: ' + error.message);
  }
});

// Cleanup de sessões antigas (1 hora)
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > oneHour) {
      sessions.delete(sessionId);
      console.log(`🧹 Cleaned expired session: ${sessionId.substring(0, 20)}...`);
    }
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║    🚀 Stalker IPTV Backend - FIXED VERSION 🚀        ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\n📡 Server: http://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/api/health`);
  console.log(`\n✨ Features:`);
  console.log(`   • Auto-discovers portal endpoints`);
  console.log(`   • Calls get_profile before fetching channels (FIXED!)`);
  console.log(`   • Supports 1000+ channels\n`);
});