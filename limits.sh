#!/bin/bash
# Читает панель /usage из интерактивной сессии Claude Code — единственное место,
# где CLI показывает остаток лимитов подписки (подкоманды usage у него нет,
# `claude -p /usage` отдаёт только расход текущей сессии, а /api/oauth/usage
# токену бота закрыт — у него нет права user:profile).
#
# Интерактивный режим игнорирует CLAUDE_CODE_OAUTH_TOKEN и требует сохранённого
# входа (claude auth login), поэтому переменную снимаем.
#
# Замер показал: панель готова за ~3,4 с. Поэтому никаких пауз «на всякий
# случай» — только частый опрос экрана и выход сразу по готовности.

set +e
unset CLAUDE_CODE_OAUTH_TOKEN

PROBE=/var/lib/claude-tg-bot/probe
S="usage-$$"
mkdir -p "$PROBE" 2>/dev/null

snap() { tmux capture-pane -p -J -t "$S" 2>/dev/null; }
cleanup() { tmux kill-session -t "$S" 2>/dev/null; }
trap cleanup EXIT

# 0. Бот одновременно зовёт `claude auth status`. Если срок ключа истёк, оба
#    процесса продлевали его одним ключом обновления, сервер отказывал второму,
#    и CLI стирал сохранённый вход (01.10.2026). Ждём auth status (максимум 15 с).
sleep 0.3
for _ in $(seq 1 50); do
  pgrep -u "$(id -u)" -f 'claude auth status' >/dev/null || break
  sleep 0.3
done

tmux kill-session -t "$S" 2>/dev/null
tmux new-session -d -s "$S" -x 210 -y 55 "cd '$PROBE'; claude"

# 1. Ждём готовности ввода (максимум 30 с). С 2.1.285 приветствия нет —
#    готовность видна по нижней строке (shift+tab, /effort). Без входа
#    в шапке «API Usage Billing» вместо названия подписки.
ready=0
for _ in $(seq 1 100); do
  s=$(snap)
  case "$s" in
    *"Select login method"*|*"Not logged in"*|*"API Usage Billing"*)
      echo "__НУЖЕН_ВХОД__ Select login method"; exit 2 ;;
    *"trust this folder"*)
      tmux send-keys -t "$S" Enter ;;
    *shortcuts*|*'Try "'*|*"Welcome back"*|*"shift+tab"*|*"/effort"*)
      ready=1; break ;;
  esac
  sleep 0.3
done
[ "$ready" = 1 ] || { echo "__НЕ_ДОЖДАЛСЯ_ЗАПУСКА__"; snap | grep -v '^[[:space:]]*$' | tail -15; exit 1; }

# Надпись о входе дорисовывается чуть позже нижней строки — смотрим ещё раз.
# Без входа /usage показывает только «Total cost», без лимитов.
sleep 0.5
case "$(snap)" in
  *"Not logged in"*|*"API Usage Billing"*) echo "__НУЖЕН_ВХОД__ Select login method"; exit 2 ;;
esac

# 2. Запрашиваем панель
tmux send-keys -t "$S" -l '/usage'
sleep 0.2
tmux send-keys -t "$S" Enter

# 3. Ждём появления процентов (максимум 20 с)
for _ in $(seq 1 66); do
  snap | grep -q '% used' && break
  sleep 0.3
done

# 4. Ждём, пока картинка перестанет меняться — панель дорисовывается частями
prev=''
for _ in $(seq 1 15); do
  cur=$(snap | grep -E '% used|Resets|Current')
  [ -n "$cur" ] && [ "$cur" = "$prev" ] && break
  prev="$cur"
  sleep 0.25
done

snap
