#!/usr/bin/env node
'use strict';
/**
 * Telegram-пульт для Claude Code — версия 2.
 * Управление разработкой с телефона: проекты, сессии, модели,
 * режим обсуждения, git-действия, учёт расхода.
 *
 * Секреты только из окружения (EnvironmentFile в systemd).
 */

const https = require('https');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─────────────────────────── Конфигурация ───────────────────────────

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || '').trim();
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/opt/projects';
const STATE_FILE = process.env.STATE_FILE || '/var/lib/claude-tg-bot/state.json';
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/bin/claude';
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MIN || 30) * 60 * 1000;

// Голосовой ввод: локальный whisper.cpp + статический ffmpeg (без root и без
// API-ключа). Всё лежит в каталоге состояния, права claudebot.
const STT_DIR = process.env.STT_DIR || '/var/lib/claude-tg-bot/stt';
const FFMPEG_BIN = path.join(STT_DIR, 'bin', 'ffmpeg');
const WHISPER_BIN = path.join(STT_DIR, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
// small (квантованная) понимает русский заметно точнее base: на тестовой фразе
// base услышал «либо от поставок» вместо «ли бот поставок», small — без единой
// ошибки. Цена — время: на одном ядре small идёт ~0,7× длительности на коротких
// голосовых и ~1,4× на длинных, base — ~0,45×. Поэтому длинные идут через base.
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(STT_DIR, 'whisper.cpp', 'models', 'ggml-small-q5_1.bin');
const WHISPER_FAST_MODEL = path.join(STT_DIR, 'whisper.cpp', 'models', 'ggml-base.bin');
const WHISPER_LANG = process.env.WHISPER_LANG || 'ru';   // 'auto' — на 4–5 с дольше
const LONG_AUDIO_S = 120;            // длиннее — быстрая base, иначе ждать дольше самой задачи
const VOICE_MAX = 20 * 1024 * 1024;  // больше Telegram ботам всё равно не отдаёт

const MAX_MSG = 3800;        // запас до лимита Telegram в 4096
const AS_FILE_OVER = 6000;   // длиннее — отправляем файлом

// Ключи — псевдонимы Claude Code: CLI сам разворачивает их в самую новую модель
// семейства (в 2.1.285: opus → claude-opus-5-5, sonnet → claude-sonnet-5-5).
// Новые модели приходят с обновлением CLI, которое root ставит по таймеру
// claude-code-update, — бот править не нужно. Номер версии в меню не зашит:
// он берётся из каталога моделей установленного CLI и из ответов модели.
const MODELS = {
  opus:   { family: 'Opus',   hint: 'для сложной и повседневной работы' },
  sonnet: { family: 'Sonnet', hint: 'быстрее и легче' },
  haiku:  { family: 'Haiku',  hint: 'самая быстрая' },
  fable:  { family: 'Fable',  hint: 'самая сильная и самая дорогая' },
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Субагенты — главный пожиратель лимита в боте: у каждого свой контекст, свой
// холодный кэш и своя запись по ×1,25, а с 2.1.28x они ещё и уходят в фон по
// умолчанию и пачками (Workflow). С 22.08 их было 110 штук и 16% всего расхода,
// а 22–24.08 они съели больше самой беседы. В боте их нет вовсе — ни инструментом,
// ни фоновыми задачами, ни расписанием.
const NO_AGENT_TOOLS = ['Agent', 'Task', 'Workflow', 'SendMessage', 'Monitor',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger'];
const NO_AGENT_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
  CLAUDE_CODE_DISABLE_CRON: '1',
  CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1',
};

const BOT_VERSION = '2026-10-02.2';
const WHATS_NEW =
`♻️ <b>Бот обновлён</b>

🎙 Голосовые снова распознаются: после обновления 1 октября они падали с ошибкой про таймаут. Отправьте последнее голосовое ещё раз.`;

if (!TOKEN) fatal('Не задан TELEGRAM_BOT_TOKEN');
if (!OWNER_ID) fatal('Не задан TELEGRAM_OWNER_ID');

function fatal(msg) { log('FATAL', msg); process.exit(1); }

function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(extra ? `${line} ${JSON.stringify(extra)}` : line);
}

// ─────────────────────────── Состояние ───────────────────────────

let state = {
  offset: 0,
  activeProject: null,
  sessions: {},          // путь проекта -> session id
  projects: {},          // имя -> путь (добавленные вручную)
  model: 'opus',         // модель выбирает владелец, дефолт — Opus 5
  effort: '',            // '' = уровень по умолчанию
  mode: 'dev',           // 'dev' — с инструментами, 'talk' — обсуждение без них
  // Сжимаем рано и только на прогретом кэше. Дорогим сжатие делает не оно
  // само, а размер беседы и остывший кэш: на 570 тыс. токенов вхолодную это
  // стоило 724 тыс. базовых, а на 150 тыс. сразу после ответа — около 190 тыс.
  autoCompact: true,
  brief: true,           // просить короткие ответы: выхлоп стоит впятеро дороже ввода
  warmHours: 6,          // сколько часов после сообщения держать кэш тёплым; 0 — не держать
  coolCompact: true,     // большую беседу сжимать, пока кэш не остыл, если пауза дольше окна
  announced: '',         // какую версию бота уже показали в «что нового»
  lastUsage: null,       // расход последнего ответа — по нему видно объём контекста
  rate: null,            // цифры лимитов подписки из потока Claude Code, см. noteRateLimit
  usage: { total: { cost: 0, tasks: 0, inTok: 0, outTok: 0 }, byDay: {}, byProject: {},
           warm: { pings: 0, base: 0, compacts: 0 } },
  lastAnswer: '',        // для кнопки «показать полностью»
};

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...state, ...saved, usage: { ...state.usage, ...(saved.usage || {}) } };
    if (!state.model) state.model = 'opus';
    if (typeof state.warmHours !== 'number') state.warmHours = 6;
    log('INFO', 'Состояние загружено', {
      проект: state.activeProject, модель: state.model || 'по умолчанию',
    });
  } catch (e) {
    if (e.code !== 'ENOENT') log('WARN', `Не удалось прочитать состояние: ${e.message}`);
  }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      log('ERROR', `Не удалось сохранить состояние: ${e.message}`);
    }
  }, 300);
}

// ─────────────────────────── Telegram API ───────────────────────────

function tg(method, payload, timeoutMs = 65000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) return reject(new Error(`${method}: ${parsed.description}`));
          resolve(parsed.result);
        } catch (e) { reject(new Error(`${method}: некорректный ответ — ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('таймаут запроса к Telegram')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Отправка файла (multipart/form-data) — для длинных ответов. */
function tgDocument(filename, content, caption) {
  return new Promise((resolve, reject) => {
    const boundary = `----tg${crypto.randomBytes(16).toString('hex')}`;
    const parts = [];
    const field = (name, value) => {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      ));
    };
    field('chat_id', OWNER_ID);
    if (caption) field('caption', caption.slice(0, 1000));
    if (caption) field('parse_mode', 'HTML');
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
      `Content-Type: text/markdown\r\n\r\n`
    ));
    parts.push(Buffer.from(content, 'utf8'));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendDocument`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) return reject(new Error(parsed.description));
          resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('таймаут отправки файла')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function send(html, extra = {}) {
  if (!html) return null;
  const chunks = splitText(String(html), MAX_MSG);
  let last = null;
  for (const chunk of chunks) {
    try {
      last = await tg('sendMessage', {
        chat_id: OWNER_ID, text: chunk, parse_mode: 'HTML',
        disable_web_page_preview: true, ...extra,
      });
    } catch (e) {
      log('ERROR', `Отправка не удалась: ${e.message}`);
      // разметка могла не пройти — пробуем без неё
      try {
        last = await tg('sendMessage', {
          chat_id: OWNER_ID, text: chunk.replace(/<[^>]+>/g, ''),
          disable_web_page_preview: true, ...extra,
        });
      } catch (e2) { log('ERROR', `Повторная отправка не удалась: ${e2.message}`); }
    }
  }
  return last;
}

async function edit(messageId, html) {
  if (!messageId) return;
  try {
    await tg('editMessageText', {
      chat_id: OWNER_ID, message_id: messageId,
      text: html.slice(0, MAX_MSG), parse_mode: 'HTML', disable_web_page_preview: true,
    });
  } catch (e) {
    if (!/not modified/i.test(e.message)) log('WARN', `Правка сообщения: ${e.message}`);
  }
}

// ──────────────────── Markdown → разметка Telegram ────────────────────

// Маркер-заглушка для спрятанных фрагментов. Символ служебный, в тексте
// ответа встретиться не может, поэтому подмена безопасна.
const NUL = '';

/**
 * Claude отвечает в Markdown, а Telegram его не понимает — понимает только
 * свой набор HTML-тегов. Переводим одно в другое.
 *
 * Порядок важен: сначала прячем код (внутри него ничего форматировать нельзя),
 * потом экранируем HTML, потом разбираем markdown, в конце возвращаем код.
 */
function md2tg(src) {
  if (!src) return '';
  const vault = [];
  const hide = (html) => `${NUL}${vault.push(html) - 1}${NUL}`;

  let t = String(src).replace(/\r\n?/g, '\n');

  // 1. Блоки кода ```lang … ``` — с подсветкой синтаксиса
  t = t.replace(/```(\w+)?[ \t]*\n([\s\S]*?)```/g, (_, lang, code) => {
    const body = esc(code.replace(/\n+$/, ''));
    return hide(lang
      ? `<pre><code class="language-${esc(lang)}">${body}</code></pre>`
      : `<pre>${body}</pre>`);
  });

  // 2. Таблицы — Telegram их не умеет, поэтому выравниваем колонки
  //    и отдаём моноширинным блоком с горизонтальной прокруткой.
  t = t.replace(/(^\|.*\|[ \t]*\n\|[ \t:|-]+\|[ \t]*\n(?:\|.*\|[ \t]*\n?)*)/gm,
    (block) => hide(renderTable(block)));

  // 3. Строчный код `…`
  t = t.replace(/`([^`\n]+)`/g, (_, c) => hide(`<code>${esc(c)}</code>`));

  // 4. Теперь можно безопасно экранировать остальное
  t = esc(t);

  // 5. Ссылки [текст](адрес)
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, txt, url) => `<a href="${url}">${txt}</a>`);

  // 6. Заголовки — в Telegram их нет, показываем жирным
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, '<b>$1</b>');

  // 7. Начертание
  t = t.replace(/\*\*\*(.+?)\*\*\*/gs, '<b><i>$1</i></b>');
  t = t.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
  t = t.replace(/__(.+?)__/gs, '<b>$1</b>');
  t = t.replace(/~~(.+?)~~/gs, '<s>$1</s>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/gm, '$1<i>$2</i>');
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/gm, '$1<i>$2</i>');

  // 8. Списки (с сохранением вложенности) и разделители
  t = t.replace(/^([ \t]*)[-*+][ \t]+/gm,
    (_, ind) => (ind.replace(/\t/g, '  ').length >= 2 ? '   ◦ ' : '• '));
  t = t.replace(/^[ \t]{0,3}(?:---+|\*\*\*+|___+)[ \t]*$/gm, '──────────');

  // 9. Цитаты — подряд идущие строки в один блок
  t = t.replace(/(?:^&gt;[ \t]?.*(?:\n|$))+/gm, (block) => {
    const body = block.replace(/^&gt;[ \t]?/gm, '').replace(/\n$/, '');
    return `<blockquote>${body}</blockquote>\n`;
  });

  // 10. Снимаем markdown-экранирование: \* и \_ должны стать обычными знаками
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, '$1');

  // 11. Возвращаем спрятанное
  t = t.replace(new RegExp(`${NUL}(\\d+)${NUL}`, 'g'), (_, i) => vault[Number(i)]);

  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// Ширина, за которой моноширинный блок перестаёт помещаться в экран телефона
// и Telegram включает горизонтальную прокрутку. Всё, что шире, показываем
// карточками — их читать сверху вниз, прокрутка не нужна.
const TABLE_FIT = 36;

/**
 * Markdown-таблица → разметка Telegram.
 * Узкая остаётся выровненной таблицей, широкая разворачивается в карточки:
 * первая колонка — заголовок записи, остальные — значения через точку.
 */
function renderTable(block) {
  const rows = block.trim().split('\n')
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));

  const sep = rows.findIndex((r) => r.length && r.every((c) => /^:?-{2,}:?$/.test(c)));
  const header = sep > 0 ? rows[sep - 1] : null;
  const data = (sep >= 0 ? rows.slice(sep + 1) : rows).filter((r) => r.some((c) => c));
  if (!data.length) return `<pre>${esc(block.trim())}</pre>`;

  // markdown-начертание внутри ячеек убираем: в таблице оно только мешает
  const strip = (c) => String(c || '').replace(/\*\*|__|~~|`/g, '').replace(/\\([*_])/g, '$1').trim();
  const head = header ? header.map(strip) : null;
  const body = data.map((r) => r.map(strip));

  const cols = Math.max(...body.map((r) => r.length), head ? head.length : 0);
  const width = [];
  for (let c = 0; c < cols; c++) {
    width[c] = Math.max(
      head ? (head[c] || '').length : 0,
      ...body.map((r) => (r[c] || '').length)
    );
  }
  const total = width.reduce((a, b) => a + b, 0) + 2 * (cols - 1);

  // Узкая таблица — оставляем выровненной, так нагляднее всего
  if (total <= TABLE_FIT) {
    const line = (r) => r.map((c, i) => (c || '').padEnd(width[i])).join('  ').trimEnd();
    const out = [];
    if (head) {
      out.push(line(head));
      out.push(width.map((w) => '─'.repeat(w)).join('  '));
    }
    body.forEach((r) => out.push(line(r)));
    return `<pre>${esc(out.join('\n'))}</pre>`;
  }

  // Широкая — карточками: заголовок записи и значения под ним
  const cards = body.map((r) => {
    const title = esc(r[0] || '');
    const rest = [];
    for (let c = 1; c < cols; c++) {
      const v = r[c];
      if (!v) continue;
      rest.push(head && head[c] ? `${esc(head[c])} <b>${esc(v)}</b>` : esc(v));
    }
    return `▪️ <b>${title}</b>${rest.length ? `\n   ${rest.join(' · ')}` : ''}`;
  });
  return cards.join('\n');
}

/**
 * Режем длинный текст по строкам, не разрывая теги: если чанк оборвался внутри
 * блока кода или цитаты, закрываем их и открываем заново в следующем куске.
 */
