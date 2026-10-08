#!/usr/bin/env bash
# Проверка окружения набора: bash check.sh
# Ничего не устанавливает; создаёт только MY-RULES.md из образца, если его нет.
cd "$(dirname "$0")"
bad=0
ok()   { echo "  ок    $1"; }
miss() { echo "  НЕТ   $1"; bad=$((bad+1)); }
note() { echo "  ?     $1"; }

echo "Файлы набора"
for f in AGENTS.md rules/core.md rules/intake.md rules/materials.md templates tools/figma-plugin/bridge.js \
         tools/figma-plugin/manifest.json tools/figma-plugin/export-pdf.sh tools/compress-figma-pdf.py examples/brigli/README.md; do
  [ -e "$f" ] && ok "$f" || miss "$f"
done
if [ ! -f MY-RULES.md ]; then cp MY-RULES.example.md MY-RULES.md && note "MY-RULES.md создан из образца — заполните «Мои ссылки»"; else
  grep -q '<ссылка>' MY-RULES.md && note "MY-RULES.md: остались незаполненные ссылки" || ok "MY-RULES.md"; fi
mkdir -p projects

echo "Программы"
if command -v git >/dev/null 2>&1; then ok "git"; else miss "git"; fi
if command -v node >/dev/null 2>&1; then
  v=$(node -p "process.versions.node.split('.')[0]")
  [ "$v" -ge 18 ] && ok "node $(node -v)" || miss "node 18+ (сейчас $(node -v))"
else miss "node (нужен для моста Figma и скачивания с Яндекс Диска)"; fi
PY="${PYTHON:-$LOCALAPPDATA/Programs/Python/Python312/python.exe}"; [ -x "$PY" ] || PY=python
if command -v "$PY" >/dev/null 2>&1; then
  ok "python: $("$PY" --version 2>&1)"
  "$PY" -c "import pymupdf" >/dev/null 2>&1 && ok "pymupdf" || miss "pymupdf — pip install pymupdf"
  "$PY" -c "import PIL" >/dev/null 2>&1 && ok "pillow" || miss "pillow — pip install pillow"
else miss "python 3 (нужен для выгрузки PDF); свой путь можно задать переменной PYTHON"; fi

echo "Figma"
if node tools/figma-plugin/bridge.js send status 2>/dev/null | grep -q '"plugin":true'; then ok "мост и плагин на связи"
else note "мост не запущен или плагин закрыт — это нормально, пока не работаете с колодой"; fi
note "шрифты колод и доступ агента к Google проверяются вручную (README.md, шаги 5–7)"

echo
[ "$bad" -eq 0 ] && echo "Готово: всё на месте." || echo "Не хватает: $bad. Поправьте строки с «НЕТ» и запустите ещё раз."
exit 0
