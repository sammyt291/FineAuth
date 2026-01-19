import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { fileURLToPath } from 'url';
import {
  openDatabase,
  saveAccount,
  getAccountByToken,
  listAccounts,
  listCharactersForAccount,
  deleteAccount,
  upsertModuleAccountData
} from './db.js';
import { ModuleManager } from './moduleManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const configPath = path.join(rootDir, 'config', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const app = express();
app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));

const db = openDatabase(path.join(rootDir, 'data.sqlite'));

const esiQueue = [];
const esiLoginStates = new Map();

const builtInModules = [
  {
    name: 'landing',
    displayName: 'Landing / Login',
    description: 'Landing page with admin and ESI login',
    mainPage: 'landing'
  },
  {
    name: 'home',
    displayName: 'Home',
    description: 'Primary dashboard and helpers',
    mainPage: 'home'
  },
  {
    name: 'accounts',
    displayName: 'Account Management',
    description: 'Manage FineAuth accounts and access',
    mainPage: 'accounts'
  },
  {
    name: 'navigation',
    displayName: 'Navigation Menus',
    description: 'Top navigation and dropdown menus',
    mainPage: 'navigation'
  }
];

let server;
let io;

const moduleManager = new ModuleManager({
  modulesPath: path.resolve(rootDir, config.modulesPath),
  moduleExtractPath: path.resolve(rootDir, config.moduleExtractPath)
});

moduleManager.registerAccountModifier((account) => account);

function createServer() {
  const httpServer = config.https.enabled
    ? https.createServer(
        {
          key: fs.readFileSync(path.resolve(rootDir, config.https.keyPath)),
          cert: fs.readFileSync(path.resolve(rootDir, config.https.certPath))
        },
        app
      )
    : http.createServer(app);

  io = new SocketIOServer(httpServer, {
    cors: { origin: '*' }
  });

  moduleManager.io = io;
  io.on('connection', (socket) => {
    socket.emit('modules:update', moduleManager.listModules());
    socket.emit('esi:queue', esiQueue);
  });

  return httpServer;
}

function startServer() {
  server = createServer();
  server.listen(config.port, () => {
    console.log(`FineAuth listening on ${config.https.enabled ? 'https' : 'http'}://localhost:${config.port}`);
  });
}

function stopServer(callback) {
  if (!server) {
    callback();
    return;
  }
  server.close(() => {
    server = null;
    io?.close();
    callback();
  });
}

function restartServer() {
  console.log('Restarting server due to SSL change...');
  stopServer(() => {
    startServer();
  });
}

function watchSslFiles() {
  if (!config.https.enabled) {
    return;
  }
  const keyPath = path.resolve(rootDir, config.https.keyPath);
  const certPath = path.resolve(rootDir, config.https.certPath);
  [keyPath, certPath].forEach((file) => {
    fs.watchFile(file, { interval: 1000 }, () => {
      restartServer();
    });
  });
}

async function loadInitialModules() {
  await moduleManager.loadBuiltInModules(builtInModules);
  const moduleFiles = fs
    .readdirSync(path.resolve(rootDir, config.modulesPath))
    .filter((file) => file.endsWith('.zip'));
  moduleFiles.forEach((file) => {
    const name = path.basename(file, '.zip');
    try {
      moduleManager.loadModuleZip(name);
      console.log(`Loaded module ${name}`);
    } catch (error) {
      console.warn(`Failed to load module ${name}: ${error.message}`);
    }
  });
}

function queueEsiTask(taskName) {
  esiQueue.push({ taskName, queuedAt: new Date().toISOString() });
  io?.emit('esi:queue', esiQueue);
}

function clearEsiQueue() {
  esiQueue.length = 0;
  io?.emit('esi:queue', esiQueue);
}

function scheduleEsiRefresh() {
  const refreshMs = config.esi.refreshIntervalMinutes * 60 * 1000;
  const nameCheckMs = config.esi.characterNameCheckMinutes * 60 * 1000;

  setInterval(() => {
    queueEsiTask('Refresh ESI tokens');
    setTimeout(() => {
      clearEsiQueue();
    }, 2000);
  }, refreshMs);

  setInterval(() => {
    queueEsiTask('Verify character names');
    setTimeout(() => {
      clearEsiQueue();
    }, 2000);
  }, nameCheckMs);
}

function parseToken(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  return token ?? null;
}

function requireAccount(req, res) {
  const token = parseToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing token' });
    return null;
  }
  const account = getAccountByToken(db, token);
  if (!account) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  return account;
}

app.get('/api/modules', (req, res) => {
  res.json({ modules: moduleManager.listModules() });
});

app.get('/api/session', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const characters = listCharactersForAccount(db, account.id).map(
    (character) => character.name
  );
  res.json({
    account: {
      id: account.id,
      name: account.name,
      type: account.type,
      characters
    }
  });
});

app.get('/api/esi-queue', (req, res) => {
  res.json({ queue: esiQueue });
});

