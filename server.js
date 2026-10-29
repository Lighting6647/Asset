const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = process.env.VERCEL ? path.join(os.tmpdir(), 'db.json') : path.join(__dirname, 'data', 'db.json');
const ACTION_PASSWORD = process.env.ACTION_PASSWORD || '664749';
const DASHBOARD_SYNC_TOKEN = process.env.IOS_DASHBOARD_SYNC_TOKEN || '';
const { createLarkReminders } = require('./lark-reminders');
const larkReminders = createLarkReminders({ readDb, persist: async db => {
  if (JSONBIN_API_KEY && JSONBIN_BIN_ID) await saveToJsonBin(db);
  else {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
} });

function requireActionPassword(data, res) {
  if (!data || data.password !== ACTION_PASSWORD) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'รหัสผ่านไม่ถูกต้อง' }));
    return false;
  }
  return true;
}

function normalizeDeviceNumber(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function requireDashboardSyncToken(req, res) {
  const suppliedToken = String(req.headers['x-integration-token'] || '');
  if (!DASHBOARD_SYNC_TOKEN || suppliedToken !== DASHBOARD_SYNC_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Integration token is invalid or not configured.' }));
    return false;
  }
  return true;
}

// Memory Cache to prevent API exhaustion and provide 0ms reads
let dbInMemory = { devices: [], logs: [], assets: [] };

// JSONBin cloud storage config
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;

// Helper to read database from memory cache
function readDb() {
  if (!dbInMemory) dbInMemory = { devices: [], logs: [], assets: [] };
  if (!dbInMemory.devices) dbInMemory.devices = [];
  if (!dbInMemory.logs) dbInMemory.logs = [];
  if (!dbInMemory.assets) dbInMemory.assets = [];
  return dbInMemory;
}

// Helper to write database to memory cache and persist it (Cloud or Local File)
function writeDb(data) {
  dbInMemory = data;
  if (JSONBIN_API_KEY && JSONBIN_BIN_ID) {
    return saveToJsonBin(data)
      .then(() => console.log('Successfully synced database to JSONBin cloud!'))
      .catch((err) => console.error('Failed to sync to JSONBin cloud:', err.message));
  } else {
    try {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Error writing local database:', err);
    }
    return Promise.resolve();
  }
}

// JSONBin.io integration helpers
function fetchFromJsonBin() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.jsonbin.io',
      port: 443,
      path: `/v3/b/${JSONBIN_BIN_ID}/latest`,
      method: 'GET',
      headers: {
        'X-Master-Key': JSONBIN_API_KEY,
        'X-Bin-Meta': 'false'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Failed to parse JSONBin payload'));
          }
        } else {
          reject(new Error(`JSONBin error status: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.end();
  });
}

function saveToJsonBin(data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const options = {
      hostname: 'api.jsonbin.io',
      port: 443,
      path: `/v3/b/${JSONBIN_BIN_ID}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_API_KEY
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`JSONBin save error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

let dbReadyPromise = null;
function ensureDbReady() {
  if (!dbReadyPromise) {
    dbReadyPromise = new Promise((resolve) => {
      initDb(() => resolve());
    });
  }
  return dbReadyPromise;
}

// Initialize database
function initDb(callback) {
  if (JSONBIN_API_KEY && JSONBIN_BIN_ID) {
    console.log('Detected JSONBin config. Fetching database from cloud...');
    fetchFromJsonBin()
      .then((data) => {
        dbInMemory = data || { devices: [], logs: [], assets: [] };
        if (!dbInMemory.devices) dbInMemory.devices = [];
        if (!dbInMemory.logs) dbInMemory.logs = [];
        if (!dbInMemory.assets) dbInMemory.assets = [];
        console.log('Database successfully loaded from JSONBin cloud!');
        callback();
      })
      .catch((err) => {
        console.error('Failed to load database from JSONBin cloud:', err.message);
        loadLocalDb();
        callback();
      });
  } else {
    console.log('Using local file system database.');
    loadLocalDb();
    callback();
  }
}

function loadLocalDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify({ devices: [], logs: [], assets: [] }, null, 2));
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    dbInMemory = JSON.parse(data);
    if (!dbInMemory.assets) dbInMemory.assets = [];
    console.log('Database successfully loaded from local file.');
  } catch (err) {
    console.error('Error reading local database:', err);
    dbInMemory = { devices: [], logs: [], assets: [] };
  }
}

// Reverse Geocoding helper using OpenStreetMap Nominatim
function getAddressFromCoords(lat, lng) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=th`;
    const options = {
      headers: {
        'User-Agent': 'iOS-Device-Monitor-App'
      }
    };

    https.get(url, options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.display_name || '');
          } catch (e) {
            resolve('');
          }
        } else {
          resolve('');
        }
      });
    }).on('error', (e) => {
      console.error('Nominatim reverse geocode error:', e.message);
      resolve('');
    });
  });
}

