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

REPO_DIR=/work/repo

# Identity коммитов — из env: образ общий на все сервисы и ничего командного
# не содержит. Дефолты повторяют commit-push из .github/actions.
git config --global user.name  "${GIT_USER_NAME:-overlap-bot}"
git config --global user.email "${GIT_USER_EMAIL:-overlap-bot@users.noreply.github.com}"

# Контейнер одноразовый и однопользовательский — проверка dubious ownership
# git здесь только мешает (dry-run клонирует из примонтированного хост-репо,
# чей uid не совпадает с root контейнера).
git config --global --add safe.directory '*'

# Два репозитория — два deploy-ключа — два SSH-алиаса одного github.com:
# GitHub не позволяет повесить один ключ на два репо, а ssh сам не умеет
# выбрать ключ по имени репозитория в URL.
setup_key() {
  local alias="$1" key="$2" file="$3"
  [ -n "$key" ] || return 0
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  printf '%s\n' "$key" > ~/.ssh/"$file"
  chmod 600 ~/.ssh/"$file"
  {
    echo "Host $alias"
    echo "  HostName github.com"
    echo "  User git"
    echo "  IdentityFile ~/.ssh/$file"
    echo "  IdentitiesOnly yes"
  } >> ~/.ssh/config
  chmod 600 ~/.ssh/config
}
setup_key github-private "${PRIVATE_REPO_SSH_KEY:-}" id_private
setup_key github-serve   "${SERVE_REPO_SSH_KEY:-}"   id_serve
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
if cmp -s package-lock.json /opt/deps/package-lock.json; then
  ln -s /opt/deps/node_modules node_modules
else
  echo "package-lock.json разошёлся с запечённым в образ — npm ci на этом прогоне; пересобери образ (deploy/railway/Dockerfile)" >&2
  npm ci --no-audit --no-fund
fi

# exec: оркестратор становится главным процессом контейнера, его exit-код —
# вердикт прогона для Railway (замена «гейт валит job» из GitHub Actions).
# Путь до tsx явный, чтобы npx не пошёл в сеть, если бинаря вдруг нет.
exec ./node_modules/.bin/tsx src/orchestrator.ts "$GROUP" "$@"
