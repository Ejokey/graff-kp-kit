// Скачивание публичной папки Яндекс Диска целиком (без авторизации, через публичный API).
//   node scripts/yadisk-public-download.js <публичная ссылка> <папка назначения> [--list] [--only <regex по пути>]
// --list — только показать состав и размеры. --only — брать только файлы, путь которых подходит под выражение. Уже скачанные файлы того же размера пропускаются.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const [, , key, dest, ...rest] = process.argv;
const flag = rest.includes('--list') ? '--list' : '';
const only = rest.includes('--only') ? new RegExp(rest[rest.indexOf('--only') + 1], 'i') : null;
if (!key || !dest) { console.error('usage: node yadisk-public-download.js <ссылка> <папка> [--list]'); process.exit(1); }

async function api(url) {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (i >= 4) throw new Error(r.status + ' ' + url);
    await new Promise(ok => setTimeout(ok, 2000 * (i + 1)));
  }
}
async function walk(p, out) {
  for (let offset = 0; ; offset += 200) {
    const j = await api(API + '?public_key=' + encodeURIComponent(key) + '&path=' + encodeURIComponent(p) + '&limit=200&offset=' + offset);
    if (j.type === 'file') { out.push({ path: '/' + j.name, size: j.size }); return; }
    const items = j._embedded.items;
    for (const it of items) {
      if (it.type === 'dir') await walk(it.path, out);
      else out.push({ path: it.path, size: it.size });
    }
    if (offset + items.length >= j._embedded.total) return;
  }
}
(async () => {
  const all = [];
  await walk('/', all);
  const files = only ? all.filter(f => only.test(f.path)) : all;
  const total = files.reduce((a, f) => a + f.size, 0);
  console.log('файлов: ' + files.length + ', всего ' + (total / 1e6).toFixed(1) + ' МБ');
  for (const f of files) {
    const to = path.join(dest, ...f.path.split('/').filter(Boolean));
    if (flag === '--list') { console.log((f.size / 1e6).toFixed(1).padStart(8) + ' МБ  ' + f.path); continue; }
    if (fs.existsSync(to) && fs.statSync(to).size === f.size) { console.log('есть    ' + f.path); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const j = await api(API + '/download?public_key=' + encodeURIComponent(key) + '&path=' + encodeURIComponent(f.path));
    const r = await fetch(j.href);
    if (!r.ok) throw new Error(r.status + ' при скачивании ' + f.path);
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(to + '.part'));
    fs.renameSync(to + '.part', to);
    const got = fs.statSync(to).size;
    console.log((got === f.size ? 'скачан  ' : 'РАЗМЕР НЕ СОВПАЛ ') + f.path + '  ' + (got / 1e6).toFixed(1) + ' МБ');
  }
  console.log('готово');
})().catch(e => { console.error('ошибка: ' + e.message); process.exit(1); });
