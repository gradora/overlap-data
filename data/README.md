# data/ — конвенции

## Slug-контракт зеркала (НЕ «чинить»!)

Ключ зеркального файла = слаг upstream-относительного пути:
не-`[A-Za-z0-9.]` → одиночный `_`, крайние `_` отброшены
(`current/sprint.json?limit=100&offset=0` → `current_sprint.json_limit_100_offset_0`).
Поэтому в именах встречается `.json` посреди имени и «нет расширения» — это
НОРМА: слаг обязан побайтово совпадать с приложением
(`SnapshotMirror.slug`, Swift). Парные тесты: `src/mirror.test.ts` ↔
`OverlapTests/SnapshotMirrorTests.swift` — менять только вместе.

## Семейства

| Путь | Продьюсер | Формат имени |
|---|---|---|
| `f1/jolpica/` | f1 | слаг пути (+ `<сезон>_<раунд>_results.json` — слайсы) |
| `f1/openf1/` | openf1 | слаг пути (история 2023+ снята полностью) |
| `wec/fiawec/` | wec | слаг пути; HTML нормализован (без countdown/таймстампа) |
| `{f1,wec,imsa}/fia/` | fia / wecfia / imsafia | `<сезон>_<раунд>.json` |
| `{f1,wec,imsa}/winners/`, `highlights/` | *winners / *highlights | `<сезон>_<раунд>.json` |
| `f1/milestones/` | f1milestones | `<сезон>_<раунд>.json` |
| `f1/beasts/`, `f1/records/` | f1beasts / f1records | `<сезон>.json` |
| `f1/history/index.json` | f1history | синглтон |
| `imsa/<год>/` | imsa | `NN_<venue-slug>.json` + `index.json` + `points.json` |
| `wec/<год>/` | wec (внутри прогона зеркала) | `index.json` + `standings.json` + `NN_<event-slug>.json` / `test_<slug>.json` (сессии события; путь публикует `index.events[].resultsPath`) |
| `f1/calendar/<год>.json` | f1overrides (внутри прогона GC) | смёрженный календарь сезона: jolpica + оверлей OpenF1 + курируемый слой. `round` 0 — сентинел «раунда в источнике нет» (тест/отмена/фантом), `status` tbc — нумерация провизорна, `sourceIds` — ключи события во всех источниках |
| `tracks/index.json` | tracks | синглтон, ПЛОСКАЯ карта slug→запись (без конверта) |
| `f1/fom/<Path>/<Topic>.jsonStream` | fomstatic (ТОЛЬКО вручную: источник отдаёт раннерам GitHub 403) | СЫРОЙ срез статики FOM live timing 2018–2021 байт в байт (WeatherData, TimingAppData, RaceControlMessages, PitLaneTimeCollection). Кухня: продьюсеров-потребителей пока нет, снят проактивно — архив уже теряли (2017 и 2022 → 403) |
| `wec/_live_health.json` | weclive (свой воркфлоу) | маркер свежести продьюсера «идущий этап»: `{"lastSuccess":"YYYY-MM-DD"}`, пишется на каждом прогоне (включая холостой) ДНЁМ — иначе 96 прогонов в сутки давали бы 96 коммитов |
| `f1/overrides/calendar.json` | — РУКАМИ (+GC f1overrides) | см. README корня |
| `f1/records/catalog.json` | — РУКАМИ | курируемые рекорды |
| `health.json` | health | heartbeat + статусы всех продьюсеров |

Derived-JSON несут конверт `{schemaVersion, generatedAt, ...}`; generatedAt
обновляется только при реальном изменении данных (git остаётся тихим).

## Архивные входы (НЕ удалять!)

Срезы `f1/openf1/` за 2023–2024 (meetings/sessions/drivers/stints/… по
meeting_key/session_key тех сезонов) приложением НЕ читаются — это архивный
вход будущих фич (ретро-лапчарты, пересчёты SC, телеметрийные кейсы из карты
источников июля-2026). Решение владельца — держать в репозитории
(DATA-PLAN, фаза 0.5); «осиротевшие» файлы здесь — норма, не мусор.