function splitText(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let buf = '', open = null;

  const flush = () => {
    if (!buf) return;
    out.push(open ? `${buf}${closeOf(open)}` : buf);
    buf = '';
  };
  const closeOf = (tag) => (tag === 'pre' ? '</pre>' : '</blockquote>');
  const openOf = (tag) => (tag === 'pre' ? '<pre>' : '<blockquote>');

  for (const line of text.split('\n')) {
    const pieces = line.length > limit - 200
      ? line.match(new RegExp(`.{1,${limit - 200}}`, 'g')) || [line]
      : [line];

    for (const piece of pieces) {
      if ((buf + '\n' + piece).length > limit - 40) {
        const carry = open;
        flush();
        if (carry) buf = openOf(carry);
      }
      buf = buf ? `${buf}\n${piece}` : piece;

      // следим, внутри какого блочного тега мы находимся
      for (const m of piece.matchAll(/<(\/?)(pre|blockquote)\b/g)) {
        open = m[1] ? null : m[2];
      }
    }
  }
  flush();
  return out.filter(Boolean);
}

// ─────────────────────────── Клавиатуры ───────────────────────────

// Нижней клавиатуры нет намеренно: она занимала пол-экрана телефона, а всё то
// же самое доступно через меню команд. Кнопки остались только там, где нужен
// выбор из списка — проекты, модели, сессии: это подсказки, а не постоянный
// интерфейс.
const noKeyboard = { remove_keyboard: true };

// ─────────────────────────── Проекты ───────────────────────────

function discoverProjects() {
  const found = {};
  try {
    for (const e of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) found[e.name] = path.join(PROJECTS_ROOT, e.name);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') log('WARN', `Обзор проектов: ${e.message}`);
  }
  return { ...found, ...state.projects };
}

const pName = () => (state.activeProject ? path.basename(state.activeProject) : '—');

// ─────────────────────────── Учёт расхода ───────────────────────────

/**
 * Цена в «базовых» токенах по ценам API: запись в часовой кэш ×2 (в пятиминутный
 * ×1,25), чтение ×0,1, выхлоп ×5. Бот на подписке пишет в часовой.
 */
function baseEq(u) {
  u = u || {};
  const wrote = u.cache_creation_input_tokens || 0;
  const hour = Math.min(wrote, (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
  return hour * 2 + (wrote - hour) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1
       + (u.input_tokens || 0) + (u.output_tokens || 0) * 5;
}

/**
 * Сколько контекста прочла модель за одно обращение. Итог задачи для этого не
 * годится: в нём сумма по всем обращениям хода, и задача с пятью вызовами
 * инструментов показывала контекст впятеро больше настоящего.
 */
const ctxOf = (u) => (u ? (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
                          + (u.input_tokens || 0) : 0);

function trackUsage(ev) {
  const cost = Number(ev.total_cost_usd || 0);
  const u = ev.usage || {};
  state.lastUsage = u;
  const inTok = Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
  const outTok = Number(u.output_tokens || 0);
  const day = new Date().toISOString().slice(0, 10);

  const t = state.usage.total;
  t.cost += cost; t.tasks += 1; t.inTok += inTok; t.outTok += outTok;

  const d = (state.usage.byDay[day] ||= { cost: 0, tasks: 0 });
  d.cost += cost; d.tasks += 1;

  if (state.activeProject) {
    const p = (state.usage.byProject[state.activeProject] ||= { cost: 0, tasks: 0 });
    p.cost += cost; p.tasks += 1;
  }
  // храним только 30 последних дней
  const days = Object.keys(state.usage.byDay).sort();
  while (days.length > 30) delete state.usage.byDay[days.shift()];
  saveState();
}

// ─────────────────────── Claude Code: версия и модели ───────────────────────

let cli = { version: '', latest: {}, mtime: 0 };

/** claude-opus-5-5 → «Opus 5.5», claude-haiku-4-5-20251001 → «Haiku 4.5». */
function modelName(id) {
  const m = String(id || '').match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=$|[-[])/);
  if (!m) return String(id || '');
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** Что стоит за пунктом меню: «opus» → «Opus 5.5» по каталогу установленного CLI. */
function modelLabel(alias) {
  const id = cli.latest[alias] || (state.resolved || {})[alias];
  return (id && modelName(id)) || MODELS[alias]?.family || alias || 'по умолчанию';
}

const modelsLine = () => Object.keys(MODELS).map(modelLabel).join(' · ');

/** Запоминаем, во что CLI на деле развернул псевдоним, — это видно по ответам. */
function noteModel(e, id) {
  if (!/^claude-/.test(String(id || ''))) return;   // у служебных ответов бывает «<synthetic>»
  e.model = id;
  if ((state.resolved || {})[e.alias] !== id) {
    state.resolved = { ...(state.resolved || {}), [e.alias]: id };
    saveState();
  }
}

/**
 * Версия установленного CLI и самые новые модели каждого семейства. Перечитываем,
 * только когда бинарник поменялся — его меняет ночной таймер claude-code-update.
 */
async function refreshCli() {
  let real, mtime;
  try { real = fs.realpathSync(CLAUDE_BIN); mtime = fs.statSync(real).mtimeMs; }
  catch (e) { log('WARN', `Claude Code не найден: ${e.message}`); return; }
  if (mtime === cli.mtime) return;
  cli.mtime = mtime;   // сразу, чтобы параллельный вызов не полез читать второй раз

  const version = await new Promise((resolve) => execFile(CLAUDE_BIN, ['--version'],
    { timeout: 30000 }, (err, out) => resolve((String(out || '').match(/\d+\.\d+\.\d+/) || [''])[0])));
  // Каталог моделей зашит в бинарник: latest_per_family:{opus:"claude-opus-5-5",…}.
  // Берём его оттуда, чтобы меню знало номера версий ещё до первого запроса.
  // Поменяется формат — номер всё равно подтянется из первого ответа модели.
  const latest = await new Promise((resolve) => execFile('grep',
    ['-a', '-o', '-m', '1', '-E', 'latest_per_family:\\{[^}]{0,400}\\}', real],
    { timeout: 30000, maxBuffer: 1 << 20 }, (err, out) => {
      const map = {};
      for (const m of String(out || '').matchAll(/(\w+):"(claude-[\w-]+)"/g)) map[m[1]] = m[2];
      resolve(map);
    }));
  cli = { version, latest, mtime };
  log('INFO', 'Claude Code', { версия: version, модели: latest });

  const prev = state.cliVersion;
  if (!version || prev === version) return;
  state.cliVersion = version; saveState();
  if (!prev) return;
  // Живой процесс на старой версии не трогаем — у него тёплый кэш. Его просто
  // перестаём прогревать: на первой же паузе он погаснет, и беседа продолжится
  // на новой версии и новых моделях. Новый системный промпт всё равно означает
  // одну запись беседы в кэш заново, пинги её только отложили бы.
  if (engine && engine.binMtime !== mtime) { engine.stale = true; rescheduleWarm(); }
  send(`🆕 <b>Claude Code обновился</b>: ${esc(prev)} → ${esc(version)}\n\n` +
       `Модели: ${esc(modelsLine())}\n\n` +
       `<i>Новая версия включится после ближайшей паузы в работе.</i>`,
       { disable_notification: true }).catch(() => {});
}

// ──────────────── Постоянный процесс Claude Code ────────────────
//
// Ключевая вещь для скорости и расхода лимитов. Раньше на каждое сообщение
// поднимался новый процесс с --resume: Claude Code перечитывал историю
// целиком (на беседе в 6 МБ это ~7 секунд) и заново прогонял весь контекст.
// Теперь процесс живёт между сообщениями и принимает их потоком
// (--input-format stream-json): контекст остаётся у него в памяти, ответ
// приходит за 2–3 секунды, а свежих токенов уходит около двух вместо сотен
// тысяч — остальное читается из прогретого кэша.
//
// Кэш промпта на стороне Anthropic живёт час — это потолок настройки
// promptCacheTtl в самом CLI («5m» или «1h», на подписке «1h»). Пока он жив,
// контекст читается по ×0,1, остывший переписывается целиком в часовой кэш по ×2.
// По логам 25.08–01.10 все 88 холодных стартов пришлись на паузы дольше часа:
// внутри часа кэш не остывал ни разу, дело только в паузах. Они и делали бот
// дороже VS Code: 54% всего расхода бота против 17% там — пауз столько же, но в
// боте после паузы приходит короткий вопрос, а за компьютером — большая задача.
//
// Поэтому после ответа кэш держим тёплым: раз в 54 минуты живому процессу уходит
// служебный пинг. Он читает беседу из кэша (×0,1), и кэш живёт ещё час. Прогон
// по реальным паузам тех же пяти недель: без прогрева холодные старты стоили
// 15,4 млн базовых токенов сверх тёплой цены, с окном 6 часов — 10,8 млн.
const CACHE_TTL_MS = 60 * 60 * 1000;
const PING_EVERY_MS = 54 * 60 * 1000;   // запас на задержки сети и таймеров
// Без прогрева процесс живёт чуть дольше кэша: погасить раньше — подарить лишний
// холодный старт, держать дольше бессмысленно, кэш всё равно истёк.
const IDLE_MS = 70 * 60 * 1000;
// Сжатие перед остыванием. Пауза дольше окна всё равно кончится холодным стартом —
// перезаписью всей беседы по ×2. Большую беседу бот сжимает заранее, пока кэш ещё
// тёплый: чтение по ×0,1 плюс выжимка, а после паузы в кэш пишется уже она
// (~35 тыс. с системным промптом), а не вся беседа. Тот же прогон: окно 6 ч со
// сжатием бесед от 80 тыс. — 8,1–8,9 млн вместо 10,8 (разброс — от длины выжимки).
// Беседы меньше не трогаем: выигрыш копеечный, а подробности теряются.
const COOL_COMPACT_MIN = 80000;
const WARM_PING = '[служебный пинг бота, пользователь ничего не писал — держу кэш ' +
  'беседы тёплым] Ничего не делай, инструменты не вызывай, ответь одним символом: .';

let engine = null;    // живой процесс Claude Code
let current = null;   // задача, выполняемая прямо сейчас
const queue = [];     // задачи, пришедшие, пока Claude занят

const isBusy = () => current !== null;

/** Настройки, при смене которых процесс надо поднимать заново. */
const engineKey = () => [state.activeProject, state.model, state.effort, state.mode].join('|');

function killEngine(reason) {
  if (!engine) return;
  const e = engine;
  engine = null;
  clearTimeout(e.idleTimer);
  log('INFO', `Останавливаю процесс Claude: ${reason}`);
  if (e.waiter) { const w = e.waiter; e.waiter = null; w.resolve({ __dead: true }); }
  try { e.child.stdin.end(); } catch {}
  try {
    e.child.kill('SIGTERM');
    setTimeout(() => { try { e.child.kill('SIGKILL'); } catch {} }, 4000);
  } catch (err) { log('WARN', `Остановка процесса: ${err.message}`); }
}

/**
 * Что делать процессу после ответа: в окне прогрева — ждать следующего пинга;
 * за окном большую беседу сжать, пока кэш тёплый; иначе — погаснуть, когда кэш остынет.
 */
function scheduleWarm(e) {
  if (!e || engine !== e) return;
  clearTimeout(e.idleTimer);
  const pingAt = e.lastTurnAt + PING_EVERY_MS;
  const warmUntil = e.lastUserAt + state.warmHours * 3600e3;
  if (state.warmHours > 0 && !e.noWarm && !e.stale && pingAt <= warmUntil) {
    e.idleTimer = setTimeout(() => warmPing(e), Math.max(1000, pingAt - Date.now()));
  } else if (wantCoolCompact(e)) {
    e.idleTimer = setTimeout(() => coolCompact(e), Math.max(1000, pingAt - Date.now()));
  } else {
    e.idleTimer = setTimeout(() => killEngine('простой'),
      Math.max(1000, e.lastTurnAt + IDLE_MS - Date.now()));
  }
}

/** Сжимать ли беседу перед остыванием: большая, кэш держится, в эту паузу ещё не сжимали. */
const wantCoolCompact = (e) => state.coolCompact && !e.noWarm && !e.coolDone
  && ctxOf(e.lastCall) >= COOL_COMPACT_MIN;

/** Перепланировать после смены настройки — но не посреди хода, его result сделает это сам. */
function rescheduleWarm() {
  if (engine && !engine.waiter) scheduleWarm(engine);
}

/** До какого момента кэш процесса останется тёплым, если ничего не писать. */
function warmEnd(e) {
  let t = e.lastTurnAt;
  if (state.warmHours > 0 && !e.noWarm && !e.stale) {
    const limit = e.lastUserAt + state.warmHours * 3600e3;
    while (t + PING_EVERY_MS <= limit) t += PING_EVERY_MS;
  }
  return t + CACHE_TTL_MS;
}

/** Служебный пинг: прочесть беседу из кэша, чтобы он прожил ещё час. */
async function warmPing(e) {
  if (engine !== e) return;
  if (e.key !== engineKey()) return killEngine('сменились проект или настройки');
  // Задача уже стоит в очереди к процессу — она кэш и прогреет
  if (isBusy()) { e.idleTimer = setTimeout(() => warmPing(e), 60e3); return; }
  const expect = ctxOf(e.lastCall);   // столько должно прочитаться из тёплого кэша
  const res = await ask(WARM_PING, null, { ping: e });
  if (res.__dead) return;
  const u = res.usage || {};
  const w = (state.usage.warm ||= { pings: 0, base: 0 });
  w.pings += 1; w.base += baseEq(u); saveState();
  const read = u.cache_read_input_tokens || 0, wrote = u.cache_creation_input_tokens || 0;
  log('INFO', 'Прогрев кэша', { чтение: read, запись: wrote, выхлоп: u.output_tokens || 0 });
  // Кэш не дожил до пинга (сверх лимитов подписки CLI урезает ему жизнь до
  // 5 минут) или пинг упёрся в ошибку — дальше пинги только тратили бы лимит
  if (res.is_error || wrote > read || read < expect * 0.5) {
    e.noWarm = true;
    log('WARN', 'Прогрев не удержал кэш — для этого процесса выключен',
        { ошибка: Boolean(res.is_error), ожидалось: expect });
  }
  scheduleWarm(e);
}

/**
 * Пауза затянулась дольше окна прогрева: сжать большую беседу, пока кэш тёплый.
 * Иначе первое сообщение после паузы переписало бы в кэш её всю.
 */
async function coolCompact(e) {
  if (engine !== e) return;
  if (e.key !== engineKey()) return killEngine('сменились проект или настройки');
  if (isBusy()) { e.idleTimer = setTimeout(() => coolCompact(e), 60e3); return; }
  const ctx = ctxOf(e.lastCall);
  const started = Date.now();
  e.coolDone = true;
  e.compacting = true;
  log('INFO', 'Сжатие перед остыванием', { контекст: ctx });
  const res = await ask('/compact', null, { ping: e });
  e.compacting = false;
  if (res.__dead) return;
  if (res.is_error || !(e.compactedAt >= started)) {
    log('WARN', 'Сжатие перед остыванием не вышло', { ошибка: Boolean(res.is_error) });
    return scheduleWarm(e);
  }
  const w = (state.usage.warm ||= { pings: 0, base: 0 });
  w.compacts = (w.compacts || 0) + 1;
  w.base += baseEq(res.usage);
  forgetContext();
  log('INFO', 'Беседа сжата перед остыванием', { было: ctx, секунд: Math.round((Date.now() - started) / 1000) });
  send(`🗜 Пока вас не было, сжал беседу (было <b>${kTok(ctx)}</b> токенов) — ` +
       `кэш вот-вот остынет. Первое сообщение после паузы перепишет в него краткую ` +
       `выжимку, а не всю беседу.\n\n<i>Настроить — /warm</i>`,
       { disable_notification: true }).catch(() => {});
}

function startEngine() {
  const cwd = state.activeProject;
  const sessionId = state.sessions[cwd];
  const talk = state.mode === 'talk';
  refreshCli().catch(() => {});   // заодно заметить, не обновился ли CLI

  const args = ['-p', '--input-format', 'stream-json',
                '--output-format', 'stream-json', '--verbose',
                // Убирает из системного промпта изменчивые части — каталог,
                // окружение, git status. Иначе любая правка файлов меняет
                // начало запроса, и весь диалог переписывается в кэш заново.
                // Замер: после правки файла чтение кэша падало с 28 589 до
                // 22 914 (то есть до голого системного промпта), с флагом —
                // остаётся 27 889. На большой беседе это разница в сотни
                // тысяч токенов на каждой правке.
                '--exclude-dynamic-system-prompt-sections'];
  // Выхлоп стоит впятеро дороже ввода. На замере обычного сообщения он давал
  // 20 780 из 37 251 — больше половины цены. Короткие ответы экономят сильнее
  // всех прочих настроек, а на телефоне читаются лучше длинных.
  const extra = [];
  if (state.brief) {
    extra.push(
      'Отвечай кратко — ответ читают с телефона в Telegram. Только суть и вывод: ' +
      'без пересказа задачи, без плана действий, без перечисления того, что уже сделал. ' +
      'Не подводи итогов и не предлагай следующие шаги, если об этом не спросили. ' +
      'Таблицы и списки — только когда они правда нужны. ' +
      'Если ответ умещается в одну строку, одной строкой и отвечай.');
  }
  // Выводы команд оседают в контексте навсегда и дорожают каждое следующее
  // сообщение: в прошлой беседе они дали 13,7 МБ из 21.
  extra.push(
    'Не вываливай в контекст сырые данные. Агрегируй прямо в команде: печатай ' +
    'итог, а не полный список; длинные выводы обрезай через head; при разборе ' +
    'таблиц и логов считай в python и выводи только результат.');
  args.push('--append-system-prompt', extra.join(' '));
  if (talk) args.push('--tools', '');   // обсуждение и расчёты — без инструментов
  else args.push('--permission-mode', 'bypassPermissions',
                 '--disallowed-tools', NO_AGENT_TOOLS.join(','));
  if (state.model) args.push('--model', state.model);
  if (state.effort) args.push('--effort', state.effort);
  if (sessionId) args.push('--resume', sessionId);
  else args.push('--session-id', crypto.randomUUID());

  const child = spawn(CLAUDE_BIN, args, {
    cwd, env: { ...process.env, CI: '1', TERM: 'dumb', ...NO_AGENT_ENV },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const now = Date.now();
  const e = { child, key: engineKey(), alias: state.model, cwd, buf: '', stderr: '',
              waiter: null, onEvent: null, idleTimer: null, fresh: !sessionId,
              model: '', lastCall: null, turnIsPing: false, binMtime: cli.mtime,
              lastTurnAt: now,     // когда кэш грелся в последний раз
              lastUserAt: now,     // когда закончился последний настоящий ход
              noWarm: false, stale: false,
              coolDone: false,     // в эту паузу беседу уже сжимали
              compacting: false, compactedAt: 0 };
  engine = e;
  log('INFO', 'Поднят процесс Claude', { cwd, продолжение: Boolean(sessionId), cli: cli.version });

  // Иначе русская буква, разрезанная между двумя кусками вывода, превращалась в «�»
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    e.buf += chunk;
    const lines = e.buf.split('\n');
    e.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }

      if (ev.session_id && state.sessions[e.cwd] !== ev.session_id) {
        state.sessions[e.cwd] = ev.session_id; saveState();
      }
      if (ev.type === 'system' && ev.subtype === 'init') noteModel(e, ev.model);
      // После сжатия прежний объём контекста ни о чём не говорит
      if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
        e.lastCall = null;
        e.compactedAt = Date.now();
        // Сжатие по заполнению Claude Code делает сам; VS Code его показывает —
        // показываем и мы. Ручное (кнопка, перед остыванием) сообщает о себе отдельно.
        const m = ev.compact_metadata || {};
        if (m.trigger === 'auto') {
          log('INFO', 'Автосжатие беседы', { было: m.pre_tokens, стало: m.post_tokens });
          const size = m.pre_tokens
            ? `: было <b>${kTok(m.pre_tokens)}</b>${m.post_tokens ? `, стало <b>${kTok(m.post_tokens)}</b>` : ''} токенов` : '';
          send(`🗜 Беседа заполнилась и сжата автоматически${size}`, { disable_notification: true }).catch(() => {});
        }
      }
      if (ev.type === 'assistant' && ev.message) {
        noteModel(e, ev.message.model);
        if (ev.message.usage) e.lastCall = ev.message.usage;
      }
      if (ev.type === 'rate_limit_event') { try { noteRateLimit(ev.rate_limit_info); } catch {} }
      if (e.onEvent) { try { e.onEvent(ev); } catch {} }

      if (ev.type === 'result') {
        e.lastTurnAt = Date.now();
        // Событие о лимитах идёт только при смене процента: тихий ответ значит «без перемен»
        if (state.rate) state.rate.seenAt = e.lastTurnAt;
        if (!e.turnIsPing) { e.lastUserAt = e.lastTurnAt; e.coolDone = false; }
        state.lastCtx = ctxOf(e.lastCall); saveState();
        if (e.waiter) { const w = e.waiter; e.waiter = null; e.onEvent = null; w.resolve(ev); }
        scheduleWarm(e);
      }
    }
  });

  child.stderr.on('data', (c) => {
    e.stderr += c.toString();
    if (e.stderr.length > 8000) e.stderr = e.stderr.slice(-8000);
  });
  // Запись в stdin умершего процесса даёт асинхронный EPIPE — без обработчика
  // он уронил бы весь бот. Сама смерть процесса ловится в close ниже.
  child.stdin.on('error', (err) => log('WARN', `stdin процесса Claude: ${err.message}`));

  const die = (why) => {
    if (engine === e) engine = null;
    clearTimeout(e.idleTimer);
    if (e.waiter) { const w = e.waiter; e.waiter = null; w.resolve({ __dead: true, why }); }
  };
  child.on('close', (code) => { log('INFO', `Процесс Claude завершился, код ${code}`); die(`код ${code}`); });
  child.on('error', (err) => { e.stderr += `\nОшибка запуска: ${err.message}`; die(err.message); });

  scheduleWarm(e);
  return e;
}

