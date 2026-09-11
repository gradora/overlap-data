#!/usr/bin/env bash
# Вход контейнера крон-джоба Railway. Порядок: git identity → deploy-ключи →
# мелкий клон приватного репо → node_modules из образа → exec оркестратора.
#
# Почему клон на каждом прогоне, а не код в образе — см. шапку Dockerfile.
#
# НЕ включать set -x: в окружении на старте лежат приватные deploy-ключи,
# трассировка утащила бы их в лог Railway.
set -euo pipefail

# Конвенция запуска: tsx src/orchestrator.ts <группа> [--push]. Группа — первый
# НЕ-флаговый аргумент; флаги уходят оркестратору как есть. Так эквивалентны
# `entrypoint.sh snapshot --push` и `GROUP=snapshot entrypoint.sh --push`:
# у Railway удобнее start command с аргументом, в docker run — как угодно.
if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
  GROUP="$1"
  shift
else
  GROUP="${GROUP:-}"
fi
if [ -z "$GROUP" ]; then
  echo "не задана группа: аргументом (entrypoint.sh snapshot --push) или переменной GROUP" >&2
  exit 2
fi

# Оба пути с дефолтами боя: переопределяются только в локальной репетиции
# (§8 docs/railway.md), где нет ни /work, ни /opt/deps, а HOME подменяется на
# временный — иначе скрипт переписал бы ~/.ssh/config машины разработчика.
WORK_DIR="${WORK_DIR:-/work}"
DEPS_DIR="${DEPS_DIR:-/opt/deps}"
REPO_DIR="$WORK_DIR/repo"
mkdir -p "$WORK_DIR"

# ФАКТ ПЛАТФОРМЫ (проверено 11.09 на живом сервисе): Railway по расписанию
# ПЕРЕЗАПУСКАЕТ ТОТ ЖЕ контейнер, а не поднимает чистый. Файловая система
# переживает прогон, поэтому всё, что ниже пишется «с нуля», обязано быть
# идемпотентным: второй тик иначе падает на `destination path '/work/repo'
# already exists`, а ~/.ssh/config и safe.directory тихо растут дублями.

# Наложение тиков: в GitHub Actions сериализацию давала concurrency-группа, на
# Railway её нет, а общая ФС делает пересечение прогонов разрушительным (чистка
# REPO_DIR снесла бы репозиторий из-под работающего продьюсера). Лок снимается
# ядром при любом завершении процесса, в том числе по kill.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$WORK_DIR/.lock-$GROUP"
  if ! flock -n 9; then
    echo "прогон группы ${GROUP} ещё идёт — тик пропущен"
    exit 0
  fi
else
  echo "flock недоступен — защиты от наложения тиков нет" >&2
fi

# Клон всегда в чистый каталог: хвост прошлого прогона — не кэш, а мина
# (оркестратор считает состояние по git-статусу свежего клона).
rm -rf "$REPO_DIR"

# Identity коммитов — из env: образ общий на все сервисы и ничего командного
# не содержит. Дефолты повторяют commit-push из .github/actions.
git config --global user.name  "${GIT_USER_NAME:-overlap-bot}"
git config --global user.email "${GIT_USER_EMAIL:-overlap-bot@users.noreply.github.com}"

# Контейнер однопользовательский — проверка dubious ownership git здесь только
# мешает (dry-run клонирует из примонтированного хост-репо, чей uid не совпадает
# с root контейнера). --replace-all, а не --add: конфиг переживает рестарт
# контейнера, и --add копил бы по строке на каждый тик.
git config --global --replace-all safe.directory '*'

# PEM в переменной окружения — главный источник боли этой связки: общие
# переменные Railway правятся ОДНОСТРОЧНЫМ полем, переносы схлопываются в
# пробелы, и openssh падает «error in libcrypto» (а ssh молча идёт без ключа и
# ловит Permission denied — диагноз по логу неочевиден). Поэтому ключ
# принимается в трёх видах: готовым PEM, в base64 (рекомендуется — такое
# значение ни один UI не испортит) и однострочным PEM, который восстанавливаем.
# Ничего из содержимого ключа в лог не попадает — только имя переменной.
decode_key() {
  local raw="$1" head tail body
  # Перенос строки переменной, а не $(printf '\n'): подстановка команды срезает
  # завершающие переносы и вернула бы пустую строку — проверка ниже стала бы
  # истинной всегда, и испорченный PEM уехал бы в файл нетронутым.
  local nl='
'
  # Нет заголовка PEM — считаем, что это base64 от файла ключа.
  if [ "${raw#*-----BEGIN}" = "$raw" ]; then
    printf '%s' "$raw" | tr -d ' \t\n\r' | base64 -d 2>/dev/null
    return
  fi
  # Заголовок есть и перенос есть — значение доехало целым; \r снимаем, потому
  # что PEM с CRLF openssh тоже не читает («invalid format»).
  case "$raw" in
    *"$nl"*) printf '%s\n' "$raw" | tr -d '\r'; return ;;
  esac
  # Однострочный PEM: заголовок и футер фиксированы, тело режем обратно по 70.
  head=$(printf '%s' "$raw" | sed -n 's/^.*\(-----BEGIN [A-Z0-9 ]*-----\).*$/\1/p')
  tail=$(printf '%s' "$raw" | sed -n 's/^.*\(-----END [A-Z0-9 ]*-----\).*$/\1/p')
  [ -n "$head" ] && [ -n "$tail" ] || return 1
  body=${raw#*"$head"}
  body=${body%"$tail"*}
  # Через переменную, а не конвейером прямо в вывод: fold не ставит перенос
  # после последней строки, и футер приклеивался бы к хвосту тела.
  body=$(printf '%s' "$body" | tr -d ' \t\r\n' | fold -w 70)
  printf '%s\n%s\n%s\n' "$head" "$body" "$tail"
}

