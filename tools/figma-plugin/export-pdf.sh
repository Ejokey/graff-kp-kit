#!/usr/bin/env bash
# Экспорт открытой страницы Figma в один сжатый PDF через мост — без ручного File → Export.
# Запускать из любой папки; мост и плагин должны быть на связи (node bridge.js send status).
#   bash <папка плагина>/export-pdf.sh "путь/итог.pdf" [--full] [dpi качество качество_масок]
# Слайды — все фреймы верхнего уровня текущей страницы и картинки, вставленные вместо фрейма (File → Export их в PDF не берёт), порядок сверху вниз. Каждый слайд выгружается отдельно
# (PDF колоды целиком — 100+ МБ, одним куском через мост не передаём), сжимается scripts/compress-figma-pdf.py
# и склеивается (PyMuPDF). По умолчанию 84 / 58 / 78: колода из 24 слайдов 160 → 22 МБ.
#
# Повторный запуск выгружает только изменённые слайды: для каждого слайда плагин считает отпечаток по содержимому слоёв
# (тексты и их оформление, размеры и положение, заливки с картинками, обводки, эффекты) — без отрисовки, за секунды.
# Сжатый PDF слайда хранится в кэше под этим отпечатком и настройками сжатия. Кэш — во временной папке, отдельный на файл
# и страницу; id слайдов значения не имеют (после пересборки слайды с тем же содержимым берутся из кэша).
# Отпечаток по картинке слайда не годится: считается столько же, сколько сам экспорт, и у части слайдов меняется
# от запуска к запуску. --full — выгрузить всё заново (если правка не поймана отпечатком).
set -e
FULL=0; ARGS=()
for a in "$@"; do if [ "$a" = "--full" ]; then FULL=1; else ARGS+=("$a"); fi; done
OUT="${ARGS[0]:?укажи путь итогового PDF}"
DPI="${ARGS[1]:-84}"; Q="${ARGS[2]:-58}"; MQ="${ARGS[3]:-78}"
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$HERE/bridge.js"
COMPRESS="$HERE/../compress-figma-pdf.py"
[ -f "$COMPRESS" ] || { echo "не найден tools/compress-figma-pdf.py"; exit 1; }
# Python: переменная PYTHON, иначе Python 3.12 из стандартной папки Windows, иначе python из PATH
PY="${PYTHON:-$LOCALAPPDATA/Programs/Python/Python312/python.exe}"
[ -x "$PY" ] || PY=python
TT="${TMPDIR:-${TEMP:-/tmp}}"
T="$TT/graff-pdf-export"
rm -rf "$T"; mkdir -p "$T"

