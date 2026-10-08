// Универсальный плагин для КП: выгрузка текстов и пакетное применение правок.
// Работает в Figma Desktop, поэтому видит локальные шрифты (Figma MCP их не видит).
figma.showUI(__html__, { width: 560, height: 620, themeColors: true });

const isText = n => n.type === 'TEXT';
const isPrice = s => /^[\d\s\u00a0]+,\d\d$|^отсутствует$/.test(s.trim());

// Выгрузка: выделенные фреймы или все фреймы верхнего уровня текущей страницы, сверху вниз
function exportTexts(ids) {
  const sel = ids ? figma.currentPage.children.filter(n => ids.includes(n.id)) : figma.currentPage.selection;
  const frames = (sel.length ? sel : figma.currentPage.children)
    .filter(n => 'findAll' in n)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const f of frames) {
    lines.push('## ' + f.id + ' | ' + f.name);
    for (const t of f.findAll(isText)) {
      if (!t.visible || !t.characters.trim()) continue;
      lines.push(t.id + ' | ' + norm(t.characters).replace(/\n/g, '⏎'));
    }
  }
  return lines.join('\n');
}

// Переносы: в Figma бывают \r и \u2028, в JSON приходят \n или ⏎ — сравниваем в одном виде
const norm = s => String(s).replace(/\r\n|\r|\u2028|\u2029/g, '\n').replace(/⏎/g, '\n');

// Figma иногда бросает строку, а не Error
const errText = e => (e && e.message) || String(e);
const textsOf = n => isText(n) ? [n] : 'findAll' in n ? n.findAll(isText) : [];

// Шрифт слоя не установлен (колоды бывают в полном «TT Hoves Pro», а стоит только Trial) — подменяем на установленный
// из того же семейства с тем же начертанием: для смены fontName нужен только новый шрифт. Что заменили — в отчёте.
const fontSubs = {};
let fontList = null;
// Шрифт грузим один раз за сессию плагина. Неустановленный не грузим вовсе (сверка со списком доступных):
// loadFontAsync такого шрифта может не вернуться, и правка зависает.
const fontsLoaded = {};
async function loadFont(fn) {
  const k = fn.family + '|' + fn.style;
  if (fontsLoaded[k]) return;
  if (!fontList) fontList = (await figma.listAvailableFontsAsync()).map(f => f.fontName);
  if (!fontList.some(f => f.family === fn.family && f.style === fn.style)) throw new Error('шрифт «' + k + '» не установлен');
  await Promise.race([figma.loadFontAsync({ family: fn.family, style: fn.style }),
    new Promise((ok, bad) => setTimeout(() => bad(new Error('шрифт «' + k + '» не загрузился за 10 с')), 10000))]);
  fontsLoaded[k] = true;
}
async function loadFonts(n) {
  if (!n.characters.length) { await loadFont(n.fontName); return; }
  for (const seg of n.getStyledTextSegments(['fontName'])) {
    const fn = seg.fontName;
    try { await loadFont(fn); continue; } catch (e) { /* ищем замену ниже */ }
    const fam = fontList.filter(f => f.family !== fn.family && f.family.indexOf(fn.family) === 0);
    const near = { Bold: 'DemiBold', DemiBold: 'Bold', Medium: 'Regular', Regular: 'Medium' };
    const sub = fam.find(f => f.style === fn.style) || fam.find(f => f.style === near[fn.style]);
    if (!sub) throw new Error('шрифт «' + fn.family + ' ' + fn.style + '» не установлен, замены нет');
    await loadFont(sub);
    n.setRangeFontName(seg.start, seg.end, sub);
    const key = fn.family + ' ' + fn.style + ' → ' + sub.family + ' ' + sub.style;
    fontSubs[key] = (fontSubs[key] || 0) + 1;
  }
}

