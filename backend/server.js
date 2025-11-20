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
    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG254 stbapp ver: 2 rev: 250 Safari/533.3',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (macAddress) {
    headers['Cookie'] = `mac=${macAddress}; stb_lang=en_GB; timezone=Europe/Lisbon`;
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
    console.log('✅ AUTHENTICATION SUCCESSFUL!\n');

    res.json({
      success: true,
      sessionId,
      message: 'Successfully connected!',
      portalInfo: {
        baseUrl: baseUrl,
        fullUrl: fullPortalUrl,
        detectedPath: discovery.path || '(root)'
      }
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

app.post('/api/channels', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(401).json({ success: false, error: 'Invalid session' });
    }

    const session = sessions.get(sessionId);
    
    // Use get_ordered_list instead of get_all_channels
    const channelsUrl = `${session.portalUrl}?type=itv&action=get_ordered_list&genre=*&force_ch_link_check=&fav=0&sortby=number&hd=0&JsHttpRequest=1-xml`;

    console.log(`🔄 Fetching channels from: ${channelsUrl}`);

    const response = await axios.get(channelsUrl, {
      headers: getStalkerHeaders(session.token, session.macAddress),
      timeout: 30000,
      maxRedirects: 5,
    });

    const channels = response.data?.js?.data || [];
    const totalItems = response.data?.js?.total_items || 0;
    
    console.log(`✅ Found ${channels.length} channels (total: ${totalItems})`);

    res.json({
      success: true,
      total: totalItems,
      channels: channels.map(ch => ({
        id: ch.id,
        name: ch.name,
        number: ch.number,
        logo: ch.logo,
        cmd: ch.cmd,
        tv_genre_id: ch.tv_genre_id,
      }))
    });

  } catch (error) {
    console.error('❌ Channels Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch channels' });
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

    const response = await axios.get(createLinkUrl, {
      headers: getStalkerHeaders(session.token, session.macAddress),
      timeout: 15000,
      maxRedirects: 5,
    });

    const streamData = response.data?.js;

    res.json({
      success: true,
      streamUrl: streamData?.cmd || streamData,
      channelId
    });

  } catch (error) {
    console.error('❌ Stream Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to get stream' });
  }
});

setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > oneHour) {
      sessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║    🚀 Stalker IPTV Backend - FINAL VERSION 🚀        ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\n📡 http://localhost:${PORT}`);
  console.log(`\n✨ Auto-discovers portal endpoints`);
  console.log(`📝 Example: Input "http://ripana.top" → Finds "/portal.php"\n`);
});