// Log actions
function addLog(db, deviceId, deviceName, action) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    deviceId,
    deviceName,
    action
  };
  db.logs.unshift(logEntry); // Add to the top of logs
  // Keep logs to a reasonable number (e.g. 100 max)
  if (db.logs.length > 100) {
    db.logs = db.logs.slice(0, 100);
  }
}

// Get local IPv4 address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

// Check verification status based on timestamps
function calculateDeviceStatus(lastVerifiedAtStr) {
  if (!lastVerifiedAtStr || lastVerifiedAtStr === '') {
    return {
      status: 'unverified',
      nextDueAt: '',
      daysRemaining: '-'
    };
  }

  const lastVerifiedAt = new Date(lastVerifiedAtStr).getTime();
  const now = Date.now();
  
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const CYCLE_MS = 15 * ONE_DAY_MS; // Check twice per month (every 15 days)
  const PENDING_WINDOW_MS = 3 * ONE_DAY_MS; // Notify 3 days before the next check
  
  const nextDueAt = lastVerifiedAt + CYCLE_MS;
  const msRemaining = nextDueAt - now;

  let status = 'active';
  if (msRemaining <= 0) {
    status = 'overdue';
  } else if (msRemaining <= PENDING_WINDOW_MS) {
    status = 'pending';
  }

  return {
    status,
    nextDueAt: new Date(nextDueAt).toISOString(),
    daysRemaining: Math.ceil(msRemaining / ONE_DAY_MS)
  };
}

// MIME Types mapping
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Universal request body reader (supports both Vercel parsed body and raw Node streams)
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'object') return resolve(req.body);
      try { return resolve(JSON.parse(req.body)); }
      catch (_) { return resolve({}); }
    }
    if (req.setEncoding) req.setEncoding('utf8');
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2000000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}


