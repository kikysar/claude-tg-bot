'use strict';
/**
 * Мост «Claude Code → Google Vertex AI (Gemini)».
 *
 * Зачем. Лимиты подписки Claude кончаются, а работу нужно продолжить в той же беседе, с теми же
 * инструментами и с тем же файлом беседы. Поэтому Gemini здесь не отдельный бот, а ещё один «движок»
 * для самого Claude Code: он остаётся агентом (читает и правит файлы, запускает команды, ведёт
 * историю), а запросы к «модели» уходят на этот мост на 127.0.0.1. Мост переводит Anthropic Messages
 * API в Vertex generateContent и обратно. Файл беседы остаётся общим: что сделал Gemini, видит Claude
 * после переключения, и наоборот — Gemini при переключении получает всю историю, ничего не теряется.
 *
 * Что делает мост:
 *  - история и инструменты Anthropic ⇄ contents/functionDeclarations Gemini, стриминг SSE, картинки и PDF;
 *  - подписи мыслей Gemini 3 (thoughtSignature): без них Vertex отвечает 400 на вызов инструмента. Они
 *    не влезают в id блока (у Anthropic id короче 64 знаков), поэтому лежат на диске по id вызова;
 *    для вызовов, сделанных Claude (подписи нет), ставится «пустая» подпись skip_thought_signature_validator;
 *  - ошибки Vertex → ошибки Anthropic с теми же кодами (429/5xx Claude Code повторяет сам);
 *  - учёт денег: Gemini оплачивает Google Cloud, не подписка Claude, поэтому мост считает расход по
 *    прайсу и останавливается на суточном потолке (GEMINI_DAILY_USD), чтобы зациклившаяся задача не сожгла бюджет.
 *
 * Только Node, без зависимостей. Слушает только 127.0.0.1 и требует секрет, который знает лишь бот.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Цены за миллион токенов (Vertex AI, прайс на 24.10.2026; Argon — по прессе 25.10.2026). big — тариф для запросов длиннее 200 тыс. токенов.
// estimated — цена взята по соседней модели, прайс на неё не найден: расход по ней ориентировочный.
const GEMINI_MODELS = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', hint: 'самая сильная, для сложных правок',
    price: { in: 2, out: 12, cache: 0.2, big: { in: 4, out: 18, cache: 0.4 } } },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', hint: 'новейшая и самая мощная (с 13.10.2026), дороже всех', estimated: true,
    price: { in: 2, out: 10, cache: 0.2, big: { in: 4, out: 20, cache: 0.4 } } },   // по сообщениям прессы: $2/$10 до 30.11.2026, потом $4/$20
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', hint: 'быстрая и недорогая',
    price: { in: 0.75, out: 3.75, cache: 0.075 } },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', hint: 'быстрая', estimated: true,
    price: { in: 0.75, out: 3.75, cache: 0.075 } },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', hint: 'быстрая', estimated: true,
    price: { in: 0.5, out: 3, cache: 0.05 } },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', hint: 'самая дешёвая', estimated: true,
    price: { in: 0.25, out: 1.5, cache: 0.025 } },
];
const FALLBACK_PRICE = { in: 0.75, out: 3.75, cache: 0.075 };
const SMALL_MODEL = 'gemini-3.1-flash-lite';       // для служебных обращений Claude Code (заголовки, выжимки)
const CONTEXT_TOKENS = 1048576;
const MAX_OUTPUT = 65535;
const DUMMY_SIG = 'skip_thought_signature_validator';   // Vertex принимает её вместо настоящей подписи

const isGeminiModel = (id) => /^gemini-/i.test(String(id || '').replace(/\[1m\]$/i, ''));
const modelInfo = (id) => GEMINI_MODELS.find((m) => m.id === String(id || '').replace(/\[1m\]$/i, ''));

/** gemini-3.1-pro-preview → «Gemini 3.1 Pro»; незнакомую модель разбираем по имени. */
function geminiLabel(id) {
  const known = modelInfo(id);
  if (known) return known.label;
  const m = String(id || '').match(/^gemini-(\d+(?:\.\d+)?)-([a-z]+(?:-[a-z]+)?)/i);
  if (!m) return String(id || '');
  const kind = m[2].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('-');
  return `Gemini ${m[1]} ${kind}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');
const rid = (prefix, n = 24) => `${prefix}${crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n)}`;
const hashText = (s) => crypto.createHash('sha1').update(String(s).trim()).digest('base64url').slice(0, 20);
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ─────────────────────────── Вход в Google ───────────────────────────

/** Ключ сервисного аккаунта → токен доступа (JWT RS256, час жизни). Кэшируется, обновляется заранее. */
class Auth {
  constructor(key, tokenUrl) {
    this.key = key;
    this.tokenUrl = tokenUrl || key.token_uri || 'https://oauth2.googleapis.com/token';
    this.tok = null; this.exp = 0; this.pending = null;
  }

  invalidate() { this.tok = null; this.exp = 0; }

  token() {
    if (this.tok && Date.now() < this.exp - 5 * 60e3) return Promise.resolve(this.tok);
    if (!this.pending) this.pending = this.fetch().finally(() => { this.pending = null; });
    return this.pending;
  }

  async fetch() {
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64u(JSON.stringify({
      iss: this.key.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: this.tokenUrl, iat: now, exp: now + 3600,
    }));
    const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(this.key.private_key).toString('base64url');
    const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claim}.${sig}`;
    const r = await rawRequest(this.tokenUrl, {
      method: 'POST', body: Buffer.from(body),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000,
    });
    const text = await readAll(r.res);
    if (r.status !== 200) {
      let why = text.slice(0, 200);
      try { const j = JSON.parse(text); why = j.error_description || j.error || why; } catch {}
      throw new BridgeError(401, 'authentication_error', `Google отказал во входе по ключу сервисного аккаунта (HTTP ${r.status}): ${why}`);
    }
    const j = JSON.parse(text);
    this.tok = j.access_token;
    this.exp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return this.tok;
  }
}

