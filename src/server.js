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
  listCharactersForAccount,
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

app.get('/api/modules', (req, res) => {
  res.json({ modules: moduleManager.listModules() });
});

app.get('/api/session', (req, res) => {
  const token = parseToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }
  const account = getAccountByToken(db, token);
  if (!account) {
    res.status(401).json({ error: 'Invalid token' });
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
    type: 'admin',
    name: username,
    accessToken,
    refreshToken: null,
    characterNames: [],
    moduleData: {},
    moduleAccountModifiers: moduleManager.getAccountModifiers()
  });
  res.json({ token: accessToken, accountId });
});

app.post('/api/login/esi', (req, res) => {
  const { mainCharacterName } = req.body;
  if (!mainCharacterName) {
    res.status(400).json({ error: 'Main character name required' });
    return;
  }
  const accessToken = cryptoRandom();
  const refreshToken = cryptoRandom();
  const { accountId } = saveAccount({
    db,
    type: 'esi',
    name: mainCharacterName,
    accessToken,
    refreshToken,
    characterNames: [mainCharacterName],
    moduleData: {},
    moduleAccountModifiers: moduleManager.getAccountModifiers()
  });
  res.json({ token: accessToken, accountId });
});

app.post('/api/modules/:name/account-data', (req, res) => {
  const token = parseToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }
  const account = getAccountByToken(db, token);
  if (!account) {
    res.status(401).json({ error: 'Invalid token' });
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
