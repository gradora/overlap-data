# syntax=docker/dockerfile:1
# Образ крон-джоба Railway (фаза C). Главный принцип: КОДА И ДАННЫХ В ОБРАЗЕ НЕТ.
#
# Кроны пушат данные в приватный репо десятки раз в сутки — образ с кодом внутри
# пришлось бы либо пересобирать на каждый такой пуш, либо мириться с тем, что
# крон бежит на отставшем коде. Поэтому образ несёт только рантайм: node + git +
# запечённые node_modules + entrypoint. Свежий код контейнер забирает сам на
# каждом прогоне (git clone --depth 1 в entrypoint.sh). Следствия:
#   - деплой кода = обычный git push в приватный репо, без пересборки;
#   - пересборка образа нужна ровно в двух случаях: сменились зависимости
#     (package-lock.json) или сам entrypoint.sh;
#   - вход билда ограничен .dockerignore-белым-списком из четырёх файлов, поэтому
#     даже случайная авто-пересборка на пуш данных упрётся в кэш слоёв.
FROM node:20-slim

# git — клон приватного репо и пуши; openssh-client — транспорт deploy key;
# ca-certificates — https продьюсеров и git. В slim ничего из этого нет.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Хост-ключи github.com снимаются на билде, а не на прогоне: рантайм не должен
# делать trust-on-first-use каждые 15 минут. Ротация ключей GitHub уронит клон
# с внятной ошибкой в лог — лечится пересборкой образа.
RUN mkdir -p /etc/ssh && ssh-keyscan github.com >> /etc/ssh/ssh_known_hosts

# Замена actions/setup-node + `npm ci` на каждый прогон: зависимости запекаются
# слоем образа один раз. Entrypoint подключит их в клон симлинком, пока
# package-lock.json клона совпадает с этим, запечённым (иначе поставит на месте
# и потребует пересборки — см. entrypoint.sh).
#
# Осознанно БЕЗ --omit=dev: tsx и typescript живут в devDependencies, но tsx —
# рантайм-раннер всех продьюсеров, без него контейнеру нечем работать.
WORKDIR /opt/deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --chmod=755 deploy/railway/entrypoint.sh /entrypoint.sh

# Кривые креды должны валить прогон сразу, а не вешать его на интерактивном
# вопросе git, которого в кроне никто не увидит.
ENV GIT_TERMINAL_PROMPT=0
# Всё расписание и весь health-учёт живут в UTC (как жили на раннерах GitHub) —
# фиксируем, чтобы никакая настройка платформы это не перекосила.
ENV TZ=UTC

WORKDIR /work
# Группа и флаги приходят аргументами start command Railway (или переменной
# GROUP — см. entrypoint.sh): `/entrypoint.sh snapshot --push`.
ENTRYPOINT ["/entrypoint.sh"]