// ─────────────────────────── Сеть ───────────────────────────

class BridgeError extends Error {
  constructor(status, type, message, retryable = false) {
    super(message);
    this.status = status; this.type = type; this.retryable = retryable;
  }
}

/** Запрос на http или https; ответ отдаётся, как только пришли заголовки. ctl.req позволяет оборвать запрос снаружи. */
function rawRequest(urlStr, { method = 'GET', headers = {}, body = null, timeout = 300000, ctl = null }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const h = { ...headers };
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: h, timeout,
    }, (res) => resolve({ status: res.statusCode, res, headers: res.headers }));
    if (ctl) ctl.req = req;
    req.on('timeout', () => req.destroy(new Error('таймаут ответа Google')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readAll(res, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    res.on('data', (c) => {
      n += c.length;
      if (n > limit) { res.destroy(); return reject(new Error('слишком большое тело')); }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

/** Ошибка Vertex → ошибка в формате Anthropic: Claude Code по её виду решает, повторять ли запрос и жаловаться ли на длину. */
function mapUpstreamError(status, text) {
  let j = null;
  try { j = JSON.parse(text); } catch {}
  const e = ((Array.isArray(j) ? j[0] : j) || {}).error || {};
  let msg = String(e.message || text.slice(0, 500) || `HTTP ${status}`).replace(/\s+/g, ' ');
  // Claude Code по этой фразе понимает, что беседу пора сжимать
  if (status === 400 && /token count|exceeds the maximum|too long|context window/i.test(msg)) msg = `prompt is too long: ${msg}`;
  const types = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error' };
  const code = status === 503 ? 529 : status;
  const type = types[status] || (status === 503 ? 'overloaded_error' : 'api_error');
  return new BridgeError(code, type, `Vertex AI: ${msg}`.slice(0, 1500), status === 429 || status >= 500);
}

// ─────────────────────────── Подписи мыслей ───────────────────────────

/**
 * Подписи мыслей Gemini 3: id вызова инструмента → подпись, а также хеш текста ответа → подпись.
 * Файл — журнал дописываемых строк, старше 45 дней отбрасываются при чтении.
 */
class SigStore {
  constructor(file, { maxAgeMs = 45 * 86400e3, maxEntries = 40000 } = {}) {
    this.file = file; this.map = new Map(); this.maxAgeMs = maxAgeMs; this.maxEntries = maxEntries;
    this.load();
  }

  load() {
    if (!this.file) return;
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    const keep = Date.now() - this.maxAgeMs;
    let lines = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      lines++;
      try {
        const r = JSON.parse(line);
        if (r.k && r.s && r.t >= keep) this.map.set(r.k, { s: r.s, t: r.t });
      } catch { /* оборванная последняя строка */ }
    }
    if (this.map.size > this.maxEntries) {
      const sorted = [...this.map.entries()].sort((a, b) => a[1].t - b[1].t);
      this.map = new Map(sorted.slice(sorted.length - this.maxEntries));
    }
    // Оборванная запись без перевода строки склеилась бы со следующей и погубила её — файл пересобираем
    if (lines > this.map.size * 2 + 100 || (raw && !raw.endsWith('\n'))) this.rewrite();
  }

  rewrite() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, [...this.map.entries()].map(([k, v]) => JSON.stringify({ k, s: v.s, t: v.t })).join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* не критично: подписи останутся в памяти */ }
  }

  get(k) { const v = this.map.get(k); return v ? v.s : null; }

  set(k, s) {
    if (!k || !s) return;
    const t = Date.now();
    this.map.set(k, { s, t });
    if (!this.file) return;
    try { fs.appendFileSync(this.file, JSON.stringify({ k, s, t }) + '\n', { mode: 0o600 }); } catch { /* см. rewrite */ }
  }
}

// ─────────────────────────── Деньги ───────────────────────────

function priceOf(id, overrides) {
  const m = modelInfo(id);
  return (overrides && overrides[id]) || (m && m.price) || FALLBACK_PRICE;
}

/** Доллары за один ответ. prompt включает кэшированную часть; думающие токены оплачиваются как выход. */
function costOf(id, u, overrides) {
  const p = priceOf(id, overrides);
  const t = p.big && u.prompt > 200000 ? p.big : p;
  const fresh = Math.max(0, u.prompt - u.cached);
  return (fresh * t.in + u.cached * (t.cache != null ? t.cache : t.in * 0.1) + u.out * t.out) / 1e6;
}

/** Расход за сутки и за всё время; переживает перезапуск бота. */
class Spend {
  constructor(file) {
    this.file = file;
    this.d = { day: dayKey(), usd: 0, tokens: { prompt: 0, cached: 0, out: 0 }, calls: 0, total: { usd: 0, calls: 0 }, byModel: {} };
    try { Object.assign(this.d, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* нового файла достаточно */ }
    this.roll();
  }

  roll() {
    if (this.d.day === dayKey()) return;
    this.d.day = dayKey(); this.d.usd = 0; this.d.calls = 0; this.d.tokens = { prompt: 0, cached: 0, out: 0 };
  }

  add(model, u, usd) {
    this.roll();
    this.d.usd += usd; this.d.calls += 1;
    this.d.tokens.prompt += u.prompt; this.d.tokens.cached += u.cached; this.d.tokens.out += u.out;
    this.d.total.usd += usd; this.d.total.calls += 1;
    const m = (this.d.byModel[model] ||= { usd: 0, calls: 0 });
    m.usd += usd; m.calls += 1;
    this.save();
  }

  today() { this.roll(); return this.d.usd; }

  save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.d), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* учёт в памяти продолжает работать */ }
  }
}