async function handleApiRequest(req, res) {
  await ensureDbReady();

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Integration-Token, X-Master-Key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Determine path
  let pathname = (req.url || '').split('?')[0];
  if (req.headers['x-matched-path'] && req.headers['x-matched-path'].startsWith('/api')) {
    pathname = req.headers['x-matched-path'].split('?')[0];
  }

  // POST /api/lark-reminders
  if (req.method === 'POST' && pathname === '/api/lark-reminders') {
    try {
      const data = await readBody(req);
      if (!requireActionPassword(data, res)) return;
      let result;
      if (data.action === 'save') { await larkReminders.saveRecipient(data); result = larkReminders.overview(); }
      else if (data.action === 'test') result = await larkReminders.testConnection();
      else if (data.action === 'send') result = await larkReminders.run({ scheduled: false });
      else if (data.action === 'status') result = larkReminders.overview();
      else if (data.action === 'summary') result = await larkReminders.sendSummary({ scheduled: false });
      else if (data.action === 'recover') result = await larkReminders.recover(data);
      else throw new Error('Unknown action');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // POST /api/integration/device-assignment
  if (req.method === 'POST' && pathname === '/api/integration/device-assignment') {
    if (!requireDashboardSyncToken(req, res)) return;
    try {
      const data = await readBody(req);
      const action = String(data.action || '');
      const deviceNumber = String(data.deviceNumber || '').trim();
      if (!['issue', 'return'].includes(action) || !deviceNumber) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'action and deviceNumber are required.' }));
        return;
      }

      const db = readDb();
      const normalizedNumber = normalizeDeviceNumber(deviceNumber);
      const matchedDevices = db.devices.filter(device => normalizeDeviceNumber(device.deviceNumber) === normalizedNumber);
      if (matchedDevices.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Device is not registered in iOS Device Monitor.', deviceNumber }));
        return;
      }

      const userName = action === 'issue' ? String(data.userName || '').trim() : 'ส่วนกลาง';
      const position = action === 'issue' ? String(data.position || '').trim() : 'คลัง IT';
      if (action === 'issue' && !userName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'userName is required when issuing a device.' }));
        return;
      }

      const syncedAt = new Date().toISOString();
      matchedDevices.forEach(device => {
        device.name = userName;
        device.userName = userName;
        device.position = position;
        device.assignmentStatus = action === 'issue' ? 'issued' : 'returned';
        device.assignmentSyncedAt = syncedAt;
        if (action === 'return') device.lastVerifiedAt = '';
        addLog(
          db,
          device.id,
          userName,
          action === 'issue'
            ? `Assigned from IT Dashboard (${device.deviceNumber})`
            : `Returned from IT Dashboard (${device.deviceNumber})`
        );
      });
      await writeDb(db);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        action,
        deviceNumber,
        matchedCount: matchedDevices.length,
        syncedAt
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // GET /api/devices
  if (req.method === 'GET' && pathname === '/api/devices') {
    const db = readDb();
    const processedDevices = db.devices.map(device => {
      const { status, nextDueAt, daysRemaining } = calculateDeviceStatus(device.lastVerifiedAt);
      return {
        ...device,
        status,
        nextDueAt,
        daysRemaining
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      devices: processedDevices, 
      logs: db.logs,
      serverIp: getLocalIpAddress()
    }));
    return;
  }

  // POST /api/check-password
  if (req.method === 'POST' && pathname === '/api/check-password') {
    try {
      const data = await readBody(req);
      if (!requireActionPassword(data, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // POST /api/repair-thai-text
  if (req.method === 'POST' && pathname === '/api/repair-thai-text') {
    try {
      const data = await readBody(req);
      if (!requireActionPassword(data, res)) return;
      const deviceRepairs = Array.isArray(data.deviceRepairs) ? data.deviceRepairs : [];
      const logRepairs = Array.isArray(data.logRepairs) ? data.logRepairs : [];
      const allowedDeviceFields = ['name', 'userName', 'position', 'accessories', 'address'];
      const allowedLogFields = ['deviceName', 'action'];
      const db = readDb();
      let devicesUpdated = 0;
      let logsUpdated = 0;

      deviceRepairs.forEach(repair => {
        const device = db.devices.find(item => item.id === repair.deviceId);
        if (!device || !repair.fields) return;
        let changed = false;
        allowedDeviceFields.forEach(field => {
          if (typeof repair.fields[field] === 'string' && device[field] !== repair.fields[field]) {
            device[field] = repair.fields[field];
            changed = true;
          }
        });
        if (changed) devicesUpdated += 1;
      });

      logRepairs.forEach(repair => {
        const log = db.logs.find(item => item.timestamp === repair.timestamp && item.deviceId === repair.deviceId);
        if (!log || !repair.fields) return;
        let changed = false;
        allowedLogFields.forEach(field => {
          if (typeof repair.fields[field] === 'string' && log[field] !== repair.fields[field]) {
            log[field] = repair.fields[field];
            changed = true;
          }
        });
        if (changed) logsUpdated += 1;
      });

      await writeDb(db);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Thai text repaired successfully', devicesUpdated, logsUpdated }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid repair payload' }));
    }
    return;
  }

  // POST /api/register
  if (req.method === 'POST' && pathname === '/api/register') {
    try {
      const data = await readBody(req);
      if (!requireActionPassword(data, res)) return;
      const { name, position, deviceNumber, accessories, userAgent, isIOS } = data;

      if (!name || name.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Device name is required.' }));
        return;
      }

      const db = readDb();
      const clientIp = (req.socket && req.socket.remoteAddress) || req.headers['x-forwarded-for'] || 'Unknown';
      const deviceId = 'dev-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);

      const newDevice = {
        id: deviceId,
        name: name.trim(),
        userName: name.trim(),
        position: (position || '').trim(),
        deviceNumber: (deviceNumber || '').trim(),
        accessories: (accessories || '').trim(),
        userAgent: userAgent || req.headers['user-agent'] || 'Unknown',
        ip: clientIp,
        isIOS: !!isIOS,
        registeredAt: new Date().toISOString(),
        lastVerifiedAt: ''
      };

      db.devices.push(newDevice);
      addLog(db, deviceId, newDevice.name, 'Registered device');
      await writeDb(db);

      console.log(`Device Registered: ${newDevice.name} (ID: ${deviceId})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Device registered successfully', device: newDevice }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // POST /api/import-devices
  if (req.method === 'POST' && pathname === '/api/import-devices') {
    try {
      const data = await readBody(req);
      if (!requireActionPassword(data, res)) return;
      if (!Array.isArray(data.devices) || data.devices.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Devices must be a non-empty array.' }));
        return;
      }

      const importedAt = new Date().toISOString();
      const incomingDevices = data.devices.map((item, index) => {
        const userName = String(item.userName || item.name || '').trim();
        const deviceNumber = String(item.deviceNumber || '').trim();
        if (!userName) throw new Error(`Missing user name at row ${index + 1}`);
        return {
          id: `import-${index + 1}-${deviceNumber || 'device'}`
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/-+/g, '-'),
          name: userName,
          userName,
          position: String(item.position || '').trim(),
          deviceNumber,
          accessories: String(item.accessories || '').trim(),
          userAgent: 'Imported from IT Asset Registry',
          ip: 'Imported',
          isIOS: !!item.isIOS,
          registeredAt: String(item.registeredAt || importedAt),
          lastVerifiedAt: String(item.lastVerifiedAt || importedAt),
          sourceRecord: item.sourceRecord || null
        };
      });

      const db = readDb();
      const replaceExisting = data.replace === true;
      if (replaceExisting) db.devices = [];
      const normalizeName = value => String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const availableByName = new Map();
      db.devices.forEach(device => {
        const key = normalizeName(device.userName || device.name);
        if (!availableByName.has(key)) availableByName.set(key, []);
        availableByName.get(key).push(device);
      });

      let updated = 0;
      let added = 0;
      incomingDevices.forEach((incoming, index) => {
        const key = normalizeName(incoming.userName);
        const candidates = availableByName.get(key) || [];
        const existing = candidates.shift();
        if (existing) {
          Object.assign(existing, {
            name: incoming.name,
            userName: incoming.userName,
            position: incoming.position,
            deviceNumber: incoming.deviceNumber,
            accessories: incoming.accessories,
            isIOS: incoming.isIOS,
            lastVerifiedAt: incoming.lastVerifiedAt,
            sourceRecord: incoming.sourceRecord,
            registrySyncedAt: importedAt
          });
          updated += 1;
        } else {
          incoming.id = `${incoming.id}-${Date.now().toString(36)}-${index + 1}`;
          incoming.registrySyncedAt = importedAt;
          db.devices.push(incoming);
          added += 1;
        }
      });

      db.logs.unshift({
        timestamp: importedAt,
        deviceId: 'bulk-import',
        deviceName: `${incomingDevices.length} registry rows`,
        action: replaceExisting
          ? `Asset Registry replaced with ${added} active devices`
          : `Asset Registry sync: ${updated} updated, ${added} added`
      });
      db.devices = db.devices.map(device => ({
        id: device.id,
        name: device.name || device.userName || '',
        userName: device.userName || device.name || '',
        position: device.position || '',
        deviceNumber: device.deviceNumber || '',
        accessories: device.accessories || '',
        isIOS: !!device.isIOS,
        registeredAt: device.registeredAt || importedAt,
        lastVerifiedAt: device.lastVerifiedAt || '',
        ...(device.assignmentStatus ? { assignmentStatus: device.assignmentStatus } : {})
      }));
      if (db.logs.length > 20) db.logs = db.logs.slice(0, 20);
      dbInMemory = db;
      if (JSONBIN_API_KEY && JSONBIN_BIN_ID) {
        await saveToJsonBin(db);
      } else {
        safeWriteLocalDb(DB_FILE, db);
      }

      console.log(`Device registry synced: ${updated} updated, ${added} added, ${db.devices.length} total`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: 'Device registry synchronized successfully.',
        sourceCount: incomingDevices.length,
        replaced: replaceExisting,
        updated,
        added,
        total: db.devices.length
      }));
    } catch (err) {
      console.error('Device registry import failed:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid import payload: ' + err.message }));
    }
    return;
  }

  // POST /api/verify
  if (req.method === 'POST' && pathname === '/api/verify') {
    try {
      const data = await readBody(req);
      const { deviceId, latitude, longitude } = data;

      if (!deviceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Device ID is required.' }));
        return;
      }

      const db = readDb();
      const deviceIndex = db.devices.findIndex(d => d.id === deviceId);

      if (deviceIndex === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Device not found.' }));
        return;
      }

      const now = new Date().toISOString();
      db.devices[deviceIndex].lastVerifiedAt = now;
      
      let logMsg = 'Confirmed presence (15-Day Check)';
      if (latitude !== undefined && latitude !== null && longitude !== undefined && longitude !== null) {
        db.devices[deviceIndex].latitude = latitude;
        db.devices[deviceIndex].longitude = longitude;
        db.devices[deviceIndex].lastLocationTime = now;
        
        const address = await getAddressFromCoords(latitude, longitude);
        db.devices[deviceIndex].address = address || '';
        
        if (address) {
          logMsg += ` at ${address}`;
        } else {
          logMsg += ` at [Lat: ${latitude.toFixed(6)}, Lng: ${longitude.toFixed(6)}]`;
        }
      }
      
      addLog(db, deviceId, db.devices[deviceIndex].name, logMsg);
      await writeDb(db);

      console.log(`Device Verified: ${db.devices[deviceIndex].name} (${deviceId})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Device verification recorded successfully' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // POST /api/delete-device
  if (req.method === 'POST' && pathname === '/api/delete-device') {
    try {
      const data = await readBody(req);
      if (!requireActionPassword(data, res)) return;
      const { deviceId } = data;

      if (!deviceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Device ID is required.' }));
        return;
      }

      const db = readDb();
      const device = db.devices.find(d => d.id === deviceId);
      if (!device) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Device not found.' }));
        return;
      }

      db.devices = db.devices.filter(d => d.id !== deviceId);
      addLog(db, deviceId, device.name, 'Removed device from system');
      await writeDb(db);

      console.log(`Device Deleted: ${device.name} (${deviceId})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Device removed successfully.' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // POST /api/edit-device
  if (req.method === 'POST' && pathname === '/api/edit-device') {
    try {
      const data = await readBody(req);
      if (!requireActionPassword(data, res)) return;
      const { deviceId, name, position, deviceNumber, accessories, isIOS } = data;

      if (!deviceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Device ID is required.' }));
        return;
      }

      if (!name || name.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Device name is required.' }));
        return;
      }

      const db = readDb();
      const deviceIndex = db.devices.findIndex(d => d.id === deviceId);
      if (deviceIndex === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Device not found.' }));
        return;
      }

      db.devices[deviceIndex].name = name.trim();
      db.devices[deviceIndex].userName = name.trim();
      db.devices[deviceIndex].position = (position || '').trim();
      db.devices[deviceIndex].deviceNumber = (deviceNumber || '').trim();
      db.devices[deviceIndex].accessories = (accessories || '').trim();
      db.devices[deviceIndex].isIOS = !!isIOS;

      addLog(db, deviceId, name.trim(), 'Edited device details');
      await writeDb(db);

      console.log(`Device Edited: ${name.trim()} (${deviceId})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Device details updated successfully.' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // GET /api/assets
  if (req.method === 'GET' && pathname === '/api/assets') {
    const db = readDb();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      assets: db.assets || [], 
      serverIp: getLocalIpAddress()
    }));
    return;
  }

  // POST /api/register-asset
  if (req.method === 'POST' && pathname === '/api/register-asset') {
    try {
      const data = await readBody(req);
      const { name, category, serialNumber, location, shelfLocation, type, image, status, borrower, dueDate } = data;

      if (!name || name.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset name is required.' }));
        return;
      }

      const db = readDb();
      const assetId = 'ast-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);

      const newAsset = {
        id: assetId,
        name: name.trim(),
        category: (category || '').trim(),
        sn: (serialNumber || '').trim(),
        location: (location || '').trim(),
        shelfLocation: (shelfLocation || '').trim(),
        status: status || 'available',
        borrower: (borrower || '').trim(),
        dueDate: dueDate || null,
        type: type || 'custom',
        image: image || null,
        registeredAt: new Date().toISOString(),
        lastScannedAt: null
      };

      db.assets.push(newAsset);
      addLog(db, assetId, newAsset.name, 'Registered new asset');
      await writeDb(db);

      console.log(`Asset Registered: ${newAsset.name} (ID: ${assetId})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Asset registered successfully', asset: newAsset }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // POST /api/edit-asset
  if (req.method === 'POST' && pathname === '/api/edit-asset') {
    try {
      const data = await readBody(req);
      const { assetId, name, category, serialNumber, location, shelfLocation, type, image, status, borrower, dueDate } = data;

      if (!assetId || !name || name.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset ID and name are required.' }));
        return;
      }

      const db = readDb();
      const index = db.assets.findIndex(a => a.id === assetId);
      if (index === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset not found.' }));
        return;
      }

      db.assets[index].name = name.trim();
      db.assets[index].category = (category || '').trim();
      db.assets[index].sn = (serialNumber || '').trim();
      db.assets[index].location = (location || '').trim();
      if (shelfLocation !== undefined) db.assets[index].shelfLocation = (shelfLocation || '').trim();
      if (status !== undefined) db.assets[index].status = status;
      if (borrower !== undefined) db.assets[index].borrower = (borrower || '').trim();
      if (dueDate !== undefined) db.assets[index].dueDate = dueDate;
      db.assets[index].type = type || db.assets[index].type || 'custom';
      
      if (image !== undefined) {
        db.assets[index].image = image;
      }

      addLog(db, assetId, name.trim(), 'Edited asset details');
      await writeDb(db);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Asset updated successfully.' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // POST /api/delete-asset
  if (req.method === 'POST' && pathname === '/api/delete-asset') {
    try {
      const data = await readBody(req);
      const { assetId } = data;

      if (!assetId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset ID is required.' }));
        return;
      }

      const db = readDb();
      const asset = db.assets.find(a => a.id === assetId);
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset not found.' }));
        return;
      }

      db.assets = db.assets.filter(a => a.id !== assetId);
      addLog(db, assetId, asset.name, 'Removed asset from system');
      await writeDb(db);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Asset removed successfully.' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // POST /api/scan-asset
  if (req.method === 'POST' && pathname === '/api/scan-asset') {
    try {
      const data = await readBody(req);
      const { assetId } = data;

      if (!assetId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset ID is required.' }));
        return;
      }

      const db = readDb();
      const index = db.assets.findIndex(a => a.id === assetId);
      if (index === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset not found.' }));
        return;
      }

      db.assets[index].lastScannedAt = new Date().toISOString();
      addLog(db, assetId, db.assets[index].name, 'Asset Scanned via QR');
      await writeDb(db);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Asset scan recorded successfully.', asset: db.assets[index] }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // POST /api/borrow-asset
  if (req.method === 'POST' && pathname === '/api/borrow-asset') {
    try {
      const data = await readBody(req);
      const { assetId, borrower, dueDate, note } = data;
      if (!assetId || !borrower) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset ID and Borrower name are required.' }));
        return;
      }
      const db = readDb();
      const index = db.assets.findIndex(a => a.id === assetId);
      if (index === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset not found.' }));
        return;
      }
      db.assets[index].status = 'borrowed';
      db.assets[index].borrower = borrower.trim();
      db.assets[index].borrowedAt = new Date().toISOString();
      db.assets[index].dueDate = dueDate || null;
      db.assets[index].borrowNote = (note || '').trim();

      addLog(db, assetId, db.assets[index].name, '[Store] เบิกยืมอุปกรณ์โดย: ' + borrower.trim() + (dueDate ? ' (กำหนดคืน: ' + dueDate + ')' : ''));
      await writeDb(db);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'บันทึกการเบิกยืมสำเร็จ', asset: db.assets[index] }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // POST /api/return-asset
  if (req.method === 'POST' && pathname === '/api/return-asset') {
    try {
      const data = await readBody(req);
      const { assetId, conditionNote } = data;
      if (!assetId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset ID is required.' }));
        return;
      }
      const db = readDb();
      const index = db.assets.findIndex(a => a.id === assetId);
      if (index === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset not found.' }));
        return;
      }
      const prevBorrower = db.assets[index].borrower || 'ไม่ระบุ';
      db.assets[index].status = 'available';
      db.assets[index].borrower = '';
      db.assets[index].dueDate = null;
      db.assets[index].returnedAt = new Date().toISOString();
      db.assets[index].lastScannedAt = new Date().toISOString();

      addLog(db, assetId, db.assets[index].name, '[Store] รับคืนอุปกรณ์เข้าคลังจาก: ' + prevBorrower + (conditionNote ? ' (สภาพ: ' + conditionNote + ')' : ''));
      await writeDb(db);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'รับคืนอุปกรณ์เข้าคลังสโตร์เรียบร้อย', asset: db.assets[index] }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload: ' + err.message }));
    }
    return;
  }

  // Fallback 404 for unhandled API
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found', path: pathname }));
}

function serveStaticFile(req, res) {
  const qPos = (req.url || '').indexOf('?');
  const pathname = qPos !== -1 ? req.url.substring(0, qPos) : (req.url || '/');
  let reqUrl = pathname === '/' ? '/index.html' : pathname;
  const safeSuffix = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');

  const candidateDirs = [
    PUBLIC_DIR,
    path.join(process.cwd(), 'public'),
    path.join(__dirname, 'public'),
    __dirname,
    process.cwd()
  ];

  let foundPath = null;
  for (const dir of candidateDirs) {
    const candidate = path.join(dir, safeSuffix);
    try {
      if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
        foundPath = candidate;
        break;
      }
    } catch (_) {}
  }

  if (!foundPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + pathname);
    return;
  }

  const ext = path.extname(foundPath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const content = fs.readFileSync(foundPath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(content);
}

async function appHandler(req, res) {
  try {
    await ensureDbReady();
    const qPos = (req.url || '').indexOf('?');
    const pathname = qPos !== -1 ? req.url.substring(0, qPos) : (req.url || '/');

    if (pathname.startsWith('/api')) {
      return await handleApiRequest(req, res);
    }

    return serveStaticFile(req, res);
  } catch (err) {
    console.error('Unhandled appHandler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Server Error: ' + err.message);
    }
  }
}

const server = http.createServer(appHandler);

if (require.main === module) {
  ensureDbReady().then(() => {
    async function pollLark() {
      try { await larkReminders.run(); } catch (error) { console.error('Lark reminder:', error.message); }
      try { await larkReminders.sendSummary(); } catch (error) { console.error('Lark summary:', error.message); }
    }
    setInterval(pollLark, 60000).unref();
    pollLark();
    server.listen(PORT, () => {
      console.log(`==================================================`);
      console.log(`📱 iOS Device Monitor server is running locally!`);
      console.log(`🔗 Access Portal: http://localhost:${PORT}`);
      console.log(`==================================================`);
    });
  });
}

appHandler.server = server;
appHandler.handleApiRequest = handleApiRequest;
appHandler.ensureDbReady = ensureDbReady;
appHandler.readDb = readDb;
appHandler.writeDb = writeDb;

module.exports = appHandler;
