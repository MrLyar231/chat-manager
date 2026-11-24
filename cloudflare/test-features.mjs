const base = 'http://127.0.0.1:8787';
const s = Math.random().toString(36).slice(2, 7);

async function api(path, opts = {}) {
  const res = await fetch(base + '/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const a = await api('/register', { method:'POST', body:JSON.stringify({username:'sea'+s+'a', password:'pass123', device:'Chrome · Windows'}) });
const b = await api('/register', { method:'POST', body:JSON.stringify({username:'sea'+s+'b', password:'pass123', device:'Safari · iOS'}) });
console.log('register with device:', a.status, b.status);

const search = await api('/users?q=' + s, { headers:{ Authorization:'Bearer ' + a.data.token } });
console.log('search by query:', search.status, search.data.map(u=>u.username));

const none = await api('/users', { headers:{ Authorization:'Bearer ' + a.data.token } });
console.log('no query returns empty:', none.status, none.data.length === 0);

const sessions = await api('/sessions', { headers:{ Authorization:'Bearer ' + a.data.token } });
console.log('sessions:', sessions.status, sessions.data.length, sessions.data[0].device, sessions.data[0].current);

const login2 = await api('/login', { method:'POST', body:JSON.stringify({username:'sea'+s+'a', password:'pass123', device:'Firefox · Android'}) });
const sessions2 = await api('/sessions', { headers:{ Authorization:'Bearer ' + a.data.token } });
console.log('sessions after 2nd login:', sessions2.data.length);

const revoke = await api('/sessions/revoke', {
  method:'POST', headers:{ Authorization:'Bearer ' + a.data.token },
  body: JSON.stringify({ token: login2.data.token }),
});
console.log('revoke session:', revoke.status, revoke.data.ok);

const sessions3 = await api('/sessions', { headers:{ Authorization:'Bearer ' + a.data.token } });
console.log('sessions after revoke:', sessions3.data.length);

const bad = await api('/sessions/revoke', {
  method:'POST', headers:{ Authorization:'Bearer ' + b.data.token },
  body: JSON.stringify({ token: a.data.token }),
});
console.log("can't revoke someone else's session:", bad.status);

process.exit(0);
