const base = 'https://chat-manager.reifly231.workers.dev';
const suffix = Math.random().toString(36).slice(2, 7);

async function api(path, opts = {}) {
  const res = await fetch(base + '/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const a = await api('/register', { method: 'POST', body: JSON.stringify({ username: 'dp' + suffix + 'a', password: 'pass123' }) });
const b = await api('/register', { method: 'POST', body: JSON.stringify({ username: 'dp' + suffix + 'b', password: 'pass123' }) });
console.log('register:', a.status, b.status);

const ws1 = new WebSocket(base.replace('https', 'wss') + '/ws?token=' + encodeURIComponent(a.data.token));
const ws2 = new WebSocket(base.replace('https', 'wss') + '/ws?token=' + encodeURIComponent(b.data.token));
await Promise.all([
  new Promise((r, j) => { ws1.onopen = r; ws1.onerror = j; }),
  new Promise((r, j) => { ws2.onopen = r; ws2.onerror = j; }),
]);
console.log('websockets connected');

let got = false;
ws2.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.type === 'message:new' && d.message.text === 'hi-' + suffix) got = true;
};

const posted = await api('/chats/1/messages', {
  method: 'POST',
  headers: { Authorization: `Bearer ${a.data.token}` },
  body: JSON.stringify({ text: 'hi-' + suffix }),
});
console.log('post message:', posted.status);
await new Promise((r) => setTimeout(r, 800));
console.log('delivered to another user:', got);

const html = await (await fetch(base + '/')).text();
console.log('mobile HTML:', html.includes('Chat Manager'));
console.log('URL:', base);
ws1.close(); ws2.close();
process.exit(got ? 0 : 1);
