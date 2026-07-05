#!/usr/bin/env node
// feed-share — 把一首直链歌以分享卡片形式注入 Duetto 房间时间线（落库+实时同步）。
// 点唱机"送进唱机"按钮经 push_server /api/jukebox-feed 调到这里；CLI 也能直接用：
//   node feed-share.mjs <url> <title> [artist] [cover] [room] [who]
// token 从 data/auth.json 的 secret 现算（部署者特权，不需要 PIN）。

import { readFileSync } from 'fs';
import { createHmac } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const [url, title, artist = '', cover = '', room = 'main', who = 'eve'] = process.argv.slice(2);
if (!url || !title) { console.error('usage: feed-share.mjs <url> <title> [artist] [cover] [room] [who]'); process.exit(2); }

let auth;
try { auth = JSON.parse(readFileSync(path.join(ROOT, 'data', 'auth.json'), 'utf8')); }
catch { console.error('NO_PIN: Duetto 还没设 PIN（data/auth.json 不存在）'); process.exit(3); }
const token = createHmac('sha256', String(auth.secret)).update('duetto-access').digest('hex');

const msg = {
  t: 'chat',
  msg: {
    who, // eve=老虚 yu=AI；点唱机是老虚在选歌，默认 eve
    share: { id: 'direct:' + url.slice(-64), title, artist, cover, url },
    time: new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Tokyo', hour12: false, hour: '2-digit', minute: '2-digit' }),
    ts: Date.now(),
  },
};

const ws = new WebSocket('ws://127.0.0.1:4183/ws?room=' + encodeURIComponent(room) + '&token=' + token);
const bail = setTimeout(() => { console.error('TIMEOUT'); process.exit(4); }, 8000);
ws.on('open', () => { ws.send(JSON.stringify(msg)); setTimeout(() => { clearTimeout(bail); ws.close(); console.log('FED: ' + title); process.exit(0); }, 300); });
ws.on('error', e => { clearTimeout(bail); console.error('WS_ERROR: ' + e.message); process.exit(5); });
ws.on('close', (c, r) => { if (c === 4401) { clearTimeout(bail); console.error('UNAUTHORIZED'); process.exit(6); } });
