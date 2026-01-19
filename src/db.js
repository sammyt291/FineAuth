import Database from 'better-sqlite3';
import crypto from 'crypto';

const HASH_ALGO = 'sha256';

export function openDatabase(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      access_token_hash TEXT NOT NULL,
      refresh_token_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS module_account_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      module_name TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
  `);
  return db;
}

export function hashToken(token) {
  return crypto.createHash(HASH_ALGO).update(token).digest('hex');
}

export function saveAccount({
  db,
  type,
  name,
  accessToken,
  refreshToken,
  characterNames,
  moduleData,
  moduleAccountModifiers
}) {
  const createdAt = new Date().toISOString();
  let accountRecord = {
    type,
    name,
    accessTokenHash: hashToken(accessToken),
    refreshTokenHash: refreshToken ? hashToken(refreshToken) : null
  };

  for (const modifier of moduleAccountModifiers) {
    accountRecord = modifier(accountRecord) ?? accountRecord;
  }

  const insertAccount = db.prepare(
    `INSERT INTO accounts (type, name, access_token_hash, refresh_token_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const result = insertAccount.run(
    accountRecord.type,
    accountRecord.name,
    accountRecord.accessTokenHash,
    accountRecord.refreshTokenHash,
    createdAt
  );

  const accountId = result.lastInsertRowid;
  if (Array.isArray(characterNames)) {
    const insertCharacter = db.prepare(
      `INSERT INTO characters (account_id, name, created_at) VALUES (?, ?, ?)`
    );
    characterNames.forEach((characterName) => {
      insertCharacter.run(accountId, characterName, createdAt);
    });
  }

  if (moduleData) {
    const insertModuleData = db.prepare(
      `INSERT INTO module_account_data (account_id, module_name, data_json, created_at)
       VALUES (?, ?, ?, ?)`
    );
    for (const [moduleName, data] of Object.entries(moduleData)) {
      insertModuleData.run(accountId, moduleName, JSON.stringify(data), createdAt);
    }
  }

  return { accountId, createdAt };
}

export function getAccountByToken(db, accessToken) {
  const tokenHash = hashToken(accessToken);
  return db
    .prepare('SELECT * FROM accounts WHERE access_token_hash = ?')
    .get(tokenHash);
}

export function listAccounts(db) {
  return db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
}

export function listCharactersForAccount(db, accountId) {
  return db
    .prepare('SELECT * FROM characters WHERE account_id = ? ORDER BY name ASC')
    .all(accountId);
}

export function deleteAccount(db, accountId) {
  db.prepare('DELETE FROM module_account_data WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM characters WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
}

export function upsertModuleAccountData(db, accountId, moduleName, data) {
  const existing = db
    .prepare(
      'SELECT id FROM module_account_data WHERE account_id = ? AND module_name = ?'
    )
    .get(accountId, moduleName);
  if (existing) {
    db.prepare('UPDATE module_account_data SET data_json = ? WHERE id = ?').run(
      JSON.stringify(data),
      existing.id
    );
    return;
  }
  db.prepare(
    'INSERT INTO module_account_data (account_id, module_name, data_json, created_at) VALUES (?, ?, ?, ?)'
  ).run(accountId, moduleName, JSON.stringify(data), new Date().toISOString());
}
