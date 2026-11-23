var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
import html from "./2cd2e892d061e01d114fe287ccd36fc3986e635d-mobile.html";
import { DurableObject } from "cloudflare:workers";
var HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};
var json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS }), "json");
var fail = /* @__PURE__ */ __name((message, status = 400) => json({ error: message }, status), "fail");
var enc = new TextEncoder();
var dec = new TextDecoder();
var toHex = /* @__PURE__ */ __name((bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""), "toHex");
var fromHex = /* @__PURE__ */ __name((hex) => new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16))), "fromHex");
async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    key,
    256
  );
  return `${toHex(new Uint8Array(bits))}:${toHex(salt)}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [hash, salt] = stored.split(":");
  const computed = await hashPassword(password, salt);
  return computed.split(":")[0] === hash;
}
__name(verifyPassword, "verifyPassword");
function randomToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(24)));
}
__name(randomToken, "randomToken");
var ChatRoom = class extends DurableObject {
  static {
    __name(this, "ChatRoom");
  }
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
    const g = this.sql.exec("SELECT id FROM chats WHERE name = '\u041E\u0431\u0449\u0438\u0439 \u0447\u0430\u0442'").toArray();
    if (!g.length) this.sql.exec("INSERT INTO chats (name, is_group) VALUES ('\u041E\u0431\u0449\u0438\u0439 \u0447\u0430\u0442', 1)");
  }
  userByToken(token) {
    if (!token) return null;
    return this.sql.exec(`
      SELECT u.id, u.username FROM tokens t
      JOIN users u ON u.id = t.user_id WHERE t.token = ?
    `, token).toArray()[0] || null;
  }
  userFromRequest(request) {
    const auth = request.headers.get("Authorization") || "";
    return this.userByToken(auth.replace(/^Bearer\s+/i, ""));
  }
  get generalId() {
    return this.sql.exec("SELECT id FROM chats WHERE name = '\u041E\u0431\u0449\u0438\u0439 \u0447\u0430\u0442'").toArray()[0].id;
  }
  // ---------- HTTP API ----------
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
    if (path === "/ws") return this.handleSocket(request, url);
    let body = {};
    if (method === "POST") {
      try {
        body = await request.json();
      } catch {
        return fail("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 JSON");
      }
    }
    if (path === "/api/register" && method === "POST") return this.register(body);
    if (path === "/api/login" && method === "POST") return this.login(body);
    const user = this.userFromRequest(request);
    if (!user) return fail("\u041D\u0435 \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u043E\u0432\u0430\u043D", 401);
    if (path === "/api/me") return json(user);
    if (path === "/api/chats" && method === "GET") return this.getChats(user);
    if (path === "/api/users" && method === "GET") return this.getUsers(user);
    if (path === "/api/chats" && method === "POST") return this.createChat(user, body);
    const m = path.match(/^\/api\/chats\/(\d+)\/messages$/);
    if (m) {
      const chatId = Number(m[1]);
      if (method === "GET") return this.getMessages(user, chatId);
      if (method === "POST") return this.postMessage(user, chatId, body);
    }
    return fail("\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E", 404);
  }
  async register(body) {
    const username = String(body.username || "").trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(username))
      return fail("\u042E\u0437\u0435\u0440\u043D\u0435\u0439\u043C: 5\u201332 \u0441\u0438\u043C\u0432\u043E\u043B\u0430, \u0442\u043E\u043B\u044C\u043A\u043E \u043B\u0430\u0442\u0438\u043D\u0438\u0446\u0430, \u0446\u0438\u0444\u0440\u044B \u0438 _");
    const password = String(body.password || "");
    if (password.length < 6) return fail("\u041F\u0430\u0440\u043E\u043B\u044C \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435 \u043A\u043E\u0440\u043E\u0447\u0435 6 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
    const existing = this.sql.exec("SELECT * FROM users WHERE username = ?", username).toArray()[0];
    if (existing && existing.password_hash) return fail("\u042D\u0442\u043E\u0442 \u044E\u0437\u0435\u0440\u043D\u0435\u0439\u043C \u0443\u0436\u0435 \u0437\u0430\u043D\u044F\u0442");
    const hash = await hashPassword(password);
    let user;
    if (existing) {
      this.sql.exec("UPDATE users SET password_hash = ? WHERE id = ?", hash, existing.id);
      user = this.sql.exec("SELECT id, username FROM users WHERE id = ?", existing.id).toArray()[0];
    } else {
      user = this.sql.exec(
        "INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id, username",
        username,
        hash
      ).toArray()[0];
    }
    this.sql.exec("INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)", this.generalId, user.id);
    const token = randomToken();
    this.sql.exec("INSERT INTO tokens (token, user_id) VALUES (?, ?)", token, user.id);
    return json({ token, user }, 201);
  }
  async login(body) {
    const username = String(body.username || "").trim().replace(/^@/, "").toLowerCase();
    const user = this.sql.exec("SELECT * FROM users WHERE username = ?", username).toArray()[0];
    if (!user || !await verifyPassword(String(body.password || ""), user.password_hash))
      return fail("\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u044E\u0437\u0435\u0440\u043D\u0435\u0439\u043C \u0438\u043B\u0438 \u043F\u0430\u0440\u043E\u043B\u044C");
    const token = randomToken();
    this.sql.exec("INSERT INTO tokens (token, user_id) VALUES (?, ?)", token, user.id);
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
    return json(this.sql.exec("SELECT id, username FROM users WHERE id != ? ORDER BY username", user.id).toArray());
  }
  createChat(user, body) {
    const name = String(body.name || "").trim().slice(0, 40);
    if (!name) return fail("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0447\u0430\u0442\u0430");
    const ids = [...new Set([user.id, ...(body.memberIds || []).map(Number)].filter(Boolean))];
    const chat = this.sql.exec(
      "INSERT INTO chats (name, is_group) VALUES (?, ?) RETURNING id, name",
      name,
      ids.length > 2 ? 1 : 0
    ).toArray()[0];
    for (const id of ids) this.sql.exec("INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)", chat.id, id);
    return json(chat, 201);
  }
  getMessages(user, chatId) {
    const member = this.sql.exec("SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?", chatId, user.id).toArray()[0];
    if (!member) return fail("\u041D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u0430 \u043A \u0447\u0430\u0442\u0443", 403);
    return json(this.sql.exec(`
      SELECT m.id, m.text, m.created_at, u.id AS user_id, u.username
      FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 50
    `, chatId).toArray().reverse());
  }
  postMessage(user, chatId, body) {
    const text = String(body.text || "").trim().slice(0, 2e3);
    if (!text) return fail("\u041F\u0443\u0441\u0442\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435");
    const member = this.sql.exec("SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?", chatId, user.id).toArray()[0];
    if (!member) return fail("\u0412\u044B \u043D\u0435 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A \u044D\u0442\u043E\u0433\u043E \u0447\u0430\u0442\u0430", 403);
    const msg = this.sql.exec(`
      INSERT INTO messages (chat_id, user_id, text) VALUES (?, ?, ?)
      RETURNING id, chat_id, user_id, text, created_at
    `, chatId, user.id, text).toArray()[0];
    msg.username = user.username;
    this.broadcast({ type: "message:new", message: msg });
    return json(msg, 201);
  }
  // ---------- WebSocket ----------
  handleSocket(request, url) {
    const user = this.userByToken(url.searchParams.get("token"));
    if (!user) return new Response("Unauthorized", { status: 401 });
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
      try {
        ws.send(raw);
      } catch {
      }
    }
  }
  broadcastOnline() {
    const ids = [...new Set(this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment()?.userId).filter(Boolean))];
    this.broadcast({ type: "users:online", ids });
  }
  webSocketMessage(ws, raw) {
    const user = ws.deserializeAttachment();
    if (!user) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data.type === "typing") {
      this.broadcast({
        type: "typing",
        userId: user.userId,
        username: user.username,
        isTyping: !!data.isTyping
      }, ws);
    }
  }
  webSocketClose(ws) {
    this.broadcastOnline();
  }
  webSocketError(ws) {
    this.broadcastOnline();
  }
};
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/mobile.html" || url.pathname === "/index.html") {
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" }
      });
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      const id = env.CHAT.idFromName("main");
      return env.CHAT.get(id).fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-fRyNwn/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-fRyNwn/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  ChatRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
