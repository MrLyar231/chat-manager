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

function newRecoveryCode() {
  const raw = toHex(crypto.getRandomValues(new Uint8Array(6))).toUpperCase();
  return `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}`;
}

const normCode = (c) => String(c || '').replace(/[^a-f0-9]/gi, '').toUpperCase();

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
        username_key TEXT,
        password_hash TEXT,
        display_name TEXT,
        bio TEXT,
        avatar_color TEXT,
        recovery_code TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        device TEXT,
        ip TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now'))
      );
    `);
    // Миграция для уже существующей базы сессий
    const tokenCols = this.sql.exec('PRAGMA table_info(tokens)').toArray();
    for (const col of ['device', 'ip', 'created_at', 'last_seen']) {
      if (!tokenCols.some((c) => c.name === col)) {
        this.sql.exec(`ALTER TABLE tokens ADD COLUMN ${col} TEXT`);
      }
    }
    this.sql.exec(`
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
        reply_to INTEGER,
        reactions TEXT,
        edited INTEGER DEFAULT 0,
        deleted INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chat_reads (
        chat_id INTEGER NOT NULL REFERENCES chats(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        last_message_id INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, user_id)
      );
    `);
    // Миграции для старых баз
    for (const [table, col, def] of [
      ['users', 'display_name', 'TEXT'], ['users', 'bio', 'TEXT'], ['users', 'avatar_color', 'TEXT'],
      ['users', 'recovery_code', 'TEXT'], ['users', 'username_key', 'TEXT'],
      ['messages', 'reply_to', 'INTEGER'], ['messages', 'reactions', 'TEXT'],
      ['messages', 'edited', 'INTEGER DEFAULT 0'], ['messages', 'deleted', 'INTEGER DEFAULT 0'],
    ]) {
      const cols = this.sql.exec(`PRAGMA table_info(${table})`).toArray();
      if (!cols.some((c) => c.name === col)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
    // Ключ в нижнем регистре для входа; отображаемое имя сохраняет оригинальный регистр
    this.sql.exec('UPDATE users SET username_key = lower(username) WHERE username_key IS NULL');
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_key ON users(username_key)');
    const g = this.sql.exec("SELECT id FROM chats WHERE name = 'Общий чат'").toArray();
    if (!g.length) this.sql.exec("INSERT INTO chats (name, is_group) VALUES ('Общий чат', 1)");
  }

  userByToken(token) {
    if (!token) return null;
    return this.sql.exec(`
      SELECT u.id, u.username, u.display_name, u.bio, u.avatar_color FROM tokens t
      JOIN users u ON u.id = t.user_id WHERE t.token = ?
    `, token).toArray()[0] || null;
  }

  userFromRequest(request) {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const user = this.userByToken(token);
    if (user) {
      user._token = token;
      this.sql.exec("UPDATE tokens SET last_seen = datetime('now') WHERE token = ?", token);
    }
    return user;
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
    if (['POST', 'PATCH', 'PUT'].includes(method)) {
      try { body = await request.json(); } catch { return fail('Некорректный JSON'); }
    }

    if (path === '/api/register' && method === 'POST') return this.register(body, request);
    if (path === '/api/login' && method === 'POST') return this.login(body, request);
    if (path === '/api/recover' && method === 'POST') return this.recover(body);
    const user = this.userFromRequest(request);
    if (!user) return fail('Не авторизован', 401);

    if (path === '/api/account' && method === 'DELETE') return this.deleteUserAccount(user.username);
    if (path === '/api/recovery-code' && method === 'GET') return this.getRecoveryCode(user);
    if (path === '/api/me' && method === 'GET') return json(user);
    if (path === '/api/me' && method === 'PATCH') return this.updateProfile(user, body);
    if (path === '/api/chats' && method === 'GET') return this.getChats(user);
    if (path === '/api/users' && method === 'GET') return this.searchUsers(user, url.searchParams.get('q'));
    if (path === '/api/sessions' && method === 'GET') return this.getSessions(user);
    if (path === '/api/sessions/revoke' && method === 'POST') return this.revokeSession(user, body);
    if (path === '/api/sessions/revoke-others' && method === 'POST') return this.revokeOthers(user);
    if (path === '/api/chats' && method === 'POST') return this.createChat(user, body);

    const m = path.match(/^\/api\/chats\/(\d+)\/messages$/);
    if (m) {
      const chatId = Number(m[1]);
      if (method === 'GET') return this.getMessages(user, chatId);
      if (method === 'POST') return this.postMessage(user, chatId, body);
    }

    let mm = path.match(/^\/api\/chats\/(\d+)\/(read|leave|search)$/);
    if (mm) {
      const chatId = Number(mm[1]);
      if (mm[2] === 'read' && method === 'POST') return this.markRead(user, chatId, body);
      if (mm[2] === 'leave' && method === 'POST') return this.leaveChat(user, chatId);
      if (mm[2] === 'search' && method === 'GET') return this.searchMessages(user, chatId, url.searchParams.get('q'));
    }

    const msg = path.match(/^\/api\/messages\/(\d+)\/(edit|delete|react)$/);
    if (msg) {
      const messageId = Number(msg[1]);
      if (msg[2] === 'edit' && method === 'PATCH') return this.editMessage(user, messageId, body);
      if (msg[2] === 'delete' && method === 'DELETE') return this.deleteMessage(user, messageId);
      if (msg[2] === 'react' && method === 'POST') return this.reactMessage(user, messageId, body);
    }

    return fail('Не найдено', 404);
  }

  clientIp(request) {
    return (
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      ''
    );
  }

  async register(body, request) {
    const original = String(body.username || '').trim().replace(/^@/, '').slice(0, 32);
    const username = original.toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(username))
      return fail('Юзернейм: 5–32 символа, только латиница, цифры и _');
    const password = String(body.password || '');
    if (password.length < 6) return fail('Пароль должен быть не короче 6 символов');

    const existing = this.sql.exec('SELECT * FROM users WHERE username_key = ?', username).toArray()[0];
    if (existing && existing.password_hash) return fail('Этот юзернейм уже занят');

    const hash = await hashPassword(password);
    let recovery = newRecoveryCode();
    let user;
    if (existing) {
      this.sql.exec('UPDATE users SET password_hash = ?, recovery_code = COALESCE(recovery_code, ?) WHERE id = ?', hash, recovery, existing.id);
      user = this.sql.exec('SELECT id, username, display_name, bio, avatar_color, recovery_code FROM users WHERE id = ?', existing.id).toArray()[0];
      recovery = user.recovery_code;
    } else {
      user = this.sql.exec(
        'INSERT INTO users (username, username_key, password_hash, display_name, bio, avatar_color, recovery_code) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, username, display_name, bio, avatar_color, recovery_code',
        original, username, hash, original, '', '#4fa8f5', recovery
      ).toArray()[0];
    }
    this.sql.exec('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)', this.generalId, user.id);
    const token = randomToken();
    this.sql.exec(
      'INSERT INTO tokens (token, user_id, device, ip) VALUES (?, ?, ?, ?)',
      token, user.id, String(body.device || 'Устройство').slice(0, 80), this.clientIp(request)
    );
    return json({ token, user, recoveryCode: recovery }, 201);
  }

  async login(body, request) {
    const username = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
    const user = this.sql.exec('SELECT * FROM users WHERE username_key = ?', username).toArray()[0];
    if (!user || !(await verifyPassword(String(body.password || ''), user.password_hash)))
      return fail('Неверный юзернейм или пароль');
    const token = randomToken();
    this.sql.exec(
      'INSERT INTO tokens (token, user_id, device, ip) VALUES (?, ?, ?, ?)',
      token, user.id, String(body.device || 'Устройство').slice(0, 80), this.clientIp(request)
    );
    return json({ token, user: {
      id: user.id, username: user.username,
      display_name: user.display_name, bio: user.bio, avatar_color: user.avatar_color,
    } });
  }

  deleteUserAccount(username) {
    const name = String(username || '').trim().replace(/^@/, '').toLowerCase();
    const user = this.sql.exec('SELECT id FROM users WHERE username_key = ?', name).toArray()[0];
    if (!user) return fail('Пользователь не найден', 404);
    const chatIds = this.sql.exec('SELECT chat_id FROM chat_members WHERE user_id = ?', user.id)
      .toArray().map((r) => r.chat_id);
    this.sql.exec('DELETE FROM messages WHERE user_id = ?', user.id);
    this.sql.exec('DELETE FROM chat_members WHERE user_id = ?', user.id);
    this.sql.exec('DELETE FROM chat_reads WHERE user_id = ?', user.id);
    this.sql.exec('DELETE FROM tokens WHERE user_id = ?', user.id);
    for (const cid of chatIds) {
      const left = this.sql.exec('SELECT COUNT(*) AS c FROM chat_members WHERE chat_id = ?', cid).toArray()[0].c;
      if (!left) this.sql.exec('DELETE FROM chats WHERE id = ?', cid);
    }
    this.sql.exec('DELETE FROM users WHERE id = ?', user.id);
    return json({ ok: true });
  }

  getRecoveryCode(user) {
    const row = this.sql.exec('SELECT recovery_code FROM users WHERE id = ?', user.id).toArray()[0];
    if (row?.recovery_code) return json({ code: row.recovery_code });
    const code = newRecoveryCode();
    this.sql.exec('UPDATE users SET recovery_code = ? WHERE id = ?', code, user.id);
    return json({ code });
  }

  async recover(body) {
    const username = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
    const user = this.sql.exec('SELECT * FROM users WHERE username_key = ?', username).toArray()[0];
    const code = normCode(body.recoveryCode);
    if (!user || !user.recovery_code || normCode(user.recovery_code) !== code)
      return fail('Неверный юзернейм или код восстановления');
    const password = String(body.newPassword || '');
    if (password.length < 6) return fail('Новый пароль должен быть не короче 6 символов');

    const newCode = newRecoveryCode();
    this.sql.exec('UPDATE users SET password_hash = ?, recovery_code = ? WHERE id = ?',
      await hashPassword(password), newCode, user.id);
    this.sql.exec('DELETE FROM tokens WHERE user_id = ?', user.id);
    return json({ ok: true, recoveryCode: newCode });
  }

  getChats(user) {
    return json(this.sql.exec(`
      SELECT c.id, c.name, c.is_group,
        (SELECT text FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_time,
        (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) AS members_count,
        COALESCE((SELECT MAX(id) FROM messages WHERE chat_id = c.id), 0) AS last_id,
        COALESCE((SELECT last_message_id FROM chat_reads WHERE chat_id = c.id AND user_id = ?), 0) AS read_id
      FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
      WHERE cm.user_id = ?
      ORDER BY COALESCE((SELECT MAX(id) FROM messages WHERE chat_id = c.id), 0) DESC
    `, user.id, user.id).toArray());
  }

  searchUsers(user, query) {
    const q = String(query || '').trim().replace(/^@/, '').toLowerCase().slice(0, 32);
    if (q.length < 2) return json([]);
    return json(this.sql.exec(`
      SELECT id, username, display_name, bio, avatar_color FROM users
      WHERE id != ? AND username_key LIKE ?
      ORDER BY username LIMIT 20
    `, user.id, `%${q}%`).toArray());
  }

  getSessions(user) {
    const rows = this.sql.exec(`
      SELECT token, device, ip, created_at, last_seen FROM tokens
      WHERE user_id = ? ORDER BY last_seen DESC
    `, user.id).toArray();
    return json(rows.map((s) => ({
      token: s.token,
      device: s.device || 'Неизвестное устройство',
      ip: s.ip || '',
      created_at: s.created_at,
      last_seen: s.last_seen,
      current: s.token === user._token,
    })));
  }

  revokeSession(user, body) {
    const token = String(body.token || '');
    const row = this.sql.exec('SELECT user_id FROM tokens WHERE token = ?', token).toArray()[0];
    if (!row || row.user_id !== user.id) return fail('Сессия не найдена', 404);
    this.sql.exec('DELETE FROM tokens WHERE token = ?', token);
    return json({ ok: true });
  }

  revokeOthers(user) {
    this.sql.exec('DELETE FROM tokens WHERE user_id = ? AND token != ?', user.id, user._token);
    return json({ ok: true });
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

  msgSelect(chatId, where = '', params = []) {
    return this.sql.exec(`
      SELECT m.id, m.chat_id, m.text, m.created_at, m.reply_to, m.reactions, m.edited, m.deleted,
        u.id AS user_id, u.username, u.display_name, u.avatar_color,
        r.text AS reply_text, ru.username AS reply_username
      FROM messages m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN messages r ON r.id = m.reply_to
      LEFT JOIN users ru ON ru.id = r.user_id
      WHERE m.chat_id = ? ${where}
      ORDER BY m.id DESC LIMIT 50
    `, chatId, ...params).toArray().reverse();
  }

  getMessages(user, chatId) {
    const member = this.sql.exec('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, user.id).toArray()[0];
    if (!member) return fail('Нет доступа к чату', 403);
    const read = this.sql.exec('SELECT last_message_id FROM chat_reads WHERE chat_id = ? AND user_id = ?', chatId, user.id).toArray()[0];
    return json(this.msgSelect(chatId));
  }

  postMessage(user, chatId, body) {
    const text = String(body.text || '').trim().slice(0, 2000);
    if (!text) return fail('Пустое сообщение');
    const member = this.sql.exec('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, user.id).toArray()[0];
    if (!member) return fail('Вы не участник этого чата', 403);
    let replyTo = Number(body.replyTo) || null;
    if (replyTo) {
      const orig = this.sql.exec('SELECT chat_id FROM messages WHERE id = ?', replyTo).toArray()[0];
      if (!orig || orig.chat_id !== chatId) replyTo = null;
    }
    const msg = this.sql.exec(`
      INSERT INTO messages (chat_id, user_id, text, reply_to) VALUES (?, ?, ?, ?)
      RETURNING id, chat_id, user_id, text, reply_to, created_at
    `, chatId, user.id, text, replyTo).toArray()[0];
    msg.username = user.username;
    msg.display_name = user.display_name;
    msg.avatar_color = user.avatar_color;
    if (replyTo) {
      const r = this.sql.exec(`
        SELECT m.text AS reply_text, u.username AS reply_username
        FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?
      `, replyTo).toArray()[0];
      if (r) Object.assign(msg, r);
    }
    this.broadcast({ type: 'message:new', message: msg });
    return json(msg, 201);
  }

  updateProfile(user, body) {
    const name = String(body.displayName ?? '').trim().slice(0, 40);
    const bio = String(body.bio ?? '').trim().slice(0, 160);
    const color = /^#[0-9a-fA-F]{6}$/.test(body.avatarColor || '') ? body.avatarColor : user.avatar_color;
    this.sql.exec('UPDATE users SET display_name = ?, bio = ?, avatar_color = ? WHERE id = ?',
      name || user.username, bio, color, user.id);
    const updated = this.sql.exec('SELECT id, username, display_name, bio, avatar_color FROM users WHERE id = ?', user.id).toArray()[0];
    this.broadcast({ type: 'profile:updated', user: updated });
    return json(updated);
  }

  editMessage(user, id, body) {
    const row = this.sql.exec('SELECT user_id, chat_id FROM messages WHERE id = ?', id).toArray()[0];
    if (!row || row.user_id !== user.id) return fail('Нельзя редактировать это сообщение', 403);
    const text = String(body.text || '').trim().slice(0, 2000);
    if (!text) return fail('Пустое сообщение');
    this.sql.exec('UPDATE messages SET text = ?, edited = 1 WHERE id = ?', text, id);
    const updated = this.msgSelect(row.chat_id).find((m) => m.id === id);
    this.broadcast({ type: 'message:edited', message: updated });
    return json(updated);
  }

  deleteMessage(user, id) {
    const row = this.sql.exec('SELECT user_id, chat_id FROM messages WHERE id = ?', id).toArray()[0];
    if (!row || row.user_id !== user.id) return fail('Нельзя удалить это сообщение', 403);
    this.sql.exec('UPDATE messages SET deleted = 1, text = "" WHERE id = ?', id);
    this.broadcast({ type: 'message:deleted', id, chatId: row.chat_id });
    return json({ ok: true });
  }

  reactMessage(user, id, body) {
    const row = this.sql.exec('SELECT chat_id, reactions FROM messages WHERE id = ?', id).toArray()[0];
    if (!row) return fail('Сообщение не найдено', 404);
    const emoji = String(body.emoji || '').slice(0, 8);
    if (!emoji) return fail('Выберите эмодзи');
    let reactions = {};
    try { reactions = JSON.parse(row.reactions || '{}'); } catch {}
    reactions[emoji] = reactions[emoji] || [];
    if (reactions[emoji].includes(user.id)) reactions[emoji] = reactions[emoji].filter((x) => x !== user.id);
    else reactions[emoji].push(user.id);
    if (!reactions[emoji].length) delete reactions[emoji];
    this.sql.exec('UPDATE messages SET reactions = ? WHERE id = ?', JSON.stringify(reactions), id);
    const updated = this.msgSelect(row.chat_id).find((m) => m.id === id);
    this.broadcast({ type: 'reaction:new', message: updated });
    return json(updated);
  }

  markRead(user, chatId, body) {
    const member = this.sql.exec('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, user.id).toArray()[0];
    if (!member) return fail('Нет доступа', 403);
    const last = Number(body.lastMessageId) || 0;
    this.sql.exec(`INSERT INTO chat_reads (chat_id, user_id, last_message_id) VALUES (?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET last_message_id = MAX(last_message_id, excluded.last_message_id)`,
      chatId, user.id, last);
    this.broadcast({ type: 'read:update', chatId, userId: user.id, lastMessageId: last });
    return json({ ok: true });
  }

  searchMessages(user, chatId, q) {
    const member = this.sql.exec('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, user.id).toArray()[0];
    if (!member) return fail('Нет доступа', 403);
    const query = String(q || '').trim().slice(0, 64);
    if (query.length < 2) return json([]);
    return json(this.msgSelect(chatId, 'AND m.text LIKE ?', [`%${query}%`]));
  }

  leaveChat(user, chatId) {
    const chat = this.sql.exec('SELECT name FROM chats WHERE id = ?', chatId).toArray()[0];
    if (!chat) return fail('Чат не найден', 404);
    if (chat.name === 'Общий чат') return fail('Нельзя покинуть общий чат');
    this.sql.exec('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, user.id);
    return json({ ok: true });
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
        chatId: data.chatId,
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
