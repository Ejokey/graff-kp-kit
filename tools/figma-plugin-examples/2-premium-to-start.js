// Разовый плагин, шаг 2: убрать уровень «Премиум», добавить «Старт», добавить строки НДС в сводную.
// Перед запуском вставить в файл слайд «Старт» из примера (текст «Выполнено блокингом») — из него берутся картинки.
// Структурные шаги пропускаются, если «Старт» уже есть — повторный запуск не плодит колонки.
(async () => {
  const log = [], skip = [];
  const get = id => figma.getNodeByIdAsync(id);
  // toLocaleString в песочнице Figma не ставит разделители разрядов, поэтому регуляркой
  const rub = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',00';
  const k = n => n === 0 ? 'отсутствует' : rub(n * 1000);
  const isText = n => n.type === 'TEXT';
  const TIERS = ['Старт', 'Стандарт', 'Комфорт', 'Бизнес', 'Премиум'];
  async function setText(n, s) {
    if (!n) return;
    if (n.characters === s) return;
    for (const fn of n.getRangeAllFontNames(0, n.characters.length)) await figma.loadFontAsync(fn);
    n.characters = s;
  }
  const tierText = (root, name) => !('findOne' in root) ? null : root.findOne(n => isText(n) && n.characters.trim() === name);
  const hasText = (root, re) => ('findOne' in root) && !!root.findOne(n => isText(n) && re.test(n.characters));
  // Ближайший предок, в котором ровно одно название уровня (= колонка / плитка уровня)
  function cardOf(t, root) {
    let c = t;
    while (c.parent && c.parent !== root) {
      const p = c.parent;
      const n = p.findAll(x => isText(x) && TIERS.includes(x.characters.trim())).length;
      if (n > 1) break;
      c = p;
    }
    return c;
  }
  const byX = arr => [...arr].sort((a, b) => a.absoluteTransform[0][2] - b.absoluteTransform[0][2]);
  const firstText = n => isText(n) ? n : ('findOne' in n ? n.findOne(isText) : null);
  const imgNode = root => {
    const all = !('findAll' in root) ? [] : root.findAll(n => 'fills' in n && Array.isArray(n.fills) && n.fills.some(f => f.type === 'IMAGE'));
    if ('fills' in root && Array.isArray(root.fills) && root.fills.some(f => f.type === 'IMAGE')) all.push(root);
    return all.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  };

  // ---------- 1. Сводная «Итоговая стоимость» ----------
  const S = await get('80701:8781');
  const header = await get('80701:8792');
  const rowIds = { dev: '80701:8849', eq: '80701:8871', bonus: '101701:29', total: '80701:8882' };
  if (S && header && !tierText(header, 'Старт')) {
    const pr = tierText(header, 'Премиум'), st = tierText(header, 'Стандарт');
    const prCol = cardOf(pr, header), stCol = cardOf(st, header);
    const par = stCol.parent;
    const clone = stCol.clone();
    par.insertChild(par.children.indexOf(stCol), clone);
    prCol.remove();
    const map = { 'Стандарт': 'Старт', 'WhiteBox': '2D-планы', '300 м': 'блокинг' };
    for (const t of clone.findAll(isText)) if (map[t.characters.trim()]) await setText(t, map[t.characters.trim()]);
    for (const key in rowIds) {
      const row = await get(rowIds[key]);
      if (!row || row.children.length !== 5) { skip.push('строка ' + key + ': ячеек ' + (row ? row.children.length : 0) + ', ожидалось 5'); continue; }
      const cells = byX(row.children);
      const c = cells[1].clone();
      row.insertChild(row.children.indexOf(cells[1]), c);
      cells[4].remove();
    }
    log.push('сводная: колонка Премиум убрана, Старт добавлен');
  }
  const vals = {
    dev: [3310000, 5594000, 7739000, 9056000],
    eq: [880000, 880000, 1280000, 1420000],
    total: [4190000, 6474000, 9019000, 10476000]
  };
  const vat = [293300, 453180, 631330, 733320];
  const totalVat = [4483300, 6927180, 9650330, 11209320];
  async function fillRow(row, label, arr) {
    const cells = byX(row.children);
    if (cells.length !== 5) { skip.push('заполнение строки ' + row.id + ': ячеек ' + cells.length); return; }
    if (label) await setText(firstText(cells[0]), label);
    for (let i = 0; i < 4; i++) await setText(firstText(cells[i + 1]), rub(arr[i]));
  }
  if (S) {
    await fillRow(await get(rowIds.dev), null, vals.dev);
    await fillRow(await get(rowIds.eq), null, vals.eq);
    const total = await get(rowIds.total);
    await fillRow(total, 'Итого, без НДС', vals.total);
    if (!hasText(S, /^НДС 7%$/)) {
      const par = total.parent;
      const r1 = total.clone(); par.insertChild(par.children.indexOf(total) + 1, r1);
      const r2 = total.clone(); par.insertChild(par.children.indexOf(r1) + 1, r2);
      await fillRow(r1, 'НДС 7%', vat);
      await fillRow(r2, 'Итого, в т.ч. НДС 7%', totalVat);
      // чтобы таблица и слайд выросли под новые строки
      for (const id of ['80701:8791', '80701:8787', '80701:8782']) {
        const n = await get(id);
        try { if (n && n.layoutMode === 'VERTICAL') n.primaryAxisSizingMode = 'AUTO'; } catch (e) {}
      }
      try { if (S.layoutMode === 'HORIZONTAL') S.counterAxisSizingMode = 'AUTO'; } catch (e) {}
      log.push('сводная: добавлены строки НДС 7% и Итого с НДС');
    }
  }

  // ---------- 2. Плитки «Радиус» и «Интерьеры»: Премиум → Старт, порядок Бизнес, Комфорт, Стандарт, Старт ----------
  const EX = figma.currentPage.findOne(n => n.type === 'FRAME' && n.parent.type === 'PAGE' && hasText(n, /Выполнено блокингом/));
  if (!EX) skip.push('не найден вставленный слайд «Старт» из примера — картинки Старт не заменены');
  const exImg = label => {
    if (!EX) return null;
    const t = EX.findOne(n => isText(n) && n.characters.trim() === label);
    if (!t) return null;
    let c = t;
    while (c.parent && c.parent !== EX && !imgNode(c)) c = c.parent;
    return imgNode(c);
  };
  const grids = [
    { id: '86701:328', sub: 'Блокинг', ex: 'Окружение', cleanup: true },
    { id: '86701:385', sub: '2D-план', ex: 'Квартиры', cleanup: false }
  ];
  for (const g of grids) {
    const slide = await get(g.id);
    if (!slide) { skip.push('нет слайда ' + g.id); continue; }
    const card = {};
    for (const name of ['Бизнес', 'Комфорт', 'Стандарт', 'Премиум']) {
      const t = tierText(slide, name) || (name === 'Премиум' ? tierText(slide, 'Старт') : null);
      if (!t) { skip.push(g.id + ': нет плитки ' + name); continue; }
      card[name] = cardOf(t, slide);
    }
    if (Object.keys(card).length !== 4) continue;
    const P = card['Премиум'];
    // тексты
    const titleP = tierText(P, 'Премиум') || tierText(P, 'Старт');
    const subP = P.findAll(n => isText(n) && n !== titleP && n.characters.trim().length > 1)[0];
    await setText(titleP, 'Старт');
    if (subP) await setText(subP, g.sub);
    // картинка
    const src = exImg(g.ex), dst = imgNode(P);
    if (src && dst) { dst.fills = JSON.parse(JSON.stringify(src.fills)); }
    else skip.push(g.id + ': картинку Старт не подставил');
    // радиус: убрать эллипс, стрелку и маркер с картинки Премиум
    if (g.cleanup) {
      const keep = new Set();
      for (const n of [dst, titleP, subP]) { let c = n; while (c && c !== P) { keep.add(c); c = c.parent; } }
      const junk = P.findAll(n => !keep.has(n) && ['ELLIPSE', 'LINE', 'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON'].includes(n.type));
      const marker = P.findAll(n => isText(n) && n.characters.trim() === 'Б');
      for (const m of marker) { let c = m; while (c.parent && c.parent !== P && !keep.has(c.parent)) c = c.parent; junk.push(c); }
      for (const n of junk) { try { if (!n.removed) n.remove(); } catch (e) {} }
      const foot = slide.findOne(n => isText(n) && n.characters.trim().startsWith('*'));
      if (foot) foot.remove();
    }
    // порядок: слоты были Премиум(1), Бизнес(2), Комфорт(3), Стандарт(4) → Бизнес, Комфорт, Стандарт, Старт
    if (P.getPluginData('startDone') === '1') { log.push(g.id + ': уже переставлено'); continue; }
    const order = ['Премиум', 'Бизнес', 'Комфорт', 'Стандарт'];
    const target = ['Бизнес', 'Комфорт', 'Стандарт', 'Премиум'];
    const par = P.parent;
    if (par.layoutMode && par.layoutMode !== 'NONE') {
      const slots = order.map(n => par.children.indexOf(card[n])).sort((a, b) => a - b);
      target.forEach((n, i) => par.insertChild(slots[i], card[n]));
    } else {
      const pos = order.map(n => ({ x: card[n].x, y: card[n].y }));
      target.forEach((n, i) => { card[n].x = pos[i].x; card[n].y = pos[i].y; });
    }
    P.setPluginData('startDone', '1');
    log.push(g.id + ': Премиум → Старт, плитки переставлены');
  }

  // ---------- 3. Слайд работ Премиум → Старт, ставится первым ----------
  const W = { std: '103701:2327', cmf: '103701:2470', bus: '103701:2613', prm: '103701:2756' };
  const prm = await get(W.prm);
  const lbl = await get('103701:2767');
  if (prm && lbl && lbl.characters.trim() !== 'Старт') {
    await setText(lbl, 'Старт');
    const b = 2781;
    const v = [451, 216, 243, 0, 277, 0, 0, 0, 0, 0, 0];
    const dev = [306, 412, 1129, 92, 184];
    const ms = v.reduce((a, c) => a + c), ds = dev.reduce((a, c) => a + c);
    const set = {};
    v.forEach((x, i) => set['103701:' + (b + 5 * i)] = k(x));
    set['103701:' + (b + 55)] = k(ms);
    dev.forEach((x, i) => set['103701:' + (b + 68 + 5 * i)] = k(x));
    set['103701:' + (b + 93)] = k(ds);
    set['103701:' + (b + 107)] = k(ms);
    set['103701:' + (b + 112)] = k(ds);
    set['103701:' + (b + 117)] = k(ms + ds);
    set['103701:2794'] = 'Моделирование объектов ближайшего окружения (блокинг)';
    for (const id in set) await setText(await get(id), set[id]);
    const fr = {}; for (const kk in W) fr[kk] = await get(W[kk]);
    const pos = ['std', 'cmf', 'bus', 'prm'].map(kk => ({ x: fr[kk].x, y: fr[kk].y }));
    ['prm', 'std', 'cmf', 'bus'].forEach((kk, i) => { fr[kk].x = pos[i].x; fr[kk].y = pos[i].y; });
    log.push('слайд работ Премиум → Старт, поставлен перед Стандартом');
  }

  console.log('KP Ikigai step 2', { log, skip });
  figma.closePlugin('Готово: ' + log.length + ' шагов' + (skip.length ? ', пропущено ' + skip.length + ' — см. консоль' : ''));
})().catch(e => { console.error(e); figma.closePlugin('Ошибка: ' + e.message + ' | ' + String(e.stack || '').slice(0, 200)); });