// ─────────────────────────── Anthropic → Gemini ───────────────────────────

/** Имя функции у Gemini: буква или _, затем буквы, цифры, _ . : -, не длиннее 64 знаков. */
const fnName = (n) => {
  let s = String(n || 'tool').replace(/[^A-Za-z0-9_.:-]/g, '_');
  if (!/^[A-Za-z_]/.test(s)) s = `_${s}`;
  return s.slice(0, 64);
};

/** Схема параметров инструмента для parametersJsonSchema: убираем только то, чего Vertex не принимает. */
function cleanSchema(s) {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === '$schema' || k === '$id') continue;
    o[k] = (k === 'properties' || k === '$defs' || k === 'definitions' || k === 'patternProperties')
      ? Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, cleanSchema(pv)]))
      : cleanSchema(v);
  }
  return o;
}

/** Запасной вариант, если Vertex отверг схему: оставляем только базовые поля. */
function simpleSchema(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { type: 'string' };
  const o = {};
  let type = s.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') || 'string';
  if (!type) type = s.properties ? 'object' : s.items ? 'array' : 'string';
  o.type = type;
  if (s.description) o.description = String(s.description).slice(0, 1000);
  if (Array.isArray(s.enum)) o.enum = s.enum.filter((x) => typeof x === 'string');
  if (type === 'object') {
    o.properties = Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, simpleSchema(v)]));
    if (Array.isArray(s.required)) o.required = s.required.filter((r) => o.properties[r]);
  }
  if (type === 'array') o.items = simpleSchema(s.items);
  return o;
}

function toolDeclarations(tools, back, simple) {
  const decls = [];
  for (const t of tools || []) {
    if (!t || !t.name) continue;
    if (t.type && t.type !== 'custom') continue;       // серверные инструменты Anthropic: web_search обрабатывает searchAnswer, остальное мост не умеет
    const name = fnName(t.name);
    back.set(name, t.name);
    const d = { name, description: String(t.description || '') };
    const sc = t.input_schema;
    if (sc && sc.properties && Object.keys(sc.properties).length) d.parametersJsonSchema = simple ? simpleSchema(sc) : cleanSchema(sc);
    decls.push(d);
  }
  return decls.length ? [{ functionDeclarations: decls }] : undefined;
}

function mediaPart(b) {
  const s = b.source || {};
  if (s.type === 'base64' && s.data) return { inlineData: { mimeType: s.media_type || (b.type === 'document' ? 'application/pdf' : 'image/png'), data: s.data } };
  if (s.type === 'text' && s.data) return { text: String(s.data) };
  if (s.type === 'url' && s.url) return { text: `[${b.type}: ${s.url}]` };
  return null;
}

/** Содержимое tool_result → текст и вложения. */
function flattenResult(content) {
  if (typeof content === 'string') return { text: content, media: [] };
  const texts = [], media = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!b) continue;
    if (b.type === 'text') texts.push(b.text || '');
    else if (b.type === 'image' || b.type === 'document') { const p = mediaPart(b); if (p) media.push(p); }
    else if (b.type === 'tool_reference') texts.push(`[tool reference: ${b.tool_name}]`);
    else if (b.text) texts.push(String(b.text));
  }
  return { text: texts.join('\n'), media };
}

/**
 * Запрос Anthropic Messages → запрос Vertex generateContent.
 * ctx: { sigs, level, preface, simple } — подписи, уровень размышлений по умолчанию, вступление к системной инструкции.
 */
