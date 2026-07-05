// Duetto TLS终结器（2026-07-05）：8446 HTTPS/WSS → 127.0.0.1:4183 HTTP/WS
// 为什么存在：Duetto是纯HTTP+WebSocket，push_server的stdlib代理过不了WS升级，
// 音频流也不该整段缓冲。这里用node核心库做透明双向管道（含upgrade），零依赖。
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const CERT = '/etc/letsencrypt/live/161-33-202-81.sslip.io/fullchain.pem';
const KEY = '/etc/letsencrypt/live/161-33-202-81.sslip.io/privkey.pem';
const UP_HOST = '127.0.0.1', UP_PORT = 4183, LISTEN = 8446;

const server = https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) });

server.on('request', (req, res) => {
  const up = http.request({ host: UP_HOST, port: UP_PORT, path: req.url,
    method: req.method, headers: { ...req.headers, host: `${UP_HOST}:${UP_PORT}` } }, r => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);                       // 流式透传：音频range/大文件不进内存
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('🎶 唱机没开。跟初一说一声"开唱机"。'); });
  req.pipe(up);
});

server.on('upgrade', (req, socket, head) => {  // WebSocket升级：裸TCP双向管
  const up = net.connect(UP_PORT, UP_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  const kill = () => { socket.destroy(); up.destroy(); };
  up.on('error', kill); socket.on('error', kill);
});

server.listen(LISTEN, '0.0.0.0', () => console.log(`duetto tls-front :${LISTEN} → ${UP_HOST}:${UP_PORT}`));