async function setText(n, s) {
  await loadFonts(n);
  // Меняем только отличающийся кусок: n.characters = s красит весь текст стилем первой буквы
  // (в «787 500,00⏎0,00» зачёркнутая первая строка съедала стиль второй)
  const cur = n.characters;
  let p = 0, q = 0;
  while (p < cur.length && p < s.length && cur[p] === s[p]) p++;
  while (q < cur.length - p && q < s.length - p && cur[cur.length - 1 - q] === s[s.length - 1 - q]) q++;
  const mid = s.slice(p, s.length - q), end = cur.length - q;
  if (!cur.length) { n.characters = s; return; }
  try {
    if (mid) n.insertCharacters(p, mid, p < cur.length ? 'AFTER' : 'BEFORE');
    if (end > p) n.deleteCharacters(p + mid.length, end + mid.length);
    if (n.characters !== s) throw 'после замены текст не совпал';
  } catch (err) {
    // Запасной путь: целиком (стиль по первой букве); причина — в консоли
    console.warn('setText fallback', n.id, errText(err));
    n.characters = s;
  }
}

// Проверка сумм: [{"name":"…","sum":["id","id"],"eq":"id"}, {"name":"…","pct":7,"of":"id","eq":"id"}]
// Число берётся из последней строки текста («787 500,00⏎0,00» → 0), «отсутствует» = 0
const added = {};
async function node(id) {
  const m = /^@(.+)\/(.+)$/.exec(id);
  return figma.getNodeByIdAsync(m ? (added[m[1]] || {})[m[2]] || '' : id);
}

// Строка/плитка по id её текстов: общий контейнер, поднятый, пока у родителя нет других текстов
async function unit(ids) {
  const nodes = [];
  for (const id of [].concat(ids)) { const n = await node(id); if (!n) throw new Error('нет слоя ' + id); nodes.push(n); }
  const chain = n => { const a = []; for (let c = n; c; c = c.parent) a.push(c); return a; };
  let u = chain(nodes[0]).find(c => nodes.every(n => chain(n).includes(c)));
  const count = n => isText(n) ? 1 : 'findAll' in n ? n.findAll(isText).length : 0;
  while (u.parent && u.parent.type !== 'PAGE' && count(u.parent) === count(u)) u = u.parent;
  if (u.type === 'PAGE' || u.parent.type === 'PAGE') throw new Error('строка не найдена — это целый слайд');
  return u;
}

async function num(id) {
  const n = await node(id);
  if (!n || !isText(n)) throw new Error(id + ': нет текстового слоя');
  const line = norm(n.characters).trim().split('\n').pop().trim();
  if (line === 'отсутствует') return 0;
  const v = parseFloat(line.replace(/[^\d,]/g, '').replace(',', '.'));
  if (isNaN(v)) throw new Error(id + ': не число «' + line + '»');
  return v;
}
const rub = v => v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
async function check(list) {
  const bad = [];
  for (const c of list || []) {
    try {
      let want;
      if (c.sum) { want = 0; for (const x of c.sum) want += typeof x === 'number' ? x : await num(x); }
      else want = Math.round((await num(c.of)) * c.pct) / 100;
      const got = await num(c.eq);
      if (Math.abs(got - want) > 0.5) bad.push(`${c.name}: стоит ${rub(got)}, должно ${rub(want)}`);
    } catch (err) { bad.push(`${c.name}: ${errText(err)}`); }
  }
  return { total: (list || []).length, bad };
}