let askChain = Promise.resolve();

/**
 * Отправляет сообщение живому процессу и ждёт события result. Строго по одному:
 * задача, сжатие и пинг прогрева иначе перебивали бы друг другу ожидание ответа.
 * content — строка или готовые блоки сообщения (текст и картинки).
 */
function ask(content, onEvent, opts = {}) {
  const run = askChain.then(() => askNow(content, onEvent, opts));
  askChain = run.catch(() => {});
  return run;
}

function askNow(content, onEvent, opts) {
  // Задачу прервали, пока она ждала очереди, — не поднимать ради неё процесс
  if (opts.skip && opts.skip()) return Promise.resolve({ __dead: true, why: 'отменено' });
  // Пинг адресован конкретному процессу: если его уже сменили, греть нечего
  if (opts.ping && (engine !== opts.ping || engine.key !== engineKey())) {
    return Promise.resolve({ __dead: true, why: 'процесс сменился' });
  }
  if (engine && engine.key !== engineKey()) killEngine('сменились проект или настройки');
  const e = engine || startEngine();

  return new Promise((resolve) => {
    e.waiter = { resolve };
    e.onEvent = onEvent;
    e.turnIsPing = Boolean(opts.ping);
    clearTimeout(e.idleTimer);
    try {
      e.child.stdin.write(JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
        },
      }) + '\n');
    } catch (err) {
      e.waiter = null;
      resolve({ __dead: true, why: err.message });
    }
  });
}

async function runClaude(task) {
  const me = current;
  const cwd = state.activeProject;
  const talk = state.mode === 'talk';
  const alive = Boolean(engine && engine.key === engineKey());
  const warm = alive && Date.now() - engine.lastTurnAt < CACHE_TTL_MS;
  const blocks = task.blocks || [];

  log('INFO', 'Запуск задачи', {
    cwd, режим: state.mode, модель: state.model,
    процесс: alive ? (warm ? 'живой, кэш тёплый' : 'живой, кэш остыл') : 'новый',
    задача: task.text.slice(0, 120), картинок: blocks.filter((b) => b.type === 'image').length,
  });

  const started = me?.startedAt || Date.now();
  const head = talk ? '💬 Думаю…' : '🚀 Работаю…';
  let statusId = null, toolCount = 0, lastTool = '', lastEdit = 0;

  const cache = !state.sessions[cwd] ? '🆕 новая беседа'
    : alive && engine.compacting ? '🗜 как раз сжимаю беседу после паузы — отвечу через минуту-две'
    : warm ? '🔥 кэш тёплый'
    : alive ? '🧊 кэш остыл — этот ответ дороже'
    : '🧵 загружаю историю';
  send(
    `${head}\n\n📁 <b>${esc(pName())}</b>${task.label ? ` • ${esc(task.label)}` : ''}\n` +
    `${cache} • ${esc(modelLabel(state.model))}`
  ).then((m) => { statusId = m && m.message_id; }).catch(() => {});

  const progress = () => {
    const now = Date.now();
    if (now - lastEdit < 3000 || !statusId) return;
    lastEdit = now;
    edit(statusId,
      `${head}\n\n📁 <b>${esc(pName())}</b>\n` +
      (toolCount ? `🔧 действий: <b>${toolCount}</b>\n` : '') +
      (lastTool ? `${lastTool}\n` : '') +
      `⏱ ${fmtDur(Math.round((now - started) / 1000))}`
    );
  };

  const timer = setTimeout(() => {
    log('WARN', 'Превышен таймаут задачи');
    stopChild('таймаут');
  }, TASK_TIMEOUT_MS);

  const typing = setInterval(() => {
    tg('sendChatAction', { chat_id: OWNER_ID, action: 'typing' }).catch(() => {});
  }, 6000);

  // Картинки и кадры — прямо в сообщении, а не путём к файлу: так их видно и
  // в режиме обсуждения (там нет инструментов), и не уходит лишний ход на
  // чтение файла, а каждый ход перечитывает весь контекст.
  const content = [{ type: 'text', text: task.text }, ...blocks];

  const res = await ask(content, (ev) => {
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const b of ev.message.content) {
        if (b.type === 'tool_use') { toolCount++; lastTool = describeTool(b); progress(); }
      }
    }
  }, { skip: () => Boolean(me?.cancelled) });

  clearTimeout(timer);
  clearInterval(typing);
  const cancelled = me?.cancelled;
  const reason = me?.cancelReason;
  const stderrTail = engine ? engine.stderr : '';
  if (current === me) current = null;

  const secs = Math.round((Date.now() - started) / 1000);
  if (statusId) {
    try { await tg('deleteMessage', { chat_id: OWNER_ID, message_id: statusId }); } catch {}
  }

  if (cancelled) {
    return send(`⛔️ <b>Остановлено</b> (${esc(reason || 'по команде')}) через ${fmtDur(secs)}\n\n` +
                `<i>Контекст беседы сохранён — следующее сообщение продолжит её.</i>`);
  }

  if (res.__dead) {
    log('ERROR', 'Процесс Claude умер во время задачи', { why: res.why, stderr: stderrTail.slice(-400) });
    return send(`❌ <b>Процесс прервался</b> • ${fmtDur(secs)}\n\n` +
                `<pre>${esc((stderrTail || res.why || 'без подробностей').slice(-1500))}</pre>\n\n` +
                `<i>Напишите ещё раз — беседа продолжится с сохранённого места.</i>`);
  }

  trackUsage(res);
  const finalText = res.result || '';
  const isError = Boolean(res.is_error) || res.subtype !== 'success';

  if (isError) {
    log('ERROR', 'Задача с ошибкой', { subtype: res.subtype });
    const detail = (finalText || stderrTail || 'нет подробностей').trim();
    const limitHit = /rate.?limit|usage limit|too many requests|429/i.test(detail);
    return send(
      `❌ <b>Ошибка</b> • ${fmtDur(secs)}\n\n<pre>${esc(detail.slice(0, 2500))}</pre>` +
      (limitHit ? `\n\n⚠️ Похоже, достигнут лимит подписки — загляните в 📈 Лимиты.` : '')
    );
  }

  log('INFO', 'Задача выполнена', { secs, toolCount });
  state.lastAnswer = finalText; saveState();

  const meta = `${talk ? '💬' : '✅'} ${fmtDur(secs)}${toolCount ? ` • 🔧 ${toolCount}` : ''} • 📁 ${esc(pName())}`;

  if (finalText.length > AS_FILE_OVER) {
    try {
      await tgDocument(
        `ответ-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`,
        finalText, `${meta}\n\nОтвет длинный — прислал файлом.`
      );
      await autoCompact();
      return;
    } catch (e) {
      log('WARN', `Файл не ушёл, шлю текстом: ${e.message}`);
    }
  }
  await send(`${meta}\n\n${md2tg(finalText) || '<i>(пустой ответ)</i>'}`,
             { reply_markup: taskKeyboard() });
  // Сжимаем после ответа, а не до: задача уже закрыта, ждать никого не заставляем
  return autoCompact();
}

