import html from './mobile.html';
import { DurableObject } from 'cloudflare:workers';

// ---------- Утилиты ----------
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type, Authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });
const fail = (message, status = 400) => json({ error: message }, status);

const enc = new TextEncoder();
const dec = new TextDecoder();
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));

async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  return `${toHex(new Uint8Array(bits))}:${toHex(salt)}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [hash, salt] = stored.split(':');
  const computed = await hashPassword(password, salt);
  return computed.split(':')[0] === hash;
}

function randomToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(24)));
}

// ---------- Durable Object: всё состояние чата ----------
export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.init();
  }

  init() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        is_group INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chat_members (
        chat_id INTEGER NOT NULL REFERENCES chats(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL REFERENCES chats(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        text TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    const g = this.sql.exec("SELECT id FROM chats WHERE name = 'Общий чат'").toArray();
    if (!g.length) this.sql.exec("INSERT INTO chats (name, is_group) VALUES ('Общий чат', 1)");
  }

  userByToken(token) {
    if (!token) return null;
    return this.sql.exec(`
      SELECT u.id, u.username FROM tokens t
      JOIN users u ON u.id = t.user_id WHERE t.token = ?
    `, token).toArray()[0] || null;
  }

  userFromRequest(request) {
    const auth = request.headers.get('Authorization') || '';
    return this.userByToken(auth.replace(/^Bearer\s+/i, ''));
  }

  get generalId() {
    return this.sql.exec("SELECT id FROM chats WHERE name = 'Общий чат'").toArray()[0].id;
  }

  // ---------- HTTP API ----------
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    if (path === '/ws') return this.handleSocket(request, url);

    let body = {};
    if (method === 'POST') {
      try { body = await request.json(); } catch { return fail('Некорректный JSON'); }
    }

    if (path === '/api/register' && method === 'POST') return this.register(body);
    if (path === '/api/login' && method === 'POST') return this.login(body);

    const user = this.userFromRequest(request);
    if (!user) return fail('Не авторизован', 401);

    if (path === '/api/me') return json(user);
    if (path === '/api/chats' && method === 'GET') return this.getChats(user);
    if (path === '/api/users' && method === 'GET') return this.getUsers(user);
    if (path === '/api/chats' && method === 'POST') return this.createChat(user, body);

    const m = path.match(/^\/api\/chats\/(\d+)\/messages$/);
    if (m) {
      const chatId = Number(m[1]);
      if (method === 'GET') return this.getMessages(user, chatId);
      if (method === 'POST') return this.postMessage(user, chatId, body);
    }

    return fail('Не найдено', 404);
  }

  async register(body) {
    const username = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(username))
      return fail('Юзернейм: 5–32 символа, только латиница, цифры и _');
    const password = String(body.password || '');
    if (password.length < 6) return fail('Пароль должен быть не короче 6 символов');

    const existing = this.sql.exec('SELECT * FROM users WHERE username = ?', username).toArray()[0];
    if (existing && existing.password_hash) return fail('Этот юзернейм уже занят');

    const hash = await hashPassword(password);
    let user;
    if (existing) {
      this.sql.exec('UPDATE users SET password_hash = ? WHERE id = ?', hash, existing.id);
      user = this.sql.exec('SELECT id, username FROM users WHERE id = ?', existing.id).toArray()[0];
    } else {
      user = this.sql.exec(
        'INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id, username',
        username, hash
      ).toArray()[0];
    }
    this.sql.exec('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)', this.generalId, user.id);
    const token = randomToken();
    this.sql.exec('INSERT INTO tokens (token, user_id) VALUES (?, ?)', token, user.id);
    return json({ token, user }, 201);
  }

  async login(body) {
    const username = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
    const user = this.sql.exec('SELECT * FROM users WHERE username = ?', username).toArray()[0];
    if (!user || !(await verifyPassword(String(body.password || ''), user.password_hash)))
      return fail('Неверный юзернейм или пароль');
    const token = randomToken();
    this.sql.exec('INSERT INTO tokens (token, user_id) VALUES (?, ?)', token, user.id);
    return json({ token, user: { id: user.id, username: user.username } });
  }

  getChats(user) {
    return json(this.sql.exec(`
      SELECT c.id, c.name, c.is_group,
        (SELECT text FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_time,
        (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) AS members_count
      FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
      WHERE cm.user_id = ?
      ORDER BY COALESCE((SELECT MAX(id) FROM messages WHERE chat_id = c.id), 0) DESC
    `, user.id).toArray());
  }

  getUsers(user) {
    return json(this.sql.exec('SELECT id, username FROM users WHERE id != ? ORDER BY username', user.id).toArray());
  }

  createChat(user, body) {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return fail('Введите название чата');
    const ids = [...new Set([user.id, ...(body.memberIds || []).map(Number)].filter(Boolean))];
    const chat = this.sql.exec(
      'INSERT INTO chats (name, is_group) VALUES (?, ?) RETURNING id, name',
      name, ids.length > 2 ? 1 : 0
    ).toArray()[0];
    for (const id of ids) this.sql.exec('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)', chat.id, id);
    return json(chat, 201);
  }

  getMessages(user, chatId) {
    const member = this.sql.exec('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, user.id).toArray()[0];
    if (!member) return fail('Нет доступа к чату', 403);
    return json(this.sql.exec(`
      SELECT m.id, m.text, m.created_at, u.id AS user_id, u.username
      FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 50
    `, chatId).toArray().reverse());
  }

  postMessage(user, chatId, body) {
    const text = String(body.text || '').trim().slice(0, 2000);
    if (!text) return fail('Пустое сообщение');
    const member = this.sql.exec('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, user.id).toArray()[0];
    if (!member) return fail('Вы не участник этого чата', 403);
    const msg = this.sql.exec(`
      INSERT INTO messages (chat_id, user_id, text) VALUES (?, ?, ?)
      RETURNING id, chat_id, user_id, text, created_at
    `, chatId, user.id, text).toArray()[0];
    msg.username = user.username;
    this.broadcast({ type: 'message:new', message: msg });
    return json(msg, 201);
  }

  // ---------- WebSocket ----------
  handleSocket(request, url) {
    const user = this.userByToken(url.searchParams.get('token'));
    if (!user) return new Response('Unauthorized', { status: 401 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId: user.id, username: user.username });
    this.broadcastOnline();
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(data, except) {
    const raw = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(raw); } catch { /* мёртвое соединение */ }
    }
  }

  broadcastOnline() {
    const ids = [...new Set(this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment()?.userId).filter(Boolean))];
    this.broadcast({ type: 'users:online', ids });
  }

  webSocketMessage(ws, raw) {
    const user = ws.deserializeAttachment();
    if (!user) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (data.type === 'typing') {
      this.broadcast({
        type: 'typing',
        userId: user.userId,
        username: user.username,
        isTyping: !!data.isTyping,
      }, ws);
    }
  }

  webSocketClose(ws) {
    this.broadcastOnline();
  }

  webSocketError(ws) {
    this.broadcastOnline();
  }
}

// ---------- Worker ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/mobile.html' || url.pathname === '/index.html') {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' },
      });
    }

    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      const id = env.CHAT.idFromName('main');
      return env.CHAT.get(id).fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
