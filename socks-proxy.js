// Минимальный SOCKS5-прокси для локальной сети.
// Весь исходящий трафик идёт через системный маршрут (сейчас — через Cloudflare WARP).
import net from 'node:net';

const PORT = Number(process.env.SOCKS_PORT || 1080);
const HOST = process.env.SOCKS_HOST || '0.0.0.0';

const server = net.createServer((client) => {
  let stage = 'hello';
  let pending = Buffer.alloc(0);
  let upstream = null;

  client.on('error', () => cleanup());
  client.on('close', () => cleanup());

  function cleanup() {
    if (upstream) { try { upstream.destroy(); } catch {} upstream = null; }
    try { client.destroy(); } catch {}
  }

  client.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);

    if (stage === 'hello') {
      if (pending.length < 2) return;
      const nmethods = pending[1];
      if (pending.length < 2 + nmethods) return;
      pending = pending.subarray(2 + nmethods);
      client.write(Buffer.from([0x05, 0x00])); // без аутентификации
      stage = 'request';
    }

    if (stage === 'request') {
      if (pending.length < 5) return;
      const atyp = pending[3];
      let offset = 4;
      let host;

      if (atyp === 0x01) {
        if (pending.length < offset + 4) return;
        host = Array.from(pending.subarray(offset, offset + 4)).join('.');
        offset += 4;
      } else if (atyp === 0x03) {
        const len = pending[offset];
        if (pending.length < offset + 1 + len) return;
        host = pending.subarray(offset + 1, offset + 1 + len).toString('ascii');
        offset += 1 + len;
      } else if (atyp === 0x04) {
        if (pending.length < offset + 16) return;
        const groups = [];
        for (let i = 0; i < 16; i += 2) groups.push(pending.readUInt16BE(offset + i).toString(16));
        host = groups.join(':');
        offset += 16;
      } else {
        return cleanup();
      }

      if (pending.length < offset + 2) return;
      const port = pending.readUInt16BE(offset);
      pending = pending.subarray(offset + 2);
      stage = 'connected';

      upstream = net.connect({ host, port }, () => {
        // успешный ответ SOCKS5
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        if (pending.length) upstream.write(pending);
        pending = Buffer.alloc(0);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', (e) => { console.log('UPSTREAM ERROR', host, port, e.message); cleanup(); });
      upstream.on('close', () => cleanup());
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SOCKS5 proxy listening on ${HOST}:${PORT}`);
});