function toGemini(body, ctx) {
  const back = new Map();                    // имя у Gemini → настоящее имя инструмента
  const toolNames = new Map();               // id вызова → имя у Gemini
  const out = [];                            // { role, parts, calls?, resp?, media? }

  for (const m of body.messages || []) {
    if (m.role === 'assistant') {
      const parts = [], calls = [];
      for (const b of typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []) {
        if (b.type === 'text' && b.text) {
          const p = { text: b.text };
          const sig = ctx.sigs.get(`tx:${hashText(b.text)}`);
          if (sig) p.thoughtSignature = sig;
          parts.push(p);
        } else if (b.type === 'tool_use') {
          const name = fnName(b.name);
          toolNames.set(b.id, name);
          const p = { functionCall: { name, args: b.input && typeof b.input === 'object' ? b.input : {} } };
          // Подпись обязательна у первого вызова каждого хода; у вызовов Claude её нет — ставим пустую
          const sig = ctx.sigs.get(`id:${b.id}`) || (calls.length === 0 ? DUMMY_SIG : null);
          if (sig) p.thoughtSignature = sig;
          parts.push(p);
          calls.push({ id: b.id, name });
        }
        // размышления Claude (thinking, redacted_thinking) Gemini ни к чему и подписаны чужим ключом
      }
      if (parts.length) out.push({ role: 'model', parts, calls });
      continue;
    }
    // user, а также system посреди беседы (новый Claude Code кладёт так сведения об окружении): для Gemini это реплика пользователя
    const parts = [], resp = [];
    for (const b of typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []) {
      if (b.type === 'text') { if (b.text) parts.push({ text: b.text }); }
      else if (b.type === 'image' || b.type === 'document') { const p = mediaPart(b); if (p) parts.push(p); }
      else if (b.type === 'tool_result') {
        const name = toolNames.get(b.tool_use_id);
        const { text, media } = flattenResult(b.content);
        if (!name) { parts.push({ text: `[tool result without a call] ${text}`.slice(0, 4000) }); continue; }
        const payload = b.is_error ? { error: text || 'error' } : { output: text || '(no output)' };
        resp.push({ id: b.tool_use_id, part: { functionResponse: { name, response: payload } }, media, text });
      } else if (b.text) parts.push({ text: String(b.text) });
    }
    if (parts.length || resp.length) out.push({ role: 'user', parts, resp });
  }

  // Подряд идущие реплики одной роли склеиваем: Gemini требует чередования
  const merged = [];
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) {
      last.parts.push(...c.parts);
      if (c.role === 'model') last.calls.push(...c.calls); else last.resp.push(...c.resp);
    } else merged.push({ ...c, parts: [...c.parts], calls: c.calls && [...c.calls], resp: c.resp && [...c.resp] });
  }

  // Каждому вызову — ровно один ответ, в том же порядке; нет ответа (прервали) — подставляем сообщение об этом
  const contents = [];
  for (let i = 0; i < merged.length; i++) {
    const c = merged[i];
    if (c.role === 'model') {
      contents.push({ role: 'model', parts: c.parts });
      if (c.calls.length) {
        let next = merged[i + 1];
        if (!next || next.role !== 'user') { next = { role: 'user', parts: [], resp: [] }; merged.splice(i + 1, 0, next); }
        next.expect = c.calls;
      }
      continue;
    }
    let parts = [];
    if (c.expect) {
      const have = new Map(c.resp.map((r) => [r.id, r]));
      const media = [];
      for (const call of c.expect) {
        const r = have.get(call.id);
        parts.push(r ? r.part : { functionResponse: { name: call.name, response: { error: 'No result was recorded for this call (it was interrupted).' } } });
        if (r) { media.push(...r.media); have.delete(call.id); }
      }
      parts.push(...media, ...c.parts, ...[...have.values()].map((r) => ({ text: `[tool result without a call] ${r.text}`.slice(0, 4000) })));
    } else {
      parts = [...c.parts, ...c.resp.map((r) => ({ text: `[tool result without a call] ${r.text}`.slice(0, 4000) }))];
    }
    if (parts.length) contents.push({ role: 'user', parts });
  }
  if (contents.length && contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '(the conversation continues)' }] });

  // Системная инструкция: вступление моста + системный промпт Claude Code без служебной строки биллинга
  const sysTexts = [];
  if (ctx.preface) sysTexts.push(ctx.preface);
  const sys = body.system;
  for (const b of typeof sys === 'string' ? [{ text: sys }] : sys || []) {
    const t = b && b.text;
    if (t && !/^x-anthropic-billing-header:/i.test(t)) sysTexts.push(t);
  }

  const gen = { maxOutputTokens: Math.max(1, Math.min(Number(body.max_tokens) || 8192, MAX_OUTPUT)) };
  if (ctx.thinking) gen.thinkingConfig = { thinkingLevel: thinkingLevel(body, ctx.level) };
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) gen.stopSequences = body.stop_sequences.slice(0, 5);

  const req = { contents, generationConfig: gen };
  if (sysTexts.length) req.systemInstruction = { parts: [{ text: sysTexts.join('\n\n') }] };
  const tools = toolDeclarations(body.tools, back, ctx.simple);
  if (tools) req.tools = tools;
  const tc = body.tool_choice;
  if (tools && tc && tc.type) {
    if (tc.type === 'any') req.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    else if (tc.type === 'tool' && tc.name) req.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [fnName(tc.name)] } };
    else if (tc.type === 'none') req.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
  }
  return { req, back };
}