/** Новая задача: сразу в работу или в очередь, если Claude занят. */
function submit(task) {
  if (!state.activeProject) return screenProjects();
  if (isBusy() || queue.length) {
    queue.push(task);
    const secs = isBusy() ? Math.round((Date.now() - current.startedAt) / 1000) : 0;
    return send(
      `📥 В очереди${queue.length > 1 ? ` (${queue.length})` : ''} — начну, как только ` +
      `закончу текущую задачу${secs ? ` (идёт ${fmtDur(secs)})` : ''}.\n<i>Прервать всё: /stop</i>`);
  }
  startTask(task);
}

function startTask(task) {
  // Занимаем слот синхронно: между этой строкой и запуском процесса есть await,
  // и без флага второе сообщение успело бы запустить вторую задачу.
  const mine = { cancelled: false, startedAt: Date.now(), prompt: task.text };
  current = mine;
  // Намеренно не ждём завершения: цикл опроса Telegram должен продолжать
  // работать, иначе команды и /stop не отвечают, пока Claude занят.
  runClaude(task)
    .catch(async (e) => {
      log('ERROR', `Сбой задачи: ${e.stack || e.message}`);
      if (current === mine) current = null;
      await send(`❌ Внутренняя ошибка: ${esc(e.message)}`).catch(() => {});
    })
    .finally(drainQueue);
}

/** После задачи — всё, что накопилось, одним сообщением. */
function drainQueue() {
  if (isBusy() || !queue.length) return;
  const list = queue.splice(0);
  // Каждый ход перечитывает весь контекст, так что три сообщения подряд
  // втрое дороже одного, в котором три абзаца.
  startTask(list.length === 1 ? list[0] : {
    text: list.map((t) => t.text).join('\n\n'),
    blocks: list.flatMap((t) => t.blocks || []),
    label: `${list.length} ${plural(list.length, 'сообщение', 'сообщения', 'сообщений')} из очереди`,
  });
}

/** 1 фото, 2 фото… — русское число для подписи. */
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  return a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

/**
 * Кнопки под ответом. На тяжёлой беседе добавляем сжатие: именно её объём
 * оплачивается заново при каждом холодном старте.
 */
function taskKeyboard() {
  const rows = [[
    { text: '🆕 Новая беседа', callback_data: 'act:newask' },
    { text: '📊 Статус', callback_data: 'act:status' },
  ]];
  // На разросшейся беседе предлагаем начать новую, а не сжимать: сжатие
  // перечитывает весь диалог и стоит примерно как он сам, а новая беседа
  // стартует почти с нуля. Память проекта при этом никуда не девается.
  if (lastContext() >= CTX_LIMIT) {
    rows.unshift([{ text: '🆕 Начать новую — дешевле', callback_data: 'act:newask' }]);
  }
  return { inline_keyboard: rows };
}

/**
 * Что именно сейчас делает Claude. Возвращает готовую разметку Telegram:
 * команды и пути — моноширинным, чтобы читались как в терминале.
 */
function describeTool(b) {
  const name = b.name || 'tool';
  const i = b.input || {};
  const mono = (v, n) => `<code>${esc(String(v).replace(/\s+/g, ' ').slice(0, n))}</code>`;

  if (name === 'Bash' && i.command) return `💻 ${mono(i.command, 90)}`;
  if (name === 'Read' && i.file_path) return `📖 ${mono(path.basename(String(i.file_path)), 60)}`;
  if (name === 'Edit' && i.file_path) return `✏️ ${mono(path.basename(String(i.file_path)), 60)}`;
  if (name === 'Write' && i.file_path) return `📝 ${mono(path.basename(String(i.file_path)), 60)}`;
  if (i.file_path) return `${esc(name)} ${mono(path.basename(String(i.file_path)), 60)}`;
  if (name === 'Grep' && i.pattern) return `🔍 ${mono(i.pattern, 50)}`;
  if (name === 'Glob' && i.pattern) return `📂 ${mono(i.pattern, 50)}`;
  if (i.pattern) return `${esc(name)} ${mono(i.pattern, 50)}`;
  if (i.url) return `🌐 ${mono(i.url, 60)}`;
  if (name === 'TodoWrite') return '📋 план задач';
  return esc(name);
}

// Токены человеческим языком: 213к, 1,2 млн.
function kTok(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(".", ",")} млн`;
  if (n >= 1000) return `${Math.round(n / 1000)}к`;
  return String(n);
}

function fmtDur(s) {
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин ${s % 60} с` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/**
 * Прервать текущую задачу. Другого способа остановить начатый ход нет, кроме
 * как погасить процесс: беседа при этом не теряется — она записана на диск,
 * и следующее сообщение поднимет процесс заново с того же места.
 */
function stopChild(reason) {
  if (!current) return false;
  current.cancelled = true;
  current.cancelReason = reason;
  killEngine(`прервано (${reason})`);
  return true;
}

// ─────────────────────────── Экраны ───────────────────────────

async function screenProjects() {
  const projects = discoverProjects();
  const names = Object.keys(projects).sort();
  const rows = names.map((n) => [{
    text: `${projects[n] === state.activeProject ? '✅ ' : '📁 '}${n}`,
    callback_data: `p:${n}`,
  }]);
  rows.push([{ text: '➕ Создать проект', callback_data: 'act:newprojhelp' }]);
  rows.push([{ text: '⧉ Клонировать из git', callback_data: 'act:clonehelp' }]);

  if (!names.length) {
    return send(
      `📂 <b>Проектов пока нет</b>\n\nПоложите их в <code>${esc(PROJECTS_ROOT)}</code> ` +
      `или клонируйте из git.`,
      { reply_markup: { inline_keyboard: rows } }
    );
  }
  return send(`📂 <b>Проекты</b>\n\nТекущий: <b>${esc(pName())}</b>`,
    { reply_markup: { inline_keyboard: rows } });
}

async function screenModel() {
  const rows = Object.entries(MODELS).map(([k, m]) => [{
    text: `${state.model === k ? '✅ ' : ''}${modelLabel(k)} — ${m.hint}`,
    callback_data: `m:${k}`,
  }]);
  // Усилие — это объём размышлений, а они идут в выхлоп, который стоит ×5.
  // high и выше выжигают лимит быстрее всего, поэтому подписываем цену.
  rows.push([{ text: `${!state.effort ? '✅ ' : ''}обычное (дёшево)`, callback_data: 'e:' }]);
  rows.push(EFFORTS.map((e) => ({
    text: `${state.effort === e ? '✅' : ''}${e}${e === 'high' || e === 'xhigh' || e === 'max' ? '💸' : ''}`,
    callback_data: `e:${e}`,
  })));
  rows.push([
    { text: `${state.mode === 'dev' ? '✅ ' : ''}🛠 Разработка`, callback_data: 'mode:dev' },
    { text: `${state.mode === 'talk' ? '✅ ' : ''}💬 Обсуждение`, callback_data: 'mode:talk' },
  ]);

  return send(
    `🤖 <b>Модель и режим</b>\n\n` +
    `Сейчас: <b>${esc(modelLabel(state.model))}</b>\n` +
    `Усилие: <b>${esc(state.effort || 'по умолчанию')}</b>\n` +
    `Режим: <b>${state.mode === 'talk' ? 'обсуждение' : 'разработка'}</b>\n\n` +
    `<i>Обсуждение — без доступа к файлам и командам: быстрее и дешевле, ` +
    `подходит для вопросов и расчётов. Разработка — полный доступ.</i>\n\n` +
    `<i>Каждое семейство — всегда самая новая модель: Claude Code` +
    `${cli.version ? ` ${esc(cli.version)}` : ''} обновляется сам каждую ночь.</i>`,
    { reply_markup: { inline_keyboard: rows } }
  );
}

/** Сколько задач прошло через бота — в штуках, без денег: работа по подписке. */
function tasksSummary() {
  const t = state.usage.total;
  const today = state.usage.byDay[new Date().toISOString().slice(0, 10)] || { tasks: 0 };
  const L = [`Сегодня: ${today.tasks} • всего: ${t.tasks}`];

  const projects = Object.entries(state.usage.byProject)
    .sort((a, b) => b[1].tasks - a[1].tasks).slice(0, 4)
    .map(([p, v]) => `  ${esc(path.basename(p))} — ${v.tasks}`);
  if (projects.length) L.push('', '<b>По проектам</b>', ...projects);
  return L.join('\n');
}

// ── Лимиты из потока Claude Code ──
// С каждым ответом Claude Code присылает rate_limit_event: долю израсходованного
// пятичасового и недельного лимита (0…1) и время сброса. Это те же цифры, что в
// панели /usage, но без входа в интерактивном режиме и без второго процесса.
// Токен бота их не закрывает, в отличие от /api/oauth/usage, где нужно право
// user:profile. Событие приходит при каждой смене целого процента или времени
// сброса, поэтому цифры свежи настолько, насколько свежа последняя работа Claude.
const RATE_WINDOWS = [
  { key: 'five_hour',        name: 'Сессия', period: '5 часов' },
  { key: 'seven_day',        name: 'Неделя', period: 'все модели' },
  { key: 'seven_day_opus',   name: 'Неделя', period: 'Opus' },
  { key: 'seven_day_sonnet', name: 'Неделя', period: 'Sonnet' },
];

function noteRateLimit(info) {
  if (!info || typeof info !== 'object') return;
  const R = state.rate || (state.rate = { windows: {}, at: 0, seenAt: 0, blocked: null });
  const take = (key, w) => {
    const u = Number(w && w.utilization), reset = Number(w && w.resetsAt);
    if (Number.isFinite(u) && u >= 0 && Number.isFinite(reset) && reset > 0) R.windows[key] = { u, reset };
  };
  for (const [key, w] of Object.entries(info.unifiedWindows || {})) take(key, w);
  // Окно, из-за которого пришло событие: так видны Opus и Sonnet, у которых своих полей нет
  if (info.rateLimitType && !(info.unifiedWindows && info.unifiedWindows[info.rateLimitType])) {
    take(info.rateLimitType, { utilization: info.utilization, resetsAt: info.resetsAt });
  }
  R.blocked = info.status === 'rejected' && Number(info.resetsAt) > 0
    ? { type: info.rateLimitType || '', reset: Number(info.resetsAt) } : null;
  R.at = R.seenAt = Date.now();
  const pct = (k) => (R.windows[k] ? Math.round(R.windows[k].u * 100) : null);
  log('INFO', 'Лимиты из потока', { сессия: pct('five_hour'), неделя: pct('seven_day'), статус: info.status });
  saveState();
}

const MSK_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Секунды Unix → «в 16:30 МСК» или «5 окт в 11:00 МСК». Москва без перехода на летнее время, UTC+3. */
function fmtResetAt(sec) {
  const m = new Date((sec + 3 * 3600) * 1000), now = new Date(Date.now() + 3 * 3600e3);
  const hm = `${String(m.getUTCHours()).padStart(2, '0')}:${String(m.getUTCMinutes()).padStart(2, '0')}`;
  const sameDay = m.getUTCFullYear() === now.getUTCFullYear() && m.getUTCMonth() === now.getUTCMonth()
    && m.getUTCDate() === now.getUTCDate();
  return `${sameDay ? '' : `${m.getUTCDate()} ${MSK_MONTHS[m.getUTCMonth()]} `}в ${hm} МСК`;
}

/** «через 2 д 21 ч», «через 1 ч 17 мин», «через 12 мин». */
function fmtIn(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), mm = min % 60;
  if (d) return `через ${d} д${h ? ` ${h} ч` : ''}`;
  if (h) return `через ${h} ч${mm ? ` ${mm} мин` : ''}`;
  return `через ${mm} мин`;
}

/** Блоки для экрана лимитов из последних событий потока. */
function rateBlocks() {
  const R = state.rate;
  if (!R || !R.windows) return null;
  const nowSec = Date.now() / 1000;
  const blocks = [];
  for (const w of RATE_WINDOWS) {
    const v = R.windows[w.key];
    if (!v) continue;
    if (v.reset <= nowSec) {
      // окно сменилось, а новых цифр ещё не было — выдумывать ноль нельзя
      if (w.key === 'five_hour' || w.key === 'seven_day') blocks.push({ ...w, pct: null, reset: '' });
      continue;
    }
    blocks.push({ ...w, pct: Math.min(100, Math.round(v.u * 100)),
                  reset: `${fmtResetAt(v.reset)}, ${fmtIn(v.reset - nowSec)}` });
  }
  return { blocks, seenAt: R.seenAt || R.at, blocked: R.blocked };
}

// Чтение панели занимает около трёх секунд и поднимает отдельный процесс,
// поэтому держим свежий результат под рукой: повторный запрос отвечает мгновенно.
const LIMITS_TTL = 90 * 1000;
let limitsCache = { raw: '', auth: null, at: 0, inFlight: null };

/** Читает панель /usage из интерактивной сессии Claude Code (там живут лимиты). */
function readLimits() {
  return new Promise((resolve) => {
    execFile('/opt/claude-tg-bot/limits.sh', [],
      { timeout: 60000, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(stdout || (err ? err.message : '')));
  });
}

/**
 * Лимиты с кэшем. force — принудительно перечитать (кнопка «Обновить»).
 * Параллельные запросы не плодят процессы: второй ждёт результат первого.
 */
function getLimits(force = false) {
  const fresh = Date.now() - limitsCache.at < LIMITS_TTL;
  if (!force && fresh && limitsCache.at) {
    return Promise.resolve({ ...limitsCache, cached: true });
  }
  if (limitsCache.inFlight) return limitsCache.inFlight;

  // Сначала вход, потом панель, не вместе. Оба процесса продлевают сохранённый
  // вход одним ключом обновления, и при гонке сервер отказывает второму —
  // 01.10.2026 так стёрся вход. Без входа панель пуста, второй процесс не нужен:
  // цифры берём из потока Claude Code.
  limitsCache.inFlight = readAuth()
    .then(async (auth) => {
      const raw = auth && auth.loggedIn === false ? '' : await readLimits();
      limitsCache = { raw, auth, at: Date.now(), inFlight: null };
      return { ...limitsCache, cached: false };
    })
    .catch((e) => {
      limitsCache.inFlight = null;
      log('ERROR', `Чтение лимитов: ${e.message}`);
      return { raw: '', auth: null, at: 0, cached: false };
    });
  return limitsCache.inFlight;
}

/** Полоса прогресса из символов — читается на телефоне лучше процентов. */
function bar(pct, width = 14) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

/** Аккаунт и план — берутся из auth status, там же почта и тип подписки. */
function readAuth() {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_OAUTH_TOKEN; // auth status учитывает только сохранённый вход
    execFile(CLAUDE_BIN, ['auth', 'status', '--json'], { timeout: 25000, env },
      (err, stdout) => { try { resolve(JSON.parse(stdout)); } catch { resolve(null); } });
  });
}

