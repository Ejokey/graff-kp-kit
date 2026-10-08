// Локальный мост между Claude и плагином «GRAFF KP — тексты» (Figma Desktop).
// Сервер:  node bridge.js
// Клиент:  node bridge.js send <команда> [payload.json | code.js | '{"inline":"json"}'] [--out файл] [--timeout сек]
// Команды: info, export, apply, check, png, run. Слушает только localhost; команды принимает только с токеном
// из файла во временной папке (его читает клиент), чтобы страница в браузере не могла править файл Figma.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const PORT = 3055, TOKEN_FILE = path.join(os.tmpdir(), 'graff-bridge.token');

if (process.argv[2] === 'send') client().catch(e => { console.error('Ошибка: ' + e.message); process.exit(1); });
else server();

function server() {
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token);
  const queue = [], results = {};
  let poller = null, lastPoll = 0, seq = 0;
  const body = req => new Promise(ok => { const a = []; req.on('data', c => a.push(c)); req.on('end', () => ok(Buffer.concat(a).toString('utf8'))); });
  const give = () => { if (poller && queue.length) { const p = poller; poller = null; clearTimeout(p.timer); p.res.writeHead(200, { 'Content-Type': 'application/json' }); p.res.end(JSON.stringify(queue.shift())); } };
  const handler = async (req, res) => {
    // Окно плагина — iframe с origin "null"; обычные страницы сюда не пускаем
    const origin = req.headers.origin;
    if (origin && origin !== 'null') { res.writeHead(403); return res.end(); }
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.writeHead(204); return res.end(); }
    const url = req.url.split('?')[0];
    if (url === '/poll') {
      lastPoll = Date.now();
      if (poller) { clearTimeout(poller.timer); poller.res.writeHead(204); poller.res.end(); }
      poller = { res, timer: setTimeout(() => { if (poller && poller.res === res) poller = null; res.writeHead(204); res.end(); }, 25000) };
      req.on('close', () => { if (poller && poller.res === res) { clearTimeout(poller.timer); poller = null; } });
      return give();
    }
    if (url === '/result' && req.method === 'POST') {
      const m = JSON.parse(await body(req));
      if (results[m.id]) { results[m.id](m); delete results[m.id]; }
      res.writeHead(204); return res.end();
    }
    if (url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ plugin: Date.now() - lastPoll < 30000, queued: queue.length }));
    }
    if (url === '/cmd' && req.method === 'POST') {
      if (req.headers['x-token'] !== token) { res.writeHead(401); return res.end('bad token'); }
      const c = JSON.parse(await body(req)), id = String(++seq);
      const wait = (c.timeout || 180) * 1000;
      const done = new Promise(ok => { results[id] = ok; setTimeout(() => { if (results[id]) { delete results[id]; ok({ ok: false, data: 'нет ответа от плагина за ' + wait / 1000 + ' с — открыт ли он в Figma?' }); } }, wait); });
      queue.push({ id, type: c.type, payload: c.payload });
      give();
      const r = await done;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r));
    }
    res.writeHead(404); res.end();
  };
  for (const host of ['127.0.0.1', '::1']) {
    http.createServer(handler).on('error', e => console.error(host + ': ' + e.message)).listen(PORT, host, () => console.log('мост слушает ' + host + ':' + PORT));
  }
}

async function client() {
  const args = process.argv.slice(3), opt = {};
  for (const k of ['--out', '--timeout']) { const i = args.indexOf(k); if (i >= 0) { opt[k] = args[i + 1]; args.splice(i, 2); } }
  const [type, src] = args;
  let payload;
  if (src) {
    if (src.trim()[0] === '{') payload = JSON.parse(src);
    else { const t = fs.readFileSync(src, 'utf8'); payload = /\.js$/.test(src) ? { code: t } : JSON.parse(t); }
  }
  const post = (p, data, headers) => new Promise((ok, bad) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: data ? 'POST' : 'GET', headers }, res => { const a = []; res.on('data', c => a.push(c)); res.on('end', () => ok(Buffer.concat(a).toString('utf8'))); });
    r.on('error', bad); if (data) r.write(data); r.end();
  });
  if (type === 'status') return console.log(await post('/status'));
  const token = fs.readFileSync(TOKEN_FILE, 'utf8');
  const r = JSON.parse(await post('/cmd', JSON.stringify({ type, payload, timeout: +opt['--timeout'] || undefined }), { 'x-token': token, 'Content-Type': 'application/json' }));
  if (!r.ok) throw new Error(typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
  if (r.b64) {
    const file = opt['--out'] || 'out.png';
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return console.log('сохранено: ' + file);
  }
  const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 1);
  if (opt['--out']) { fs.writeFileSync(opt['--out'], text); console.log('сохранено: ' + opt['--out'] + ' (' + text.length + ' символов)'); }
  else console.log(text);
}