/** Усилие Claude Code → уровень размышлений Gemini (minimal принимают не все модели, поэтому нижний уровень — low). */
function thinkingLevel(body, def) {
  if (body.thinking && body.thinking.type === 'disabled') return 'low';
  const eff = body.output_config && body.output_config.effort;
  if (eff) return ({ low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' })[eff] || def;
  const budget = body.thinking && body.thinking.budget_tokens;
  if (budget) return budget < 3000 ? 'low' : budget < 12000 ? 'medium' : 'high';
  return def;
}

// ─────────────────────────── Gemini → Anthropic ───────────────────────────

/** Выход в виде потока событий Anthropic (stream: true). Заголовки уходят только вместе с первым содержимым. */
class SseOut {
  constructor(res, model) { this.res = res; this.model = model; this.id = rid('msg_'); this.idx = -1; this.open = false; this.begun = false; this.done = false; }

  ev(name, data) { this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); }

  begin() {
    if (this.begun) return;
    this.begun = true;
    this.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'request-id': rid('req_') });
    this.ev('message_start', { type: 'message_start', message: {
      id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  }

  closeText() {
    if (!this.open) return;
    this.ev('content_block_stop', { type: 'content_block_stop', index: this.idx });
    this.open = false;
  }

  text(s) {
    this.begin();
    if (!this.open) {
      this.idx++; this.open = true;
      this.ev('content_block_start', { type: 'content_block_start', index: this.idx, content_block: { type: 'text', text: '' } });
    }
    this.ev('content_block_delta', { type: 'content_block_delta', index: this.idx, delta: { type: 'text_delta', text: s } });
  }

  tool(id, name, args) {
    this.begin(); this.closeText();
    this.idx++;
    this.ev('content_block_start', { type: 'content_block_start', index: this.idx, content_block: { type: 'tool_use', id, name, input: {} } });
    this.ev('content_block_delta', { type: 'content_block_delta', index: this.idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args || {}) } });
    this.ev('content_block_stop', { type: 'content_block_stop', index: this.idx });
  }

  end(stop, usage) {
    this.begin(); this.closeText();
    this.ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage });
    this.ev('message_stop', { type: 'message_stop' });
    this.done = true; this.res.end();
  }

  /** Ошибка: до первого содержимого — обычный ответ с кодом (Claude Code по нему решает, повторять ли), после — событие error. */
  fail(e) {
    this.done = true;
    if (!this.begun) return sendError(this.res, e.status || 502, e.type || 'api_error', e.message);
    this.ev('error', { type: 'error', error: { type: e.type || 'api_error', message: e.message } });
    this.res.end();
  }
}

/** Выход одним сообщением (stream: false). */
class JsonOut {
  constructor(res, model) { this.res = res; this.model = model; this.blocks = []; this.begun = false; this.done = false; }
  begin() { this.begun = true; }
  text(s) {
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.type === 'text') last.text += s; else this.blocks.push({ type: 'text', text: s });
  }
  tool(id, name, args) { this.blocks.push({ type: 'tool_use', id, name, input: args || {} }); }
  end(stop, usage) {
    this.done = true;
    const body = JSON.stringify({ id: rid('msg_'), type: 'message', role: 'assistant', model: this.model, content: this.blocks, stop_reason: stop, stop_sequence: null, usage });
    this.res.writeHead(200, { 'Content-Type': 'application/json', 'request-id': rid('req_') });
    this.res.end(body);
  }
  fail(e) { this.done = true; sendError(this.res, e.status || 502, e.type || 'api_error', e.message); }
}

function sendError(res, status, type, message) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  const h = { 'Content-Type': 'application/json', 'request-id': rid('req_') };
  if (status === 429 || status === 529) h['retry-after'] = '5';
  res.writeHead(status, h);
  res.end(body);
}

