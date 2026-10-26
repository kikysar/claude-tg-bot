// Проверка моста Gemini (gemini.js) на поддельном Vertex AI и поддельном сервере входа Google. Сеть не нужна.
// Запуск: node test/gemini-test.js
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../gemini.js');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; if (process.env.VERBOSE) console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); }
};
const section = (s) => console.log(`\n${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha1').update(String(s).trim()).digest('base64url').slice(0, 20);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
  type: 'service_account', project_id: 'test-proj', client_email: 'bot@test-proj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'http://placeholder/token',
};

// ───────── Поддельные Google (вход) и Vertex ─────────
const fake = { tokenCalls: 0, jwtOk: [], reqs: [], queue: [], closed: 0, hold: false, tokenLife: 3600 };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/token') {
      fake.tokenCalls++;
      const assertion = new URLSearchParams(raw).get('assertion') || '';
      const [h, c, s] = assertion.split('.');
      let ok = false;
      try {
        const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
        ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')) &&
          claim.iss === SA.client_email && claim.scope === 'https://www.googleapis.com/auth/cloud-platform' &&
          claim.exp - claim.iat === 3600 && JSON.parse(Buffer.from(h, 'base64url').toString()).alg === 'RS256';
      } catch {}
      fake.jwtOk.push(ok);
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ok ? { access_token: `tok-${fake.tokenCalls}`, expires_in: fake.tokenLife } : { error: 'invalid_grant' }));
    }
    const m = /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^:]+):(\w+)/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end('no'); }
    let body = {}; try { body = JSON.parse(raw); } catch {}
    const rec = { project: m[1], location: m[2], model: m[3], method: m[4], url: req.url, auth: req.headers.authorization, body };
    fake.reqs.push(rec);
    req.on('close', () => { if (!res.writableFinished) fake.closed++; });
    const step = fake.queue.shift();
    if (fake.hold) return;        // удерживаем соединение — проверка обрыва клиентом
    if (!step) { res.writeHead(500); return res.end('queue empty'); }
    if (step.status && step.status !== 200) {
      res.writeHead(step.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(step.error || [{ error: { code: step.status, message: step.message || 'boom', status: 'X' } }]));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Кусок, разрезанный посреди события, — так приходит по сети
    const wire = step.chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');
    const cut = Math.floor(wire.length / 2);
    res.write(wire.slice(0, cut));
    setTimeout(() => { res.write(wire.slice(cut)); res.end(); }, 5);
  });
});

const part = (p, fin, usage) => ({ candidates: [{ content: { role: 'model', parts: [p] }, ...(fin ? { finishReason: fin } : {}) }], ...(usage ? { usageMetadata: usage } : {}) });
const text = (t, extra = {}) => part({ text: t, ...extra });
const fcall = (name, args, sig) => part({ functionCall: { name, args, id: `call_${Math.floor(Math.random() * 1e6)}` }, ...(sig ? { thoughtSignature: sig } : {}) });
const done = (usage, fin = 'STOP') => part({ text: '' }, fin, usage);
const USAGE = { promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 5, thoughtsTokenCount: 20 };

// Клиент моста
function call(bridge, p, body, { method = 'POST', headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: bridge.port, path: p, method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.secret}`, ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const t = Buffer.concat(parts).toString('utf8');
        const r = { status: res.statusCode, headers: res.headers, text: t, json: null, events: [] };
        if (/event-stream/.test(res.headers['content-type'] || '')) {
          for (const b of t.split('\n\n')) {
            const ev = /^event: (.+)$/m.exec(b), d = /^data: (.+)$/m.exec(b);
            if (ev && d) r.events.push({ ev: ev[1], d: JSON.parse(d[1]) });
          }
        } else { try { r.json = JSON.parse(t); } catch {} }
        resolve(r);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const evNames = (r) => r.events.map((e) => e.ev).join(',');
const blocksOf = (r) => r.events.filter((e) => e.ev === 'content_block_start').map((e) => e.d.content_block);
const last = (a) => a[a.length - 1];

const BASE_REQ = (extra = {}) => ({
  model: 'gemini-3.1-pro-preview', max_tokens: 1000, stream: true,
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.310.600; cc_entrypoint=cli;' }, { type: 'text', text: 'You are Claude Code, a CLI.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  ...extra,
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mk = (extra = {}) => {
    const key = { ...SA, token_uri: `${origin}/token` };
    return G.createBridge({ key, vertexBase: origin, tokenUrl: `${origin}/token`, dataDir: path.join(tmp, `d${Math.random().toString(36).slice(2, 7)}`),
      retryWaits: [20, 20], dailyUsd: 0, ...extra });
  };
  const bridge = await mk().listen();

  section('1. Доступ и служебные адреса');
  {
    check('без секрета — 401 в формате Anthropic', await (async () => {
      const r = await new Promise((res) => http.get({ host: '127.0.0.1', port: bridge.port, path: '/v1/models' }, (x) => { let t = ''; x.on('data', (c) => (t += c)); x.on('end', () => res({ s: x.statusCode, j: JSON.parse(t) })); }));
      return r.s === 401 && r.j.type === 'error' && r.j.error.type === 'authentication_error';
    })());
    const bad = await call(bridge, '/v1/models', undefined, { method: 'GET', headers: { Authorization: 'Bearer nope' } });
    check('чужой секрет — 401', bad.status === 401);
    const viaKey = await call(bridge, '/v1/models', undefined, { method: 'GET', headers: { Authorization: '', 'x-api-key': bridge.secret } });
    check('секрет можно передать и как x-api-key', viaKey.status === 200 && viaKey.json.data.length === G.GEMINI_MODELS.length);
    check('список моделей: id, окно и вывод', viaKey.json.data[0].id === 'gemini-3.1-pro-preview' && viaKey.json.data[0].max_input_tokens === 1048576 && viaKey.json.data[0].max_tokens === 65535);
    const one = await call(bridge, '/v1/models/gemini-3.7-flash', undefined, { method: 'GET' });
    check('одна модель по id', one.status === 200 && one.json.id === 'gemini-3.7-flash');
    const health = await new Promise((res) => http.get({ host: '127.0.0.1', port: bridge.port, path: '/health' }, (x) => { let t = ''; x.on('data', (c) => (t += c)); x.on('end', () => res({ s: x.statusCode, t })); }));
    check('/health без секрета отвечает ok', health.s === 200 && health.t === 'ok');
    const nf = await call(bridge, '/v1/nothing', {});
    check('неизвестный адрес — 404 not_found_error', nf.status === 404 && nf.json.error.type === 'not_found_error');
    const ct = await call(bridge, '/v1/messages/count_tokens', { messages: [{ role: 'user', content: 'x'.repeat(3500) }] });
    check('count_tokens отвечает оценкой без обращения в Google', ct.status === 200 && ct.json.input_tokens > 900 && ct.json.input_tokens < 1200 && fake.reqs.length === 0, ct.json);
  }

  section('2. Текстовый ответ потоком');
  {
    fake.queue.push({ chunks: [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }], usageMetadata: { trafficType: 'ON_DEMAND' } }, text('lo'), part({ text: '', thoughtSignature: 'SIGTEXT' }, 'STOP', USAGE)] });
    const r = await call(bridge, '/v1/messages?beta=true', BASE_REQ({ output_config: { effort: 'low' }, thinking: { type: 'adaptive' } }));
    check('поток событий Anthropic по порядку', evNames(r) === 'message_start,content_block_start,content_block_delta,content_block_delta,content_block_stop,message_delta,message_stop', evNames(r));
    check('текст склеивается из кусков', r.events.filter((e) => e.ev === 'content_block_delta').map((e) => e.d.delta.text).join('') === 'Hello');
    const md = last(r.events.filter((e) => e.ev === 'message_delta')).d;
    check('конец хода end_turn', md.delta.stop_reason === 'end_turn');
    check('расход: свежий ввод = всего − из кэша, выход = ответ + мысли',
      md.usage.input_tokens === 200 && md.usage.cache_read_input_tokens === 800 && md.usage.output_tokens === 25 && md.usage.cache_creation_input_tokens === 0, md.usage);
    const up = last(fake.reqs);
    check('Vertex: проект, регион global, модель, метод и токен', up.project === 'test-proj' && up.location === 'global' && up.model === 'gemini-3.1-pro-preview' &&
      up.method === 'streamGenerateContent' && /alt=sse/.test(up.url) && up.auth === 'Bearer tok-1', up);
    const sys = up.body.systemInstruction.parts[0].text;
    check('системная инструкция: вступление моста + промпт Claude Code, без строки биллинга',
      sys.startsWith('You are Gemini (model gemini-3.1-pro-preview)') && sys.includes('You are Claude Code, a CLI.') && !/billing/i.test(sys), sys.slice(0, 120));
    check('лимит ответа и уровень размышлений из усилия', up.body.generationConfig.maxOutputTokens === 1000 && up.body.generationConfig.thinkingConfig.thinkingLevel === 'low', up.body.generationConfig);
    check('реплика пользователя передана', JSON.stringify(up.body.contents) === JSON.stringify([{ role: 'user', parts: [{ text: 'hi' }] }]));
    check('цена ответа по прайсу Pro: 200×$2 + 800×$0,2 + 25×$12', Math.abs(bridge.spend.d.usd - 0.00086) < 1e-9, bridge.spend.d.usd);
    check('подпись последнего куска запомнена по хешу текста', bridge.sigs.get(`tx:${sha('Hello')}`) === 'SIGTEXT');
    check('токен получен один раз, подпись входа верна', fake.tokenCalls === 1 && fake.jwtOk.every(Boolean));
  }

  section('3. Вызовы инструментов и подписи мыслей');
  const TOOLS = [
    { name: 'Bash', description: 'Run a command', input_schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number', minimum: 1 } }, required: ['command'], additionalProperties: false } },
    { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    { name: 'mcp__my server__do it', description: 'odd name', input_schema: { type: 'object', properties: { x: { type: 'string' } } } },
    { name: 'NoArgs', description: 'no params', input_schema: { type: 'object', properties: {} } },
    { type: 'web_search_20250305', name: 'web_search' },
  ];
  let id1, id2;
  {
    fake.queue.push({ chunks: [text('Let me look'), fcall('Bash', { command: 'echo hi' }, 'SIG-BASH'), fcall('Read', { file_path: '/etc/hostname' }), fcall('mcp__my_server__do_it', { x: '1' }), done(USAGE)] });
    const r = await call(bridge, '/v1/messages', BASE_REQ({ tools: TOOLS, tool_choice: { type: 'auto' } }));
    const bl = blocksOf(r);
    check('в ответе текст и три вызова, по порядку', bl.map((b) => b.type).join() === 'text,tool_use,tool_use,tool_use', bl.map((b) => b.type));
    check('имя инструмента с пробелами возвращено настоящим', bl[3].name === 'mcp__my server__do it', bl[3].name);
    check('id вызовов в стиле Anthropic', bl.slice(1).every((b) => /^toolu_[A-Za-z0-9]{22}$/.test(b.id)), bl.map((b) => b.id));
    const deltas = r.events.filter((e) => e.ev === 'content_block_delta' && e.d.delta.type === 'input_json_delta');
    check('аргументы идут одним куском JSON', deltas.length === 3 && JSON.parse(deltas[0].d.delta.partial_json).command === 'echo hi' && JSON.parse(deltas[1].d.delta.partial_json).file_path === '/etc/hostname');
    check('конец хода tool_use', last(r.events.filter((e) => e.ev === 'message_delta')).d.delta.stop_reason === 'tool_use');
    [id1, id2] = [bl[1].id, bl[2].id];
    check('подпись первого вызова лежит по его id, у второго её нет', bridge.sigs.get(`id:${id1}`) === 'SIG-BASH' && bridge.sigs.get(`id:${id2}`) === null);
    const up = last(fake.reqs).body;
    const decl = up.tools[0].functionDeclarations;
    check('инструменты: одна запись, без серверных, имена безопасные', up.tools.length === 1 && decl.map((d) => d.name).join() === 'Bash,Read,mcp__my_server__do_it,NoArgs', decl.map((d) => d.name));
    check('схема Bash уходит как parametersJsonSchema без $schema', !('$schema' in decl[0].parametersJsonSchema) && decl[0].parametersJsonSchema.additionalProperties === false && decl[0].parametersJsonSchema.properties.timeout.minimum === 1, decl[0]);
    check('у инструмента без параметров схемы нет', !('parametersJsonSchema' in decl[3]) && !('parameters' in decl[3]));
    check('tool_choice auto не задаёт toolConfig', up.toolConfig === undefined);
  }
  {
    // Второй ход: вызовы и ответы на них возвращаются в Gemini вместе с подписью
    fake.queue.push({ chunks: [text('done'), done(USAGE)] });
    const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
    await call(bridge, '/v1/messages', BASE_REQ({ tools: TOOLS, messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'claude-sig' }, { type: 'text', text: 'Let me look' }, toolUse(id1, 'Bash', { command: 'echo hi' }), toolUse(id2, 'Read', { file_path: '/etc/hostname' })] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id2, content: [{ type: 'text', text: 'no such file' }], is_error: true }, { type: 'tool_result', tool_use_id: id1, content: 'hi\n' }, { type: 'text', text: '<system-reminder>note</system-reminder>' }] },
    ] }));
    const c = last(fake.reqs).body.contents;
    check('история: user, model, user', c.map((x) => x.role).join() === 'user,model,user', c.map((x) => x.role));
    check('мысли Claude отброшены, текст и два вызова на месте', c[1].parts.length === 3 && c[1].parts[0].text === 'Let me look' && c[1].parts[1].functionCall.name === 'Bash' && c[1].parts[2].functionCall.name === 'Read', c[1].parts);
    check('подпись вернулась на первый вызов, второй без неё', c[1].parts[1].thoughtSignature === 'SIG-BASH' && !('thoughtSignature' in c[1].parts[2]) && !c[1].parts.some((p) => p.thoughtSignature === 'claude-sig'));
    check('ответы идут в порядке вызовов, ошибка — как error', c[2].parts[0].functionResponse.name === 'Bash' && c[2].parts[0].functionResponse.response.output === 'hi\n' &&
      c[2].parts[1].functionResponse.name === 'Read' && c[2].parts[1].functionResponse.response.error === 'no such file', c[2].parts);
    check('текст после результатов остаётся в той же реплике', c[2].parts.length === 3 && /system-reminder/.test(c[2].parts[2].text));
  }

  section('4. История, которую писал Claude: подписей нет');
  {
    fake.queue.push({ chunks: [text('ok'), done(USAGE)] });
    const messages = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_claude_made_1', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'toolu_claude_made_2', name: 'Read', input: { file_path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_claude_made_1', content: 'a b' }, { type: 'tool_result', tool_use_id: 'toolu_claude_made_2', content: 'x' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_claude_made_3', name: 'Bash', input: { command: 'pwd' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_claude_made_3', content: '' }] },
    ];
    await call(bridge, '/v1/messages', BASE_REQ({ tools: TOOLS, messages }));
    const c = last(fake.reqs).body.contents;
    check('первый вызов каждого хода получает пустую подпись, второй параллельный — нет',
      c[1].parts[0].thoughtSignature === G.DUMMY_SIG && !('thoughtSignature' in c[1].parts[1]) && c[3].parts[0].thoughtSignature === G.DUMMY_SIG, [c[1].parts, c[3].parts]);
    check('пустой вывод инструмента не оставляет пустую строку', c[4].parts[0].functionResponse.response.output === '(no output)');
  }

  section('5. Пары «вызов — результат» чинятся');
  {
    fake.queue.push({ chunks: [text('ok'), done(USAGE)] });
    const messages = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'text', text: 'trying' }, { type: 'tool_use', id: 'toolu_lost', name: 'Bash', input: { command: 'sleep 9' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stray', content: 'stray output' }, { type: 'text', text: 'interrupted, continue' }] },
    ];
    await call(bridge, '/v1/messages', BASE_REQ({ tools: TOOLS, messages }));
    const c = last(fake.reqs).body.contents;
    check('вызов без результата получает ответ «не записан»', c[2].parts[0].functionResponse.name === 'Bash' && /No result was recorded/.test(c[2].parts[0].functionResponse.response.error), c[2].parts);
    check('результат без вызова уходит текстом и не ломает пару', c[2].parts.length === 3 && /stray output/.test(c[2].parts[1].text) && c[2].parts[2].text === 'interrupted, continue', c[2].parts);
  }
  {
    // Вызов в самом конце беседы, ответа нет вовсе
    fake.queue.push({ chunks: [text('ok'), done(USAGE)] });
    await call(bridge, '/v1/messages', BASE_REQ({ tools: TOOLS, messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_end', name: 'Bash', input: {} }] }] }));
    const c = last(fake.reqs).body.contents;
    check('висящий в конце вызов закрывается ответом', c.length === 3 && c[2].role === 'user' && c[2].parts[0].functionResponse.name === 'Bash', c.map((x) => x.role));
  }

  section('6. Роли, вложения, выбор инструмента');
  {
    fake.queue.push({ chunks: [text('ok'), done(USAGE)] });
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, img] },
      { role: 'system', content: [{ type: 'text', text: '# Environment: Linux' }] },
    ];
    await call(bridge, '/v1/messages', BASE_REQ({ messages, tool_choice: { type: 'tool', name: 'Read' }, tools: TOOLS }));
    const up = last(fake.reqs).body;
    check('system посреди беседы становится репликой пользователя и склеивается с соседней', up.contents.length === 1 && up.contents[0].parts.map((p) => p.text || (p.inlineData && 'img')).join('|') === 'look|img|# Environment: Linux', up.contents);
    check('картинка идёт как inlineData', up.contents[0].parts[1].inlineData.mimeType === 'image/png' && up.contents[0].parts[1].inlineData.data === 'AAAA');
    check('tool_choice tool → режим ANY с одним именем', up.toolConfig.functionCallingConfig.mode === 'ANY' && up.toolConfig.functionCallingConfig.allowedFunctionNames.join() === 'Read', up.toolConfig);
  }
  {
    // Картинка из результата инструмента идёт следом за ответами на вызовы
    fake.queue.push({ chunks: [text('ok'), done(USAGE)] });
    await call(bridge, '/v1/messages', BASE_REQ({ tools: TOOLS, messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_img', name: 'Read', input: { file_path: 'a.png' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: [{ type: 'text', text: 'image file' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }] }] },
    ] }));
    const p = last(fake.reqs).body.contents[2].parts;
    check('ответ на вызов, затем картинка', p[0].functionResponse.response.output === 'image file' && p[1].inlineData.mimeType === 'image/jpeg', p);
  }
  {
    const lvl = async (extra, model = 'gemini-3.1-pro-preview') => {
      fake.queue.push({ chunks: [text('ok'), done(USAGE)] });
      await call(bridge, '/v1/messages', BASE_REQ({ ...extra, model }));
      return last(fake.reqs).body.generationConfig.thinkingConfig;
    };
    check('усилие xhigh и max → high', (await lvl({ output_config: { effort: 'xhigh' } })).thinkingLevel === 'high' && (await lvl({ output_config: { effort: 'max' } })).thinkingLevel === 'high');
    check('без усилия — medium (уровень по умолчанию моста)', (await lvl({})).thinkingLevel === 'medium');
    check('размышления выключены → low (minimal принимают не все модели)', (await lvl({ thinking: { type: 'disabled' } })).thinkingLevel === 'low');
    check('бюджет размышлений → уровень', (await lvl({ thinking: { type: 'enabled', budget_tokens: 2000 } })).thinkingLevel === 'low' && (await lvl({ thinking: { type: 'enabled', budget_tokens: 30000 } })).thinkingLevel === 'high');
    check('у моделей не третьего поколения уровня размышлений нет', (await lvl({}, 'gemini-2.5-flash')) === undefined);
  }

  section('7. Какая модель отвечает');
  {
    const asked = async (model) => { fake.queue.push({ chunks: [text('ok'), done(USAGE)] }); await call(bridge, '/v1/messages', BASE_REQ({ model })); return last(fake.reqs).model; };
    check('суффикс [1m] отбрасывается', await asked('gemini-3.7-flash[1m]') === 'gemini-3.7-flash');
    check('служебные обращения haiku идут на самую дешёвую', await asked('claude-haiku-4-5-20251001') === G.SMALL_MODEL);
    check('любая другая Claude-модель — на модель по умолчанию', await asked('claude-opus-4-8') === 'gemini-3.1-pro-preview');
    check('незнакомая Gemini идёт как есть', await asked('gemini-9-ultra') === 'gemini-9-ultra');
  }

  section('8. Ответ одним сообщением (без потока)');
  {
    fake.queue.push({ chunks: [text('He'), text('llo'), fcall('Read', { file_path: 'a' }), done(USAGE)] });
    const r = await call(bridge, '/v1/messages', BASE_REQ({ stream: false, tools: TOOLS }));
    check('JSON-сообщение Anthropic', r.status === 200 && r.json.type === 'message' && r.json.role === 'assistant' && r.json.stop_reason === 'tool_use', r.json);
    check('блоки: слитый текст и вызов', r.json.content.length === 2 && r.json.content[0].text === 'Hello' && r.json.content[1].type === 'tool_use' && r.json.content[1].input.file_path === 'a');
    check('usage на месте', r.json.usage.input_tokens === 200 && r.json.usage.output_tokens === 25 && r.json.usage.cache_read_input_tokens === 800);
  }

  section('9. Ошибки Vertex → ошибки Anthropic');
  {
    const reqs0 = fake.reqs.length;
    fake.queue.push({ status: 429, message: 'Resource exhausted' }, { chunks: [text('after retry'), done(USAGE)] });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('429 мост повторяет сам и отдаёт успех', r.status === 200 && fake.reqs.length - reqs0 === 2 && r.events.some((e) => e.d.delta && e.d.delta.text === 'after retry'));
  }
  {
    fake.queue.push({ status: 429, message: 'Resource exhausted' }, { status: 429, message: 'Resource exhausted' }, { status: 429, message: 'Resource exhausted' });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('429 после повторов — rate_limit_error с retry-after', r.status === 429 && r.json.error.type === 'rate_limit_error' && Boolean(r.headers['retry-after']) && /Resource exhausted/.test(r.json.error.message), r.json);
  }
  {
    fake.queue.push({ status: 400, message: 'The input token count (2100000) exceeds the maximum number of tokens allowed (1048576).' });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('слишком длинный запрос узнаётся по фразе Claude Code', r.status === 400 && /prompt is too long/.test(r.json.error.message) && r.json.error.type === 'invalid_request_error', r.json);
  }
  {
    fake.queue.push({ status: 403, message: 'Vertex AI API has not been used in project test-proj before or it is disabled.' });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('403 — permission_error с пояснением Google', r.status === 403 && r.json.error.type === 'permission_error' && /not been used/.test(r.json.error.message));
  }
  {
    fake.queue.push({ status: 503, message: 'overloaded' }, { status: 503, message: 'overloaded' }, { status: 503, message: 'overloaded' });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('503 → 529 overloaded_error, Claude Code повторит', r.status === 529 && r.json.error.type === 'overloaded_error');
  }
  {
    fake.queue.push({ status: 400, message: 'Invalid value at generation_config' });
    const r = await call(bridge, '/v1/messages', BASE_REQ({ stream: false }));
    check('без потока ошибка тоже обычным ответом', r.status === 400 && r.json.type === 'error');
  }
  {
    // Токен протух: Vertex отвечает 401 — мост берёт новый и повторяет
    const tc = fake.tokenCalls;
    fake.queue.push({ status: 401, message: 'Request had invalid authentication credentials.' }, { chunks: [text('fresh'), done(USAGE)] });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('401 → новый токен и успех', r.status === 200 && fake.tokenCalls === tc + 1 && last(fake.reqs).auth === `Bearer tok-${fake.tokenCalls}`);
  }

  section('10. Пустой и заблокированный ответ');
  {
    const n0 = fake.reqs.length;
    fake.queue.push({ chunks: [done({ promptTokenCount: 10, candidatesTokenCount: 0 })] }, { chunks: [text('second try'), done(USAGE)] });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('пустой ответ спрашивается заново, клиент видит один целый', fake.reqs.length - n0 === 2 && blocksOf(r).length === 1 && r.events.filter((e) => e.ev === 'message_start').length === 1);
  }
  {
    const n0 = fake.reqs.length;
    fake.queue.push({ chunks: [done({ promptTokenCount: 10 })] }, { chunks: [done({ promptTokenCount: 10 })] }, { chunks: [done({ promptTokenCount: 10 })] });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('пустой три раза подряд — понятная пометка, а не пустое сообщение', fake.reqs.length - n0 === 3 && blocksOf(r).length === 1 && /пустой ответ/.test(r.events.find((e) => e.d.delta && e.d.delta.text).d.delta.text));
  }
  {
    const n0 = fake.reqs.length;
    fake.queue.push({ chunks: [part({ text: '' }, 'SAFETY', { promptTokenCount: 10 })] });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('отказ по безопасности не повторяется и объясняется', fake.reqs.length - n0 === 1 && /отказался отвечать \(SAFETY\)/.test(r.events.find((e) => e.d.delta && e.d.delta.text).d.delta.text));
  }
  {
    fake.queue.push({ chunks: [part({ text: '' }, 'MALFORMED_FUNCTION_CALL', { promptTokenCount: 10 })], }, { chunks: [part({ text: '' }, 'MALFORMED_FUNCTION_CALL', { promptTokenCount: 10 })] }, { chunks: [part({ text: '' }, 'MALFORMED_FUNCTION_CALL', { promptTokenCount: 10 })] });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('кривой вызов инструмента три раза подряд — ошибка 502, Claude Code повторит сам', r.status === 502 && r.json.error.type === 'api_error' && /MALFORMED_FUNCTION_CALL/.test(r.json.error.message), r.json);
  }
  {
    fake.queue.push({ chunks: [text('cut off'), done(USAGE, 'MAX_TOKENS')] });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('упёрлись в лимит ответа → max_tokens', last(r.events.filter((e) => e.ev === 'message_delta')).d.delta.stop_reason === 'max_tokens');
  }
  {
    // Ошибка посреди потока: после первого содержимого заголовки уже ушли, остаётся событие error
    fake.queue.push({ chunks: [text('partial'), { error: { code: 500, message: 'internal glitch' } }] });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    check('сбой посреди потока — событие error в потоке', r.status === 200 && last(r.events).ev === 'error' && /internal glitch/.test(last(r.events).d.error.message), evNames(r));
  }

  section('11. Схемы инструментов, которые Vertex не принял');
  {
    const bad = [{ name: 'Weird', description: 'w', input_schema: { type: 'object', properties: { a: { type: ['string', 'null'], description: 'x', format: 'uri' }, b: { type: 'object', propertyNames: { pattern: '^a' }, additionalProperties: { type: 'string' } } }, required: ['a', 'zzz'] } }];
    const n0 = fake.reqs.length;
    fake.queue.push({ status: 400, message: 'Invalid JSON payload received. Unknown name "propertyNames" at tools[0].function_declarations[0].parameters_json_schema' }, { chunks: [text('ok'), done(USAGE)] });
    const r = await call(bridge, '/v1/messages', BASE_REQ({ tools: bad }));
    const second = fake.reqs[fake.reqs.length - 1].body.tools[0].functionDeclarations[0].parametersJsonSchema;
    check('после отказа схема упрощена и запрос прошёл', r.status === 200 && fake.reqs.length - n0 === 2 && second.type === 'object' && second.properties.a.type === 'string' && !('format' in second.properties.a) && !('propertyNames' in second.properties.b) && second.required.join() === 'a', second);
    fake.queue.push({ chunks: [text('ok'), done(USAGE)] });
    const n1 = fake.reqs.length;
    await call(bridge, '/v1/messages', BASE_REQ({ tools: bad }));
    check('набор запомнен: следующий запрос сразу с упрощёнными схемами', fake.reqs.length - n1 === 1 && !('propertyNames' in fake.reqs[fake.reqs.length - 1].body.tools[0].functionDeclarations[0].parametersJsonSchema.properties.b));
  }

  section('12. Обрыв клиентом и потолок расхода');
  {
    fake.hold = true;
    const c0 = fake.closed;
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: bridge.port, path: '/v1/messages', method: 'POST', headers: { Authorization: `Bearer ${bridge.secret}`, 'Content-Type': 'application/json' } });
      req.on('error', () => {});
      req.end(JSON.stringify(BASE_REQ()));
      setTimeout(() => { req.destroy(); resolve(); }, 150);
    });
    await sleep(200);
    check('когда Claude Code обрывает соединение, запрос к Google тоже обрывается', fake.closed === c0 + 1, fake.closed - c0);
    fake.hold = false;
  }
  {
    const capped = await mk({ dailyUsd: 0.001 }).listen();
    fake.queue.push({ chunks: [text('one'), done({ promptTokenCount: 1000, candidatesTokenCount: 100 })] });   // 1000×$2 + 100×$12 = $0,0032
    const a = await call(capped, '/v1/messages', BASE_REQ());
    const n0 = fake.reqs.length;
    const b = await call(capped, '/v1/messages', BASE_REQ());
    check('первый ответ проходит, расход сверх суточного потолка останавливает следующий', a.status === 200 && b.status === 400 && /Суточный потолок/.test(b.json.error.message) && fake.reqs.length === n0, b.json);
    const reopened = G.createBridge({ key: { ...SA, token_uri: `${origin}/token` }, vertexBase: origin, tokenUrl: `${origin}/token`, dataDir: path.join(tmp, 'spend-reload'), dailyUsd: 0 });
    reopened.spend.add('gemini-3.1-pro-preview', { prompt: 10, cached: 0, out: 10 }, 0.5);
    const again = new G.Spend(path.join(tmp, 'spend-reload', 'spend.json'));
    check('расход переживает перезапуск', Math.abs(again.today() - 0.5) < 1e-9 && again.d.total.calls === 1);
    await capped.close();
  }

  section('13. Цены');
  {
    const c = (m, prompt, cached, out) => G.costOf(m, { prompt, cached, out });
    check('Pro до 200 тыс. токенов: $2 / $0,2 / $12', Math.abs(c('gemini-3.1-pro-preview', 100000, 0, 1000) - (0.2 + 0.012)) < 1e-9);
    check('Pro сверх 200 тыс. токенов дороже: $4 / $0,4 / $18', Math.abs(c('gemini-3.1-pro-preview', 300000, 100000, 1000) - ((200000 * 4 + 100000 * 0.4 + 1000 * 18) / 1e6)) < 1e-9);
    check('Flash: $0,75 / $3,75', Math.abs(c('gemini-3.7-flash', 1e6, 0, 1e6) - 4.5) < 1e-9);
    check('незнакомая модель считается по цене Flash, а не бесплатно', c('gemini-9-ultra', 1e6, 0, 0) === 0.75);
    check('подписи моделей', G.geminiLabel('gemini-3.1-pro-preview') === 'Gemini 3.1 Pro' && G.geminiLabel('gemini-4-flash-lite') === 'Gemini 4 Flash-Lite' && G.geminiLabel('gemini-3.6-flash') === 'Gemini 3.6 Flash');
    check('isGeminiModel узнаёт и суффикс [1m]', G.isGeminiModel('gemini-3.1-pro-preview[1m]') && !G.isGeminiModel('opus') && !G.isGeminiModel('claude-opus-5-5'));
  }

  section('14. Подписи на диске');
  {
    const file = path.join(tmp, 'sigs-test.jsonl');
    const old = Date.now() - 50 * 86400e3;
    fs.writeFileSync(file, [JSON.stringify({ k: 'id:old', s: 'S-OLD', t: old }), JSON.stringify({ k: 'id:new', s: 'S-NEW', t: Date.now() }), '{"k":"id:broken","s":"S-'].join('\n'));
    const st = new G.SigStore(file);
    check('старше 45 дней и оборванная строка отбрасываются', st.get('id:old') === null && st.get('id:new') === 'S-NEW' && st.get('id:broken') === null);
    st.set('id:added', 'S-ADDED');
    check('новая подпись переживает перечитывание файла', new G.SigStore(file).get('id:added') === 'S-ADDED');
    const mode = fs.statSync(file).mode & 0o777;
    check('файл подписей закрыт от чужих (600)', process.platform === 'win32' || mode === 0o600, mode.toString(8));
  }

  section('15. Размышления Gemini не показываются');
  {
    fake.queue.push({ chunks: [part({ text: 'private reasoning summary', thought: true }), text('Answer'), done(USAGE)] });
    const r = await call(bridge, '/v1/messages', BASE_REQ());
    const all = r.events.filter((e) => e.d.delta && e.d.delta.text).map((e) => e.d.delta.text).join('');
    check('части с thought:true не попадают в ответ', all === 'Answer', all);
  }

  await bridge.close();
  server.close();
  console.log(`\n${fail ? '✗' : '✓'} Мост Gemini: ${pass} проверок прошли${fail ? `, ${fail} упали` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Сбой теста:', e); process.exit(2); });