app.post('/api/login/admin', (req, res) => {
  const { username, password } = req.body;
  if (
    username !== config.adminAuth.username ||
    password !== config.adminAuth.password
  ) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const accessToken = cryptoRandom();
  const { accountId } = saveAccount({
    db,
    type: 'static',
    name: username,
    accessToken,
    refreshToken: null,
    characterNames: [],
    moduleData: {},
    moduleAccountModifiers: moduleManager.getAccountModifiers()
  });
  res.json({ token: accessToken, accountId });
});

app.get('/api/esi/login', (req, res) => {
  if (!config.esi.clientId || !config.esi.clientSecret) {
    res.status(500).send('ESI SSO is not configured.');
    return;
  }
  const state = cryptoRandom();
  esiLoginStates.set(state, Date.now());
  const scope = Array.isArray(config.esi.scopes) ? config.esi.scopes.join(' ') : '';
  const authorizeUrl = new URL('https://login.eveonline.com/v2/oauth/authorize');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', config.esi.callbackUrl);
  authorizeUrl.searchParams.set('client_id', config.esi.clientId);
  authorizeUrl.searchParams.set('scope', scope);
  authorizeUrl.searchParams.set('state', state);
  res.redirect(authorizeUrl.toString());
});

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || !esiLoginStates.has(state)) {
    res.status(400).send('Invalid ESI callback.');
    return;
  }
  esiLoginStates.delete(state);

  const credentials = Buffer.from(
    `${config.esi.clientId}:${config.esi.clientSecret}`
  ).toString('base64');

  try {
    const tokenResponse = await fetch('https://login.eveonline.com/v2/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Host: 'login.eveonline.com'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code
      })
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      res.status(500).send(`Failed to exchange ESI code: ${errorText}`);
      return;
    }

    const tokenData = await tokenResponse.json();
    const verifyResponse = await fetch('https://login.eveonline.com/oauth/verify', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      }
    });

    if (!verifyResponse.ok) {
      const errorText = await verifyResponse.text();
      res.status(500).send(`Failed to verify ESI token: ${errorText}`);
      return;
    }

    const verifyData = await verifyResponse.json();
    const accessToken = cryptoRandom();
    saveAccount({
      db,
      type: 'esi',
      name: verifyData.CharacterName,
      accessToken,
      refreshToken: tokenData.refresh_token,
      characterNames: [verifyData.CharacterName],
      moduleData: {},
      moduleAccountModifiers: moduleManager.getAccountModifiers()
    });

    res.send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>FineAuth ESI Login</title>
        </head>
        <body>
          <script>
            localStorage.setItem('fineauth_token', ${JSON.stringify(accessToken)});
            window.location.href = '/#/module/home';
          </script>
          <p>Signing you in...</p>
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`ESI login failed: ${error.message}`);
  }
});

app.get('/api/accounts', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  if (account.type !== 'static') {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }
  const accounts = listAccounts(db).map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    createdAt: item.created_at
  }));
  res.json({ accounts });
});

app.delete('/api/accounts/:id', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  if (account.type !== 'static') {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }
  const targetId = Number(req.params.id);
  if (!Number.isFinite(targetId)) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  if (targetId === account.id) {
    res.status(403).json({ error: 'Cannot delete your own account' });
    return;
  }
  deleteAccount(db, targetId);
  res.json({ status: 'ok' });
});

app.post('/api/modules/:name/account-data', (req, res) => {
  const account = requireAccount(req, res);
  if (!account) {
    return;
  }
  const moduleName = req.params.name;
  upsertModuleAccountData(db, account.id, moduleName, req.body);
  res.json({ status: 'ok' });
});

app.use('/modules', (req, res, next) => {
  const moduleName = req.path.split('/').filter(Boolean)[0];
  const moduleData = moduleManager.getModule(moduleName);
  if (!moduleData || moduleData.builtIn) {
    res.status(404).send('Module not found');
    return;
  }
  const staticPath = path.join(moduleData.assetsPath);
  express.static(staticPath)(req, res, next);
});

function cryptoRandom() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function handleConsoleCommands() {
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (data) => {
    const command = data.trim();
    if (!command) {
      return;
    }
    const [action, moduleName] = command.split(' ');
    try {
      if (action === 'load' && moduleName) {
        moduleManager.loadModuleZip(moduleName);
        console.log(`Loaded module ${moduleName}`);
      } else if (action === 'unload' && moduleName) {
        moduleManager.unloadModule(moduleName);
        console.log(`Unloaded module ${moduleName}`);
      } else if (action === 'reload' && moduleName) {
        moduleManager.reloadModule(moduleName);
        console.log(`Reloaded module ${moduleName}`);
      } else {
        console.log('Commands: load <module>, unload <module>, reload <module>');
      }
    } catch (error) {
      console.error(error.message);
    }
  });
}

await loadInitialModules();
startServer();
watchSslFiles();
scheduleEsiRefresh();
handleConsoleCommands();
