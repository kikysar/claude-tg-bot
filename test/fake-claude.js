// Поддельный Claude Code для проверки бота: говорит на stream-json, считает
// «кэш», пишет всё, что получил, в журнал FAKE_LOG.
const fs = require('fs');
const http = require('http');
const LOG = process.env.FAKE_LOG;
const args = process.argv.slice(2);
const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : '');
const sid = at('--session-id') || at('--resume') || 'sid';
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
const E = process.env;
log({ start: args, env: {
  bg: E.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, wf: E.CLAUDE_CODE_DISABLE_WORKFLOWS,
  cron: E.CLAUDE_CODE_DISABLE_CRON, ep: E.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS },
  leak: E.DEEPSEEK_API_KEY !== undefined || E.TRANSLATE_API_KEY !== undefined,   // ключ переводчика до Claude доходить не должен
  // Куда ходит Claude Code и чем входит: по подписке (токен, ключ, чужой провайдер) или через мост Gemini. Сами секреты в журнал не пишем
  auth: { base: E.ANTHROPIC_BASE_URL || '', token: (E.ANTHROPIC_AUTH_TOKEN || '').length, apiKey: E.ANTHROPIC_API_KEY !== undefined,
    oauth: E.CLAUDE_CODE_OAUTH_TOKEN !== undefined, use: Object.keys(E).filter((k) => k.startsWith('CLAUDE_CODE_USE_')),
    toolSearch: E.ENABLE_TOOL_SEARCH, window: E.CLAUDE_CODE_AUTO_COMPACT_WINDOW, nonEss: E.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC } });

// Модель Google: тот же процесс, но ответ он берёт у моста Gemini по HTTP, как настоящий Claude Code с ANTHROPIC_BASE_URL
const GEM = /^gemini-/i.test(at('--model'));
function viaBridge(model, text) {
  return new Promise((resolve) => {
    const u = new URL('/v1/messages', E.ANTHROPIC_BASE_URL);
    const body = JSON.stringify({ model, max_tokens: 1024, stream: true, system: [{ type: 'text', text: 'You are Claude Code (test double).' }],
      messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${E.ANTHROPIC_AUTH_TOKEN}` } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: `API Error: ${res.statusCode} ${t}` });
        let answer = '', usage = {}, apiErr = '';
        for (const block of t.split('\n\n')) {
          const d = /^data: (.+)$/m.exec(block);
          if (!d) continue;
          const j = JSON.parse(d[1]);
          if (j.type === 'content_block_delta' && j.delta.type === 'text_delta') answer += j.delta.text;
          if (j.type === 'message_delta') usage = j.usage || {};
          if (j.type === 'error') apiErr = `API Error: ${JSON.stringify(j)}`;
        }
        resolve(apiErr ? { error: apiErr } : { answer, usage });
      });
    });
    req.on('error', (e) => resolve({ error: `API Error: Unable to connect (${e.message})` }));
    req.end(body);
  });
}

// Включён перевод — бот просит отвечать по-английски; так же отвечает и этот двойник
const english = at('--append-system-prompt').includes('machine-translated');
// Живой ответ для прогона с настоящим переводчиком (REALCLI): разметка, список, код в строке и блоком, путь, адрес
const REAL_ANSWER = [
  'The service does not start because the file `/etc/claude-tg-bot.env` has no `TELEGRAM_BOT_TOKEN` line, so the bot exits right after launch.',
  '', '1. Add the token to the file.', '2. Restart the unit:', '', '```bash', 'sudo systemctl restart claude-tg-bot', '```', '',
  'Then open https://example.com/logs and look for the line "Connected as @testbot" — it means the bot is up.'].join('\n');
// На обычный вопрос про службу (первый вопрос прогона с настоящим переводчиком) отвечаем так, как ответил бы Claude, а не заглушкой
const REAL_PLAIN = 'Check the journal first: run `journalctl -u claude-tg-bot -n 50` and look for permission errors or a missing token. If the unit fails right after a reboot, it usually starts before the network is up.';
function answerFor(text) {
  if (!english) return `Ответ на: ${text.slice(0, 40)}`;
  if (text.includes('REALANSWER')) return REAL_ANSWER;
  if (/why the (?:service|bot)\b/i.test(text)) return REAL_PLAIN;
  const head = `Answer to: ${text.slice(0, 40)}`;
  if (text.includes('CODE')) {
    return `${head}\n\nRun \`ls -la /opt/app\` first.\n\n\`\`\`bash\nsudo systemctl restart claude-tg-bot\n\`\`\`\n\nThen check the log.`;
  }
  if (text.includes('DROPTAG')) return `${head}\n\nOpen \`config.json\` now. DROPTAG`;
  if (text.includes('LONG')) {
    return [head, ...Array.from({ length: 8 }, (_, i) => `P${i + 1}: ${'word '.repeat(170).trim()}.`)].join('\n\n');
  }
  return head;
}

let ctx = 30000;
let buf = '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const l of lines) if (l.trim()) chain = chain.then(() => handle(JSON.parse(l)));
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));

// Беседа, файла которой на сервере нет (удалили или перенесли): настоящий Claude Code на --resume ничего не делает, присылает
// result с ошибкой и текстом в errors, пишет то же в stderr и выходит с кодом 1. Какие беседы «пропали», говорит файл FAKE_GONE.
const gone = args.includes('--resume') && process.env.FAKE_GONE && fs.existsSync(process.env.FAKE_GONE) &&
  fs.readFileSync(process.env.FAKE_GONE, 'utf8').split('\n').includes(at('--resume'));

async function handle(msg) {
  if (gone) {
    log({ gone: sid });
    // FAKE_GONE_SILENT — вариант без итога хода: процесс просто выходит, а причина только в stderr
    if (!(process.env.FAKE_GONE_SILENT && fs.existsSync(process.env.FAKE_GONE_SILENT))) {
      out({ type: 'result', subtype: 'error_during_execution', duration_ms: 0, is_error: true, num_turns: 0, session_id: sid,
            total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            errors: [`No conversation found with session ID: ${sid}`] });
    }
    process.stderr.write(`No conversation found with session ID: ${sid}\n`);
    setTimeout(() => process.exit(1), 20);
    return;
  }
  const content = msg.message.content;
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  log({ msg: text, kinds: content.map((b) => b.type), images: content.filter((b) => b.type === 'image').length });
  // FAILRUN — ход закончился другой ошибкой (не про пропавшую беседу): процесс жив, беседа цела
  if (text.includes('FAILRUN')) {
    out({ type: 'result', subtype: 'error_during_execution', duration_ms: 0, is_error: true, num_turns: 0, session_id: sid,
          total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          errors: ['boom: some other failure'] });
    return;
  }
  if (GEM) {
    const model = at('--model').replace(/\[1m\]$/i, '');
    out({ type: 'system', subtype: 'init', session_id: sid, model });
    const r = await viaBridge(model, text);
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    // Ошибка API приходит итогом хода с is_error и текстом ошибки в result — так её отдаёт настоящий Claude Code
    if (r.error) {
      out({ type: 'result', subtype: 'success', is_error: true, result: r.error, session_id: sid, total_cost_usd: 0, usage: zero });
      return;
    }
    out({ type: 'assistant', session_id: sid, message: { model, usage: r.usage, content: [{ type: 'text', text: r.answer }] } });
    // 0,9 — «цена по прайсу Claude», которую Claude Code насчитал бы за чужую модель: бот её учитывать не должен
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.9, result: r.answer, usage: r.usage });
    return;
  }
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' });
  const ping = text.includes('служебный пинг');
  const cold = ping && process.env.FAKE_COLD && fs.existsSync(process.env.FAKE_COLD);
  if (text.includes('большая беседа')) ctx = 120000;
  if (text.includes('автосжатие')) {   // беседа упёрлась в окно — Claude Code сжимает сам
    out({ type: 'system', subtype: 'compact_boundary', session_id: sid,
          compact_metadata: { trigger: 'auto', pre_tokens: 190000, post_tokens: 9000 } });
    ctx = 9000;
  }
  if (text === '/compact') {
    const slow = process.env.FAKE_SLOW && fs.existsSync(process.env.FAKE_SLOW);
    await sleep(slow ? 400 : 20);
    out({ type: 'system', subtype: 'compact_boundary', session_id: sid,
          compact_metadata: { trigger: 'manual', pre_tokens: ctx } });
    const was = ctx;
    ctx = 8000;
    out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: sid,
          usage: { cache_read_input_tokens: was, output_tokens: 6000 } });
    return;
  }
  const usage = () => ({ input_tokens: 3, output_tokens: 20,
    cache_read_input_tokens: cold ? 2000 : ctx, cache_creation_input_tokens: cold ? ctx : 400 });
  if (!ping) {
    out({ type: 'assistant', session_id: sid, message: { model: 'claude-opus-5-5', usage: usage(),
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } });
    // «очень долго» — больше полутора часов по ускоренным часам бота (2,6 с × 2000)
    // SLOWQ — то же «долго», но латиницей: русское слово перевод на английский заменил бы
    await sleep(text.includes('очень долго') ? 2600 : text.includes('долго') || text.includes('SLOWQ') ? 400 : 15);
  }
  const u = usage();
  // PLANQ — как в режиме плана: готовый план лежит в вызове ExitPlanMode, а итоговый текст — короткая отписка
  if (text.includes('PLANQ')) {
    out({ type: 'assistant', session_id: sid, message: { model: 'claude-opus-5-5', usage: usage(),
      content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'PLAN-BODY: step one, step two' } }] } });
  }
  out({ type: 'assistant', session_id: sid, message: { model: 'claude-opus-5-5', usage: u,
    content: [{ type: 'text', text: ping ? '.' : 'ok' }] } });
  ctx += ping ? 60 : 1500;
  // как у настоящего CLI: событие о лимитах идёт перед итогом хода, когда цифры сменились
  if (process.env.FAKE_RATE && fs.existsSync(process.env.FAKE_RATE)) {
    out({ type: 'rate_limit_event', session_id: sid, uuid: 'rl-' + Date.now(),
          rate_limit_info: JSON.parse(fs.readFileSync(process.env.FAKE_RATE, 'utf8')) });
  }
  // в итоге хода — сумма по обращениям, как у настоящего CLI
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.01,
    result: ping ? '.' : text.includes('PLANQ') ? 'Plan presented.' : answerFor(text),
    usage: { ...u, cache_read_input_tokens: u.cache_read_input_tokens * (ping ? 1 : 2) } });
  // EXITAFTER — ответил и завершился (как процесс, который выгрузили): следующее сообщение поднимет новый, с --resume
  if (text.includes('EXITAFTER')) setTimeout(() => process.exit(0), 30);
}