# Отпечатки всех слайдов одним запросом: id, отпечаток — сверху вниз
cat > "$T/prints.js" <<'EOF'
const r = v => typeof v === 'number' ? Math.round(v * 100) / 100 : String(v);
const js = v => v === figma.mixed ? 'mixed' : JSON.stringify(v);
const KEYS = ['opacity', 'rotation', 'blendMode', 'cornerRadius', 'strokeWeight', 'clipsContent', 'layoutMode', 'itemSpacing',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'isMask', 'textAlignHorizontal', 'textAlignVertical'];
const desc = (n, root) => {
  const o = [n.type, n.name, n.visible, root ? '' : r(n.x), root ? '' : r(n.y), r(n.width), r(n.height)];
  for (const k of KEYS) if (k in n) o.push(r(n[k]));
  for (const k of ['fills', 'strokes', 'effects']) if (k in n) o.push(js(n[k]));
  if ('vectorPaths' in n) o.push(js(n.vectorPaths));
  if (n.type === 'TEXT') o.push(n.characters, js(n.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'textDecoration', 'lineHeight', 'letterSpacing'])));
  return o.join('|');
};
const fnv = (s, seed) => { let h = seed; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
// слайд — фрейм верхнего уровня или картинка, вставленная вместо фрейма (прямоугольник шириной со слайд)
const frames = figma.currentPage.children.filter(n => n.visible && (n.type === 'FRAME' || (n.type !== 'TEXT' && n.width >= 1000))).sort((a, b) => a.y - b.y);
const out = [figma.root.name + ' | ' + figma.currentPage.name];
for (const f of frames) {
  const parts = [desc(f, true)].concat('findAll' in f ? f.findAll(() => true).map(n => desc(n, false)) : []);
  const s = parts.join('\n');
  out.push(f.id + ' ' + fnv(s, 0x811c9dc5) + fnv(s, 0x1234abcd) + '-' + parts.length + '-' + s.length);
}
return out.join('\n');
EOF
node "$B" send run "$T/prints.js" --timeout 600 --out "$T/prints.txt" > /dev/null
NAME="$(head -n 1 "$T/prints.txt")"
C="$TT/graff-pdf-cache/$(node -e "let h=0x811c9dc5;for(const c of Buffer.from(process.argv[1]))h=Math.imul(h^c,0x01000193);console.log((h>>>0).toString(16))" "$NAME")"
[ "$FULL" = 1 ] && rm -rf "$C"
mkdir -p "$C"
tail -n +2 "$T/prints.txt" | tr -d '\r' > "$T/ids.txt"; echo >> "$T/ids.txt"
echo "файл | страница: $NAME | слайдов: $(grep -c . "$T/ids.txt")"

i=0; new=0; : > "$T/order.txt"
while read -r id print; do
  [ -z "$id" ] && continue
  print="$print-$DPI-$Q-$MQ"
  i=$((i+1)); n=$(printf '%03d' $i)
  if [ ! -s "$C/$print.pdf" ]; then
    new=$((new+1))
    printf 'const n = await figma.getNodeByIdAsync("%s");\nconst b = await n.exportAsync({ format: "PDF" });\nreturn figma.base64Encode(b);\n' "$id" > "$T/one.js"
    node "$B" send run "$T/one.js" --timeout 300 --out "$T/$n.b64" > /dev/null
    node -e "
const fs=require('fs');const b=Buffer.from(fs.readFileSync(process.argv[1],'utf8'),'base64');
if(b.slice(0,5).toString()!=='%PDF-'){console.error('слайд '+process.argv[3]+': не PDF — '+b.slice(0,200).toString());process.exit(1);}
fs.writeFileSync(process.argv[2],b);fs.unlinkSync(process.argv[1]);
console.log(process.argv[3]+' '+process.argv[4]+' выгружен, '+(b.length/1e6).toFixed(1)+' МБ');" "$T/$n.b64" "$T/$n.pdf" "$n" "$id"
    "$PY" "$COMPRESS" "$T/$n.pdf" "$T/$n.c.pdf" --dpi "$DPI" --quality "$Q" --mask-quality "$MQ" > /dev/null 2>&1
    [ -s "$T/$n.c.pdf" ] || { echo "слайд $n: сжатие не удалось"; exit 1; }
    mv "$T/$n.c.pdf" "$C/$print.pdf"; rm -f "$T/$n.pdf"
  fi
  echo "$print.pdf" >> "$T/order.txt"
done < "$T/ids.txt"
echo "выгружено заново: $new из $i, из кэша: $((i-new))"

# Склейка в порядке слайдов; из кэша убираем PDF, которых в колоде больше нет
cat > "$T/merge.py" <<'EOF'
import sys, os, pymupdf
cache, order, out = sys.argv[1], sys.argv[2], sys.argv[3]
names = [l.strip() for l in open(order, encoding='utf-8') if l.strip()]
doc = pymupdf.open()
for nm in names:
    with pymupdf.open(os.path.join(cache, nm)) as s:
        if s.page_count != 1: sys.exit('в %s страниц: %d' % (nm, s.page_count))
        doc.insert_pdf(s)
if doc.page_count != len(names): sys.exit('страниц %d, слайдов %d' % (doc.page_count, len(names)))
doc.save(out, garbage=3, deflate=True)
for f in os.listdir(cache):
    if f.endswith('.pdf') and f not in names: os.remove(os.path.join(cache, f))
EOF
"$PY" "$T/merge.py" "$C" "$T/order.txt" "$T/merged.pdf" 2>&1 | grep -v -i patterntype || true
[ -s "$T/merged.pdf" ] || { echo "склейка не удалась"; exit 1; }
mv "$T/merged.pdf" "$OUT"
echo "готово: $OUT, страниц $i, $(node -e "console.log((require('fs').statSync(process.argv[1]).size/1e6).toFixed(1))" "$OUT") МБ"
