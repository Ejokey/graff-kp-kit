// Разовый плагин, шаг 4: починка по результатам просмотра презентации.
// В строках итога сводной 6 слоёв (первый — служебный «4»), подпись — 5-й с конца, значения — 4 последних.
(async () => {
  const log = [], skip = [];
  const get = id => figma.getNodeByIdAsync(id);
  const rub = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',00';
  const isText = n => n.type === 'TEXT';
  const texts = n => isText(n) ? [n] : ('findAll' in n ? n.findAll(isText) : []);
  const firstText = n => texts(n).filter(t => t.visible && t.characters.trim())[0] || null;
  async function setText(n, s) {
    if (!n || n.characters === s) return;
    for (const fn of n.getRangeAllFontNames(0, n.characters.length)) await figma.loadFontAsync(fn);
    n.characters = s;
  }
  const imgNodes = root => {
    const all = 'findAll' in root ? root.findAll(n => 'fills' in n && Array.isArray(n.fills) && n.fills.some(f => f.type === 'IMAGE')) : [];
    if ('fills' in root && Array.isArray(root.fills) && root.fills.some(f => f.type === 'IMAGE')) all.push(root);
    return all.sort((a, b) => b.width * b.height - a.width * a.height);
  };

  // ---------- 1. Сводная: три нижние строки ----------
  const rows = [
    ['80701:8882', 'Итого, без НДС', [4190000, 6474000, 9019000, 10476000]],
    ['105715:827', 'НДС 7%', [293300, 453180, 631330, 733320]],
    ['105715:840', 'Итого, в т.ч. НДС 7%', [4483300, 6927180, 9650330, 11209320]]
  ];
  for (const [id, label, vals] of rows) {
    const r = await get(id);
    if (!r) { skip.push('нет строки ' + id); continue; }
    const ch = r.children;
    if (ch.length < 5) { skip.push(id + ': слоёв ' + ch.length); continue; }
    await setText(firstText(ch[ch.length - 5]), label);
    const cells = ch.slice(-4);
    for (let i = 0; i < 4; i++) await setText(firstText(cells[i]), rub(vals[i]));
  }
  log.push('сводная: строки итога, НДС и итога с НДС заполнены');

  // ---------- 2. Радиус: плитка «Старт» — картинка блокинга из вставленного слайда, без маркера ----------
  const slide = await get('86701:328');
  const EX = figma.currentPage.findOne(n => n.type === 'FRAME' && n.parent.type === 'PAGE' && texts(n).some(t => /Выполнено блокингом/.test(t.characters)));
  const title = slide && texts(slide).find(t => t.characters.trim() === 'Старт');
  if (!slide || !title) skip.push('радиус: не нашёл плитку Старт');
  else if (!EX) skip.push('радиус: нет вставленного слайда из примера');
  else {
    // плитка = предок заголовка, в котором только один уровень
    let card = title;
    while (card.parent && card.parent !== slide && texts(card.parent).filter(t => ['Старт', 'Стандарт', 'Комфорт', 'Бизнес'].includes(t.characters.trim())).length === 1) card = card.parent;
    const exT = texts(EX).find(t => t.characters.trim() === 'Окружение');
    let exCard = exT; while (exCard && exCard.parent !== EX && !imgNodes(exCard).length) exCard = exCard.parent;
    const src = exCard && imgNodes(exCard)[0];
    const dst = imgNodes(card)[0];
    if (src && dst) { dst.fills = JSON.parse(JSON.stringify(src.fills)); log.push('радиус: картинка блокинга подставлена'); }
    else skip.push('радиус: картинка не найдена (src ' + !!src + ', dst ' + !!dst + ')');
    // удалить всё в плитке, кроме картинки и текстов (маркер «Б», эллипс, стрелка)
    const sub = texts(card).find(t => t !== title && t.characters.trim().length > 1);
    const keep = new Set();
    for (const n of [dst, title, sub]) for (let c = n; c && c !== card; c = c.parent) keep.add(c);
    let removed = 0;
    const walk = n => { for (const c of [...n.children]) { if (keep.has(c)) { if ('children' in c && c !== dst) walk(c); } else if (c.visible !== false || true) { c.remove(); removed++; } } };
    if ('children' in card) walk(card);
    log.push('радиус: удалено лишних слоёв в плитке Старт: ' + removed);
  }

  // ---------- 3. Слайд работ «Старт»: название строки интерьеров без «дизайн-проекта Заказчика» ----------
  const ints = await get('103701:2809');
  if (ints && isText(ints) && ints.characters.startsWith('Создание набора 3D моделей и материалов для наполнения интерьеров')) {
    await setText(ints, 'Создание набора 3D моделей и материалов для наполнения интерьеров');
    log.push('Старт: строка интерьеров переименована');
  } else skip.push('Старт: строка интерьеров не найдена по id 103701:2809');

  console.log('KP Ikigai step 4', { log, skip });
  figma.closePlugin('Готово: ' + log.length + ' шагов' + (skip.length ? ', пропущено ' + skip.length + ' — см. консоль' : ''));
})().catch(e => { console.error(e); figma.closePlugin('Ошибка: ' + e.message + ' | ' + String(e.stack || '').slice(0, 200)); });