const MONTHS = { jan: 'янв', feb: 'фев', mar: 'мар', apr: 'апр', may: 'мая', jun: 'июн',
                 jul: 'июл', aug: 'авг', sep: 'сен', oct: 'окт', nov: 'ноя', dec: 'дек' };

/** «7:09pm (Europe/Moscow)» → «в 19:09», «Aug 17, 10:59am» → «17 авг в 10:59». */
function ruReset(s) {
  if (!s) return '';
  let t = String(s).replace(/\s*\([^)]*\)\s*/g, '').trim();
  const to24 = (h, m, ap) => {
    let hh = Number(h) % 12;
    if (/pm/i.test(ap)) hh += 12;
    return `${String(hh).padStart(2, '0')}:${m}`;
  };
  t = t.replace(/(\d{1,2}):(\d{2})\s*(am|pm)/i, (_, h, m, ap) => to24(h, m, ap));
  t = t.replace(/(\d{1,2})\s*(am|pm)/i, (_, h, ap) => to24(h, '00', ap)); // «11am» без минут
  t = t.replace(/\b([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?/, (_, mon, d) => {
    const ru = MONTHS[mon.toLowerCase()];
    return ru ? `${Number(d)} ${ru}` : `${mon} ${d}`;
  });
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Разбирает панель /usage. Реальный вид блока:
 *   Current session
 *   █                          2% used
 *   Resets 7:09pm (Europe/Moscow)
 */
function parseUsagePanel(raw) {
  const lines = raw.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const blocks = [];

  const LABELS = [
    { re: /^current session/i,             name: 'Сессия', period: '5 часов' },
    { re: /^current week \(all models\)/i, name: 'Неделя',  period: 'все модели' },
    { re: /^current week \(opus\)/i,       name: 'Неделя',  period: 'Opus' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const hit = LABELS.find((L) => L.re.test(lines[i]));
    if (!hit) continue;
    if (blocks.some((b) => b.name === hit.name && b.period === hit.period)) continue;

    let pct = null, reset = '';
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      if (pct === null) {
        const m = lines[j].match(/(\d+(?:\.\d+)?)\s*%\s*used/i);
        if (m) pct = Math.round(Number(m[1]));
      }
      if (!reset) {
        const m = lines[j].match(/^resets?\s+(.+)$/i);
        if (m) reset = ruReset(m[1]);
      }
      if (pct !== null && reset) break;
    }
    if (pct !== null) blocks.push({ ...hit, pct, reset });
  }
  return { blocks };
}

const PLANS = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team',
                enterprise: 'Claude Enterprise', free: 'Claude Free' };

/** Единый экран: аккаунт, остаток лимитов подписки, собственный учёт бота. */
async function screenUsage(force = false) {
  // свежий кэш — отвечаем сразу, без сообщения-заглушки
  const ready = !force && limitsCache.at && Date.now() - limitsCache.at < LIMITS_TTL;
  const wait = ready ? null : await send('🔄 Считываю лимиты…');

  const { auth, raw, at, cached } = await getLimits(force);
  const panel = parseUsagePanel(raw).blocks;        // точная панель — если на сервере есть вход
  const live = panel.length ? null : rateBlocks();  // иначе цифры из последних ответов Claude
  const blocks = panel.length ? panel : (live ? live.blocks : []);

  const L = ['📊 <b>Использование</b>', ''];

  if (auth?.email) {
    L.push('<b>Аккаунт</b>');
    L.push(`👤 ${esc(auth.email)}`);
    L.push(`💳 ${esc(PLANS[auth.subscriptionType] || auth.subscriptionType || '—')}`);
    L.push('');
  }

  if (blocks.length) {
    L.push('<b>Лимиты подписки</b>');
    const blocked = live && live.blocked && live.blocked.reset > Date.now() / 1000 ? live.blocked : null;
    if (blocked) {
      const w = RATE_WINDOWS.find((x) => x.key === blocked.type);
      L.push(`⛔ <b>Лимит исчерпан</b>${w ? ` — ${esc(w.name.toLowerCase())} (${esc(w.period)})` : ''}, ` +
             `сброс ${esc(fmtResetAt(blocked.reset))}`);
    }
    for (const b of blocks) {
      const warn = b.pct >= 90 ? ' 🔴' : b.pct >= 70 ? ' 🟡' : '';
      L.push('', `${esc(b.name)} <i>(${esc(b.period)})</i>${warn}`);
      if (b.pct === null) { L.push('<i>окно сменилось — новые цифры придут с ближайшим ответом Claude</i>'); continue; }
      L.push(`<code>${bar(b.pct)}</code> <b>${b.pct}%</b>`);
      if (b.reset) L.push(`<i>сброс ${esc(b.reset)}</i>`);
    }
    L.push('');
  } else {
    L.push('📭 <b>Цифр лимитов пока нет</b>',
           'Claude Code присылает их вместе с каждым ответом. Отправьте любое сообщение, ' +
           'а когда он ответит, нажмите «Обновить».', '');
  }

  L.push('📋 <b>Задач через бота</b>', tasksSummary());

  const ago = (sec) => (sec < 60 ? `${sec} с` : sec < 3600 ? `${Math.round(sec / 60)} мин`
    : `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`);
  if (live) {
    const age = Math.max(0, Math.round((Date.now() - live.seenAt) / 1000));
    L.push('', `<i>цифры из последнего ответа Claude, ${ago(age)} назад` +
               `${age > 3 * 3600 ? ' — обновятся со следующим ответом' : ''}</i>`);
  } else if (cached || Date.now() - at > 5000) {
    L.push('', `<i>данные ${ago(Math.round((Date.now() - at) / 1000))} назад</i>`);
  }

  const text = L.join('\n');
  const kb = { reply_markup: { inline_keyboard: [[
    { text: '🔄 Обновить', callback_data: 'act:limits' },
  ]] } };

  if (wait) {
    await edit(wait.message_id, text);
    await tg('editMessageReplyMarkup',
      { chat_id: OWNER_ID, message_id: wait.message_id, ...kb }).catch(() => {});
  } else await send(text, kb);
}

async function screenStatus() {
  const L = ['📊 <b>Состояние</b>', ''];
  L.push(`📁 Проект: <b>${esc(pName())}</b>`);
  if (state.activeProject) {
    L.push(`<code>${esc(state.activeProject)}</code>`);
    const sid = state.sessions[state.activeProject];
    L.push(`🧵 Сессия: ${sid ? `<code>${esc(sid.slice(0, 8))}…</code>` : 'не начата'}`);
  }
  L.push(`🤖 Модель: <b>${esc(modelLabel(state.model))}</b>` +
         `${state.effort ? ` • усилие ${esc(state.effort)}` : ''}` +
         `${cli.version ? ` • Claude Code ${esc(cli.version)}` : ''}`);
  L.push(`⚙️ Режим: <b>${state.mode === 'talk' ? '💬 обсуждение' : '🛠 разработка'}</b>`);
  const alive = engine && engine.key === engineKey();
  const left = alive ? warmEnd(engine) - Date.now() : 0;
  if (alive && engine.waiter) L.push('🔥 Кэш тёплый — Claude сейчас работает');
  else if (left > 0) {
    L.push(`🔥 Кэш тёплый ещё <b>${fmtDur(Math.round(left / 1000))}</b> — ответы быстрые и дешёвые`);
  } else if (alive) L.push('🧊 Кэш остыл — первый ответ дороже');
  else L.push('💤 Процесс спит — первый ответ дольше и дороже');
  L.push(`♨️ Прогрев: <b>${state.warmHours ? `${state.warmHours} ч после сообщения` : 'выключен'}</b>` +
         `${state.coolCompact ? ` • после — сжатие бесед от ${kTok(COOL_COMPACT_MIN)}` : ''}` +
         `${alive && engine.noWarm ? ' • для этой беседы не удержал кэш' : ''}` +
         `${alive && engine.stale ? ' • ждёт паузы, чтобы перейти на новый Claude Code' : ''}`);

  const ctx = lastContext();
  if (ctx) {
    const share = Math.round((ctx / COMPACT_WINDOW) * 100);
    const mark = ctx >= CTX_LIMIT ? '🔴' : ctx >= CTX_LIMIT * 0.6 ? '🟡' : '🟢';
    L.push(`${mark} Контекст: <b>${kTok(ctx)}</b> из ${kTok(COMPACT_WINDOW)} (${share}%)`);
    // Одно сообщение = несколько обращений к модели (чтение файла, команда,
    // снова чтение), и каждое перечитывает весь контекст. Показываем цену.
    const perMsg = ctx * 0.1 * 4;
    L.push(`💸 Примерно <b>${kTok(perMsg)}</b> за сообщение` +
           `${ctx >= CTX_LIMIT ? ' — <b>дорого</b>' : ''}`);
    if (ctx >= CTX_LIMIT) L.push('<i>Новая беседа снизит это в разы и стоит дешевле сжатия</i>');
  }
  L.push(`✂️ Краткие ответы: <b>${state.brief ? 'да' : 'нет'}</b>`);
  if (['high', 'xhigh', 'max'].includes(state.effort)) {
    L.push(`💸 Усилие <b>${esc(state.effort)}</b> — долгие размышления, лимит тает быстрее`);
  }

  if (isBusy()) {
    const secs = Math.round((Date.now() - current.startedAt) / 1000);
    L.push('', `⏳ <b>Выполняется</b> ${fmtDur(secs)}`, `<i>${esc(current.prompt.slice(0, 200))}</i>`);
    if (queue.length) L.push(`📥 В очереди: <b>${queue.length}</b>`);
  } else {
    L.push('', '💤 Свободен');
  }

  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = (k) => Number((mem.match(new RegExp(`${k}:\\s+(\\d+)`)) || [])[1] || 0) / 1024;
    L.push('', `💾 RAM: ${Math.round(g('MemAvailable'))} / ${Math.round(g('MemTotal'))} МБ`);
  } catch {}
  const today = state.usage.byDay[new Date().toISOString().slice(0, 10)];
  if (today) L.push(`📋 Задач сегодня: ${today.tasks}`);

  return send(L.join('\n'));
}

const WARM_CHOICES = [0, 2, 4, 6, 8, 12];

async function screenWarm() {
  const rows = [WARM_CHOICES.slice(0, 3), WARM_CHOICES.slice(3)].map((r) => r.map((h) => ({
    text: `${state.warmHours === h ? '✅ ' : ''}${h ? `${h} ч` : 'выкл'}`,
    callback_data: `w:${h}`,
  })));
  rows.push([{ text: `${state.coolCompact ? '✅' : '❌'} Сжимать перед остыванием`, callback_data: 'wc' }]);
  const ctx = lastContext();
  const w = state.usage.warm || { pings: 0, base: 0 };
  const L = [
    '🔥 <b>Прогрев кэша</b>', '',
    `Сейчас: <b>${state.warmHours ? `${state.warmHours} ч после каждого сообщения` : 'выключен'}</b>`,
    `Сжатие перед остыванием: <b>${state.coolCompact ? 'включено' : 'выключено'}</b>`, '',
    'Кэш беседы живёт час. Пока он тёплый, контекст читается по ×0,1, ' +
    'остывший переписывается целиком по ×2 — в 20 раз дороже. Раньше так ' +
    'оплачивалась каждая пауза дольше часа, и это была половина всего расхода бота.', '',
    'Бот раз в 54 минуты шлёт Claude служебный пинг: тот читает беседу ' +
    'из кэша, и кэш живёт ещё час. Пишете снова — ответ сразу дешёвый.', '',
    `Если пауза дольше окна, а беседа больше ${kTok(COOL_COMPACT_MIN)}, бот сжимает её, ` +
    'пока кэш ещё тёплый: после паузы в кэш пишется краткая выжимка, а не вся беседа. ' +
    'Мелкие подробности прошлых шагов при этом теряются, как при любом сжатии.',
  ];
  if (ctx) {
    L.push('', `На текущей беседе (<b>${kTok(ctx)}</b>): пинг ≈ <b>${kTok(ctx * 0.1)}</b>, ` +
               `холодный старт ≈ <b>${kTok(ctx * 2)}</b> — как 20 пингов.`);
  }
  L.push('', '<i>По вашим паузам за пять недель окна от 4 до 12 часов со сжатием ' +
             'почти равны по выгоде. Без прогрева паузы обходятся почти вдвое дороже.</i>');
  if (w.pings || w.compacts) {
    L.push('', `Пингов: ${w.pings} • сжатий перед остыванием: ${w.compacts || 0} • ` +
               `≈ ${kTok(w.base)} базовых токенов`);
  }
  return send(L.join('\n'), { reply_markup: { inline_keyboard: rows } });
}

const GIT_ACTIONS = {
  status: ['status', '--short', '--branch'],
  diff:   ['diff', '--stat'],
  log:    ['log', '--oneline', '-15'],
  pull:   ['pull', '--ff-only'],
  push:   ['push'],
};

async function screenGit() {
  if (!state.activeProject) return send('❌ Сначала выберите проект — /project');
  return send(`🔀 <b>Git</b> • ${esc(pName())}`, {
    reply_markup: { inline_keyboard: [
      [{ text: '📋 Статус', callback_data: 'g:status' }, { text: '📊 Изменения', callback_data: 'g:diff' }],
      [{ text: '📜 История', callback_data: 'g:log' }],
      [{ text: '⬇️ Pull', callback_data: 'g:pull' }, { text: '⬆️ Push', callback_data: 'g:push' }],
    ] },
  });
}

function runGit(action) {
  return new Promise((resolve) => {
    execFile('git', GIT_ACTIONS[action], { cwd: state.activeProject, timeout: 60000 },
      (err, stdout, stderr) => resolve((stdout || '') + (stderr || '') || (err ? err.message : '(пусто)')));
  });
}

