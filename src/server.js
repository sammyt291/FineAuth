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
  listCharactersForAccount
} from './db.js';
import { ModuleManager } from './moduleManager.js';
import { PermissionsManager } from './permissions.js';

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
let esiStatus = {
  status: 'unknown',
  players: null,
  serverVersion: null,
  lastUpdated: null,
  error: null
};

let server;
let io;

const permissionsManager = new PermissionsManager({
  permissionsPath: path.join(rootDir, 'config', 'permissions.json')
});
permissionsManager.registerPermission('admin', 'Full administrative access.');

const moduleManager = new ModuleManager({
  modulesPath: path.resolve(rootDir, config.modulesPath),
  moduleExtractPath: path.resolve(rootDir, config.moduleExtractPath),
  permissionsManager
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
    socket.emit('esi:status', esiStatus);

    socket.on('session:request', (payload, respond) => {
      const token = payload?.token ?? null;
      if (!token) {
        respond?.({ account: null });
        return;
      }
      const account = getAccountByToken(db, token);
      if (!account) {
        respond?.({ account: null, error: 'Invalid token' });
        return;
      }
      const characters = listCharactersForAccount(db, account.id).map(
        (character) => character.name
      );
      respond?.({
        account: {
          id: account.id,
          name: account.name,
          type: account.type,
          characters,
          isAdmin: permissionsManager.isAdmin(account.name)
        }
      });
    });

    socket.on('esi:login', (_payload, respond) => {
      if (!config.esi.clientId || !config.esi.clientSecret) {
        respond?.({ error: 'ESI SSO is not configured.' });
        return;
      }
      const state = cryptoRandom();
      esiLoginStates.set(state, Date.now());
      const scope = Array.isArray(config.esi.scopes)
        ? config.esi.scopes.join(' ')
        : '';
      const authorizeUrl = new URL('https://login.eveonline.com/v2/oauth/authorize');
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('redirect_uri', config.esi.callbackUrl);
      authorizeUrl.searchParams.set('client_id', config.esi.clientId);
      authorizeUrl.searchParams.set('scope', scope);
      authorizeUrl.searchParams.set('state', state);
      respond?.({ url: authorizeUrl.toString() });
    });

    socket.on('esi:status:request', (_payload, respond) => {
      respond?.(esiStatus);
    });
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
  moduleManager.loadModulesFromDisk();
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
  const statusRefreshMs = (config.esi.statusRefreshSeconds ?? 60) * 1000;

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

  setInterval(() => {
    refreshEsiStatus();
  }, statusRefreshMs);
}

async function refreshEsiStatus() {
  try {
    const response = await fetch(
      'https://esi.evetech.net/latest/status/?datasource=tranquility'
    );
    if (!response.ok) {
      throw new Error(`ESI status error: ${response.status}`);
    }
    const data = await response.json();
    esiStatus = {
      status: 'online',
      players: data.players ?? null,
      serverVersion: data.server_version ?? null,
      lastUpdated: new Date().toISOString(),
      error: null
    };
  } catch (error) {
    esiStatus = {
      status: 'unavailable',
      players: null,
      serverVersion: null,
      lastUpdated: new Date().toISOString(),
      error: error.message
    };
  }
  io?.emit('esi:status', esiStatus);
}

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

app.use('/modules', (req, res, next) => {
  const moduleName = req.path.split('/').filter(Boolean)[0];
  const moduleData = moduleManager.getModule(moduleName);
  if (!moduleData) {
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
    const tokens = command.split(' ').filter(Boolean);
    const action = tokens[0]?.toLowerCase();
    const moduleName = tokens[1];
    try {
      if (action === 'help') {
        console.log('Commands:');
        console.log('  help - Show available commands');
        console.log('  load <module> - Load a module (folder or zip)');
        console.log('  unload <module> - Unload a module');
        console.log('  reload <module> - Reload a module');
        console.log('  set Admin <username> - Grant admin permissions to an ESI user');
        return;
      }
      if (action === 'set' && tokens[1]?.toLowerCase() === 'admin') {
        const accountName = tokens.slice(2).join(' ');
        if (!accountName) {
          console.log('Usage: set Admin <username>');
          return;
        }
        permissionsManager.setAccountPermission('admin', accountName, true);
        io?.emit('permissions:updated');
        console.log(`Granted admin access to ${accountName}.`);
        return;
      }
      if (action === 'load' && moduleName) {
        moduleManager.loadModule(moduleName);
        console.log(`Loaded module ${moduleName}`);
        return;
      }
      if (action === 'unload' && moduleName) {
        moduleManager.unloadModule(moduleName);
        console.log(`Unloaded module ${moduleName}`);
        return;
      }
      if (action === 'reload' && moduleName) {
        moduleManager.reloadModule(moduleName);
        console.log(`Reloaded module ${moduleName}`);
        return;
      }
      console.log('Type "help" to view available commands.');
    } catch (error) {
      console.error(error.message);
    }
  });
}

await loadInitialModules();
startServer();
watchSslFiles();
scheduleEsiRefresh();
refreshEsiStatus();
handleConsoleCommands();
