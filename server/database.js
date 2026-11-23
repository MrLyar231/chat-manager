import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashPassword, verifyPassword, signToken } from './auth.js';

// В облаке база лежит на постоянном диске, локально — рядом с сервером
const dbPath = process.env.DB_PATH || 'chat.db';
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    is_group    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id  INTEGER NOT NULL REFERENCES chats(id),
    user_id  INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL REFERENCES chats(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Миграция для старых баз, где пароля ещё не было
const columns = db.prepare('PRAGMA table_info(users)').all();
if (!columns.some((c) => c.name === 'password_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
}

// Общий чат, куда попадают все пользователи (удобно для теста)
const general = db.prepare('SELECT id FROM chats WHERE name = ?').get('Общий чат');
if (!general) {
  db.prepare('INSERT INTO chats (name, is_group) VALUES (?, 1)').run('Общий чат');
}

const GENERAL_ID = db.prepare('SELECT id FROM chats WHERE name = ?').get('Общий чат').id;

function normalizeUsername(raw) {
  return String(raw || '').trim().replace(/^@/, '').toLowerCase();
}

function validateUsername(username) {
  if (!/^[a-z0-9_]{5,32}$/.test(username)) {
    throw new Error('Юзернейм: 5–32 символа, только латиница, цифры и _');
  }
}

function joinGeneral(userId) {
  db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)')
    .run(GENERAL_ID, userId);
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

export function register(rawUsername, password) {
  const username = normalizeUsername(rawUsername);
  validateUsername(username);

  const pass = String(password || '');
  if (pass.length < 6) throw new Error('Пароль должен быть не короче 6 символов');

  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existing && existing.password_hash) {
    throw new Error('Этот юзернейм уже занят');
  }

  let user;
  if (existing) {
    // Позволяет «забрать» старый аккаунт из учебной версии без пароля
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(pass), existing.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  } else {
    const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, hashPassword(pass));
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  joinGeneral(user.id);

  return { token: signToken(user), user: publicUser(user) };
}

export function authenticate(rawUsername, password) {
  const username = normalizeUsername(rawUsername);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !user.password_hash || !verifyPassword(String(password || ''), user.password_hash)) {
    throw new Error('Неверный юзернейм или пароль');
  }

  return { token: signToken(user), user: publicUser(user) };
}

export function getUserById(id) {
  return db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) || null;
}

export function getChats(userId) {
  return db.prepare(`
    SELECT
      c.id, c.name, c.is_group,
      (SELECT m.text FROM messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
      (SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_time,
      (SELECT COUNT(*) FROM chat_members cm2 WHERE cm2.chat_id = c.id) AS members_count
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.chat_id = c.id), 0) DESC
  `).all(userId);
}

export function createChat(userId, name, memberIds = []) {
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) throw new Error('Введите название чата');

  const ids = [...new Set([userId, ...memberIds.map(Number)].filter(Boolean))];
  const create = db.transaction(() => {
    const info = db.prepare('INSERT INTO chats (name, is_group) VALUES (?, ?)')
      .run(cleanName, ids.length > 2 ? 1 : 0);
    const chatId = info.lastInsertRowid;
    const add = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)');
    for (const id of ids) add.run(chatId, id);
    return chatId;
  });
  return create();
}

export function getMessages(chatId, userId, limit = 50) {
  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(chatId, userId);
  if (!member) return null;

  return db.prepare(`
    SELECT m.id, m.text, m.created_at, u.id AS user_id, u.username
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.chat_id = ?
    ORDER BY m.id DESC LIMIT ?
  `).all(chatId, limit).reverse();
}

export function addMessage(chatId, userId, text) {
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) throw new Error('Пустое сообщение');

  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(chatId, userId);
  if (!member) throw new Error('Вы не участник этого чата');

  const info = db.prepare('INSERT INTO messages (chat_id, user_id, text) VALUES (?, ?, ?)')
    .run(chatId, userId, clean);

  return db.prepare(`
    SELECT m.id, m.text, m.created_at, u.id AS user_id, u.username
    FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?
  `).get(info.lastInsertRowid);
}

export function getUsersExcept(userId) {
  return db.prepare('SELECT id, username FROM users WHERE id != ? ORDER BY username').all(userId);
}

export default db;
