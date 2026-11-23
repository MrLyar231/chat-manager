const base = 'http://127.0.0.1:8787';
const suffix = Math.random().toString(36).slice(2, 7);

async function api(path, opts = {}) {
  const res = await fetch(base + '/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const a = await api('/register', { method: 'POST', body: JSON.stringify({ username: 'cf' + suffix + 'a', password: 'pass123' }) });
const b = await api('/register', { method: 'POST', body: JSON.stringify({ username: 'cf' + suffix + 'b', password: 'pass123' }) });
console.log('register:', a.status, b.status);

const login = await api('/login', { method: 'POST', body: JSON.stringify({ username: '@cf' + suffix + 'a', password: 'pass123' }) });
console.log('login with @:', login.status);

const chats = await api('/chats', { headers: { Authorization: `Bearer ${a.data.token}` } });
console.log('chats:', chats.status, chats.data.length);

const ws1 = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + encodeURIComponent(a.data.token));
const ws2 = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + encodeURIComponent(b.data.token));
await Promise.all([
  new Promise((r, j) => { ws1.onopen = r; ws1.onerror = j; }),
  new Promise((r, j) => { ws2.onopen = r; ws2.onerror = j; }),
]);
console.log('websockets connected');

let got = false;
ws2.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.type === 'message:new' && d.message.text === 'hello-' + suffix) got = true;
};

const posted = await api('/chats/1/messages', {
  method: 'POST',
  headers: { Authorization: `Bearer ${a.data.token}` },
  body: JSON.stringify({ text: 'hello-' + suffix }),
});
console.log('post message:', posted.status);
await new Promise((r) => setTimeout(r, 500));
console.log('message delivered via WebSocket:', got);

const html = await (await fetch(base + '/')).text();
console.log('HTML served:', html.includes('Chat Manager'));

const bad = await api('/login', { method: 'POST', body: JSON.stringify({ username: 'cf' + suffix + 'a', password: 'wrong' }) });
console.log('wrong password rejected:', !!bad.data.error);

ws1.close(); ws2.close();
process.exit(got && bad.data.error ? 0 : 1);