const HELP =
`🤖 <b>Claude Code в Telegram</b>

Пишите задачу текстом — она уйдёт в Claude Code в активном проекте. Контекст сохраняется сам: чтобы продолжить разговор, просто напишите следующее сообщение, ничего нажимать не нужно. Пока Claude занят, новые сообщения встают в очередь и уйдут одной задачей.

<b>Команды</b> — все в меню слева от поля ввода
/project — выбрать проект
/newproject имя — создать новый проект
/status — проект, модель, кэш, память
/model — модель, усилие, режим
/warm — прогрев кэша и сжатие перед паузой
/limits — остаток лимитов подписки
/sessions — переключиться между беседами
/compact — сжать беседу, если разрослась
/git — статус, изменения, история, pull/push
/new — начать беседу заново
/stop — прервать задачу и очистить очередь

<b>Два режима</b> (переключаются в /model)
🛠 Разработка — Claude читает и правит файлы, запускает команды и тесты, работает с git.
💬 Обсуждение — без доступа к файлам: быстрые ответы, расчёты, разбор идей.

<b>Фото и файлы</b>
Пришлите картинку — Claude её посмотрит. Подпись к фото становится задачей: «что тут не так?» вместе со скриншотом работает как надо. Несколько фото — альбомом или подряд — уходят одной задачей; текст, дописанный следом в течение нескольких секунд, тоже. Файлы — логи, PDF, что угодно до 20 МБ.

<b>Голос и видео</b>
Голосовые и аудио распознаю в текст (whisper на сервере, без интернета и ключей) — расшифровка показывается, чтобы было видно, что услышано. Кружки и видео — тоже речь плюс кадры: Claude видит, что вы показываете.

Длинные ответы приходят файлом. Долгие задачи идут в фоне — уведомление придёт само.`;

// ─────────────────────────── Роутер ───────────────────────────

function handleText(text) {
  if (!state.activeProject) return screenProjects();
  // Фото или голосовое ещё собираются — текст к ним и относится
  if (batch) return acceptText(text);
  return submit({ text });
}

async function cmdProject(arg) {
  if (!arg) return screenProjects();
  const p = path.resolve(arg);
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return send(`❌ Каталог не найден:\n<code>${esc(p)}</code>`);
  state.projects[path.basename(p)] = p;
  state.activeProject = p;
  saveState();
  log('INFO', 'Проект выбран', { path: p });
  return send(`✅ Проект: <b>${esc(path.basename(p))}</b>\n<code>${esc(p)}</code>`);
}

/**
 * Создаёт пустой проект прямо из чата: каталог в PROJECTS_ROOT + git init,
 * и сразу делает его активным. Имя чистим до безопасного — без слэшей и
 * прочего, чтобы нельзя было создать каталог вне корня проектов.
 */
async function cmdNewProject(arg) {
  const name = String(arg || '').trim().replace(/[^\w.\-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  if (!name) {
    return send(
      `➕ <b>Новый проект</b>\n\nУкажите имя:\n<code>/newproject имя-проекта</code>\n\n` +
      `Создам каталог в <code>${esc(PROJECTS_ROOT)}</code>, инициализирую git ` +
      `и сделаю проект активным.`
    );
  }
  const p = path.join(PROJECTS_ROOT, name);
  if (fs.existsSync(p)) {
    // Уже есть — не перезатираем, просто переключаемся на него
    state.activeProject = p; saveState();
    return send(`📁 Проект <b>${esc(name)}</b> уже существует — сделал активным.\n<code>${esc(p)}</code>`);
  }
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    log('ERROR', `Создание проекта: ${e.message}`);
    return send(`❌ Не удалось создать каталог:\n<code>${esc(e.message)}</code>`);
  }

  // git init — необязательный: если git недоступен, проект всё равно рабочий
  const gitInit = await new Promise((resolve) => {
    execFile('git', ['init', '-q'], { cwd: p, timeout: 20000 }, (err) => resolve(!err));
  });

  state.activeProject = p; saveState();
  log('INFO', 'Проект создан', { path: p, git: gitInit });
  return send(
    `✅ <b>Проект создан</b>: <b>${esc(name)}</b>\n<code>${esc(p)}</code>\n` +
    `${gitInit ? '🔀 git инициализирован' : '⚠️ git init не выполнился — каталог создан без репозитория'}\n\n` +
    `<i>Проект уже активен — пишите задачу, и я начну в нём работать.</i>`
  );
}

// ─────────────────────────── Сессии ───────────────────────────

/** Каталог, где Claude Code хранит историю проекта. */
function sessionDir(projectPath) {
  const slug = projectPath.replace(/[/.]/g, '-');
  return path.join(process.env.HOME || '/home/claudebot', '.claude', 'projects', slug);
}

/** Первое осмысленное сообщение пользователя — как заголовок беседы. */
function firstUserMessage(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(512 * 1024, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'user' || !o.message) continue;
      let t = o.message.content;
      if (Array.isArray(t)) t = t.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      if (typeof t !== 'string') continue;
      t = t.replace(/\s+/g, ' ').trim();
      if (t.length < 20 || t.startsWith('<') || /tool_result|continued from a previous/i.test(t)) continue;
      return t.slice(0, 60);
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return '';
}

function listSessions(projectPath) {
  const dir = sessionDir(projectPath);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch { return []; }
  return files.map((f) => {
    const full = path.join(dir, f);
    const st = fs.statSync(full);
    return {
      id: f.replace(/\.jsonl$/, ''),
      mtime: st.mtimeMs,
      size: st.size,
      title: firstUserMessage(full),
    };
  }).sort((a, b) => b.mtime - a.mtime);
}

const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.round(b / 1024)} КБ`);
const fmtDate = (ms) => new Date(ms).toLocaleString('ru-RU',
  { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function screenSessions() {
  if (!state.activeProject) return send('❌ Сначала выберите проект — /project');

  const cur = state.sessions[state.activeProject];
  const all = listSessions(state.activeProject);

  // Длинную историю Claude Code перечитывает при каждом сообщении: беседа
  // на 6 МБ добавляет к ответу около четырёх секунд, на 20 МБ — около семи.
  const HEAVY = 4 * 1024 * 1024;

  const rows = all.slice(0, 8).map((s) => [{
    text: `${s.id === cur ? '✅ ' : s.size >= HEAVY ? '🐢 ' : '🧵 '}` +
          `${fmtDate(s.mtime)} · ${s.title || s.id.slice(0, 8)}`.slice(0, 58),
    callback_data: `s:${s.id}`,
  }]);
  rows.push([{ text: '🆕 Начать новую беседу', callback_data: 'act:newask' }]);
  if (cur) rows.push([{ text: '🗜 Сжать текущую беседу', callback_data: 'act:compact' }]);

  const L = [`🧵 <b>Сессии</b> · ${esc(pName())}`, ''];
  if (cur) {
    const c = all.find((s) => s.id === cur);
    L.push(`Сейчас активна: <b>${esc(c?.title || cur.slice(0, 8))}</b>`);
    if (c) L.push(`<i>${fmtDate(c.mtime)} · ${fmtSize(c.size)}</i>`);
    if (c && c.size >= HEAVY) {
      L.push('', `🐢 <b>Беседа тяжёлая</b> — Claude перечитывает её целиком ` +
                 `перед каждым ответом, это добавляет несколько секунд. ` +
                 `Для новой темы быстрее начать свежую.`);
    }
  } else {
    L.push('Активной беседы нет — следующее сообщение начнёт новую.');
  }
  L.push('', '<i>Чтобы продолжить разговор, просто напишите сообщение — ' +
            'ничего нажимать не нужно. Кнопки ниже переключают между беседами.</i>');

  return send(L.join('\n'), { reply_markup: { inline_keyboard: rows } });
}

async function askNewSession() {
  if (!state.activeProject) return send('❌ Сначала выберите проект');
  return send(
    `🆕 <b>Начать новую беседу?</b>\n\n` +
    `Текущий разговор никуда не денется — его можно будет вернуть ` +
    `через 🧵 Сессии. Просто следующее сообщение начнётся с чистого листа.`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Да, начать новую', callback_data: 'act:newyes' },
      { text: '↩️ Отмена', callback_data: 'act:cancelnew' },
    ]] } }
  );
}

async function cmdNew() {
  delete state.sessions[state.activeProject];
  killEngine('новая беседа'); // у живого процесса в памяти прежний контекст
  saveState();
  log('INFO', 'Начата новая сессия', { project: state.activeProject });
  return send(
    `🆕 Новая беседа для <b>${esc(pName())}</b>.\n\n` +
    `<i>Прошлая сохранена — вернуть можно через 🧵 Сессии.</i>`
  );
}

/**
 * Сжимает беседу: Claude заменяет всю историю кратким пересказом.
 * После этого каждое сообщение стоит десятки тысяч токенов вместо двухсот.
 */
// Окно авто-сжатия самого Claude Code выставлено в 200 тысяч переменной
// CLAUDE_CODE_AUTO_COMPACT_WINDOW (по умолчанию у Opus около миллиона, из-за
// чего беседы не сжимались вообще ни разу). Свой порог держим ниже окна, чтобы
// сжатие произошло у нас — сразу после ответа, на прогретом кэше, — а не
// догнало пользователя первым сообщением после паузы, когда кэш уже остыл.
const CTX_LIMIT = 60000;
// Окно авто-сжатия самого CLI: беседа сжимается, не доходя до него тысяч 30
const COMPACT_WINDOW = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) || 1e6;

// Кэш промпта живёт час. Сжатие на прогретом кэше читает контекст по ×0,1,
// на остывшем переписывает целиком по ×2 — дороже в двадцать раз.
const WARM_MS = 50 * 60 * 1000;

/** Контекст последнего ответа — сколько токенов реально ушло в запрос. */
function lastContext() {
  if (typeof state.lastCtx === 'number') return state.lastCtx;
  return ctxOf(state.lastUsage);   // состояние от прошлой версии бота
}

/** После сжатия прежний объём ни о чём не говорит — узнаем новый на следующем ответе. */
function forgetContext() {
  state.lastCtx = 0;
  if (engine) engine.lastCall = null;
  saveState();
}

/** После задачи: если контекст разросся — сжимаем сами и сообщаем об этом. */
async function autoCompact() {
  if (!state.autoCompact) return;
  const ctx = lastContext();
  if (ctx < CTX_LIMIT || isBusy()) return;

  // Только на тёплой сессии. Если процесс умер или кэш успел остыть, сжатие
  // обойдётся как полная перезапись беседы — тогда дешевле новая беседа.
  const warm = engine && engine.key === engineKey()
               && Date.now() - (engine.lastTurnAt || 0) < WARM_MS;
  if (!warm) {
    log('INFO', 'Сжатие отложено: кэш остыл', { контекст: ctx });
    await send(
      `🧊 <b>Беседа выросла, но кэш остыл</b>

Контекст <b>${kTok(ctx)}</b>. Сжимать сейчас — это переписать её целиком, дороже самой беседы. Дешевле начать новую: /new

