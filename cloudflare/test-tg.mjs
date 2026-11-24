const base = 'http://127.0.0.1:8787';
const s = Math.random().toString(36).slice(2, 7);
async function api(path, opts = {}) {
  const r = await fetch(base + '/api' + path, { ...opts, headers: { 'Content-Type':'application/json', ...(opts.headers||{}) } });
  return { status: r.status, data: await r.json().catch(()=>({})) };
}
const a = await api('/register', { method:'POST', body:JSON.stringify({username:'tg'+s+'a',password:'pass123',device:'Test'}) });
const b = await api('/register', { method:'POST', body:JSON.stringify({username:'tg'+s+'b',password:'pass123',device:'Test'}) });
const H = { Authorization:'Bearer ' + a.data.token };

const p = await api('/me', { method:'PATCH', headers:H, body:JSON.stringify({displayName:'Алиса', bio:'привет', avatarColor:'#ff0000'}) });
console.log('profile patch:', p.status, p.data.display_name);

const m1 = await api('/chats/1/messages', { method:'POST', headers:H, body:JSON.stringify({text:'первое сообщение'}) });
const m2 = await api('/chats/1/messages', { method:'POST', headers:H, body:JSON.stringify({text:'ответ', replyTo:m1.data.id}) });
console.log('reply:', m2.status, m2.data.reply_to === m1.data.id, m2.data.reply_text);

const edit = await api(`/messages/${m1.data.id}/edit`, { method:'PATCH', headers:H, body:JSON.stringify({text:'изменённое'}) });
console.log('edit:', edit.status, edit.data.edited, edit.data.text);

const react = await api(`/messages/${m1.data.id}/react`, { method:'POST', headers:H, body:JSON.stringify({emoji:'🔥'}) });
console.log('react:', react.status, JSON.stringify(react.data.reactions));

const del = await api(`/messages/${m2.data.id}/delete`, { method:'DELETE', headers:H });
console.log('delete:', del.status, del.data.ok);

const msgs = await api('/chats/1/messages', { headers:H });
console.log('messages:', msgs.status, msgs.data.length, msgs.data[0].text, msgs.data[0].deleted);

const search = await api('/chats/1/search?q=измен', { headers:H });
console.log('search:', search.status, search.data.length);

const read = await api('/chats/1/read', { method:'POST', headers:H, body:JSON.stringify({lastMessageId:m1.data.id}) });
console.log('read:', read.status, read.data.ok);

const chats = await api('/chats', { headers:H });
console.log('chats unread:', chats.status, chats.data[0].last_id, chats.data[0].read_id);

const badEdit = await api(`/messages/${m1.data.id}/edit`, { method:'PATCH', headers:{Authorization:'Bearer ' + b.data.token}, body:JSON.stringify({text:'хак'}) });
console.log("can't edit other's message:", badEdit.status);
process.exit(0);