// Правки: {"edits":[{"id":"1:2","text":"новый","from":"старый (необязательно)"}], "remove":["id"], "hide":["id"]}
async function apply(json) {
  const plan = JSON.parse(json);
  const res = { changed: 0, same: 0, removed: 0, hidden: 0, skipped: [] };
  for (const k in fontSubs) delete fontSubs[k];
  for (const e of plan.edits || []) {
    const n = await figma.getNodeByIdAsync(e.id);
    if (!n || !isText(n)) { res.skipped.push(e.id + ': нет текстового слоя'); continue; }
    const cur = norm(n.characters);
    const text = norm(e.text);
    if (cur === text) { res.same++; continue; }
    // from сверяем без учёта вида пробелов: в ценах бывают неразрывные и тонкие, перенос вместо пробела
    const loose = s => norm(s).replace(/\s+/g, ' ').trim();
    if (e.from !== undefined && loose(cur) !== loose(e.from)) { res.skipped.push(e.id + ': сейчас «' + cur.slice(0, 40) + '», ожидалось «' + e.from.slice(0, 40) + '»'); continue; }
    if (e.from === undefined && isPrice(cur) !== isPrice(text)) { res.skipped.push(e.id + ': цена ↔ текст, укажи "from" для подтверждения'); continue; }
    try { await setText(n, text); res.changed++; } catch (err) { res.skipped.push(e.id + ': ' + errText(err)); }
  }
  // Добавление строк: {"like":["id подписи","id значения"],"after":[…],"as":"ключ","texts":{"id из like-строки":"новый текст"}}
  // Клонируется строка like, встаёт после строки after (по умолчанию — после like). Тексты мапятся по порядку слоёв.
  // В check на тексты новой строки ссылаться как "@ключ/id из like-строки".
  res.added = [];
  for (const a of plan.add || []) {
    const name = a.as || JSON.stringify(a.like);
    try {
      const src = await unit(a.like), anchor = await unit(a.after || a.like);
      const parent = anchor.parent;
      const tag = 'add:' + name;
      // Уже добавлена прошлым запуском — не клонируем снова, только дописываем тексты
      let copy = parent.children.find(c => c.getPluginData('graff') === tag);
      const fresh = !copy;
      if (fresh) {
        copy = src.clone();
        copy.setPluginData('graff', tag);
        parent.insertChild(parent.children.indexOf(anchor) + 1, copy);
      }
      if (fresh && (!('layoutMode' in parent) || parent.layoutMode === 'NONE')) {
        copy.x = anchor.x; copy.y = anchor.y + anchor.height;
        res.skipped.push(name + ': у родителя нет автолейаута — строка встала под якорь, соседей не сдвинуло, проверь глазами');
      }
      const from = textsOf(src), to = textsOf(copy), map = {};
      from.forEach((t, i) => { map[t.id] = to[i].id; });
      added[name] = map;
      for (const [id, text] of Object.entries(a.texts || {})) {
        if (!map[id]) { res.skipped.push(name + ': ' + id + ' не из строки like'); continue; }
        await setText(await figma.getNodeByIdAsync(map[id]), norm(text));
      }
      res.added.push(name + ' → ' + copy.id);
    } catch (err) { res.skipped.push(name + ': ' + errText(err)); }
  }
  // Сноска на слайде: {"like":"id текста-образца","in":"id слайда","as":"ключ","text":"…","x":0.04,"y":0.86,"w":0.3}
  // Клон текста like кладётся на слайд in; x, y, w — доли ширины/высоты слайда. Позиция ставится один раз, при создании.
  for (const t of plan.note || []) {
    const name = t.as || t.in;
    try {
      const src = await figma.getNodeByIdAsync(t.like), frame = await figma.getNodeByIdAsync(t.in);
      if (!src || !isText(src)) throw new Error('нет текста-образца ' + t.like);
      if (!frame || !('appendChild' in frame)) throw new Error('нет слайда ' + t.in);
      const tag = 'note:' + name;
      let copy = frame.children.find(c => c.getPluginData('graff') === tag);
      const fresh = !copy;
      if (fresh) {
        copy = src.clone();
        copy.setPluginData('graff', tag);
        frame.appendChild(copy);
        if ('layoutMode' in frame && frame.layoutMode !== 'NONE') copy.layoutPositioning = 'ABSOLUTE';
      }
      await setText(copy, norm(t.text));
      if (fresh) {
        if (t.w) { copy.textAutoResize = 'HEIGHT'; copy.resize(frame.width * t.w, copy.height); }
        copy.x = frame.width * t.x;
        // bottom — отступ в px от нижнего края слайда (вместо y)
        copy.y = t.bottom !== undefined ? frame.height - t.bottom - copy.height : frame.height * t.y;
      }
      res.added.push(name + ' → ' + copy.id);
    } catch (err) { res.skipped.push(name + ': ' + errText(err)); }
  }
  // Оформление куска текста: {"id":"id или @ключ/id","from":0,"to":6,"bold":true,"strike":true,"fill":"#8a8a8a","scale":0.8}
  // from/to — позиции символов (по умолчанию весь текст); scale — размер относительно последнего символа текста
  for (const s of plan.style || []) {
    try {
      const n = await node(s.id);
      if (!n || !isText(n)) throw new Error('нет текстового слоя');
      await loadFonts(n);
      const len = n.characters.length, a = s.from || 0, b = s.to === undefined ? len : Math.min(s.to, len);
      if (b <= a) throw new Error('пустой диапазон');
      if (s.strike !== undefined) n.setRangeTextDecoration(a, b, s.strike ? 'STRIKETHROUGH' : 'NONE');
      if (s.fill) {
        const h = parseInt(s.fill.slice(1), 16);
        n.setRangeFills(a, b, [{ type: 'SOLID', color: { r: (h >> 16) / 255, g: (h >> 8 & 255) / 255, b: (h & 255) / 255 } }]);
      }
      if (s.scale) {
        const base = n.getRangeFontSize(len - 1, len);
        if (typeof base === 'number') n.setRangeFontSize(a, b, Math.round(base * s.scale));
      }
      if (s.bold) {
        const fam = n.getRangeFontName(a, a + 1).family;
        let ok = false;
        for (const st of ['Bold', 'DemiBold', 'SemiBold', 'Medium']) {
          try { await loadFont({ family: fam, style: st }); n.setRangeFontName(a, b, { family: fam, style: st }); ok = true; break; } catch (e) { /* следующее начертание */ }
        }
        if (!ok) throw new Error('нет жирного начертания «' + fam + '»');
      }
      res.added.push('оформление ' + s.id);
    } catch (err) { res.skipped.push('оформление ' + s.id + ': ' + errText(err)); }
  }
  // Удаление: "id" — сам слой; ["id","id"] — строка целиком (общий контейнер этих текстов)
  for (const r of plan.remove || []) {
    try {
      const n = Array.isArray(r) ? await unit(r) : await figma.getNodeByIdAsync(r);
      if (n && !n.removed) { n.remove(); res.removed++; } else res.skipped.push(r + ': нечего удалять');
    } catch (err) { res.skipped.push(r + ': ' + errText(err)); }
  }
  for (const id of plan.hide || []) {
    const n = await figma.getNodeByIdAsync(id);
    if (n) { n.visible = false; res.hidden++; } else res.skipped.push(id + ': нет слоя');
  }
  res.fonts = Object.keys(fontSubs).map(k => k + ' (' + fontSubs[k] + ')');
  res.check = await check(plan.check);
  return res;
}

