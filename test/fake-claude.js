// Поддельный Claude Code для проверки бота: говорит на stream-json, считает
// «кэш», пишет всё, что получил, в журнал FAKE_LOG.
const fs = require('fs');
const LOG = process.env.FAKE_LOG;
const args = process.argv.slice(2);
const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : '');
const sid = at('--session-id') || at('--resume') || 'sid';
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
log({ start: args, env: {
  bg: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, wf: process.env.CLAUDE_CODE_DISABLE_WORKFLOWS,
  cron: process.env.CLAUDE_CODE_DISABLE_CRON, ep: process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS } });

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

async function handle(msg) {
  const content = msg.message.content;
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  log({ msg: text, kinds: content.map((b) => b.type), images: content.filter((b) => b.type === 'image').length });
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
    await sleep(text.includes('долго') ? 400 : 15);
  }
  const u = usage();
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
    result: ping ? '.' : `Ответ на: ${text.slice(0, 40)}`,
    usage: { ...u, cache_read_input_tokens: u.cache_read_input_tokens * (ping ? 1 : 2) } });
}