# Два репозитория — два deploy-ключа — два SSH-алиаса одного github.com:
# GitHub не позволяет повесить один ключ на два репо, а ssh сам не умеет
# выбрать ключ по имени репозитория в URL.
# ~/.ssh/config собирается заново каждый прогон: файл переживает рестарт
# контейнера, и дописывание через >> копило бы дубли Host-блоков до бесконечности.
mkdir -p ~/.ssh && chmod 700 ~/.ssh
: > ~/.ssh/config
chmod 600 ~/.ssh/config

setup_key() {
  local alias="$1" key="$2" file="$3" var="$4"
  [ -n "$key" ] || return 0
  decode_key "$key" > ~/.ssh/"$file" || true
  chmod 600 ~/.ssh/"$file"
  # Валидация здесь, а не «когда-нибудь у git»: иначе прогон умирает в
  # Permission denied, и час уходит на поиски прав вместо испорченного PEM.
  if ! ssh-keygen -y -f ~/.ssh/"$file" >/dev/null 2>&1; then
    echo "переменная ${var} не читается как приватный ключ (испорченный PEM?): положи в неё вывод \`base64 < файл-ключа | tr -d '\\n'\`" >&2
    exit 2
  fi
  {
    echo "Host $alias"
    echo "  HostName github.com"
    echo "  User git"
    echo "  IdentityFile ~/.ssh/$file"
    echo "  IdentitiesOnly yes"
  } >> ~/.ssh/config
  chmod 600 ~/.ssh/config
}
setup_key github-private "${PRIVATE_REPO_SSH_KEY:-}" id_private PRIVATE_REPO_SSH_KEY
setup_key github-serve   "${SERVE_REPO_SSH_KEY:-}"   id_serve   SERVE_REPO_SSH_KEY
# Ключи легли в файлы — из окружения убираем: оркестратору и его дочерним
# процессам секреты не нужны, а меньше носителей — меньше путей утечки в лог.
unset PRIVATE_REPO_SSH_KEY SERVE_REPO_SSH_KEY 2>/dev/null || true

# CLONE_URL напрямую задаётся только в локальном dry-run (file:///work/host);
# в бою URL собирается из PRIVATE_REPO=owner/name через ssh-алиас.
if [ -z "${CLONE_URL:-}" ]; then
  if [ -z "${PRIVATE_REPO:-}" ]; then
    echo "не задан источник кода: PRIVATE_REPO (owner/name) или CLONE_URL" >&2
    exit 2
  fi
  CLONE_URL="git@github-private:${PRIVATE_REPO}.git"
fi

# Куда пушить витрину — контракт с оркестратором: он берёт готовый ssh-URL из
# SERVE_REPO_URL при --push. URL собирается здесь, потому что алиас
# github-serve — деталь этого контейнера, оркестратор про неё знать не должен.
if [ -n "${SERVE_REPO:-}" ] && [ -z "${SERVE_REPO_URL:-}" ]; then
  export SERVE_REPO_URL="git@github-serve:${SERVE_REPO}.git"
fi

# --depth 1: продьюсерам история не нужна, а полный клон с годами данных —
# лишние секунды и трафик на каждом 15-минутном прогоне. Rebase-retry пуша
# поверх мелкого клона работает: fetch дотягивает новые коммиты до имеющейся
# верхушки, и merge-base для rebase есть (пока никто не делает force-push).
echo "прогон группы ${GROUP}: клон ${CLONE_URL} (${CLONE_BRANCH:-main})"
git clone --quiet --depth 1 --single-branch --branch "${CLONE_BRANCH:-main}" \
  "$CLONE_URL" "$REPO_DIR"
cd "$REPO_DIR"

# node_modules из образа подключаются симлинком ТОЛЬКО пока lock-файл клона
# байт-в-байт совпадает с запечённым: иначе прогон молча работал бы на чужих
# версиях зависимостей. Разошлись — ставим на месте (медленно, но корректно)
# и кричим в лог: это сигнал пересобрать образ, а не норма жизни.
if cmp -s package-lock.json "$DEPS_DIR/package-lock.json"; then
  ln -s "$DEPS_DIR/node_modules" node_modules
else
  echo "package-lock.json разошёлся с запечённым в образ — npm ci на этом прогоне; пересобери образ (deploy/railway/Dockerfile)" >&2
  npm ci --no-audit --no-fund
fi

# exec: оркестратор становится главным процессом контейнера, его exit-код —
# вердикт прогона для Railway (замена «гейт валит job» из GitHub Actions).
# Путь до tsx явный, чтобы npx не пошёл в сеть, если бинаря вдруг нет.
exec ./node_modules/.bin/tsx src/orchestrator.ts "$GROUP" "$@"