/** События SSE от Vertex: каждое — JSON после «data:». */
async function* sseJson(res) {
  res.setEncoding('utf8');
  let buf = '';
  for await (const chunk of res) {
    buf += chunk;
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buf);
      if (!m) break;
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      yield j;
    }
  }
  const tail = buf.trim();
  if (tail.startsWith('data:')) { try { yield JSON.parse(tail.slice(5).trim()); } catch { /* оборвано */ } }
}

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);
const isBlocked = (f) => BLOCKED.has(f) || /^BLOCKED_/.test(f);
const BROKEN = new Set(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS']);

/**
 * Читает поток Vertex и отдаёт его в out. Возвращает { empty, usage, finish }.
 * empty — модель ничего не сказала: до первого содержимого ничего не отправлено, так что можно спросить заново.
 */
async function pump(up, out, ctx) {
  let usage = null, finish = '', finishMessage = '', calls = 0, wrote = false;
  let text = '', pendingSig = null;
  const flushText = () => {
    if (text && pendingSig) ctx.sigs.set(`tx:${hashText(text)}`, pendingSig);
    text = ''; pendingSig = null;
  };
  for await (const j of sseJson(up)) {
    if (j.error) throw new BridgeError(502, 'api_error', `Vertex AI: ${String(j.error.message || JSON.stringify(j.error)).slice(0, 500)}`, true);
    if (j.usageMetadata && j.usageMetadata.promptTokenCount != null) usage = j.usageMetadata;
    const cand = (j.candidates || [])[0];
    if (!cand) {
      if (j.promptFeedback && j.promptFeedback.blockReason) finish = `BLOCKED_${j.promptFeedback.blockReason}`;
      continue;
    }
    for (const p of (cand.content && cand.content.parts) || []) {
      if (p.thought) continue;                          // краткое изложение мыслей не просили, но если придёт — не показываем
      if (p.functionCall) {
        flushText();
        const id = rid('toolu_', 22);
        if (p.thoughtSignature) ctx.sigs.set(`id:${id}`, p.thoughtSignature);
        const name = ctx.back.get(p.functionCall.name) || p.functionCall.name;
        out.tool(id, name, p.functionCall.args || {});
        calls++; wrote = true;
        continue;
      }
      if (typeof p.text === 'string') {
        if (p.thoughtSignature) pendingSig = p.thoughtSignature;
        if (p.text) { out.text(p.text); text += p.text; wrote = true; }
      }
    }
    if (cand.finishReason) finish = cand.finishReason;
    if (cand.finishMessage) finishMessage = String(cand.finishMessage);
  }
  flushText();
  return { empty: !wrote, usage, finish, finishMessage, calls };
}

// ─────────────────────────── Мост ───────────────────────────

/**
 * opts: keyFile | key, project, location, models (id через запятую или массив), dataDir, log, dailyUsd,
 *       defaultModel, level (уровень размышлений по умолчанию), secret, port, host, vertexBase, tokenUrl, prices, retryWaits (мс).
 */
function createBridge(opts = {}) {
  const log = opts.log || (() => {});
  const key = opts.key || JSON.parse(fs.readFileSync(opts.keyFile, 'utf8'));
  const project = opts.project || key.project_id;
  const location = opts.location || 'global';
  const base = opts.vertexBase || (location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`);
  const ids = (Array.isArray(opts.models) ? opts.models : String(opts.models || '').split(',')).map((s) => s.trim()).filter(Boolean);
  const models = (ids.length ? ids : GEMINI_MODELS.map((m) => m.id)).map((id) => ({ id, label: geminiLabel(id), hint: (modelInfo(id) || {}).hint || '', estimated: !modelInfo(id) || Boolean(modelInfo(id).estimated) }));
  const defaultModel = opts.defaultModel || models[0].id;
  const level = opts.level || 'medium';
  const dailyUsd = opts.dailyUsd == null ? 25 : Number(opts.dailyUsd);
  const secret = opts.secret || crypto.randomBytes(24).toString('hex');
  const auth = new Auth(key, opts.tokenUrl);
  if (opts.dataDir) { try { fs.mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 }); } catch {} }
  const dataFile = (n) => (opts.dataDir ? path.join(opts.dataDir, n) : null);
  const sigs = new SigStore(dataFile('signatures.jsonl'));
  const spend = new Spend(dataFile('spend.json'));
  const simpleTools = new Set();                    // наборы инструментов, схемы которых Vertex отверг: дальше шлём упрощённые
  const prefaceFor = (model) => `You are Gemini (model ${model}), made by Google, working inside the Claude Code agent harness through a compatibility bridge. ` +
    `The instructions below were written for Claude Code and may say that you are Claude or mention Claude models: follow them for tools, ` +
    `permissions and workflow, but if asked who you are, answer that you are Gemini by Google. The conversation history may contain earlier ` +
    `turns written by Claude; treat them as your own earlier work in the same project and continue consistently.`;

  const authorized = (req) => {
    const given = String(req.headers['x-api-key'] || '').trim() || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const a = Buffer.from(given), b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const resolveModel = (asked) => {
    const m = String(asked || '').replace(/\[1m\]$/i, '');
    if (models.some((x) => x.id === m) || isGeminiModel(m)) return m;
    if (/haiku/i.test(m)) return SMALL_MODEL;
    return defaultModel;
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 128 * 1024 * 1024) { req.destroy(); reject(new Error('тело больше 128 МБ')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  /** Открыть поток у Vertex; 429 и 5xx пробуем ещё раз-два, вход обновляем при 401. */
  async function openUpstream(model, payload, ctl, method = 'streamGenerateContent') {
    const url = `${base}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:${method}${method === 'streamGenerateContent' ? '?alt=sse' : ''}`;
    const body = Buffer.from(JSON.stringify(payload));
    const waits = opts.retryWaits || [1500, 4000];
    for (let i = 0; ; i++) {
      const tok = await auth.token();
      const r = await rawRequest(url, { method: 'POST', body, ctl, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } });
      if (r.status === 200) return r.res;
      const err = mapUpstreamError(r.status, await readAll(r.res));
      if (r.status === 401 && i === 0) { auth.invalidate(); continue; }
      if (err.retryable && i < waits.length && !ctl.aborted) { await sleep(waits[i]); continue; }
      throw err;
    }
  }

  /** Подзапрос WebSearch из Claude Code: у Anthropic это серверный инструмент web_search, здесь на него отвечает Gemini с поиском Google. */
  const isSearchCall = (body) => Array.isArray(body.tools) && body.tools.length > 0 && body.tools.every((t) => t && /^web_search/.test(String(t.type || '')));

  async function searchAnswer(body, model, out, ctl, t0) {
    const conv = toGemini({ ...body, tools: [], tool_choice: undefined }, { sigs, level, preface: '', thinking: false, simple: false });
    conv.req.tools = [{ googleSearch: {} }];
    delete conv.req.toolConfig;
    const up = await openUpstream(model, conv.req, ctl);
    let text = '', u = null, queries = [];
    const links = new Map();
    for await (const j of sseJson(up)) {
      if (j.error) throw new BridgeError(502, 'api_error', `Vertex AI: ${String(j.error.message || JSON.stringify(j.error)).slice(0, 500)}`, true);
      if (j.usageMetadata && j.usageMetadata.promptTokenCount != null) u = j.usageMetadata;
      const cand = (j.candidates || [])[0];
      if (!cand) continue;
      for (const p of (cand.content && cand.content.parts) || []) if (typeof p.text === 'string' && !p.thought) text += p.text;
      const gm = cand.groundingMetadata;
      if (gm) {
        for (const q of gm.webSearchQueries || []) if (!queries.includes(q)) queries.push(q);
        for (const c of gm.groundingChunks || []) if (c.web && c.web.uri && !links.has(c.web.uri)) links.set(c.web.uri, c.web.title || c.web.uri);
      }
    }
    text = text.trim() || 'No results were returned by the search.';
    if (links.size) text += '\n\nSources:\n' + [...links].slice(0, 10).map(([uri, title]) => `- ${title}: ${uri}`).join('\n');
    out.text(text);
    const tok = { prompt: (u && u.promptTokenCount) || 0, cached: (u && u.cachedContentTokenCount) || 0, out: u ? (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) : 0 };
    const usd = costOf(model, tok, opts.prices) + 0.014 * Math.max(1, queries.length);   // поиск Google у Vertex оплачивается отдельно, ≈$14 за 1000 запросов
    spend.add(model, tok, usd);
    out.end('end_turn', { input_tokens: tok.prompt, output_tokens: tok.out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    log('INFO', 'Gemini: веб-поиск', { модель: model, сек: Math.round((Date.now() - t0) / 100) / 10, запросов: queries.length, источников: links.size, usd: Math.round(usd * 10000) / 10000 });
  }

  async function messages(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendError(res, 400, 'invalid_request_error', 'bridge: the request body is not valid JSON'); }
    const model = resolveModel(body.model);
    const out = body.stream ? new SseOut(res, body.model || model) : new JsonOut(res, body.model || model);
    const ctl = { aborted: false, req: null };
    res.on('close', () => { if (!res.writableFinished) { ctl.aborted = true; try { ctl.req && ctl.req.destroy(); } catch {} } });

    if (dailyUsd > 0 && spend.today() >= dailyUsd) {
      return out.fail(new BridgeError(400, 'invalid_request_error',
        `Суточный потолок расхода на Gemini достигнут: $${spend.today().toFixed(2)} из $${dailyUsd}. Поднять — GEMINI_DAILY_USD в /etc/claude-tg-bot.env или переключитесь на Claude (/model).`));
    }

    const t0 = Date.now();
    try {
      if (isSearchCall(body)) return await searchAnswer(body, model, out, ctl, t0);
      const toolSig = JSON.stringify((body.tools || []).map((t) => t.name));
      let conv = toGemini(body, { sigs, level, preface: prefaceFor(model), thinking: /^gemini-3/.test(model), simple: simpleTools.has(toolSig) });
      for (let attempt = 0; ; attempt++) {
        let up;
        try {
          up = await openUpstream(model, conv.req, ctl);
        } catch (e) {
          // Vertex не принял схему инструмента — один раз повторяем с упрощёнными схемами и запоминаем это
          if (e.status === 400 && /schema|parameters|function_declarations|functionDeclarations/i.test(e.message) && !simpleTools.has(toolSig) && body.tools && body.tools.length) {
            simpleTools.add(toolSig);
            log('WARN', 'Vertex отверг схемы инструментов, перехожу на упрощённые', { причина: e.message.slice(0, 200) });
            conv = toGemini(body, { sigs, level, preface: prefaceFor(model), thinking: /^gemini-3/.test(model), simple: true });
            continue;
          }
          throw e;
        }
        const r = await pump(up, out, { sigs, back: conv.back });
        if (r.empty && !ctl.aborted && attempt < 2 && !isBlocked(r.finish)) {
          log('WARN', 'Gemini вернул пустой ответ, спрашиваю ещё раз', { модель: model, причина: r.finish || 'нет', сообщение: r.finishMessage.slice(0, 300) });
          continue;
        }
        if (r.empty && BROKEN.has(r.finish)) throw new BridgeError(502, 'api_error', `Vertex AI: ответ прерван (${r.finish}) — модель сформировала вызов инструмента неверно`, true);
        if (r.empty) out.text(isBlocked(r.finish) ? `⚠️ Gemini отказался отвечать (${r.finish}).` : '⚠️ Gemini вернул пустой ответ.');
        const u = r.usage || {};
        const tok = { prompt: u.promptTokenCount || 0, cached: u.cachedContentTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
        const usd = costOf(model, tok, opts.prices);
        spend.add(model, tok, usd);
        const stop = r.calls ? 'tool_use' : r.finish === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
        out.end(stop, { input_tokens: Math.max(0, tok.prompt - tok.cached), output_tokens: tok.out, cache_read_input_tokens: tok.cached, cache_creation_input_tokens: 0 });
        log('INFO', 'Gemini', { модель: model, сек: Math.round((Date.now() - t0) / 100) / 10, вход: tok.prompt, из_кэша: tok.cached, выход: tok.out,
          мысли: u.thoughtsTokenCount || 0, вызовов: r.calls, конец: r.finish, usd: Math.round(usd * 10000) / 10000 });
        return;
      }
    } catch (e) {
      if (ctl.aborted || out.done) return;
      const err = e instanceof BridgeError ? e : new BridgeError(502, 'api_error', `bridge: ${e.message}`, true);
      log('WARN', 'Gemini: ошибка', { модель: model, код: err.status, текст: err.message.slice(0, 300) });
      out.fail(err);
    }
  }

  const estimate = (body) => Math.ceil(JSON.stringify([body.system || '', body.messages || [], body.tools || []]).length / 3.5);

  async function handle(req, res) {
    const p = new URL(req.url, 'http://x').pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/health')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      if (!authorized(req)) return sendError(res, 401, 'authentication_error', 'invalid x-api-key');
      if (req.method === 'POST' && p === '/v1/messages') return await messages(req, res);
      if (req.method === 'POST' && p === '/v1/messages/count_tokens') {
        let body = {};
        try { body = JSON.parse(await readBody(req)); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: estimate(body) }));
      }
      const asModel = (m) => ({ type: 'model', id: m.id, display_name: m.label, created_at: '2026-01-01T00:00:00Z', max_input_tokens: CONTEXT_TOKENS, max_tokens: MAX_OUTPUT });
      if (req.method === 'GET' && p === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: models.map(asModel), has_more: false, first_id: models[0].id, last_id: models[models.length - 1].id }));
      }
      if (req.method === 'GET' && p.startsWith('/v1/models/')) {
        const id = decodeURIComponent(p.slice('/v1/models/'.length));
        const m = models.find((x) => x.id === id) || { id, label: geminiLabel(id) };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(asModel(m)));
      }
      sendError(res, 404, 'not_found_error', `bridge: no route ${req.method} ${p}`);
    } catch (e) {
      log('ERROR', `Мост Gemini: ${e.message}`);
      sendError(res, 500, 'api_error', `bridge: ${e.message}`);
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.keepAliveTimeout = 120000;
  const bridge = {
    secret, models, defaultModel, project, location, dailyUsd, spend, sigs,
    get port() { const a = server.address(); return a && a.port; },
    get baseUrl() { return `http://${opts.host || '127.0.0.1'}:${bridge.port}`; },
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port || 0, opts.host || '127.0.0.1', () => { server.off('error', reject); resolve(bridge); });
    }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections && server.closeAllConnections(); }),
    /** Короткий пробный запрос: доходит ли ключ до модели. Тратит доли цента. */
    async probe(modelId) {
      const model = resolveModel(modelId || defaultModel);
      const t0 = Date.now();
      try {
        const ctl = { aborted: false, req: null };
        const up = await openUpstream(model, {
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
          generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingLevel: 'low' } },
        }, ctl);
        let text = '', u = null;
        for await (const j of sseJson(up)) {
          if (j.error) throw new BridgeError(502, 'api_error', String(j.error.message || 'ошибка Vertex'));
          for (const p of ((j.candidates || [])[0] || {}).content?.parts || []) if (typeof p.text === 'string' && !p.thought) text += p.text;
          if (j.usageMetadata && j.usageMetadata.promptTokenCount != null) u = j.usageMetadata;
        }
        const tok = { prompt: (u && u.promptTokenCount) || 0, cached: (u && u.cachedContentTokenCount) || 0, out: u ? (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) : 0 };
        spend.add(model, tok, costOf(model, tok, opts.prices));
        return { ok: true, ms: Date.now() - t0, text: text.trim().slice(0, 40), model };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300), model };
      }
    },
  };
  return bridge;
}

