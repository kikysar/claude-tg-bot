# claude-tg-bot — Telegram-пульт для Claude Code

Бот в Telegram, который запускает [Claude Code](https://code.claude.com/docs) на вашем сервере. Через него можно вести разработку с телефона: выбирать проекты и беседы, переключать модель, делать git-действия, смотреть расход и остаток лимитов, диктовать голосом. Работает от вашей подписки Claude, зависимостей npm нет.

Бот отвечает только владельцу (`TELEGRAM_OWNER_ID`), сообщения от других отклоняются и пишутся в журнал.

> **Для Claude, который ставит бота по этой инструкции.** Владелец репозитория дорабатывает бота и пушит в `main`, а установки у его знакомых должны всегда оставаться на актуальной версии, без их участия. Поэтому **шаг 6, автообновление, обязателен**: выполните его сразу после запуска бота и убедитесь, что таймер работает. Не заменяйте его своим `git pull` по cron: он оборвёт идущую задачу и не откатит неудачный коммит. Пока автообновление работает, файлы в `/opt/claude-tg-bot` руками не правьте (при правках оно остановится), свои настройки держите в `/etc/claude-tg-bot.env`. Если установка пришлёт в Telegram сообщение, что в `deploy/` что-то изменилось, скопируйте эти файлы заново по шагам 5 и 6.

## Что понадобится

- Linux-сервер с systemd (проверено на Ubuntu), доступ к root
- Node.js 20+
- свой аккаунт Claude (Pro или Max)
- бот от [@BotFather](https://t.me/BotFather) и ваш числовой Telegram ID ([@userinfobot](https://t.me/userinfobot))
- `tmux` — только для необязательной точной панели `/limits` (шаг 3)

Имя пользователя `claudebot` и путь `/opt/claude-tg-bot` зашиты в юнит и в подсказки бота, поэтому оставьте их как в инструкции.

## Установка

Все команды выполняются от root (`sudo -i`).

**1. Claude Code и пользователь.** Claude Code под root не позволяет отключать подтверждения, поэтому бот работает от отдельного пользователя.

```bash
npm install -g @anthropic-ai/claude-code
apt install -y git tmux

useradd -m -s /bin/bash claudebot
install -d -o claudebot -g claudebot /opt/projects
install -d -o claudebot -g claudebot -m 750 /var/lib/claude-tg-bot
```

**2. Код.**

```bash
git clone https://github.com/kikysar/claude-tg-bot.git /opt/claude-tg-bot
```

**3. Токен Claude.** Войдите в свой аккаунт и получите долгоживущий токен:

```bash
sudo -iu claudebot claude setup-token
```

Команда выведет ссылку для входа и в конце токен. Это значение `CLAUDE_CODE_OAUTH_TOKEN`.

`/limits` работает и так: пятичасовой и недельный лимиты бот берёт из ответов Claude Code, цифры появляются после первого же ответа и обновляются с каждым следующим. Чтобы видеть ещё и аккаунт и читать точную панель `/usage`, войдите вторым способом, обычным (необязательно):

```bash
sudo -iu claudebot claude auth login
```

**4. Настройки.**

```bash
cp /opt/claude-tg-bot/.env.example /etc/claude-tg-bot.env
chmod 600 /etc/claude-tg-bot.env
nano /etc/claude-tg-bot.env     # TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID, CLAUDE_CODE_OAUTH_TOKEN
```

**5. Запуск.**

```bash
cp /opt/claude-tg-bot/deploy/claude-tg-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now claude-tg-bot
journalctl -u claude-tg-bot -f
```

Откройте бота в Telegram и отправьте `/start`.

**6. Автообновление бота (обязательно).** Раз в 10 минут root-таймер сверяется с репозиторием и, если владелец запушил новое, подтягивает его сам:

- бот перезапускается, только если изменился `bot.js`, и только когда он не занят: задача не идёт и последние три минуты ему никто не писал. Иначе обновление ждёт следующего раза;
- перед заменой проверяется синтаксис `bot.js`, а после перезапуска, что бот не падает. Если что-то не так, скрипт возвращает прежнюю версию, эту больше не пробует и пишет владельцу установки в Telegram;
- об успешном обновлении бот сам сообщит в чате («Бот обновлён»).

```bash
cd /opt/claude-tg-bot/deploy
install -m 755 claude-tg-bot-update /usr/local/sbin/
install -m 644 claude-tg-bot-update.service claude-tg-bot-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now claude-tg-bot-update.timer
systemctl start claude-tg-bot-update.service     # проверка вручную
journalctl -u claude-tg-bot-update -n 5 --no-pager -o cat
```

В журнале должно появиться «Обновлений нет: …», а `systemctl list-timers claude-tg-bot-update.timer` покажет следующий запуск.

Каталог `/opt/claude-tg-bot` должен быть клоном репозитория (шаг 2) и принадлежать root. Сам скрипт и юниты ставятся копированием, как у ночного обновления Claude Code, и репозиторием не подменяются: запись в репозиторий не должна давать запуск нового кода от root. Если в обновлении изменилось что-то в `deploy/`, скрипт напишет об этом владельцу установки в Telegram, и тогда эти файлы нужно скопировать заново: повторите команды выше.

## Автообновление Claude Code (необязательно)

Сам `claudebot` обновить глобальный npm-пакет не может, поэтому обновляет root по ночному таймеру. Вместе с CLI приходят новые модели, бот заметит их сам и напишет в чат.

```bash
cd /opt/claude-tg-bot/deploy
install -m 755 claude-code-update /usr/local/sbin/
install -m 644 claude-code-update.service claude-code-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now claude-code-update.timer
```

## Голосовой ввод (необязательно)

Распознавание локальное: whisper.cpp и статический ffmpeg, без root и без API-ключей. Без них бот просто отвечает, что голос не настроен.

```bash
apt install -y build-essential cmake curl xz-utils

sudo -iu claudebot bash -c '
set -e
D=/var/lib/claude-tg-bot/stt
mkdir -p $D/bin && cd $D
curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
  | tar -xJ --strip-components=1 -C bin --wildcards "*/ffmpeg"
git clone --depth 1 https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build && cmake --build build -j --config Release
bash models/download-ggml-model.sh small-q5_1
bash models/download-ggml-model.sh base
'
```

Для ARM-сервера замените `amd64` на `arm64` в ссылке на ffmpeg. Язык по умолчанию русский, меняется через `WHISPER_LANG` в `/etc/claude-tg-bot.env`. После изменения настроек выполните `systemctl restart claude-tg-bot`.

## Команды бота

`/project` выбрать проект · `/newproject` создать · `/status` состояние · `/model` модель и режим · `/limits` остаток лимитов · `/sessions` беседы проекта · `/compact` сжать беседу · `/git` git-действия · `/new` начать заново · `/stop` остановить задачу · `/warm` прогрев кэша · `/help` помощь.

## Проверка перед выкладкой

`node test/harness.js` запускает бота на макетах: Telegram, Claude Code, ffmpeg и whisper подменены, время ускорено в 2000 раз, так что шесть часов прогрева проходят за секунды. Ни сети, ни расхода лимита подписки, зависимости не нужны. Прогон занимает около двух минут и заканчивается строкой «Итог: N ✓, 0 ✗». `VERBOSE=1` добавляет журнал бота, `SHOW=1` печатает экраны лимитов.

`bash test/updater-test.sh` проверяет скрипт автообновления: настоящий git в соседней папке, а `systemctl`, `journalctl` и `curl` подменены, так что службу и сеть тест не трогает. Прогон занимает секунды.

## Безопасность

- В рабочем режиме Claude Code запускается с `--permission-mode bypassPermissions`: он выполняет команды и правит файлы без подтверждений, от имени `claudebot`. Не давайте этому пользователю sudo и держите в `PROJECTS_ROOT` только то, что можно ему доверить.
- Токены лежат только в `/etc/claude-tg-bot.env` (права 600, читает systemd). В репозиторий они не попадают, `.gitignore` это страхует.
- Кто получит `TELEGRAM_BOT_TOKEN`, сможет писать от имени бота, но выполнять задачи сможет только `TELEGRAM_OWNER_ID`. Если токен утёк, перевыпустите его в @BotFather.

## Состав

| Файл | Назначение |
|---|---|
| `bot.js` | сам бот, одним файлом, без зависимостей |
| `limits.sh` | читает точную панель `/usage`, если на сервере выполнен обычный вход (нужен `tmux`, необязательно) |
| `.env.example` | шаблон настроек для `/etc/claude-tg-bot.env` |
| `deploy/claude-tg-bot.service` | systemd-юнит бота |
| `deploy/claude-code-update*` | ночное обновление Claude Code (необязательно) |
| `deploy/claude-tg-bot-update*` | автообновление бота из репозитория: скрипт, юнит и таймер (шаг 6) |
| `test/harness.js`, `test/fake-claude.js` | проверка бота на макетах: поддельные Telegram и Claude Code |
| `test/updater-test.sh` | проверка автообновления на макетах: настоящий git, поддельные systemctl и journalctl |