<i>Если продолжите здесь — сожму сам сразу после следующего ответа, пока кэш горячий.</i>`
    );
    return;
  }

  log('INFO', 'Автосжатие: контекст вырос', { контекст: ctx });
  const note = await send(
    `🗜 <b>Сжимаю беседу</b>\n\n` +
    `Контекст дорос до <b>${kTok(ctx)}</b> токенов — на таком объёме каждое ` +
    `следующее сообщение стоит дорого. Сжимаю, чтобы дальше было дешевле.`
  );

  const started = Date.now();
  const res = await ask('/compact', null);
  const secs = Math.round((Date.now() - started) / 1000);

  if (res.__dead) {
    if (note) await edit(note.message_id, '⚠️ Сжать не удалось — процесс завершился. Попробую позже.');
    return;
  }
  forgetContext();
  if (note) await edit(note.message_id,
    `✅ <b>Беседа сжата</b> за ${fmtDur(secs)}\n\n` +
    `Было <b>${kTok(ctx)}</b> токенов контекста. Суть разговора сохранена.\n\n` +
    `<i>Отключить автосжатие: /autocompact</i>`);
}

async function cmdAutoCompact() {
  state.autoCompact = !state.autoCompact;
  saveState();
  return send(state.autoCompact
    ? `⚠️ <b>Автосжатие включено</b>\n\nБот сожмёт беседу сам, когда контекст ` +
      `перевалит за ${kTok(CTX_LIMIT)}.\n\n<i>Учтите: сжатие перечитывает весь ` +
      `диалог и стоит примерно как он сам. На большой беседе это разовый удар ` +
      `по лимиту. Обычно дешевле начать новую беседу — /new.</i>`
    : `✅ <b>Автосжатие выключено</b>\n\nБот не будет тратить лимит без спроса. ` +
      `Сжать вручную — /compact.`);
}

async function cmdBrief() {
  state.brief = !state.brief;
  saveState();
  return send(state.brief
    ? `✅ <b>Краткие ответы включены</b>\n\nВыхлоп стоит впятеро дороже ввода и ` +
      `даёт больше половины цены сообщения — это самая крупная экономия из доступных.`
    : `📝 <b>Краткие ответы выключены</b>\n\nОтветы станут подробнее и дороже: ` +
      `на замере выхлоп давал 20 780 из 37 251 за сообщение.`);
}

async function cmdCompact() {
  if (!state.activeProject) return send('❌ Сначала выберите проект');
  if (!state.sessions[state.activeProject]) return send('💤 Сжимать нечего — беседа ещё не начата');
  if (isBusy()) return send('⏳ Идёт задача, дождитесь её завершения');

  const wait = await send('🗜 Сжимаю беседу — Claude пересказывает историю коротко…');
  const started = Date.now();
  const res = await ask('/compact', null);
  const secs = Math.round((Date.now() - started) / 1000);

  if (res.__dead) {
    if (wait) await edit(wait.message_id, `❌ Не удалось сжать: процесс завершился`);
    return;
  }
  forgetContext();
  const after = listSessions(state.activeProject).find((s) => s.id === state.sessions[state.activeProject]);
  if (wait) await edit(wait.message_id,
    `✅ <b>Беседа сжата</b> за ${fmtDur(secs)}\n\n` +
    (after ? `Размер истории: ${fmtSize(after.size)}\n\n` : '') +
    `<i>Суть разговора сохранена, лишние подробности убраны. ` +
    `Дальше ответы будут быстрее и дешевле по лимиту.</i>`);
}

async function cmdCancel() {
  const queued = queue.splice(0).length;
  const media = dropBatch();
  const dropped = [queued ? `очередь (${queued})` : '', media ? 'недособранные вложения' : '']
    .filter(Boolean).join(' и ');
  if (!isBusy()) {
    return send(dropped ? `🗑 Отменил ${dropped}.` : '💤 Сейчас ничего не выполняется');
  }
  stopChild('по команде');
  return send(`⛔️ Останавливаю…${dropped ? `\nЗаодно отменил ${dropped}.` : ''}`);
}

async function route(text) {
  const [raw, ...rest] = text.split(/\s+/);
  const cmd = raw.toLowerCase().split('@')[0];
  const arg = rest.join(' ');

  switch (cmd) {
    case '/start':
      // заодно убираем нижнюю клавиатуру, если она осталась от прошлых версий
      return send(`👋 <b>Готов к работе</b>\n\n${HELP}`, { reply_markup: noKeyboard });
    case '/help': return send(HELP);
    case '/project': return cmdProject(arg);
    case '/newproject': return cmdNewProject(arg);
    case '/status': return screenStatus();
    case '/model': return screenModel();
    case '/warm': return screenWarm();
    case '/usage': return screenUsage();
    case '/limits': return screenUsage();
    case '/git': return screenGit();
    case '/sessions': return screenSessions();
    case '/compact': return cmdCompact();
    case '/autocompact': return cmdAutoCompact();
    case '/brief': return cmdBrief();
    case '/new': return askNewSession();
    case '/stop':
    case '/cancel': return cmdCancel();
    default:
      if (cmd.startsWith('/')) return send(`❓ Неизвестная команда ${esc(cmd)}`);
      return handleText(text);
  }
}

async function handleCallback(cq) {
  await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  const data = cq.data || '';
  log('INFO', 'Нажата кнопка', { data });

  if (data.startsWith('p:')) {
    const name = data.slice(2);
    const projects = discoverProjects();
    if (!projects[name]) return send(`❌ Проект «${esc(name)}» не найден`);
    if (state.activeProject !== projects[name]) killEngine('смена проекта');
    state.activeProject = projects[name];
    saveState();
    log('INFO', 'Проект выбран', { path: state.activeProject });
    return send(`✅ Проект: <b>${esc(name)}</b>\n<code>${esc(state.activeProject)}</code>`);
  }
  if (data.startsWith('m:')) {
    const was = state.model;
    state.model = data.slice(2); saveState();
    if (was !== state.model) killEngine('сменилась модель');
    const ctx = lastContext();
    return send(
      `🤖 Модель: <b>${esc(modelLabel(state.model))}</b>` +
      (was !== state.model
        ? `\n\n<i>Кэш у каждой модели свой, поэтому первое сообщение перепишет ` +
          `беседу в кэш заново${ctx ? ` (≈ ${kTok(ctx * 2)})` : ''} — дальше как обычно.</i>`
        : '')
    );
  }
  if (data.startsWith('w:')) {
    const h = Number(data.slice(2));
    if (!WARM_CHOICES.includes(h)) return;
    state.warmHours = h; saveState();
    rescheduleWarm();
    return send(h
      ? `🔥 Держу кэш тёплым <b>${h} ч</b> после каждого сообщения.`
      : `🧊 Прогрев выключен: после часа тишины кэш остывает, и первый ответ после паузы дороже.`);
  }
  if (data === 'wc') {
    state.coolCompact = !state.coolCompact; saveState();
    rescheduleWarm();
    return send(state.coolCompact
      ? `🗜 Сжатие перед остыванием включено: если пауза дольше окна прогрева, ` +
        `беседу больше ${kTok(COOL_COMPACT_MIN)} сожму, пока кэш тёплый.`
      : `Сжатие перед остыванием выключено: после долгой паузы беседа целиком ` +
        `перепишется в кэш, зато сохранится дословно.`);
  }
  if (data.startsWith('e:')) {
    const v = data.slice(2);
    state.effort = state.effort === v ? '' : v; saveState();
    const pricey = ['high', 'xhigh', 'max'].includes(state.effort);
    return send(`⚙️ Усилие: <b>${esc(state.effort || 'обычное')}</b>` +
      (pricey ? `\n\n💸 <i>Это режим долгих размышлений. Они идут в выхлоп, ` +
                `который стоит впятеро дороже ввода — лимит будет таять заметно быстрее. ` +
                `Для обычных задач хватает обычного усилия.</i>` : ''));
  }
  if (data.startsWith('mode:')) {
    state.mode = data.slice(5); saveState();
    return send(state.mode === 'talk'
      ? '💬 Режим обсуждения: без доступа к файлам, быстрые ответы и расчёты.'
      : '🛠 Режим разработки: полный доступ к файлам, командам и git.');
  }
  if (data.startsWith('g:')) {
    if (!state.activeProject) return send('❌ Проект не выбран');
    const action = data.slice(2);
    const out = await runGit(action);
    return send(`🔀 <b>git ${esc(action)}</b> • ${esc(pName())}\n\n<pre>${esc(out.slice(0, 3000))}</pre>`);
  }
  if (data.startsWith('s:')) {
    const id = data.slice(2);
    state.sessions[state.activeProject] = id;
    killEngine('переключение беседы'); // иначе процесс продолжит прежнюю
    saveState();
    const info = listSessions(state.activeProject).find((x) => x.id === id);
    log('INFO', 'Сессия переключена', { project: state.activeProject, id });
    return send(
      `✅ Продолжаю беседу\n\n<b>${esc(info?.title || id.slice(0, 8))}</b>\n` +
      `<i>${info ? `${fmtDate(info.mtime)} · ${fmtSize(info.size)}` : ''}</i>\n\n` +
      `Пишите — контекст на месте.`
    );
  }
  if (data === 'act:limits') return screenUsage(true); // кнопка — всегда свежие данные
  if (data === 'act:compact') return cmdCompact();
  if (data === 'act:newask') return askNewSession();
  if (data === 'act:newyes') return cmdNew();
  if (data === 'act:cancelnew') return send('↩️ Отменено — беседа продолжается.');
  if (data === 'act:new') return askNewSession();
  if (data === 'act:status') return screenStatus();
  if (data === 'act:newprojhelp') {
    return send(
      `➕ <b>Новый проект</b>\n\nОтправьте команду с именем:\n\n` +
      `<code>/newproject имя-проекта</code>\n\n` +
      `Создам каталог в <code>${esc(PROJECTS_ROOT)}</code>, сделаю git init ` +
      `и сразу активирую — можно писать задачу.`
    );
  }
  if (data === 'act:clonehelp') {
    return send(
      `➕ <b>Новый проект из git</b>\n\nВыполните на сервере:\n\n` +
      `<code>git clone АДРЕС ${esc(PROJECTS_ROOT)}/имя\n` +
      `chown -R claudebot:claudebot ${esc(PROJECTS_ROOT)}/имя</code>\n\n` +
      `После этого он появится в списке 📁 Проекты.`
    );
  }
}

// ─────────────────────────── Вложения ───────────────────────────

const UPLOAD_DIR = path.join(path.dirname(STATE_FILE), 'uploads');
const UPLOAD_KEEP_DAYS = 7;
const MAX_UPLOAD = 20 * 1024 * 1024;  // Telegram отдаёт ботам файлы до 20 МБ
// Крупнее 1568 по стороне модель картинку всё равно ужмёт, а токенов уйдёт
// больше. Кадрам хватает меньшего: у кружка и сам исходник около 400 точек.
const IMAGE_SIDE = 1568;
const NOTE_FRAMES = 6, NOTE_SIDE = 512;
const VIDEO_FRAMES = 8, VIDEO_SIDE = 768;
const AUDIO_MAX_S = 20 * 60;   // дальше не распознаём: ждать пришлось бы дольше самой задачи
// Части одного сообщения — альбом, фото и следом текст — ждём столько после
// последней. Без слов ждём дольше: подпись часто дописывают отдельным сообщением.
const BATCH_WAIT_MS = 2500;
const WORDLESS_WAIT_MS = 6000;

const IMAGE_EXT = /^\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;
const AUDIO_EXT = /^\.(ogg|oga|opus|mp3|m4a|aac|wav|flac|amr|wma)$/i;
const VIDEO_EXT = /^\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i;

const guessExt = (mime) => ({
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
}[mime] || '');

const KIND_NAME = { voice: 'голосовое', audio: 'аудио', note: 'кружок', video: 'видео',
                    image: 'картинку', file: 'файл' };

/**
 * Что пришло: голосовое, аудио, кружок, видео, картинка или просто файл.
 * keep — оставить исходник в uploads и назвать Claude путь к нему: вдруг
 * понадобится сам файл. Голосовые и кружки после разбора не нужны.
 */
function mediaOf(msg) {
  const of = (o, kind, ext, keep = true) => ({
    kind, keep, id: o.file_id, size: o.file_size || 0, dur: Number(o.duration) || 0,
    name: o.file_name || '', ext: path.extname(o.file_name || '') || guessExt(o.mime_type) || ext,
  });
  if (msg.voice) return of(msg.voice, 'voice', '.ogg', false);
  if (msg.video_note) return of(msg.video_note, 'note', '.mp4', false);
  if (msg.audio) return of(msg.audio, 'audio', '.mp3');
  if (msg.video) return of(msg.video, 'video', '.mp4');
  if (msg.animation) return { ...of(msg.animation, 'video', '.mp4', false), mute: true };
  // Telegram присылает лесенку размеров фото — берём самый крупный
  if (msg.photo?.length) return of(msg.photo[msg.photo.length - 1], 'image', '.jpg');
  if (msg.document) {
    const m = of(msg.document, 'file', '');
    const mime = msg.document.mime_type || '';
    if (/^image\//.test(mime) || IMAGE_EXT.test(m.ext)) m.kind = 'image';
    else if (/^audio\//.test(mime) || AUDIO_EXT.test(m.ext)) m.kind = 'audio';
    else if (/^video\//.test(mime) || VIDEO_EXT.test(m.ext)) m.kind = 'video';
    return m;
  }
  return null;
}

/** Скачивает файл Telegram на диск и возвращает путь. */
async function downloadTgFile(fileId, destPath) {
  const info = await tg('getFile', { file_id: fileId });
  if (!info?.file_path) throw new Error('Telegram не отдал путь к файлу');

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath, { mode: 0o640 });
    const fail = (e) => { out.destroy(); fs.rm(destPath, { force: true }, () => {}); reject(e); };
    out.on('error', fail);
    const req = https.get(`https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`,
      { timeout: 120000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`загрузка вернула ${res.statusCode}`));
        }
        res.on('error', fail);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
      });
    req.on('timeout', () => req.destroy(new Error('таймаут загрузки')));
    req.on('error', fail);
  });
  return destPath;
}

/** Убирает вложения старше недели, чтобы диск не заполнялся молча. */
function sweepUploads() {
  const edge = Date.now() - UPLOAD_KEEP_DAYS * 86400e3;
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, f);
      try { if (fs.statSync(p).mtimeMs < edge) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

const rm = (...files) => { for (const f of files) if (f) fs.rm(f, { force: true }, () => {}); };

/** Запуск внешней программы; в ошибке — хвост её stderr. Таймаут Node принимает только целым. */
function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: Math.ceil(timeout), maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout || ''));
      const tail = String(stderr || '').trim().split('\n').slice(-2).join(' ');
      reject(new Error(`${path.basename(bin)}: ${tail || err.message}`.slice(0, 300)));
    });
  });
}

const ffmpeg = (args, timeout = 120000) =>
  run(FFMPEG_BIN, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], timeout);

/** Вписать в квадрат side×side, мелкое не растягивая. */
const fit = (side) => `scale='min(${side},iw)':'min(${side},ih)'` +
  ':force_original_aspect_ratio=decrease:force_divisible_by=2';

const jpegBlock = (buf) =>
  ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });

const RAW_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                   '.gif': 'image/gif', '.webp': 'image/webp' };

/** Картинка для модели: JPEG не крупнее IMAGE_SIDE, прямо в сообщении. */
async function imageBlock(src) {
  const out = `${src}.send.jpg`;
  try {
    await ffmpeg(['-i', src, '-vf', fit(IMAGE_SIDE), '-frames:v', '1', '-q:v', '3', out], 60000);
    return jpegBlock(fs.readFileSync(out));
  } catch (e) {
    // ffmpeg не осилил формат — отдаём как есть, если модель такой примет
    const mime = RAW_MIME[path.extname(src).toLowerCase()];
    if (mime && fs.statSync(src).size <= 3.5 * 1024 * 1024) {
      return { type: 'image', source: { type: 'base64', media_type: mime,
                                         data: fs.readFileSync(src).toString('base64') } };
    }
    throw new Error(`картинка не читается: ${e.message}`);
  } finally { rm(out); }
}

/** Длительность ролика из заголовка — для видео, присланного файлом. */
function probeDuration(src) {
  return new Promise((resolve) => {
    execFile(FFMPEG_BIN, ['-hide_banner', '-nostdin', '-i', src], { timeout: 30000 }, (err, so, se) => {
      const m = String(se || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
    });
  });
}

/** Кадр из середины каждого из n равных отрезков ролика — по одному на ~4 секунды. */
async function videoFrames(src, secs, max, side) {
  const n = secs > 0 ? Math.max(1, Math.min(max, Math.round(secs / 4))) : 1;
  const files = Array.from({ length: n }, (_, i) => `${src}.f${String(i + 1).padStart(2, '0')}.jpg`);
  // Шаг чуть короче n-й доли ролика: при точном шаге фильтр fps терял
  // последний кадр на округлении у конца (из кружка в 23 с выходило 5 кадров из 6).
  const span = Math.max(secs * 0.9, secs - 1);
  try {
    const pick = secs > 0
      ? ['-ss', (secs / (2 * n)).toFixed(2), '-i', src, '-vf', `fps=${n}/${span.toFixed(2)},${fit(side)}`]
      : ['-i', src, '-vf', fit(side)];
    await ffmpeg([...pick, '-frames:v', String(n), '-q:v', '4', `${src}.f%02d.jpg`], 120000);
    return files.filter((f) => fs.existsSync(f)).map((f) => jpegBlock(fs.readFileSync(f)));
  } finally { rm(...files); }
}

const sttReady = () => fs.existsSync(WHISPER_BIN) && fs.existsSync(FFMPEG_BIN) && fs.existsSync(WHISPER_MODEL);

// Тишину и шум whisper «слышит» как титры роликов, на которых учился
const NOT_SPEECH = /^(продолжение следует|субтитры (сделал|создавал|подготовил|делал)|редактор субтитров|корректор|спасибо за (просмотр|внимание)|подписывайтесь|до (новых )?встреч)/i;

function cleanTranscript(raw) {
  const t = String(raw || '')
    .replace(/\[[^\]]*\]|\(\s*[^)]{0,30}\)|\*[^*]{0,30}\*/g, ' ')   // [музыка], (смех), *шум*
    .replace(/\s+/g, ' ').replace(/ ([.,!?…])/g, '$1').trim();
  return t.split(/(?<=[.!?…])\s+/).filter((s) => s && !NOT_SPEECH.test(s)).join(' ').trim();
}

/** Речь → текст через whisper.cpp. Длительность — по размеру WAV: 16 кГц × 16 бит = 32 000 байт/с. */
async function transcribe(src) {
  const wav = `${src}.wav`;
  try {
    await ffmpeg(['-i', src, '-vn', '-t', String(AUDIO_MAX_S), '-ar', '16000', '-ac', '1',
                  '-c:a', 'pcm_s16le', wav], 180000);
    const secs = Math.max(0, (fs.statSync(wav).size - 44) / 32000);
    if (secs < 0.5) return { text: '', secs };
    const model = secs > LONG_AUDIO_S && fs.existsSync(WHISPER_FAST_MODEL) ? WHISPER_FAST_MODEL : WHISPER_MODEL;
    // -bs 1 -bo 1 — жадный поиск вместо лучевого: на одном ядре заметно быстрее;
    // -sns — не выдумывать [музыку] и прочие неречевые пометки.
    const args = ['-m', model, '-f', wav, '-l', WHISPER_LANG, '-bs', '1', '-bo', '1',
                  '-sns', '-nt', '-np', '-t', '1'];
    // Окно whisper рассчитано на 30 секунд — короткой записи хватает части:
    // 50 позиций на секунду с запасом, кратно 64. Короткие голосовые так заметно быстрее.
    if (secs < 28) args.push('-ac', String(Math.ceil(((secs + 2) * 50) / 64) * 64));
    const out = await run(WHISPER_BIN, args, Math.min(30 * 60000, 120000 + secs * 3000));
    return { text: cleanTranscript(out), secs, cut: secs >= AUDIO_MAX_S - 1 };
  } finally { rm(wav); }
}

const clock = (s) => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const STATUS = { voice: '🎙 Распознаю…', audio: '🎧 Распознаю…', note: '🎥 Смотрю кружок…', video: '🎬 Смотрю видео…' };
const TITLE = { voice: '🎙 Голосовое', audio: '🎧 Аудио', note: '🎥 Кружок', video: '🎬 Видео' };

/**
 * Скачать и разобрать одно вложение. Возвращает часть будущей задачи:
 * слова (подпись, расшифровка), картинки для модели, пометку для Claude.
 */
async function preparePart(msg, m) {
  const status = STATUS[m.kind] ? await send(STATUS[m.kind]) : null;
  const say = (html) => (status ? edit(status.message_id, html) : send(html));
  try {
    return await buildPart(msg, m, say);
  } catch (e) {
    log('ERROR', `Вложение (${m.kind}): ${e.message}`);
    await say(`❌ Не удалось разобрать ${KIND_NAME[m.kind]}: ${esc(e.message.slice(0, 300))}`);
    return null;
  }
}

async function buildPart(msg, m, say) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o750 });
  sweepUploads();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const safe = (m.name || `${m.kind}${m.ext}`).replace(/[^\w.\-]+/g, '_').slice(-80);
  // Случайная вставка: части альбома приходят в одну секунду и с одинаковыми именами
  const src = path.join(UPLOAD_DIR, `${stamp}-${crypto.randomBytes(3).toString('hex')}-${safe}`);
  const part = { kind: m.kind, words: (msg.caption || '').trim(), blocks: [], saved: [], note: '' };
  await downloadTgFile(m.id, src);

  try {
    if (m.kind === 'image') {
      part.blocks.push(await imageBlock(src));
      part.saved.push(src);
      return part;
    }
    if (m.kind === 'file') {
      part.saved.push(src);
      return part;
    }

    const av = m.kind === 'voice' || m.kind === 'audio';
    // У видео длительность берём из файла: Telegram округляет её до секунды
    let secs = av ? m.dur : (await probeDuration(src)) || m.dur;
    const frames = av ? [] : await videoFrames(src, secs,
      m.kind === 'note' ? NOTE_FRAMES : VIDEO_FRAMES, m.kind === 'note' ? NOTE_SIDE : VIDEO_SIDE);

    let speech = { text: '' };
    if (av && !sttReady()) throw new Error('распознавание речи не настроено на сервере (нет whisper или ffmpeg)');
    if (!m.mute && sttReady()) {
      speech = await transcribe(src).catch((e) => {
        if (av) throw e;
        log('WARN', `Речь из видео: ${e.message}`);   // например, ролик без звука
        return { text: '' };
      });
    }
    if (!secs && speech.secs) secs = speech.secs;
    const heard = speech.text;
    const shown = heard.length > 3000 ? `${heard.slice(0, 3000)}…` : heard;

    if (av && !heard && !part.words) {
      await say(`🤔 В ${m.kind === 'voice' ? 'голосовом' : 'записи'} не разобрал слов — попробуйте ещё раз.`);
      return null;
    }
    part.words = [part.words, heard].filter(Boolean).join('\n\n');

    const bits = [`${TITLE[m.kind]} ${clock(secs)}`];
    if (heard) {
      bits.push(`речь расшифрована whisper — в словах возможны ошибки` +
                (speech.cut ? `, распознаны первые ${AUDIO_MAX_S / 60} мин` : ''));
    } else if (!av) bits.push(m.mute ? 'без звука' : 'речи нет');
    if (frames.length) {
      bits.push(`${frames.length} ${plural(frames.length, 'кадр', 'кадра', 'кадров')} по порядку ниже`);
      part.blocks.push({ type: 'text', text: `${TITLE[m.kind]} ${clock(secs)} — кадры:` }, ...frames);
    }
    if (m.keep && state.mode !== 'talk') { bits.push(`файл: ${src}`); part.saved.push(src); }
    part.note = bits.join('; ');

    await say(av
      ? `${m.kind === 'voice' ? '🎙' : '🎧'} <i>${esc(shown)}</i>`
      : `${TITLE[m.kind]} ${clock(secs)} · ${frames.length} ${plural(frames.length, 'кадр', 'кадра', 'кадров')}` +
        (heard ? `\n🎙 <i>${esc(shown)}</i>` : ' · без речи'));
    return part;
  } finally {
    if (!m.keep) rm(src);
  }
}

// Части, которые соберутся в одну задачу: альбом, фото с текстом следом,
// несколько голосовых подряд. Каждый ход перечитывает весь контекст, поэтому
// одна задача из трёх частей втрое дешевле трёх отдельных.
let batch = null;
// Распознавание и кадры — по одному: ядро у сервера одно, а память общая с Claude
let mediaChain = Promise.resolve();
let noProjectAt = 0;

function openBatch() {
  if (!batch) batch = { slots: [], pending: 0, timer: null };
  clearTimeout(batch.timer);
  return batch;
}

/** Закрыть сбор, когда всё разобрано и новые части перестали приходить. */
function armBatch(b) {
  if (batch !== b || b.pending) return;
  clearTimeout(b.timer);
  const words = b.slots.some((s) => s.part?.words);
  b.timer = setTimeout(() => {
    if (batch !== b || b.pending) return;
    batch = null;
    const parts = b.slots.map((s) => s.part).filter(Boolean);
    if (parts.length) submitParts(parts);
  }, words ? BATCH_WAIT_MS : WORDLESS_WAIT_MS);
}

function dropBatch() {
  if (!batch) return false;
  clearTimeout(batch.timer);
  batch = null;
  return true;
}

function acceptText(text) {
  const b = openBatch();
  b.slots.push({ part: { kind: 'text', words: text, blocks: [], saved: [], note: '' } });
  armBatch(b);
}

/** Вложение из Telegram. Не ждём разбора: опрос Telegram должен идти дальше. */
function acceptMedia(msg, m) {
  if (!state.activeProject) {
    // альбом из десяти фото не должен дать десять одинаковых ответов
    if (Date.now() - noProjectAt > 30000) {
      noProjectAt = Date.now();
      send('❌ Сначала выберите проект — /project').catch(() => {});
    }
    return;
  }
  if (m.size > MAX_UPLOAD) {
    send(`❌ Файл слишком большой: ${fmtSize(m.size)}.\nTelegram отдаёт ботам не больше 20 МБ.`).catch(() => {});
    return;
  }
  const b = openBatch();
  const slot = { part: null };
  b.slots.push(slot);   // место в порядке прихода, даже если разбор закончится позже
  b.pending++;
  log('INFO', 'Вложение', { вид: m.kind, размер: m.size, альбом: msg.media_group_id || '' });
  mediaChain = mediaChain
    .then(() => (batch === b ? preparePart(msg, m) : null))   // сбор отменили — ядро не тратим
    .then((part) => { slot.part = part; })
    .catch((e) => log('ERROR', `Вложение: ${e.stack || e.message}`))
    .finally(() => { b.pending--; armBatch(b); });
}

function submitParts(parts) {
  if (state.mode === 'talk' && parts.some((p) => p.kind === 'file')) {
    send('💬 В режиме обсуждения у Claude нет доступа к файлам — файлы пропустил. ' +
         'Чтобы он их открыл, переключитесь на 🛠 Разработку: /model').catch(() => {});
    parts = parts.filter((p) => p.kind !== 'file');
    if (!parts.some((p) => p.words || p.blocks.length)) return;
  }
  submit(buildTask(parts));
}

/** Части → одна задача: сначала слова, потом пометки для Claude, картинки отдельными блоками. */
function buildTask(parts) {
  const talk = state.mode === 'talk';
  const words = parts.map((p) => p.words).filter(Boolean);
  const notes = parts.map((p) => p.note).filter(Boolean);
  const images = parts.filter((p) => p.kind === 'image');
  const files = parts.filter((p) => p.kind === 'file').flatMap((p) => p.saved);
  if (images.length) {
    notes.push(`🖼 ${images.length} фото — ниже` +
      (talk ? '' : `; сохранены на сервере: ${images.flatMap((p) => p.saved).join(', ')}`));
  }
  if (files.length) notes.push(`📎 ${files.length > 1 ? 'Файлы' : 'Файл'} — открой перед ответом:\n${files.join('\n')}`);

  const text = [
    words.join('\n\n') || 'Посмотри и разбери, что здесь.',
    notes.map((n) => `[${n}]`).join('\n'),
  ].filter(Boolean).join('\n\n');
  return { text, blocks: parts.flatMap((p) => p.blocks), label: partsLabel(parts) };
}

function partsLabel(parts) {
  const L = [];
  const add = (kind, icon, one, few, many) => {
    const c = parts.filter((p) => p.kind === kind).length;
    if (c) L.push(`${icon} ${c > 1 ? `${c} ` : ''}${plural(c, one, few, many)}`);
  };
  add('voice', '🎙', 'голосовое', 'голосовых', 'голосовых');
  add('audio', '🎧', 'аудио', 'аудио', 'аудио');
  add('note', '🎥', 'кружок', 'кружка', 'кружков');
  add('video', '🎬', 'видео', 'видео', 'видео');
  add('image', '🖼', 'фото', 'фото', 'фото');
  add('file', '📎', 'файл', 'файла', 'файлов');
  return L.join(' + ');
}

async function handleUpdate(u) {
  state.offset = u.update_id + 1;
  saveState();

  if (u.callback_query) {
    if (String(u.callback_query.from.id) !== OWNER_ID) {
      log('WARN', 'Чужой callback отклонён', { id: u.callback_query.from.id });
      return;
    }
    return handleCallback(u.callback_query);
  }

  const msg = u.message;
  if (!msg) return;
  if (String(msg.from.id) !== OWNER_ID) {
    log('WARN', 'Доступ запрещён', { id: msg.from.id, username: msg.from.username });
    return;
  }

  const m = mediaOf(msg);
  if (m) return acceptMedia(msg, m);

  if (!msg.text) return;
  const text = msg.text.trim();
  log('INFO', 'Сообщение', { text: text.slice(0, 100) });
  return route(text);
}

// ─────────────────────────── Главный цикл ───────────────────────────

let running = true, failures = 0;

async function poll() {
  while (running) {
    try {
      const updates = await tg('getUpdates', {
        offset: state.offset, timeout: 50,
        allowed_updates: ['message', 'callback_query'],
      });
      failures = 0;
      for (const u of updates) {
        try { await handleUpdate(u); }
        catch (e) { log('ERROR', `Обработка обновления: ${e.stack || e.message}`); }
      }
    } catch (e) {
      failures++;
      const wait = Math.min(60, 2 ** Math.min(failures, 5));
      log('ERROR', `Опрос не удался (${failures}): ${e.message}. Пауза ${wait} с`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

function shutdown(sig) {
  log('INFO', `Получен ${sig}, завершаюсь`);
  running = false;
  if (isBusy()) stopChild('перезапуск сервиса');
  killEngine('остановка сервиса');
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log('ERROR', `Необработанный reject: ${e?.stack}`));
process.on('uncaughtException', (e) => log('ERROR', `Необработанное исключение: ${e?.stack}`));

(async () => {
  loadState();
  log('INFO', 'Бот запускается', { projectsRoot: PROJECTS_ROOT, owner: OWNER_ID });
  try {
    const me = await tg('getMe');
    log('INFO', `Подключён как @${me.username}`);
  } catch (e) { fatal(`Не удалось подключиться к Telegram: ${e.message}`); }

  await tg('setMyCommands', { commands: [
    { command: 'project', description: '📁 выбрать проект' },
    { command: 'newproject', description: '➕ создать проект' },
    { command: 'status', description: '📊 состояние' },
    { command: 'model', description: '🤖 модель и режим' },
    { command: 'warm', description: '🔥 прогрев кэша' },
    { command: 'limits', description: '📈 остаток лимитов' },
    { command: 'sessions', description: '🧵 беседы проекта' },
    { command: 'compact', description: '🗜 сжать беседу' },
    { command: 'git', description: '🔀 git' },
    { command: 'new', description: '🆕 начать заново' },
    { command: 'stop', description: '⛔ остановить задачу' },
    { command: 'help', description: '❓ помощь' },
  ] }).catch(() => {});

  // Версию CLI и каталог моделей — сразу, чтобы меню знало номера моделей.
  // Дальше раз в полчаса: ночью CLI обновляет таймер claude-code-update.
  await refreshCli().catch((e) => log('WARN', `Версия Claude Code: ${e.message}`));
  setInterval(() => refreshCli().catch(() => {}), 30 * 60 * 1000);

  if (state.announced !== BOT_VERSION) {
    await send(`${WHATS_NEW}\n\nВсё про бота: /help`).catch(() => {});
    state.announced = BOT_VERSION; saveState();
  } else {
    await send('♻️ Бот перезапущен', { disable_notification: true }).catch(() => {});
  }
  poll();
})();