module.exports = {
  createBridge, GEMINI_MODELS, geminiLabel, isGeminiModel, modelInfo, costOf, toGemini, cleanSchema, simpleSchema, mapUpstreamError,
  thinkingLevel, SigStore, Spend, DUMMY_SIG, SMALL_MODEL, CONTEXT_TOKENS, MAX_OUTPUT,
};

// Отдельный запуск: node gemini.js --key ключ.json [--port 8788] [--secret строка] [--data каталог] [--models a,b]
// Нужен, чтобы подключить Gemini к Claude Code на компьютере: ANTHROPIC_BASE_URL=http://127.0.0.1:8788, ANTHROPIC_AUTH_TOKEN=<секрет>.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n, d = '') => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  if (!arg('key')) { console.error('usage: node gemini.js --key service-account.json [--port 8788] [--secret S] [--data DIR] [--models a,b] [--daily-usd 25]'); process.exit(2); }
  const bridge = createBridge({
    keyFile: arg('key'), port: Number(arg('port', '8788')), secret: arg('secret') || undefined, dataDir: arg('data') || undefined,
    models: arg('models'), dailyUsd: arg('daily-usd') === '' ? undefined : Number(arg('daily-usd')),
    log: (lvl, msg, extra) => console.log(`[${new Date().toISOString()}] [${lvl}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`),
  });
  bridge.listen().then(() => {
    console.log(`Gemini bridge: ${bridge.baseUrl}  (project ${bridge.project}, ${bridge.location})`);
    console.log(`ANTHROPIC_BASE_URL=${bridge.baseUrl}`);
    console.log(`ANTHROPIC_AUTH_TOKEN=${bridge.secret}`);
  }).catch((e) => { console.error(`cannot start: ${e.message}`); process.exit(1); });
}
