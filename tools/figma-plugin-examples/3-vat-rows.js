// Разовый плагин, шаг 3: починить сводную (лишние копии строки «Итого») и добавить НДС
// в таблицы «Итого» на слайдах «Основные работы». Безопасен при повторном запуске.
// Порядок ячеек берём из порядка слоёв, а не из координат: после вставки координаты
// автолейаута в плагине обновляются не сразу — из-за этого сломался шаг 2.
(async () => {
  const log = [], skip = [];
  const get = id => figma.getNodeByIdAsync(id);
  // toLocaleString в песочнице Figma не ставит разделители разрядов, поэтому регуляркой
  const rub = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',00';
  const isText = n => n.type === 'TEXT';
  const texts = n => isText(n) ? [n] : ('findAll' in n ? n.findAll(isText) : []);
  const firstText = n => texts(n).filter(t => t.visible && t.characters.trim())[0] || null;
  async function setText(n, s) {
    if (!n || n.characters === s) return;
    for (const fn of n.getRangeAllFontNames(0, n.characters.length)) await figma.loadFontAsync(fn);
    n.characters = s;
  }
  // row: первая ячейка — подпись, дальше значения по порядку слоёв
  async function fillRow(row, label, arr) {
    const cells = row.children;
    if (cells.length !== arr.length + 1) { skip.push(row.id + ': ячеек ' + cells.length + ', ожидалось ' + (arr.length + 1)); return; }
    if (label) await setText(firstText(cells[0]), label);
    for (let i = 0; i < arr.length; i++) await setText(firstText(cells[i + 1]), rub(arr[i]));
  }
  const grow = (from, stopAt) => {
    for (let n = from; n && n !== stopAt && n.parent && n.parent.type !== 'PAGE'; n = n.parent) {
      try { if (n.layoutMode === 'VERTICAL') n.primaryAxisSizingMode = 'AUTO'; else if (n.layoutMode === 'HORIZONTAL') n.counterAxisSizingMode = 'AUTO'; } catch (e) {}
    }
  };

  // ---------- 1. Сводная ----------
  const total = await get('80701:8882');
  const bonus = await get('101701:29');
  if (total && bonus) {
    const par = total.parent;
    // всё, что после бонуса, кроме исходной строки «Итого», — копии от прошлых запусков
    const after = par.children.slice(par.children.indexOf(bonus) + 1);
    let removed = 0;
    for (const r of after) if (r !== total) { r.remove(); removed++; }
    par.insertChild(par.children.indexOf(bonus) + 1, total);
    await fillRow(total, 'Итого, без НДС', [4190000, 6474000, 9019000, 10476000]);
    const r1 = total.clone(); par.insertChild(par.children.indexOf(total) + 1, r1);
    const r2 = total.clone(); par.insertChild(par.children.indexOf(r1) + 1, r2);
    await fillRow(r1, 'НДС 7%', [293300, 453180, 631330, 733320]);
    await fillRow(r2, 'Итого, в т.ч. НДС 7%', [4483300, 6927180, 9650330, 11209320]);
    // остальные строки — заново по порядку слоёв (шаг 2 мог записать их со сдвигом)
    await fillRow(await get('80701:8849'), null, [3310000, 5594000, 7739000, 9056000]);
    await fillRow(await get('80701:8871'), null, [880000, 880000, 1280000, 1420000]);
    log.push('сводная: удалено копий ' + removed + ', строки НДС собраны заново');
  }

  // ---------- 2. «Основные работы»: НДС в таблице «Итого» ----------
  const slides = [
    { name: 'Старт', total: '103701:2898', sum: 3310000, vat: 231700, withVat: 3541700 },
    { name: 'Стандарт', total: '103701:2469', sum: 5594000, vat: 391580, withVat: 5985580 },
    { name: 'Комфорт', total: '103701:2612', sum: 7739000, vat: 541730, withVat: 8280730 },
    { name: 'Бизнес', total: '103701:2755', sum: 9056000, vat: 633920, withVat: 9689920 }
  ];
  for (const s of slides) {
    const t = await get(s.total);
    if (!t) { skip.push(s.name + ': нет узла итога'); continue; }
    if (t.characters.replace(/\s/g, '') !== rub(s.sum).replace(/\s/g, '')) { skip.push(s.name + ': в итоге «' + t.characters + '», ожидалось ' + rub(s.sum)); continue; }
    // строка ИТОГО = предок, чей родитель (таблица) содержит строку «Разработка»
    let row = t;
    while (row.parent && row.parent.type !== 'PAGE' && !texts(row.parent).some(x => x.characters.trim() === 'Разработка')) row = row.parent;
    const table = row.parent;
    if (!table || table.type === 'PAGE') { skip.push(s.name + ': не нашёл таблицу «Итого»'); continue; }
    if (texts(table).some(x => x.characters.trim() === 'НДС 7%')) { log.push(s.name + ': НДС уже есть'); continue; }
    const r1 = row.clone(); table.insertChild(table.children.indexOf(row) + 1, r1);
    const r2 = row.clone(); table.insertChild(table.children.indexOf(r1) + 1, r2);
    await fillRow(row, 'Итого, без НДС', [s.sum]);
    await fillRow(r1, 'НДС 7%', [s.vat]);
    await fillRow(r2, 'Итого, с НДС 7%', [s.withVat]);
    grow(table);
    log.push(s.name + ': добавлены НДС 7% и итог с НДС');
  }

  console.log('KP Ikigai step 3', { log, skip });
  figma.closePlugin('Готово: ' + log.length + ' шагов' + (skip.length ? ', пропущено ' + skip.length + ' — см. консоль' : ''));
})().catch(e => { console.error(e); figma.closePlugin('Ошибка: ' + e.message + ' | ' + String(e.stack || '').slice(0, 200)); });
