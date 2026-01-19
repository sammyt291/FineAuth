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
      refresh_token TEXT,
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
  ensureColumn(db, 'characters', 'character_id', 'INTEGER');
  ensureColumn(db, 'characters', 'corporation_id', 'INTEGER');
  ensureColumn(db, 'characters', 'corporation_name', 'TEXT');
  ensureColumn(db, 'characters', 'alliance_id', 'INTEGER');
  ensureColumn(db, 'characters', 'alliance_name', 'TEXT');
  ensureColumn(db, 'characters', 'updated_at', 'TEXT');
  ensureColumn(db, 'characters', 'refresh_token', 'TEXT');
  ensureColumn(db, 'characters', 'refresh_token_hash', 'TEXT');
  ensureColumn(db, 'accounts', 'refresh_token', 'TEXT');
  return db;
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
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
    `INSERT INTO accounts (type, name, refresh_token, access_token_hash, refresh_token_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const result = insertAccount.run(
    accountRecord.type,
    accountRecord.name,
    refreshToken ?? null,
    accountRecord.accessTokenHash,
    accountRecord.refreshTokenHash,
    createdAt
  );

  const accountId = result.lastInsertRowid;
  if (Array.isArray(characterNames)) {
    const insertCharacter = db.prepare(
      `INSERT INTO characters (account_id, name, character_id, corporation_id, corporation_name, alliance_id, alliance_name, refresh_token, refresh_token_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    characterNames.forEach((characterName) => {
      const {
        name: resolvedName,
        characterId,
        corporationId,
        corporationName,
        allianceId,
        allianceName,
        refreshToken
      } = normalizeCharacterDetails(characterName);
      const timestamp = new Date().toISOString();
      const refreshTokenHash = refreshToken ? hashToken(refreshToken) : null;
      insertCharacter.run(
        accountId,
        resolvedName,
        characterId,
        corporationId,
        corporationName,
        allianceId,
        allianceName,
        refreshToken ?? null,
        refreshTokenHash,
        createdAt,
        timestamp
      );
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
  return db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all();
}

export function listCharactersForAccount(db, accountId) {
  return db
    .prepare('SELECT * FROM characters WHERE account_id = ? ORDER BY name ASC')
    .all(accountId);
}

export function getAccountById(db, accountId) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
}

export function getAccountByName(db, accountName) {
  if (!accountName) {
    return null;
  }
  return db
    .prepare(
      'SELECT * FROM accounts WHERE name = ? COLLATE NOCASE ORDER BY created_at ASC LIMIT 1'
    )
    .get(accountName);
}

export function getAccountByCharacterName(db, characterName) {
  if (!characterName) {
    return null;
  }
  return db
    .prepare(
      `SELECT accounts.*
       FROM accounts
       JOIN characters ON characters.account_id = accounts.id
       WHERE characters.name = ? COLLATE NOCASE
       ORDER BY accounts.created_at ASC
       LIMIT 1`
    )
    .get(characterName);
}

export function updateAccountTokens(db, accountId, { accessToken, refreshToken }) {
  if (!accountId || !accessToken) {
    return;
  }
  db.prepare(
    `UPDATE accounts
     SET refresh_token = ?,
         access_token_hash = ?,
         refresh_token_hash = ?
     WHERE id = ?`
  ).run(
    refreshToken ?? null,
    hashToken(accessToken),
    refreshToken ? hashToken(refreshToken) : null,
    accountId
  );
}

export function getModuleAccountData(db, accountId, moduleName) {
  if (!accountId || !moduleName) {
    return null;
  }
  return db
    .prepare(
      'SELECT * FROM module_account_data WHERE account_id = ? AND module_name = ?'
    )
    .get(accountId, moduleName);
}

export function addCharacterToAccount(db, accountId, characterInput) {
  const {
    name: characterName,
    characterId,
    corporationId,
    corporationName,
    allianceId,
    allianceName,
    refreshToken
  } = normalizeCharacterDetails(characterInput);
  if (!accountId || !characterName) {
    return { added: false };
  }
  const existing = db
    .prepare(
      'SELECT id FROM characters WHERE account_id = ? AND name = ? COLLATE NOCASE'
    )
    .get(accountId, characterName);
  if (existing) {
    if (
      characterId ||
      corporationId ||
      corporationName ||
      allianceId ||
      allianceName
    ) {
      updateCharacterDetails(db, existing.id, {
        name: characterName,
        characterId,
        corporationId,
        corporationName,
        allianceId,
        allianceName
      });
    }
    if (refreshToken) {
      updateCharacterTokens(db, existing.id, refreshToken);
    }
    return { added: false, existingId: existing.id };
  }
  const createdAt = new Date().toISOString();
  const refreshTokenHash = refreshToken ? hashToken(refreshToken) : null;
  const result = db
    .prepare(
      `INSERT INTO characters (account_id, name, character_id, corporation_id, corporation_name, alliance_id, alliance_name, refresh_token, refresh_token_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      accountId,
      characterName,
      characterId,
      corporationId,
      corporationName,
      allianceId,
      allianceName,
      refreshToken ?? null,
      refreshTokenHash,
      createdAt,
      createdAt
    );
  return { added: true, characterId: result.lastInsertRowid };
}

export function updateCharacterTokens(db, characterRowId, refreshToken) {
  if (!characterRowId || !refreshToken) {
    return;
  }
  db.prepare(
    `UPDATE characters
     SET refresh_token = ?,
         refresh_token_hash = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    refreshToken,
    hashToken(refreshToken),
    new Date().toISOString(),
    characterRowId
  );
}

export function updateCharacterDetails(db, characterRowId, details) {
  if (!characterRowId) {
    return;
  }
  const {
    name,
    characterId,
    corporationId,
    corporationName,
    allianceId,
    allianceName
  } = normalizeCharacterDetails(details);
  db.prepare(
    `UPDATE characters
     SET name = ?,
         character_id = ?,
         corporation_id = ?,
         corporation_name = ?,
         alliance_id = ?,
         alliance_name = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    name,
    characterId,
    corporationId,
    corporationName,
    allianceId,
    allianceName,
    new Date().toISOString(),
    characterRowId
  );
}

function normalizeCharacterDetails(characterInput) {
  if (typeof characterInput === 'string') {
    return {
      name: characterInput,
      characterId: null,
      corporationId: null,
      corporationName: null,
      allianceId: null,
      allianceName: null,
      refreshToken: null
    };
  }
  return {
    name: characterInput?.name ?? '',
    characterId: characterInput?.characterId ?? null,
    corporationId: characterInput?.corporationId ?? null,
    corporationName: characterInput?.corporationName ?? null,
    allianceId: characterInput?.allianceId ?? null,
    allianceName: characterInput?.allianceName ?? null,
    refreshToken: characterInput?.refreshToken ?? null
  };
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
