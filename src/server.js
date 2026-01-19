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
  addCharacterToAccount,
  getAccountById,
  updateCharacterDetails,
  getAccountByName,
  getAccountByCharacterName,
  updateAccountTokens
} from './db.js';
import { ModuleManager } from './moduleManager.js';
import { PermissionsManager } from './permissions.js';
import { ModuleSettingsManager } from './moduleSettings.js';

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
let esiTaskSequence = 1;
const esiCache = new Map();
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
permissionsManager.registerPermission(
  'characters.add',
  'Allow members to add additional characters.'
);

const moduleSettingsManager = new ModuleSettingsManager({
  settingsPath: path.join(rootDir, 'config', 'module-settings.json')
});

const moduleManager = new ModuleManager({
  modulesPath: path.resolve(rootDir, config.modulesPath),
  moduleExtractPath: path.resolve(rootDir, config.moduleExtractPath),
  permissionsManager,
  decorateModule: (moduleData) => ({
    ...moduleData,
    settings: moduleSettingsManager.getModuleSettings(moduleData)
  })
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
    socket.emit('esi:queue', getEsiQueuePayload());
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
      if (socket.data.accountDataQueuedFor !== account.name) {
        queueAccountDataRequests(account.name);
        socket.data.accountDataQueuedFor = account.name;
      }
      const characters = listCharactersForAccount(db, account.id).map(
        (character) => ({
          name: character.name,
          characterId: character.character_id ?? null,
          corporationId: character.corporation_id ?? null,
          corporationName: character.corporation_name ?? null,
          allianceId: character.alliance_id ?? null,
          allianceName: character.alliance_name ?? null,
          updatedAt: character.updated_at ?? null
        })
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

    socket.on('esi:login', (payload, respond) => {
      if (!config.esi.clientId || !config.esi.clientSecret) {
        respond?.({ error: 'ESI SSO is not configured.' });
        return;
      }
      const mode = payload?.mode ?? 'primary';
      let account = null;
      if (mode === 'add-character') {
        const token = payload?.token;
        if (!token) {
          respond?.({ error: 'Missing session token.' });
          return;
        }
        account = getAccountByToken(db, token);
        if (!account) {
          respond?.({ error: 'Invalid session token.' });
          return;
        }
        if (!canAddCharacters(account.name)) {
          respond?.({ error: 'You do not have permission to add characters.' });
          return;
        }
      }
      const state = cryptoRandom();
      esiLoginStates.set(state, {
        createdAt: Date.now(),
        mode,
        accountId: account?.id ?? null,
        accountName: account?.name ?? null
      });
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

    socket.on('characters:refresh', async (payload, respond) => {
      const token = payload?.token;
      if (!token) {
        respond?.({ error: 'Missing session token.' });
        return;
      }
      const account = getAccountByToken(db, token);
      if (!account) {
        respond?.({ error: 'Invalid session token.' });
        return;
      }
      const characters = listCharactersForAccount(db, account.id);
      if (!characters.length) {
        respond?.({ characters: [] });
        return;
      }
      const task = queueUserEsiTask({
        taskName: 'Refresh character details',
        accountName: account.name,
        type: 'refresh'
      });
      try {
        for (const character of characters) {
          const details = await fetchCharacterDetails({
            name: character.name,
            characterId: character.character_id,
            cache: false
          });
          updateCharacterDetails(db, character.id, {
            name: character.name,
            ...details
          });
        }
        const refreshed = listCharactersForAccount(db, account.id).map(
          (character) => ({
            name: character.name,
            characterId: character.character_id ?? null,
            corporationId: character.corporation_id ?? null,
            corporationName: character.corporation_name ?? null,
            allianceId: character.alliance_id ?? null,
            allianceName: character.alliance_name ?? null,
            updatedAt: character.updated_at ?? null
          })
        );
        respond?.({ characters: refreshed });
      } catch (error) {
        respond?.({ error: error.message });
      } finally {
        completeEsiTask(task.id);
      }
    });

    socket.on('module:settings:request', (payload, respond) => {
      const token = payload?.token;
      const moduleName = payload?.moduleName;
      if (!token || !moduleName) {
        respond?.({ error: 'Missing settings request data.' });
        return;
      }
      const account = getAccountByToken(db, token);
      if (!account || !permissionsManager.isAdmin(account.name)) {
        respond?.({ error: 'Admin access required.' });
        return;
      }
      const moduleData = moduleManager.getModule(moduleName);
      if (!moduleData?.adminSettings) {
        respond?.({ error: 'Module does not expose settings.' });
        return;
      }
      respond?.({
        moduleName,
        settings: moduleSettingsManager.getModuleSettings(moduleData),
        adminSettings: moduleData.adminSettings
      });
    });

    socket.on('module:settings:update', (payload, respond) => {
      const token = payload?.token;
      const moduleName = payload?.moduleName;
      if (!token || !moduleName) {
        respond?.({ error: 'Missing settings update data.' });
        return;
      }
      const account = getAccountByToken(db, token);
      if (!account || !permissionsManager.isAdmin(account.name)) {
        respond?.({ error: 'Admin access required.' });
        return;
      }
      const moduleData = moduleManager.getModule(moduleName);
      if (!moduleData?.adminSettings) {
        respond?.({ error: 'Module does not expose settings.' });
        return;
      }
      moduleSettingsManager.updateModuleSettings(moduleData, payload.settings ?? {});
      moduleManager.notifyClients();
      respond?.({ ok: true });
    });

    socket.on('admin:accounts:request', (payload, respond) => {
      const token = payload?.token;
      if (!token) {
        respond?.({ error: 'Missing session token.' });
        return;
      }
      const account = getAccountByToken(db, token);
      if (!account || !permissionsManager.isAdmin(account.name)) {
        respond?.({ error: 'Admin access required.' });
        return;
      }
      const accounts = listAccounts(db).map((entry) => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        createdAt: entry.created_at
      }));
      respond?.({ accounts });
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
  const task = {
    id: esiTaskSequence++,
    taskName,
    queuedAt: new Date().toISOString(),
    accountName: null,
    type: 'system',
    estimatedSeconds: config.esi.queueRunSeconds ?? 12
  };
  esiQueue.push(task);
  emitEsiQueue();
  return task;
}

function queueUserEsiTask({ taskName, accountName, type }) {
  const task = {
    id: esiTaskSequence++,
    taskName,
    queuedAt: new Date().toISOString(),
    accountName,
    type,
    estimatedSeconds: config.esi.queueRunSeconds ?? 12
  };
  esiQueue.push(task);
  emitEsiQueue();
  return task;
}

function queueAccountDataRequests(accountName) {
  if (!accountName) {
    return;
  }
  const tasks = [
    { taskName: 'Sync mail data', type: 'mail' },
    { taskName: 'Sync skill data', type: 'skills' },
    { taskName: 'Sync training queue', type: 'training-queue' },
    { taskName: 'Sync wallet history', type: 'wallet' }
  ];
  tasks.forEach((task) => {
    queueUserEsiTask({
      taskName: task.taskName,
      accountName,
      type: task.type
    });
  });
}

function updateEsiTask(taskId, updates) {
  const task = esiQueue.find((entry) => entry.id === taskId);
  if (!task) {
    return;
  }
  Object.assign(task, updates);
  emitEsiQueue();
}

function completeEsiTask(taskId) {
  const index = esiQueue.findIndex((entry) => entry.id === taskId);
  if (index === -1) {
    return;
  }
  esiQueue.splice(index, 1);
  emitEsiQueue();
}

function emitEsiQueue() {
  io?.emit('esi:queue', getEsiQueuePayload());
}

function getEsiQueuePayload() {
  return {
    items: esiQueue,
    queueRunSeconds: config.esi.queueRunSeconds ?? 12,
    updatedAt: new Date().toISOString()
  };
}

function clearEsiQueue() {
  esiQueue.length = 0;
  emitEsiQueue();
}

function scheduleEsiRefresh() {
  const refreshMs = config.esi.refreshIntervalMinutes * 60 * 1000;
  const nameCheckMs = config.esi.characterNameCheckMinutes * 60 * 1000;
  const statusRefreshMs = (config.esi.statusRefreshSeconds ?? 60) * 1000;
  const queueRunMs = (config.esi.queueRunSeconds ?? 12) * 1000;

  setInterval(() => {
    const task = queueEsiTask('Refresh ESI tokens');
    setTimeout(() => {
      completeEsiTask(task.id);
    }, queueRunMs);
  }, refreshMs);

  setInterval(() => {
    const task = queueEsiTask('Verify character names');
    setTimeout(() => {
      completeEsiTask(task.id);
    }, queueRunMs);
  }, nameCheckMs);

  setInterval(() => {
    refreshEsiStatus();
  }, statusRefreshMs);
}

async function refreshEsiStatus() {
  const task = queueEsiTask('Refresh ESI server status');
  try {
    const data = await fetchEsiJson(
      'https://esi.evetech.net/latest/status/?datasource=tranquility'
    );
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
  } finally {
    completeEsiTask(task.id);
  }
  io?.emit('esi:status', esiStatus);
}

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || !esiLoginStates.has(state)) {
    res.status(400).send('Invalid ESI callback.');
    return;
  }
  const loginState = esiLoginStates.get(state);
  esiLoginStates.delete(state);

  const credentials = Buffer.from(
    `${config.esi.clientId}:${config.esi.clientSecret}`
  ).toString('base64');

  const task = queueUserEsiTask({
    taskName:
      loginState?.mode === 'add-character'
        ? 'Add character: Authenticating'
        : 'ESI login',
    accountName: loginState?.accountName ?? null,
    type: 'login'
  });
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
    updateEsiTask(task.id, {
      taskName:
        loginState?.mode === 'add-character'
          ? `Add character: ${verifyData.CharacterName}`
          : 'ESI login'
    });

    const characterDetails = await fetchCharacterDetails({
      name: verifyData.CharacterName,
      characterId: verifyData.CharacterID,
      cache: true
    });

    if (loginState?.mode === 'add-character' && loginState.accountId) {
      const account = getAccountById(db, loginState.accountId);
      if (!account) {
        res.status(400).send('Account not found for character add.');
        return;
      }
      addCharacterToAccount(db, account.id, {
        name: verifyData.CharacterName,
        characterId: verifyData.CharacterID,
        ...characterDetails
      });
      res.send(`
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8" />
            <title>FineAuth Characters</title>
          </head>
          <body>
            <script>
              window.location.href = '/#/module/characters';
            </script>
            <p>Adding character...</p>
          </body>
        </html>
      `);
      return;
    }

    const accessToken = cryptoRandom();
    const existingAccount =
      getAccountByCharacterName(db, verifyData.CharacterName) ??
      getAccountByName(db, verifyData.CharacterName);

    if (existingAccount) {
      updateAccountTokens(db, existingAccount.id, {
        accessToken,
        refreshToken: tokenData.refresh_token
      });
      addCharacterToAccount(db, existingAccount.id, {
        name: verifyData.CharacterName,
        characterId: verifyData.CharacterID,
        ...characterDetails
      });
    } else {
      saveAccount({
        db,
        type: 'esi',
        name: verifyData.CharacterName,
        accessToken,
        refreshToken: tokenData.refresh_token,
        characterNames: [
          {
            name: verifyData.CharacterName,
            characterId: verifyData.CharacterID,
            ...characterDetails
          }
        ],
        moduleData: {},
        moduleAccountModifiers: moduleManager.getAccountModifiers()
      });
    }

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
  } finally {
    completeEsiTask(task.id);
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
  const originalUrl = req.url;
  req.url = req.url.replace(`/${moduleName}`, '') || '/';
  express.static(staticPath)(req, res, (error) => {
    req.url = originalUrl;
    next(error);
  });
});

function cryptoRandom() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function fetchEsiJson(url, { cache = true, ttlSeconds } = {}) {
  const ttlMs = (ttlSeconds ?? config.esi.cacheSeconds ?? 45) * 1000;
  const cacheKey = url;
  if (cache) {
    const cached = esiCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ESI status error: ${response.status}`);
  }
  const data = await response.json();
  if (cache) {
    esiCache.set(cacheKey, {
      value: data,
      expiresAt: Date.now() + ttlMs
    });
  }
  return data;
}

async function fetchCharacterDetails({ name, characterId, cache = true }) {
  let resolvedCharacterId = characterId;
  if (!resolvedCharacterId && name) {
    const search = await fetchEsiJson(
      `https://esi.evetech.net/latest/search/?categories=character&search=${encodeURIComponent(
        name
      )}&strict=true&datasource=tranquility`,
      { cache }
    );
    resolvedCharacterId = Array.isArray(search.character)
      ? search.character[0]
      : null;
  }
  if (!resolvedCharacterId) {
    return {
      characterId: null,
      corporationId: null,
      corporationName: null,
      allianceId: null,
      allianceName: null
    };
  }
  const characterData = await fetchEsiJson(
    `https://esi.evetech.net/latest/characters/${resolvedCharacterId}/?datasource=tranquility`,
    { cache }
  );
  const corporationId = characterData?.corporation_id ?? null;
  const allianceId = characterData?.alliance_id ?? null;
  let corporationName = null;
  let allianceName = null;
  if (corporationId) {
    const corporation = await fetchEsiJson(
      `https://esi.evetech.net/latest/corporations/${corporationId}/?datasource=tranquility`,
      { cache }
    );
    corporationName = corporation?.name ?? null;
  }
  if (allianceId) {
    const alliance = await fetchEsiJson(
      `https://esi.evetech.net/latest/alliances/${allianceId}/?datasource=tranquility`,
      { cache }
    );
    allianceName = alliance?.name ?? null;
  }
  return {
    characterId: resolvedCharacterId,
    corporationId,
    corporationName,
    allianceId,
    allianceName
  };
}

function canAddCharacters(accountName) {
  const moduleData = moduleManager.getModule('characters');
  const settings = moduleData
    ? moduleSettingsManager.getModuleSettings(moduleData)
    : {};
  if (settings.allowAllMembers) {
    return true;
  }
  return permissionsManager.hasPermission(accountName, 'characters.add');
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
