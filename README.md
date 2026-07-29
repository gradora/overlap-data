# overlap-data

Снапшот-бэкенд данных приложения **Overlap** (F1 / WEC / IMSA): GitHub Actions
по расписанию тянет источники, кладёт ответы и derived-карточки в `data/`,
приложение читает их mirror-first с `raw.githubusercontent.com` (фолбэк —
живой источник). Зачем: прошедшие результаты доступны независимо от состояния
источников и того, открывал ли пользователь приложение; источники разгружены.

## Архитектура

```
Jolpica ─┐                       ┌─ data/f1/jolpica/   (зеркало, + пер-раундовые слайсы)
OpenF1 ──┤                       ├─ data/f1/openf1/    (зеркало, история 2023+)
fiawec ──┤  src/producers/* ────►├─ data/wec/fiawec/   (зеркало HTML, нормализовано)
Al Kamel ┤  (cron, см. ниже)     ├─ data/{f1,wec,imsa}/{fia,winners,highlights}/
fia.com ─┤                       ├─ data/f1/{milestones,beasts,records,history}/
enwiki ──┘                       ├─ data/imsa/<year>/  (снапшот этапов)
                                 ├─ data/tracks/index.json
                                 └─ data/health.json   (heartbeat + статусы)
```

- `src/lib/` — общий код: `mirror` (slug-контракт со Swift! см. data/README),
  `http` (UA+retry), `sources`, `slug`, `env`, `freeze` (окно оседания 7д),
  `season`, `schedule` (курируемый календарь IMSA), `alkamel*`, `fiawecsite`.
- `src/producers/` — 19 продьюсеров-entrypoint'ов (по одному npm-скрипту),
  друг друга не импортируют: общий код — только через lib (`fiadocs` — парс-ядро
  документов стюардов, `winnersbuild` — сборщики прошлых победителей).
- `data/f1/overrides/calendar.json` — РУЧНАЯ ручка: завод события до появления
  в источниках (кейс Sepang), приложение показывает с бейджем TBC и само
  дедуплицирует после публикации. Никакой продьюсер его не пишет.
- `data/f1/records/catalog.json` — РУЧНОЙ каталог all-time рекордов
  (held/chases) для продьюсера f1records.

## Workflows

| Workflow | Расписание | Что | Гейт |
|---|---|---|---|
| `snapshot.yml` | каждый час (`17 * * * *`) | 17 продьюсеров + health | все шаги (workflows.test.ts следит) |
| `fia.yml` | `*/15` Пт–Вс | только штрафы FIA (своя concurrency-group — не дропается за snapshot) | exit-code |
| `tracks.yml` | Пн 04:00 | справочник трасс из англ-вики | exit-code |
| `ci.yml` | push/PR | typecheck + tests | — |

Коммит/пуш — общий composite action `.github/actions/commit-push` (5 попыток
с rebase). Алерт: любой упавший продьюсер валит job → письмо владельцу;
исключения-толерантности: OpenF1 401 в лайв-сессию, records при пустом сезоне.

## Операторские ручки (env)

Семантика едина (`src/lib/env.ts`): флаг включён ⇔ значение ровно `1`.

| Ручка | Дефолт | Что |
|---|---|---|
| `SEASON` | текущий год | сезон прогона; прошлый год у openf1 = historic-бэкфилл |
| `FIA_BACKFILL` / `WEC_FIA_BACKFILL` / `IMSA_FIA_BACKFILL` | 2 / 1 / 1 | сколько прошлых этапов доскрейпить |
| `FIA_FORCE` / `WEC_FIA_FORCE` / `IMSA_FIA_FORCE` | — | пересобрать даже замороженные |
| `WEC_HL_FORCE` / `IMSA_HL_FORCE` | — | то же для хайлайтов |
| `WEC_WINNERS_BACKFILL` / `IMSA_WINNERS_BACKFILL` | 1 | глубина бэкфилла победителей |
| `TRACKS_ONLY=slug,slug` | — | ТОЛЬКО отладка: пишет index из перечисленных — коммитить нельзя |

## Данные

Конвенции имён файлов и slug-контракт — `data/README.md`. Derived-семейства
несут конверт `{schemaVersion, generatedAt}` (метка меняется только с данными).
Сезонное обслуживание — `SEASON-CHECKLIST.md`.
