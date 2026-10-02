#!/bin/bash
# Проверка автообновления (deploy/claude-tg-bot-update) на макетах: настоящий git
# с «GitHub» в соседней папке, а systemctl, journalctl и curl подменены, так что
# живую службу и сеть тест не трогает. Запуск из корня репозитория:
#   bash test/updater-test.sh
set -u
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
ok=0; bad=0

check() {   # имя, затем команда: проходит, если она вернула 0
  local name=$1; shift
  if "$@"; then ok=$((ok + 1)); echo "  ✓ $name"
  else bad=$((bad + 1)); echo "  ✗ $name"; fi
}
not() { ! "$@"; }

# ── подмены ──
mkdir -p "$T/bin" "$T/state"
cat > "$T/bin/systemctl" <<'EOF'
#!/bin/bash
echo "systemctl $*" >> "$FAKE_DIR/calls"
case "$1" in
  is-active) [ "$(cat "$FAKE_DIR/active" 2>/dev/null || echo 1)" = 1 ]; exit $? ;;
  show)   # NRestarts: ровное число, а при «crashy» растёт с каждым вопросом, как у службы, что падает в цикле
    if [ -f "$FAKE_DIR/crashy" ]; then n=$(( $(cat "$FAKE_DIR/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_DIR/n"; echo "$n"
    else cat "$FAKE_DIR/nrestarts" 2>/dev/null || echo 0; fi ;;
esac
exit 0
EOF
cat > "$T/bin/journalctl" <<'EOF'
#!/bin/bash
cat "$FAKE_DIR/journal" 2>/dev/null
exit 0
EOF
cat > "$T/bin/curl" <<'EOF'
#!/bin/bash
cat > "$FAKE_DIR/curl-stdin"
echo "$*" >> "$FAKE_DIR/notify"
exit 0
EOF
command -v flock >/dev/null 2>&1 || printf '#!/bin/bash\nexit 0\n' > "$T/bin/flock"
chmod +x "$T/bin/"*
printf 'TELEGRAM_BOT_TOKEN=123:TEST\nTELEGRAM_OWNER_ID=42\nCLAUDE_CODE_OAUTH_TOKEN=не-читать\n' > "$T/env"

# ── репозиторий: «GitHub», рабочая копия владельца и установка друга ──
git init -q --bare "$T/origin.git"
git -C "$T/origin.git" symbolic-ref HEAD refs/heads/main
git clone -q -c core.autocrlf=false "$T/origin.git" "$T/work" 2>/dev/null
cd "$T/work" || exit 1
git config user.email t@example.com; git config user.name tester
mkdir -p deploy
cp "$SRC/bot.js" "$SRC/limits.sh" .
cp "$SRC/deploy/claude-tg-bot-update" deploy/
echo "# v1" > README.md
git add -A; git commit -qm "v1"; git branch -M main; git push -q origin main 2>/dev/null
git clone -q -c core.autocrlf=false -b main "$T/origin.git" "$T/inst" 2>/dev/null
git -C "$T/inst" config user.email t@example.com; git -C "$T/inst" config user.name tester
cd "$SRC" || exit 1

# скрипт запускается, как в жизни, из /usr/local/sbin, а не из клона
mkdir -p "$T/sbin"
cp "$SRC/deploy/claude-tg-bot-update" "$T/sbin/"

# ── помощники ──
reset() { : > "$T/calls"; : > "$T/notify"; rm -f "$T/active" "$T/crashy" "$T/n" "$T/nrestarts"; }
run() {   # запуск скрипта в песочнице; вывод в $T/out, код в $rc
  PATH="$T/bin:$PATH" FAKE_DIR="$T" BOT_REPO="${REPO_UNDER_TEST:-$T/inst}" BOT_SERVICE=updater-test-service \
    BOT_UPDATE_STATE="$T/state" BOT_ENV_FILE="$T/env" BOT_SETTLE_S=0 BOT_QUIET_S=180 \
    bash "$T/sbin/claude-tg-bot-update" > "$T/out" 2>&1
  rc=$?
}
push() {   # файл, строка, сообщение коммита: правка владельца репозитория
  ( cd "$T/work" && printf '%s\n' "$2" >> "$1" && git add -A && git commit -qm "$3" && git push -q origin main 2>/dev/null )
}
said() { grep -qF -- "$1" "$T/out"; }
nrestart() { grep -c '^systemctl restart' "$T/calls"; }
head_of() { git -C "$1" rev-parse HEAD; }
synced() { [ "$(head_of "$T/inst")" = "$(git -C "$T/origin.git" rev-parse main)" ]; }
stamp() { date -u -d "@$(( $(date +%s) - $1 ))" +%Y-%m-%dT%H:%M:%S.000Z; }
journal() { printf '[%s] [INFO] %s {}\n' "$(stamp "$2")" "$1" > "$T/journal"; }   # событие, сколько секунд назад

echo "1. Новых коммитов нет"
reset; run
check "выход без ошибки" test "$rc" = 0
check "сказал, что обновлений нет" said "Обновлений нет"
check "службу не трогал" test "$(nrestart)" = 0

echo "2. Правка README: бот не перезапускается"
reset; push README.md "# v2" "правка README"; run
check "обновление подтянуто" synced
check "перезапуска нет" test "$(nrestart)" = 0
check "сказал, что перезапуск не нужен" said "перезапуск не нужен"
check "владельцу установки не пишет" test ! -s "$T/notify"

echo "3. Правка bot.js, но бот занят"
reset; push bot.js "// v3" "правка bot.js"
journal "Запуск задачи" 600; run
check "идёт задача: обновление отложено" said "отложено"
check "идёт задача: файлы не тронуты" not synced
journal "Задача выполнена" 30; run
check "свежая активность тоже откладывает" said "отложено"
journal "Сообщение" 30; run
check "свежее сообщение тоже откладывает" said "отложено"
check "перезапусков не было" test "$(nrestart)" = 0

echo "4. Бот тихий: обновление ставится"
reset; journal "Задача выполнена" 3600; run
check "подтянуто" synced
check "бот перезапущен один раз" test "$(nrestart)" = 1
check "сказал про перезапуск" said "Бот перезапущен"
check "об успехе в Telegram не пишет" test ! -s "$T/notify"

echo "5. Сломанный bot.js не ставится"
reset; before=$(head_of "$T/inst")
push bot.js "this is ((( not javascript" "поломка"; run
check "выход с ошибкой" test "$rc" = 1
check "осталась прежняя версия" test "$(head_of "$T/inst")" = "$before"
check "перезапуска нет" test "$(nrestart)" = 0
check "владельцу установки написано" test -s "$T/notify"
check "токен не в списке процессов" not grep -q '123:TEST' "$T/notify"
check "токен ушёл через stdin" grep -q '123:TEST' "$T/curl-stdin"
reset; run
check "эту версию повторно не пробует" said "уже не запускалась"
check "и повторно не жалуется" test ! -s "$T/notify"

echo "6. Исправление после поломки"
reset; ( cd "$T/work" && git revert --no-edit HEAD >/dev/null && git push -q origin main 2>/dev/null ); run
check "откат поломки подтянут" synced
check "содержимое прежнее: перезапуск не нужен" test "$(nrestart)" = 0
reset; push bot.js "// v6" "новая правка"; run
check "следующая версия подтянута" synced
check "бот перезапущен" test "$(nrestart)" = 1

echo "7. Бот после обновления падает: откат"
reset; before=$(head_of "$T/inst")
push bot.js "// v7" "версия, которая не стартует"; echo 0 > "$T/active"; run
check "выход с ошибкой" test "$rc" = 1
check "вернулась прежняя версия" test "$(head_of "$T/inst")" = "$before"
check "перезапуск и откат: два раза" test "$(nrestart)" = 2
check "владельцу установки написано" test -s "$T/notify"
reset; run
check "плохую версию больше не пробует" said "уже не запускалась"
check "перезапусков нет" test "$(nrestart)" = 0

echo "7б. Бот держится, хотя systemd перезапускал его и раньше: ложного отката нет"
reset; echo 5 > "$T/nrestarts"
push bot.js "// v7b" "обновление"; run
check "выход без ошибки" test "$rc" = 0
check "подтянуто" synced
check "бот перезапущен один раз" test "$(nrestart)" = 1
check "владельцу установки не пишет" test ! -s "$T/notify"

echo "7в. Бот «жив», но systemd перезапускает его снова и снова: откат"
reset; before=$(head_of "$T/inst"); touch "$T/crashy"
push bot.js "// v7c" "версия, которая падает в цикле"; run
check "выход с ошибкой" test "$rc" = 1
check "вернулась прежняя версия" test "$(head_of "$T/inst")" = "$before"
check "перезапуск и откат: два раза" test "$(nrestart)" = 2
check "владельцу установки написано" test -s "$T/notify"

echo "8. Правки руками останавливают обновление"
reset; echo "// моя правка" >> "$T/inst/bot.js"
push bot.js "// v8" "обновление"; run
check "выход с ошибкой" test "$rc" = 1
check "правка владельца установки цела" grep -q "моя правка" "$T/inst/bot.js"
check "перезапуска нет" test "$(nrestart)" = 0
check "владельцу установки написано" test -s "$T/notify"
git -C "$T/inst" checkout -q -- bot.js

echo "9. История переписана (force push): установка следует за ней"
reset; run                                  # v8 встаёт как обычное обновление
check "v8 подтянут" synced
reset
( cd "$T/work" && git reset -q --hard HEAD~1 && echo "// переписано" >> bot.js && git commit -qam "переписанная история" && git push -q -f origin main 2>/dev/null )
run
check "установка совпадает с репозиторием" synced
check "бот перезапущен" test "$(nrestart)" = 1

echo "10. GitHub недоступен"
reset; mv "$T/origin.git" "$T/origin.away"; run
check "выход без ошибки" test "$rc" = 0
check "сказал, что GitHub не ответил" said "GitHub не ответил"
check "перезапуска нет" test "$(nrestart)" = 0
mv "$T/origin.away" "$T/origin.git"

echo "11. Изменились файлы в deploy/: скрипт обновления репозиторием не подменяется"
reset; push deploy/claude-tg-bot-update "# новая версия скрипта" "обновление скрипта"; run
check "выход без ошибки" test "$rc" = 0
check "подтянуто" synced
check "бот не перезапускался" test "$(nrestart)" = 0
check "установленный скрипт не тронут" cmp -s "$SRC/deploy/claude-tg-bot-update" "$T/sbin/claude-tg-bot-update"
check "в журнале предупреждение про deploy/" said "изменились файлы в deploy/"
check "владельцу установки написано, что файлы нужно поставить заново" grep -q 'файлы в deploy/' "$T/notify"

echo "12. Каталог не клон репозитория"
reset; mkdir -p "$T/plain"; REPO_UNDER_TEST="$T/plain" run
check "выход с ошибкой" test "$rc" = 1
check "сказал, что это не клон" said "не клон"
check "владельцу установки написано" test -s "$T/notify"

echo "13. Журнальные строки, по которым скрипт судит о занятости, есть в bot.js"
pat=$(sed -n "s/.*grep -E '\(Запуск задачи[^']*\)'.*/\1/p" "$SRC/deploy/claude-tg-bot-update")
check "в скрипте нашёлся список строк" test -n "$pat"
while IFS= read -r alt; do
  [ -n "$alt" ] || continue
  needle=$alt
  case $alt in '\] '*) alt=${alt#'\] '}; needle="log('INFO', '$alt'" ;; esac
  check "bot.js пишет «$alt»" grep -qF -- "$needle" "$SRC/bot.js"
done < <(printf '%s\n' "$pat" | tr '|' '\n')

echo
echo "Итог: $ok ✓, $bad ✗"
[ "$bad" = 0 ]
