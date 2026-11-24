const base = 'http://127.0.0.1:8787';
const s = Math.random().toString(36).slice(2, 7);
async function api(path, opts = {}) {
  const r = await fetch(base + '/api' + path, { ...opts, headers: { 'Content-Type':'application/json', ...(opts.headers||{}) } });
  return { status:r.status, data:await r.json().catch(()=>({})) };
}
const reg = await api('/register', {method:'POST', body:JSON.stringify({username:'rc'+s,password:'pass123'})});
console.log('register code:', reg.status, reg.data.recoveryCode);
const code = reg.data.recoveryCode;
const codeView = await api('/recovery-code', {headers:{Authorization:'Bearer '+reg.data.token}});
console.log('recovery-code endpoint:', codeView.status, codeView.data.code === code);
const bad = await api('/recover', {method:'POST', body:JSON.stringify({username:'rc'+s,recoveryCode:'0000-0000-0000',newPassword:'newpass'})});
console.log('wrong code rejected:', bad.status);
const rec = await api('/recover', {method:'POST', body:JSON.stringify({username:'rc'+s,recoveryCode:code,newPassword:'newpass'})});
console.log('recover:', rec.status, rec.data.ok, 'new code:', rec.data.recoveryCode);
const oldLogin = await api('/login', {method:'POST', body:JSON.stringify({username:'rc'+s,password:'pass123'})});
console.log('old password rejected:', oldLogin.status);
const newLogin = await api('/login', {method:'POST', body:JSON.stringify({username:'rc'+s,password:'newpass'})});
console.log('new password works:', newLogin.status);
const oldToken = await api('/chats', {headers:{Authorization:'Bearer '+reg.data.token}});
console.log('old sessions revoked:', oldToken.status);
process.exit(0);