// Команды от Claude через локальный мост (bridge.js): окно плагина забирает их с localhost и присылает сюда с req
async function bridge(msg) {
  const p = msg.payload || {};
  if (msg.type === 'info') {
    return { file: figma.root.name, page: figma.currentPage.name,
      frames: figma.currentPage.children.filter(n => 'findAll' in n).sort((a, b) => a.y - b.y || a.x - b.x)
        .map(n => ({ id: n.id, name: n.name, x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.width), h: Math.round(n.height) })) };
  }
  if (msg.type === 'export') return exportTexts(p.ids);
  if (msg.type === 'apply') return await apply(JSON.stringify(p));
  if (msg.type === 'check') return await check(p.check);
  if (msg.type === 'png') {
    const n = await figma.getNodeByIdAsync(p.id);
    if (!n || !('exportAsync' in n)) throw new Error('нет слоя ' + p.id);
    return await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: p.scale || 1 } });
  }
  // Разовый структурный скрипт: тело async-функции с аргументом figma, результат — через return
  if (msg.type === 'run') {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return await new AsyncFunction('figma', p.code)(figma);
  }
  throw new Error('неизвестная команда ' + msg.type);
}

figma.ui.onmessage = async msg => {
  if (msg.req) {
    let ok = true, data;
    try { data = await bridge(msg); } catch (err) { ok = false; data = errText(err); }
    figma.ui.postMessage({ type: 'bridge', req: msg.req, cmd: msg.type, ok, data: data === undefined ? null : data });
    return;
  }
  try {
    if (msg.type === 'export') figma.ui.postMessage({ type: 'exported', text: exportTexts() });
    if (msg.type === 'check') figma.ui.postMessage({ type: 'checked', res: await check(JSON.parse(msg.json).check) });
    if (msg.type === 'apply') {
      const res = await apply(msg.json);
      figma.ui.postMessage({ type: 'applied', res });
      figma.notify(`Изменено ${res.changed}, без изменений ${res.same}, пропущено ${res.skipped.length}`);
    }
  } catch (err) {
    figma.ui.postMessage({ type: 'error', text: errText(err) });
  }
};
