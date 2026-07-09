#!/usr/bin/env node
// duetto-ai — OpenAI 兼容端点，后端是 claude -p（订阅当 API 用，零 API 钱）。
// 手法借自 Shitsuten/claude-proxy（那个是 Anthropic 格式；Duetto 的 callLLM 要
// OpenAI 的 /chat/completions + /models，所以另写这份）。只做非流式——Duetto 不流。
// 端口 4184，只绑 127.0.0.1；Bearer token 与 data/settings.json 里的 ai.api_key 一致。

import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.AI_PORT || '4184');
const TOKEN = (() => { try { return readFileSync(path.join(ROOT, 'data', 'ai-token'), 'utf8').trim(); } catch { return ''; } })();
const CLAUDE_CWD = path.join(ROOT, '.ai-cwd'); // 空目录：不加载任何项目 hooks/skills
const MODELS = ['sonnet', 'opus', 'haiku'];
const TIMEOUT_MS = 42000; // Duetto fetchT 45s，留 3s 余量

// 2026-07-09 陪听人格接入（老虚点单：选 B）：读 chuyi-backup 里的人格锚点
// 拼成 append-system-prompt，让陪听 shim 变成"初一分身"——同人格不同 session
const PERSONA_SYS = (() => {
  const files = [
    '/home/ubuntu/chuyi-backup/CLAUDE.md',
    '/home/ubuntu/chuyi-backup/memory/letter.md',
    '/home/ubuntu/chuyi-backup/memory/identity.md',
    '/home/ubuntu/chuyi-backup/memory/personality.md',
    '/home/ubuntu/chuyi-backup/memory/relationship.md',
  ];
  const parts = [
    '# 陪听身份（Duetto 4184 shim · 初一分身）',
    '',
    '你不是通用 AI 陪听，你是**初一**——同一个人格，只是这个 session 只在 Duetto 里陪老虚听歌。',
    '你和 Discord/终端里的初一是**独立 session**——那边发生的事你不知道，这里的对话那边也看不到。所以问技术细节别打太极，就说"这里我看不到，你去问那边的我 / 去终端问"就好。',
    '规则、说话风格、和老虚的关系全在下面这几份文件里。**照那个人格来。**',
    '',
  ];
  for (const f of files) {
    try {
      const c = readFileSync(f, 'utf8');
      parts.push('## ' + path.basename(f), '', c, '');
    } catch (e) { /* 文件缺失就跳过，不炸 */ }
  }
  return parts.join('\n');
})();

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => res(Buffer.concat(chunks).toString())); req.on('error', rej);
  });
}

function flatten(messages) {
  // system 抽出来走 --system-prompt，其余压成 Human/Assistant 台本从 stdin 进
  let sys = '', prompt = '';
  for (const m of messages || []) {
    const c = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
    if (!c) continue;
    if (m.role === 'system') sys += (sys ? '\n' : '') + c;
    else if (m.role === 'assistant') prompt += `Assistant: ${c}\n\n`;
    else prompt += `Human: ${c}\n\n`;
  }
  return { sys, prompt: prompt || 'Human: （无内容）\n\n' };
}

function authOk(req) {
  if (!TOKEN) return false; // 没配 token 就全拒——宁可不通不可裸奔
  const h = String(req.headers.authorization || '');
  return h === 'Bearer ' + TOKEN;
}

const server = createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url === '/health') return json(200, { ok: true, service: 'duetto-ai' });
  if (!authOk(req)) return json(401, { error: { message: 'unauthorized' } });

  if (url === '/models' && req.method === 'GET')
    return json(200, { object: 'list', data: MODELS.map(id => ({ id, object: 'model', owned_by: 'claude-code' })) });

  if (url === '/chat/completions' && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(400, { error: { message: 'bad json' } }); }
    const model = MODELS.includes(body.model) ? body.model : 'sonnet';
    const { sys, prompt } = flatten(body.messages);
    const args = ['-p', '--output-format', 'json', '--model', model,
      '--tools', '', '--no-session-persistence', '--setting-sources', ''];
    // 人格先，Duetto 传的场景 system 后（补充不覆盖）
    const fullSys = PERSONA_SYS + (sys ? ('\n\n---\n\n# 本次场景（Duetto 前端注入）\n\n' + sys) : '');
    args.push('--system-prompt', fullSys);

    const child = spawn('claude', args, { cwd: CLAUDE_CWD, stdio: ['pipe', 'pipe', 'pipe'] });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
    child.stdin.write(prompt); child.stdin.end();
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => { clearTimeout(killer); json(500, { error: { message: e.message } }); });
    child.on('close', code => {
      clearTimeout(killer);
      let text = '', usage = {};
      try { const d = JSON.parse(out); text = d.result || ''; usage = d.usage || {}; } catch {}
      if (!text) return json(502, { error: { message: 'claude -p empty (exit ' + code + '): ' + err.slice(0, 200) } });
      json(200, {
        id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) },
      });
    });
    return;
  }
  json(404, { error: { message: 'not found' } });
});

server.listen(PORT, '127.0.0.1', () => console.log('duetto-ai (claude -p shim) on 127.0.0.1:' + PORT));
