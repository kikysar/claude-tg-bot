// Проверка бота на макетах: Telegram, Claude Code, ffmpeg и whisper поддельные,
// время ускорено в SPEED раз. Запуск из корня репозитория: node test/harness.js
// (VERBOSE=1 — с журналом бота, SHOW=1 — с экранами лимитов).
const path = require('path'), fs = require('fs'), os = require('os');
const EventEmitter = require('events');
const { Readable } = require('stream');
const cp = require('child_process');
const https = require('https');

const SPEED = 2000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgbot-'));
const env = process.env;
env.TELEGRAM_BOT_TOKEN = 'TEST'; env.TELEGRAM_OWNER_ID = '1';
env.STATE_FILE = path.join(tmp, 'state', 'state.json');
env.PROJECTS_ROOT = path.join(tmp, 'projects');
env.CLAUDE_BIN = path.join(tmp, 'claude-bin');
env.STT_DIR = path.join(tmp, 'stt');
env.FAKE_LOG = path.join(tmp, 'fake.log');
env.FAKE_COLD = path.join(tmp, 'cold.flag');
env.FAKE_SLOW = path.join(tmp, 'slow.flag');
env.FAKE_RATE = path.join(tmp, 'rate.json');
fs.mkdirSync(path.join(env.PROJECTS_ROOT, 'demo'), { recursive: true });
fs.writeFileSync(env.CLAUDE_BIN, 'bin');
const FFMPEG = path.join(env.STT_DIR, 'bin', 'ffmpeg');
const WHISPER = path.join(env.STT_DIR, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
for (const f of [FFMPEG, WHISPER, path.join(env.STT_DIR, 'whisper.cpp', 'models', 'ggml-small-q5_1.bin')]) {
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x');
}

// ── время ──
const realNow = Date.now.bind(Date), T0 = realNow();
Date.now = () => T0 + (realNow() - T0) * SPEED;
const rST = global.setTimeout, rSI = global.setInterval;
global.setTimeout = (fn, ms = 0, ...a) => rST(fn, Math.max(0, (ms || 0) / SPEED), ...a);
global.setInterval = (fn, ms = 0, ...a) => rSI(fn, Math.max(1, (ms || 0) / SPEED), ...a);
const sleepReal = (ms) => new Promise((r) => rST(r, ms));
const hours = () => (Date.now() - T0) / 3600e3;

// ── Telegram ──
const calls = [];
let uid = 0, msgId = 100, waiting = null;
const updates = [];
function push(u) { updates.push({ update_id: ++uid, ...u }); if (waiting) { const w = waiting; waiting = null; w(); } }
const msg = (extra) => push({ message: { message_id: ++msgId, from: { id: 1 }, chat: { id: 1 }, ...extra } });
const text = (t) => msg({ text: t });
const button = (data) => push({ callback_query: { id: String(++uid), from: { id: 1 }, data } });

https.request = (opts, cb) => {
  const req = new EventEmitter();
  let body = '';
  req.write = (b) => { body += b; };
  req.destroy = () => {};
  req.end = () => {
    const method = opts.path.split('/').pop();
    let payload = {}; try { payload = JSON.parse(body); } catch {}
    const respond = (result) => process.nextTick(() => {
      const res = new EventEmitter(); cb(res);
      res.emit('data', JSON.stringify({ ok: true, result })); res.emit('end');
    });
    if (method === 'getUpdates') {
      const deliver = () => respond(updates.splice(0));
      if (updates.length) deliver(); else waiting = deliver;
      return;
    }
    if (method !== 'sendChatAction') calls.push({ method, payload, h: hours() });
    if (method === 'sendMessage') { const id = ++msgId; calls[calls.length - 1].id = id; return respond({ message_id: id }); }
    if (method === 'getMe') return respond({ username: 'testbot' });
    if (method === 'getFile') return respond({ file_path: `files/${payload.file_id}` });
    respond(true);
  };
  return req;
};
https.get = (url, opts, cb) => {
  if (typeof opts === 'function') cb = opts;
  const req = new EventEmitter();
  process.nextTick(() => { const res = Readable.from([Buffer.from('DATA')]); res.statusCode = 200; cb(res); });
  return req;
};

// ── внешние программы ──
const runs = { ffmpeg: [], whisper: [], whisperMs: [] };
const origExecFile = cp.execFile;
// Настоящий execFile отвергает нецелый таймаут; подмена должна быть так же строга,
// иначе такая ошибка проходит проверку и падает только на живом голосовом.
const strictOpts = (opts) => {
  const t = opts && opts.timeout;
  if (t !== undefined && !(Number.isInteger(t) && t >= 0)) {
    throw Object.assign(new RangeError(
      `The value of "timeout" is out of range. It must be an unsigned integer. Received ${t}`), { code: 'ERR_OUT_OF_RANGE' });
  }
};
const WHISPER_SAYS = ' Привет, это голосовое [музыка]. Продолжение следует...\n';
let whisperOut = WHISPER_SAYS, whisperFail = false;   // что «слышит» whisper и не упал ли он
let cliVersion = '2.1.285';
let authIn = false, limitsRuns = 0;   // есть ли сохранённый вход; сколько раз читали панель
const PANEL = ' Current session\n  ██████████  61% used\n  Resets 7:09pm (Europe/Moscow)\n\n' +
              ' Current week (all models)\n  ████  40% used\n  Resets Oct 5, 11am (Europe/Moscow)\n';
cp.execFile = (bin, args, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  strictOpts(opts);
  const done = (err, so = '', se = '') => process.nextTick(() => cb && cb(err, so, se));
  if (bin === env.CLAUDE_BIN && args[0] === '--version') return done(null, `${cliVersion} (Claude Code)\n`);
  if (bin === env.CLAUDE_BIN && args[0] === 'auth') {
    return done(null, JSON.stringify(authIn
      ? { loggedIn: true, email: 'me@example.com', subscriptionType: 'pro' } : { loggedIn: false, authMethod: 'none' }));
  }
  if (bin === '/opt/claude-tg-bot/limits.sh') { limitsRuns++; return done(null, PANEL); }
  if (bin === 'grep') {
    return done(null, 'latest_per_family:{opus:"claude-opus-5-5",sonnet:"claude-sonnet-5-5",' +
                      'haiku:"claude-haiku-4-5-20251001",fable:"claude-fable-5-1"}\n');
  }
  if (bin === FFMPEG) {
    runs.ffmpeg.push(args);
    const outp = args[args.length - 1];
    if (!args.includes('-y')) return done(new Error('exit 1'), '', '  Duration: 00:00:23.40, start: 0.000000');
    // 5,4125 с, как у настоящих записей: длительность почти никогда не бывает целой
    if (outp.endsWith('.wav')) fs.writeFileSync(outp, Buffer.alloc(44 + 173200));
    else if (outp.includes('%02d')) {
      const n = Number(args[args.indexOf('-frames:v') + 1]);
      for (let i = 1; i <= n; i++) fs.writeFileSync(outp.replace('%02d', String(i).padStart(2, '0')), 'JPEG');
    } else fs.writeFileSync(outp, 'JPEG');
    return done(null);
  }
  if (bin === WHISPER) {
    runs.whisper.push(args);
    runs.whisperMs.push(opts.timeout);
    if (whisperFail) return done(new Error('exit 1'), '', 'whisper: модель не загрузилась');
    return done(null, whisperOut);
  }
  return origExecFile(bin, args, opts, cb);
};
const origSpawn = cp.spawn;
cp.spawn = (bin, args, opts) => (bin === env.CLAUDE_BIN
  ? origSpawn(process.execPath, [path.join(__dirname, 'fake-claude.js'), ...args], opts)
  : origSpawn(bin, args, opts));

// ── журнал бота и проверки ──
const logs = [];
const out = console.log;
console.log = (...a) => {
  const s = `${hours().toFixed(2)}h ${a.join(' ')}`;
  logs.push(s);
  if (env.VERBOSE) out(s);
};
const fakeLog = () => (fs.existsSync(env.FAKE_LOG)
  ? fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const asks = (from = 0) => fakeLog().slice(from).filter((x) => x.msg !== undefined);
const userAsks = (from = 0) => asks(from).filter((x) => !x.msg.includes('служебный пинг'));
const pingsSince = (from = 0) => asks(from).filter((x) => x.msg.includes('служебный пинг')).length;
const texts = () => calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
  .map((c) => c.payload.text || '');
const lastWith = (s) => [...calls].reverse().find((c) => (c.payload.text || '').includes(s));
const st = () => JSON.parse(fs.readFileSync(env.STATE_FILE, 'utf8'));
const count = (s) => logs.filter((l) => l.includes(s)).length;
async function waitFor(what, pred, ms = 30000) {
  const end = realNow() + ms;
  while (realNow() < end) { if (pred()) return; await sleepReal(3); }
  throw new Error(`не дождался: ${what}`);
}
let ok = 0, bad = 0;
function check(name, cond, info) {
  if (cond) { ok++; out(`  ✓ ${name}`); return; }
  bad++;
  out(`  ✗ ${name}${info === undefined ? '' : ` — ${typeof info === 'string' ? info : JSON.stringify(info)}`}`);
}

require('../bot.js');

(async () => {
  await waitFor('старт', () => texts().some((t) => t.includes('Бот обновлён')));
  check('меню: есть /warm', calls.find((c) => c.method === 'setMyCommands').payload.commands.some((c) => c.command === 'warm'));

  out('1. Задача и прогрев');
  button('p:demo');
  await waitFor('проект', () => texts().some((t) => t.includes('Проект: <b>demo')));
  const t1 = hours();
  text('привет');
  await waitFor('ответ', () => texts().some((t) => t.includes('Ответ на: привет')));
  const start = fakeLog().find((x) => x.start).start;
  const dis = start[start.indexOf('--disallowed-tools') + 1] || '';
  check('субагенты выключены флагом', ['Agent', 'Task', 'Workflow'].every((t) => dis.split(',').includes(t)), dis);
  const env1 = fakeLog().find((x) => x.start).env;
  check('субагенты выключены окружением', Object.values(env1).every((v) => v === '1'), env1);
  check('в промпте нет совета про субагента', !start.join(' ').includes('субагент'));
  check('статус задачи: модель с номером', texts().some((t) => t.includes('🆕 новая беседа • Opus 5.5')), texts().slice(-4));
  await waitFor('процесс погас', () => count('Останавливаю процесс Claude: простой') >= 1, 60000);
  check('6 пингов за окно 6 ч', pingsSince() === 6, pingsSince());
  const kill1 = logs.find((l) => l.includes('Останавливаю процесс Claude: простой'));
  const dt = parseFloat(kill1) - t1;
  check('процесс погас через ~6,6 ч', dt > 6.4 && dt < 6.9, dt.toFixed(2));
  check('пинги учтены', st().usage.warm.pings === 6, st().usage.warm);
  check('контекст — одно обращение, не сумма', st().lastCtx > 30000 && st().lastCtx < 40000, st().lastCtx);
  check('автосжатие не сработало от суммы', count('Автосжатие') === 0);
  check('маленькую беседу перед остыванием не сжимал', !asks().some((x) => x.msg === '/compact'));

  out('2. Очередь');
  let b = fakeLog().length;
  text('долго: задача 1');
  await waitFor('задача 1 ушла', () => userAsks(b).some((x) => x.msg.includes('задача 1')));
  text('задача 2'); text('задача 3');
  await waitFor('ответ на очередь', () => texts().some((t) => t.includes('Ответ на: задача 2')));
  let u = userAsks(b);
  check('очередь — одной задачей', u.length === 2 && u[1].msg.includes('задача 2') && u[1].msg.includes('задача 3'),
        u.map((x) => x.msg));
  check('сказал, что в очереди', texts().some((t) => t.includes('📥 В очереди')));
  check('в статусе — подпись очереди', texts().some((t) => t.includes('2 сообщения из очереди')));
  check('кэш тёплый в статусе', texts().some((t) => t.includes('🔥 кэш тёплый')));

  out('3. Альбом');
  b = fakeLog().length;
  msg({ media_group_id: 'g1', photo: [{ file_id: 'p1s', file_size: 100 }, { file_id: 'p1', file_size: 1000 }], caption: 'что на фото?' });
  msg({ media_group_id: 'g1', photo: [{ file_id: 'p2', file_size: 1000 }] });
  msg({ media_group_id: 'g1', photo: [{ file_id: 'p3', file_size: 1000 }] });
  await waitFor('альбом ушёл', () => userAsks(b).length >= 1);
  u = userAsks(b);
  check('альбом — одна задача с тремя картинками', u.length === 1 && u[0].images === 3, u);
  check('подпись первой, пометка про фото', u[0].msg.startsWith('что на фото?') && u[0].msg.includes('🖼 3 фото'), u[0].msg);
  check('скачан крупный размер', calls.some((c) => c.method === 'getFile' && c.payload.file_id === 'p1'));
  check('картинки ужимаются без растяжения', runs.ffmpeg.some((r) => r.join(' ').includes("scale='min(1568,iw)'")));
  check('подпись альбома в статусе', texts().some((t) => t.includes('🖼 3 фото')));

  out('4. Голосовое');
  b = fakeLog().length;
  const c0 = calls.length;
  msg({ voice: { file_id: 'v1', duration: 5, file_size: 5000 } });
  await waitFor('голосовое ушло', () => userAsks(b).length >= 1);
  u = userAsks(b);
  check('мусор whisper вычищен', !u[0].msg.includes('Продолжение следует') && !u[0].msg.includes('[музыка]'), u[0].msg);
  check('пометка про голосовое', u[0].msg.includes('🎙 Голосовое 0:05'), u[0].msg);
  check('расшифровка показана', texts().some((t) => t.startsWith('🎙 <i>Привет, это голосовое.')));
  const sent4 = calls.slice(c0).filter((c) => c.method === 'sendMessage');
  const status4 = sent4.find((c) => c.payload.text === '🎙 Распознаю…');
  const heard4 = sent4.find((c) => c.payload.text.startsWith('🎙 <i>Привет, это голосовое.'));
  check('расшифровка — отдельным сообщением со звуком', heard4 && !heard4.payload.disable_notification, heard4 && heard4.payload);
  check('статус «Распознаю…» без звука', status4 && status4.payload.disable_notification === true, status4 && status4.payload);
  check('статус убран после расшифровки', status4 && calls.slice(c0).some((c) => c.method === 'deleteMessage' && c.payload.message_id === status4.id), status4);
  check('расшифровка не правкой статуса', !calls.slice(c0).some((c) => c.method === 'editMessageText' && c.payload.text.startsWith('🎙')));
  const w = runs.whisper[runs.whisper.length - 1];
  check('whisper: ru, жадный поиск, окно 384', w.includes('ru') && w.includes('-bs') && w[w.indexOf('-ac') + 1] === '384', w.join(' '));
  check('whisper: таймаут — целое число миллисекунд', runs.whisperMs.length > 0 && runs.whisperMs.every((t) => Number.isInteger(t) && t >= 120000), runs.whisperMs);
  check('исходник голосового удалён', !fs.readdirSync(path.join(tmp, 'state', 'uploads')).some((f) => /voice/.test(f)));

  // сбой распознавания и «слов не разобрано» тоже приходят новым сообщением, а задача не уходит
  const shown = (from, start) => calls.slice(from).find((c) => c.method === 'sendMessage' && c.payload.text.startsWith(start));
  const statusGone = (from, statusText) => {
    const s = calls.slice(from).find((c) => c.method === 'sendMessage' && c.payload.text === statusText);
    return !!s && calls.slice(from).some((c) => c.method === 'deleteMessage' && c.payload.message_id === s.id);
  };
  b = fakeLog().length;
  const c1 = calls.length;
  whisperFail = true;
  msg({ voice: { file_id: 'v2', duration: 4, file_size: 4000 } });
  await waitFor('сбой показан', () => shown(c1, '❌ Не удалось разобрать'));
  whisperFail = false;
  check('сбой распознавания — новым сообщением, статус убран', statusGone(c1, '🎙 Распознаю…'), calls.slice(c1).map((c) => c.method));
  const c2 = calls.length;
  whisperOut = ' [музыка]\n';
  msg({ voice: { file_id: 'v3', duration: 3, file_size: 3000 } });
  await waitFor('«слов нет» показано', () => shown(c2, '🤔'));
  whisperOut = WHISPER_SAYS;
  check('«слов не разобрал» — новым сообщением, статус убран', statusGone(c2, '🎙 Распознаю…'), calls.slice(c2).map((c) => c.method));
  await sleepReal(60);
  check('после сбоев задача Claude не уходила', userAsks(b).length === 0, userAsks(b));

  out('5. Кружок');
  b = fakeLog().length;
  msg({ video_note: { file_id: 'n1', duration: 23, length: 384, file_size: 50000 } });
  await waitFor('кружок ушёл', () => userAsks(b).length >= 1);
  u = userAsks(b);
  check('кружок: 6 кадров', u[0].images === 6, u[0]);
  check('кружок: подпись кадров перед ними', u[0].kinds[1] === 'text' && u[0].kinds[2] === 'image', u[0].kinds);
  check('кружок: пометка', u[0].msg.includes('Кружок 0:23') && u[0].msg.includes('6 кадров'), u[0].msg);
  const fr = runs.ffmpeg.find((r) => r.join(' ').includes('fps=6/22.40'));
  check('кадры: длительность из файла, шаг с запасом', fr && fr[fr.indexOf('-ss') + 1] === '1.95',
        runs.ffmpeg.map((r) => r.join(' ')).filter((r) => r.includes('fps=')));
  check('статус кружка', texts().some((t) => t.startsWith('🎥 Кружок 0:23 · 6 кадров\n🎙')));
  check('кружок: итог новым сообщением, статус тихий и убран', (() => {
    const s = calls.find((c) => c.method === 'sendMessage' && c.payload.text === '🎥 Смотрю кружок…');
    return !!s && s.payload.disable_notification === true && calls.some((c) => c.method === 'deleteMessage' && c.payload.message_id === s.id);
  })());

  out('6. Фото и текст следом');
  b = fakeLog().length;
  msg({ photo: [{ file_id: 'p9', file_size: 1000 }] });
  text('а это что?');
  await waitFor('ушло', () => userAsks(b).length >= 1);
  await sleepReal(50);
  u = userAsks(b);
  check('фото и текст — одна задача', u.length === 1 && u[0].images === 1 && u[0].msg.startsWith('а это что?'), u);

  out('7. /stop');
  text('долго: задача 4');
  await waitFor('задача 4 ушла', () => userAsks().some((x) => x.msg.includes('задача 4')));
  text('задача 5');
  text('/stop');
  await waitFor('остановлено', () => texts().some((t) => t.includes('Остановлено')));
  check('очередь сброшена', texts().some((t) => t.includes('Заодно отменил очередь (1)')));
  await sleepReal(300);
  check('задача 5 не ушла', !userAsks().some((x) => x.msg.includes('задача 5')));

  out('8. Пинг на остывшем кэше');
  fs.writeFileSync(env.FAKE_COLD, '1');
  b = fakeLog().length;
  const kills = count('простой');
  text('задача 6');
  await waitFor('ответ 6', () => texts().some((t) => t.includes('Ответ на: задача 6')));
  await waitFor('прогрев выключен', () => count('Прогрев не удержал кэш') >= 1);
  await waitFor('процесс погас', () => count('простой') > kills);
  check('после холодного пинга больше не пингует', pingsSince(b) === 1, pingsSince(b));
  fs.unlinkSync(env.FAKE_COLD);

  out('9. /warm');
  text('/warm');
  await waitFor('экран прогрева', () => texts().some((t) => t.includes('Прогрев кэша')));
  check('экран: цена пинга и холодного старта', lastWith('Прогрев кэша').payload.text.includes('холодный старт ≈'));
  button('w:0');
  await waitFor('выключен', () => texts().some((t) => t.includes('Прогрев выключен')));
  b = fakeLog().length;
  const kills9 = count('простой');
  text('задача 7');
  await waitFor('ответ 7', () => texts().some((t) => t.includes('Ответ на: задача 7')));
  await waitFor('погас', () => count('простой') > kills9);
  check('без прогрева пингов нет', pingsSince(b) === 0, pingsSince(b));
  const k9 = logs.filter((l) => l.includes('простой')).pop();
  button('w:6');
  await waitFor('включён', () => texts().some((t) => t.includes('Держу кэш тёплым <b>6 ч')));

  out('10. Экраны');
  text('задача 8');
  await waitFor('ответ 8', () => texts().some((t) => t.includes('Ответ на: задача 8')));
  text('/status');
  await waitFor('статус', () => texts().some((t) => t.includes('Состояние') && t.includes('Кэш тёплый ещё')));
  const sTxt = lastWith('Состояние').payload.text;
  check('статус: модель и версия CLI', sTxt.includes('Opus 5.5') && sTxt.includes('Claude Code 2.1.285'), sTxt);
  check('статус: прогрев', sTxt.includes('Прогрев: <b>6 ч'), sTxt);
  text('/model');
  await waitFor('модель', () => texts().some((t) => t.includes('Модель и режим')));
  const mm = lastWith('Модель и режим').payload;
  const btns = mm.reply_markup.inline_keyboard.flat().map((x) => x.text);
  check('меню моделей с номерами', btns.includes('✅ Opus 5.5 — для сложной и повседневной работы') &&
        btns.includes('Sonnet 5.5 — быстрее и легче') && btns.includes('Haiku 4.5 — самая быстрая'), btns);

  out('11. /compact');
  text('/compact');
  await waitFor('сжато', () => texts().some((t) => t.includes('Беседа сжата')));
  await sleepReal(20);
  check('контекст забыт после сжатия', st().lastCtx === 0, st().lastCtx);

  out('11б. Сжатие перед остыванием');
  text('/autocompact');   // как у владельца: сжатие после каждой задачи выключено
  await waitFor('автосжатие выключено', () => texts().some((t) => t.includes('Автосжатие выключено')));
  button('w:2');
  await waitFor('окно 2 ч', () => texts().some((t) => t.includes('Держу кэш тёплым <b>2 ч')));
  b = fakeLog().length;
  let kills11 = count('простой');
  const t11 = hours();
  text('большая беседа: задача 9');
  await waitFor('ответ 9', () => texts().some((t) => t.includes('Ответ на: большая беседа')));
  await waitFor('процесс погас', () => count('простой') > kills11, 60000);
  const a11 = asks(b);
  const ci = a11.findIndex((x) => x.msg === '/compact');
  check('2 пинга, затем сжатие', pingsSince(b) === 2 && ci === a11.length - 1, a11.map((x) => x.msg.slice(0, 12)));
  const c11 = logs.find((l) => l.includes('Сжатие перед остыванием'));
  const dc = parseFloat(c11) - t11;
  check('сжал на ~2,7 ч — когда остыл бы кэш', dc > 2.6 && dc < 2.85, dc.toFixed(2));
  const k11 = parseFloat(logs.filter((l) => l.includes('простой')).pop()) - t11;
  check('погас через ~70 мин после сжатия', k11 - dc > 1.1 && k11 - dc < 1.25, (k11 - dc).toFixed(2));
  const note = lastWith('сжал беседу');
  check('сообщил тихо', note && note.payload.disable_notification === true && /было <b>12\dк/.test(note.payload.text), note && note.payload);
  check('сжатие учтено', st().usage.warm.compacts === 1 && st().lastCtx === 0, st().usage.warm);
  text('задача 10');
  await waitFor('ответ 10', () => texts().some((t) => t.includes('Ответ на: задача 10')));
  check('после сжатия беседа продолжается', userAsks(b).some((x) => x.msg.includes('задача 10')));
  await waitFor('погас', () => count('простой') > kills11 + 1, 60000);

  out('11в. Без окна, сообщение во время сжатия');
  button('w:0');
  await waitFor('выключен', () => texts().filter((t) => t.includes('Прогрев выключен')).length >= 2);
  fs.writeFileSync(env.FAKE_SLOW, '1');
  b = fakeLog().length;
  const t11c = hours();
  text('большая беседа: задача 11');
  await waitFor('сжатие началось', () => count('Сжатие перед остыванием') >= 2, 60000);
  check('без прогрева сжимает через ~54 мин', parseFloat(logs.filter((l) => l.includes('Сжатие перед остыванием')).pop()) - t11c < 1.0);
  text('задача 12');
  await waitFor('ответ 12', () => texts().some((t) => t.includes('Ответ на: задача 12')));
  check('статус: идёт сжатие', texts().some((t) => t.includes('🗜 как раз сжимаю беседу')), texts().slice(-5));
  const a11c = asks(b).map((x) => x.msg);
  check('задача ушла после сжатия', a11c.indexOf('/compact') >= 0 && a11c.indexOf('/compact') < a11c.findIndex((m) => m.includes('задача 12')), a11c);
  fs.unlinkSync(env.FAKE_SLOW);

  out('11г. Выключатель');
  text('/warm');
  await waitFor('экран', () => texts().filter((t) => t.includes('Прогрев кэша')).length >= 2);
  const wTxt = lastWith('Прогрев кэша').payload;
  check('экран: выключатель и учёт сжатий', wTxt.reply_markup.inline_keyboard.flat().some((x) => x.callback_data === 'wc') &&
        wTxt.text.includes('сжатий перед остыванием: 2'), wTxt.text);
  button('wc');
  await waitFor('выключено', () => texts().some((t) => t.includes('Сжатие перед остыванием выключено')));
  b = fakeLog().length;
  kills11 = count('простой');
  text('большая беседа: задача 13');
  await waitFor('ответ 13', () => texts().some((t) => t.includes('Ответ на: большая беседа: задача 13')));
  await waitFor('погас', () => count('простой') > kills11, 60000);
  check('выключено — не сжимает', !asks(b).some((x) => x.msg === '/compact'), asks(b).map((x) => x.msg));
  button('wc');
  button('w:6');
  await waitFor('включено', () => texts().some((t) => t.includes('Сжатие перед остыванием включено')));
  text('задача 14');   // живой процесс для проверки обновления CLI
  await waitFor('ответ 14', () => texts().some((t) => t.includes('Ответ на: задача 14')));

  out('11д. Автосжатие Claude Code');
  const autoNotes = () => calls.filter((c) => c.method === 'sendMessage' && (c.payload.text || '').includes('сжата автоматически'));
  check('ручное сжатие за автоматическое не выдаётся', autoNotes().length === 0, autoNotes().map((c) => c.payload.text));
  text('автосжатие: задача 15');
  await waitFor('ответ 15', () => texts().some((t) => t.includes('Ответ на: автосжатие: задача 15')));
  await waitFor('сообщение о сжатии', () => autoNotes().length > 0);
  const an = autoNotes()[0].payload;
  check('сообщил тихо: было 190к, стало 9к', autoNotes().length === 1 && an.disable_notification === true &&
        an.text.includes('было <b>190к</b>, стало <b>9к</b> токенов'), an);

  out('11е. Лимиты из потока Claude Code');
  const nowS = () => Math.floor(Date.now() / 1000);
  const limScreens = () => calls.filter((c) => (c.payload.text || '').includes('Использование'));
  text('/limits');
  await waitFor('экран без цифр', () => texts().some((t) => t.includes('Цифр лимитов пока нет')));
  check('нет событий и входа — «цифр пока нет», без просьбы войти и без панели',
        !texts().some((t) => t.includes('auth login')) && limitsRuns === 0, { limitsRuns });

  fs.writeFileSync(env.FAKE_RATE, JSON.stringify({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: nowS() + 18000,
    unifiedWindows: { five_hour: { utilization: 0.534, resetsAt: nowS() + 18000 },
                      seven_day: { utilization: 0.35, resetsAt: nowS() + 604800 } } }));
  text('задача 16');
  await waitFor('ответ 16', () => texts().some((t) => t.includes('Ответ на: задача 16')));
  await waitFor('цифры сохранены', () => st().rate && st().rate.windows.seven_day);
  check('состояние: 53% и 35%, время сброса в секундах',
        Math.round(st().rate.windows.five_hour.u * 100) === 53 && Math.round(st().rate.windows.seven_day.u * 100) === 35 &&
        st().rate.windows.five_hour.reset > nowS(), st().rate);
  text('/limits');
  await waitFor('экран с цифрами', () => limScreens().some((c) => (c.payload.text || '').includes('<b>53%</b>')));
  let lim = [...limScreens()].reverse().find((c) => (c.payload.text || '').includes('<b>53%</b>')).payload.text;
  check('сессия 53%, неделя 35%', lim.includes('Сессия') && lim.includes('<b>35%</b>') && lim.includes('Неделя'), lim);
  check('сброс: по Москве и «через»', /сброс в \d\d:\d\d МСК, через (\d+ ч|\d+ мин)/.test(lim) &&
        /сброс \d+ [а-я]+ в \d\d:\d\d МСК, через \d д/.test(lim), lim);
  const show = (title, t) => { if (env.SHOW) out(`----- ${title} -----\n${t.replace(/<\/?[a-z]+>/g, '')}\n-----`); };
  show('экран: цифры из потока', lim);
  check('подпись: цифры из последнего ответа', lim.includes('цифры из последнего ответа Claude'), lim);
  check('вход не нужен: панель не запускали', limitsRuns === 0, { limitsRuns });

  authIn = true;   // вход появился — точная панель главнее
  button('act:limits');
  await waitFor('панель', () => limScreens().some((c) => (c.payload.text || '').includes('<b>61%</b>')));
  lim = [...limScreens()].reverse().find((c) => (c.payload.text || '').includes('<b>61%</b>')).payload.text;
  check('со входом — цифры панели и аккаунт', lim.includes('<b>40%</b>') && lim.includes('me@example.com') &&
        !lim.includes('из последнего ответа') && limitsRuns === 1, { lim, limitsRuns });
  authIn = false;

  fs.writeFileSync(env.FAKE_RATE, JSON.stringify({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: nowS() + 9000,
    unifiedWindows: { five_hour: { utilization: 1, resetsAt: nowS() + 9000 },
                      seven_day: { utilization: 0.36, resetsAt: nowS() + 604800 } } }));
  text('задача 17');
  await waitFor('ответ 17', () => texts().some((t) => t.includes('Ответ на: задача 17')));
  button('act:limits');
  await waitFor('лимит исчерпан', () => limScreens().some((c) => (c.payload.text || '').includes('Лимит исчерпан')));
  lim = [...limScreens()].reverse().find((c) => (c.payload.text || '').includes('Лимит исчерпан')).payload.text;
  show('экран: лимит исчерпан', lim);
  check('исчерпан: плашка, 100% и сброс', lim.includes('⛔') && lim.includes('<b>100%</b>') && lim.includes('сессия') &&
        lim.includes('🔴'), lim);

  fs.writeFileSync(env.FAKE_RATE, JSON.stringify({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: nowS() - 60,
    unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: nowS() - 60 },
                      seven_day: { utilization: 0.4, resetsAt: nowS() + 604800 } } }));
  text('задача 18');
  await waitFor('ответ 18', () => texts().some((t) => t.includes('Ответ на: задача 18')));
  button('act:limits');
  await waitFor('окно сменилось', () => limScreens().some((c) => (c.payload.text || '').includes('окно сменилось')));
  lim = [...limScreens()].reverse().find((c) => (c.payload.text || '').includes('окно сменилось')).payload.text;
  show('экран: окно сменилось', lim);
  check('прошедшее окно — без выдуманных цифр', !lim.includes('90%') && lim.includes('<b>40%</b>') && !lim.includes('Лимит исчерпан'), lim);
  fs.unlinkSync(env.FAKE_RATE);

  out('12. Обновление CLI');
  cliVersion = '2.1.300';
  const later = new Date(realNow() + 60000);
  fs.utimesSync(env.CLAUDE_BIN, later, later);
  await waitFor('сообщение', () => texts().some((t) => t.includes('Claude Code обновился')));
  check('сообщение об обновлении', texts().some((t) => t.includes('2.1.285 → 2.1.300')));
  text('/status');
  await waitFor('статус', () => texts().filter((t) => t.includes('Состояние')).length >= 2);
  check('старый процесс ждёт паузы', lastWith('Состояние').payload.text.includes('ждёт паузы'), lastWith('Состояние').payload.text);

  out('13. Долгая задача не обрывается');
  b = fakeLog().length;
  const c13 = calls.length, t13 = hours();
  const since13 = () => calls.slice(c13).map((c) => c.payload.text || '');
  text('очень долго: задача 16');
  await waitFor('итог долгой задачи', () => since13().some((t) => t.includes('Ответ на: очень долго') || t.includes('Остановлено')), 60000);
  const took13 = hours() - t13;
  const after13 = since13();
  check('задача шла дольше получаса', took13 > 1.0, took13.toFixed(2));
  check('таймаут не сработал', count('Превышен таймаут') === 0 && !after13.some((t) => t.includes('Остановлено')), after13);
  check('ответ пришёл', after13.some((t) => t.includes('Ответ на: очень долго: задача 16')), after13);
  check('в итоге указано время больше часа', after13.some((t) => /✅ 1 ч \d+ мин/.test(t)), after13);

  out(`\nИтог: ${ok} ✓, ${bad} ✗`);
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  out(`ОШИБКА: ${e.message}`);
  out(logs.slice(-25).join('\n'));
  process.exit(2);
});
