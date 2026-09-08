// Витринный прогноз погоды (фаза B кухни F1, план §2): два семейства файлов,
// снимающие прямые походы клиента в Open-Meteo, — `<серия>/forecast/<id>.json`
// по событиям трёх серий и `weather/now.json` по всем трассам refs с coord.
//
// ЕДИНСТВЕННЫЙ сетевой выход — Open-Meteo (CC-BY 4.0; атрибуция называется в
// About приложения, машинных маркеров источника формы файлов не несут — сторож
// sourceleak). Всё остальное уже лежит на диске после прогона соседей: витрина
// календаря F1 (даты + trackRef), сезонные индексы WEC/IMSA (окна и привязка к
// трассе), координаты — курируемая карта refs. Поэтому шаг стоит в snapshot.yml
// ПОСЛЕ f1overrides (витрина календаря собирается там).
//
// Режим считает БЭК — клиент перестаёт решать по датам (порт его правил живёт
// в lib/forecast.ts):
//  - горизонт прогноза (≤16 дней или недавно прошло) — 1 запрос Forecast API
//    каждый прогон;
//  - отстоявшееся (isFrozen, 7 дней — заодно перекрывает лаг ERA5 ~5 дней) —
//    пересборка из Archive API и печать final под гейтом полноты; в файле
//    такого события regime = "archive" даже там, где клиентский расчёт по
//    датам ещё сказал бы forecast: содержимое честно называет источник данных;
//  - дальнее будущее — климатология 5 прошлых лет, но ТОЛЬКО в суточном слоте
//    (FORECAST_TYPICAL=1): ~5 archive-запросов на событие не место в
//    ежечасном кроне, а типичная погода за сутки не меняется.
//
// Вся политика записи (kept-previous, кворум, гейт запечатывания) —
// resolveForecast; продьюсеру остаются сбор целей, фетч и конверт.
//
// Привязка «событие → трасса»: F1 и WEC несут trackRef (пространство слагов
// refs), IMSA — только строку venue, резолвящуюся imsaVenue-алиасами карты.
// Покрытие обеих осей держат fail-loud тесты refs.test.ts: дыра валит CI
// раньше, чем продьюсер молча пропустит этап. Ключи файлов = id витрины, как
// у соседнего weather/: f1 — id события календаря, wec — `wec-<сезон>-<слаг>`,
// imsa — `imsa-<сезон>-<раунд>`.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeJSONWithEnvelope } from "../lib/mirror.js";
import { isFrozen } from "../lib/freeze.js";
import { envFlag } from "../lib/env.js";
import { loadRefs, trackByAlias, type RefsMap } from "../lib/refs.js";
import {
  archiveURL, fetchOpenMeteoHourly, forecastURL, nowURL,
  type Coord, type EventWindow, type ForecastHourly,
} from "../lib/openmeteo.js";
import {
  FORECAST_PARSER_VERSION, FORECAST_SCHEMA_VERSION, NOW_SCHEMA_VERSION, TYPICAL_YEARS,
  clipNowHourly, forecastRegime, makeTypical, resolveForecast, shiftYearsUTC,
  type ForecastCandidate, type ForecastDoc, type NowDoc, type NowTrackEntry, type TypicalBlob,
} from "../lib/forecast.js";

const DATA_DIR = join(process.cwd(), "data");
const DAY_MS = 24 * 3600 * 1000;

type Log = (m: string) => void;
type FetchHourly = (url: string) => Promise<ForecastHourly | null>;

/// Бережный темп к бесплатному API: пауза перед каждым запросом. User-Agent —
/// общий нейтральный из http.ts (внутри fetchJSON), туда же таймаут и ретрай
/// на 429/5xx.
const PAUSE_MS = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/// Счётчик сетевых запросов прогона — единственный способ оператора увидеть
/// в логе крона рост бюджета к бесплатному API (лимит 10k/сутки).
let fetchCount = 0;
async function pacedFetch(url: string): Promise<ForecastHourly | null> {
  fetchCount++;
  await sleep(PAUSE_MS);
  return fetchOpenMeteoHourly(url);
}

function readJSON<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// MARK: - Сбор целей (бессетевой)

type Series = "f1" | "wec" | "imsa";

interface Target {
  series: Series;
  season: number;
  eventId: string;
  name: string;
  coord: Coord;
  window: EventWindow;
}

interface F1CalendarEvent {
  id?: string;
  kind?: string;
  name?: string;
  trackRef?: string | null;
  dates?: { start?: string | null; race?: string | null };
}

interface SeasonIndexEvent {
  round?: number;
  slug?: string;
  name?: string;
  venue?: string;
  trackRef?: string | null;
  start?: string | null;
  end?: string | null;
  status?: string | null;
}

interface SeasonDoc<E> { season?: number; events?: E[] }

const parseMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/// Окно события F1 — от первого дня уик-энда до конца дня гонки; точнее не
/// нужно (та же огрубка, что у f1weather: окно freeze недельное, а покрытие
/// hourly и так расширяется на ±1 день).
function f1Window(e: F1CalendarEvent): EventWindow | null {
  const race = e.dates?.race;
  if (!race) return null;
  const startMs = parseMs(`${e.dates?.start ?? race}T00:00:00Z`);
  const endMs = parseMs(`${race}T23:59:59Z`);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return { startMs, endMs };
}

/// Годы сезонных каталогов серии (`data/<серия>/<год>/index.json`).
function seasonYears(dataDir: string, series: Series): number[] {
  const dir = join(dataDir, series);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^\d{4}$/.test(n)).map(Number).sort();
}

/// Все события трёх серий, у которых есть окно и координаты. Событие без
/// trackRef/резолва/coord — НЕ дыра (правило 2 плана: неизвестная трасса
/// легальна), оно просто выпадает из прогноза; счёт таких попадает в лог.
function collectTargets(dataDir: string, refs: RefsMap, log: Log): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();
  let unmapped = 0;

  const coordOf = (slug: string | null | undefined): Coord | null => {
    if (!slug) return null;
    return refs.tracks.find((t) => t.slug === slug)?.coord ?? null;
  };
  let brokenWindow = 0;
  const push = (series: Series, season: number, eventId: string, name: string,
                coord: Coord | null, window: EventWindow | null): void => {
    if (!coord) { unmapped++; return; }
    // Битое окно — тот же класс «выпало из прогноза», что и без координат:
    // молчаливый дроп события неотличим от «всё собрано», поэтому счёт в лог.
    if (!window) { brokenWindow++; return; }
    if (seen.has(eventId)) {
      // Ключ-конвенция weather/ у IMSA — раунд, а round=0 это сентинел:
      // второй тест сезона схлопнулся бы в тот же файл. Молча перезаписывать
      // нельзя — пропускаем с криком.
      log(`::warning::forecast: дубль id «${eventId}» — событие пропущено`);
      return;
    }
    seen.add(eventId);
    targets.push({ series, season, eventId, name, coord, window });
  };

  // F1 — витрина календаря.
  const calDir = join(dataDir, "f1", "calendar");
  if (existsSync(calDir)) {
    for (const file of readdirSync(calDir).filter((f) => /^\d{4}\.json$/.test(f)).sort()) {
      const year = Number(file.slice(0, 4));
      const doc = readJSON<SeasonDoc<F1CalendarEvent>>(join(calDir, file));
      // Январское отравление: файл сезона с ЧУЖИМ season не разбираем —
      // прогноз уехал бы под чужие id (тот же гейт, что у f1weather).
      if (!doc || doc.season !== year) {
        log(`::warning::forecast: f1/calendar/${file} несёт чужой season — пропуск`);
        continue;
      }
      for (const e of doc.events ?? []) {
        if (!e.id) continue;
        // У отменённого этапа нет ни сессий, ни страницы погоды.
        if (e.kind === "cancelled") continue;
        push("f1", year, e.id, e.name ?? e.id, coordOf(e.trackRef), f1Window(e));
      }
    }
  }

  // WEC и IMSA — сезонные индексы. Окно уже в индексе (start/end),
  // различается только привязка к трассе: trackRef против venue-строки.
  for (const series of ["wec", "imsa"] as const) {
    for (const year of seasonYears(dataDir, series)) {
      const doc = readJSON<SeasonDoc<SeasonIndexEvent>>(
        join(dataDir, series, String(year), "index.json"));
      if (!doc || doc.season !== year) {
        log(`::warning::forecast: ${series}/${year}/index.json несёт чужой season — пропуск`);
        continue;
      }
      for (const e of doc.events ?? []) {
        // Симметрия с F1: отменённый этап эндуранса не фетчится и уж точно
        // не запечатывается «прогнозом несуществующего уик-энда». Подстрокой:
        // WEC несёт статусы источника (EventScheduled/EventCompleted →
        // потенциально EventCancelled), IMSA — свои (finished/upcoming).
        if ((e.status ?? "").toLowerCase().includes("cancel")) continue;
        const startMs = parseMs(e.start);
        const endMs = parseMs(e.end);
        const window = startMs !== null && endMs !== null && endMs >= startMs
          ? { startMs, endMs } : null;
        const coord = series === "wec"
          ? coordOf(e.trackRef)
          : trackByAlias(refs, "imsaVenue", e.venue ?? "")?.coord ?? null;
        const eventId = series === "wec"
          ? (e.slug ? `wec-${year}-${e.slug}` : null)
          : (e.round !== undefined ? `imsa-${year}-${e.round}` : null);
        if (!eventId) continue;
        push(series, year, eventId, e.name ?? eventId, coord, window);
      }
    }
  }

  if (unmapped > 0) {
    log(`  событий без трассы/координат: ${unmapped} — не дыра, но и не прогноз`);
  }
  if (brokenWindow > 0) {
    log(`::warning::forecast: событий с нечитаемым окном: ${brokenWindow}`);
  }
  return targets;
}

// MARK: - Прогноз одного события

type EventOutcome = "written" | "unchanged" | "kept-previous" | "skipped" | "deferred";

async function buildEventForecast(
  dataDir: string, t: Target, now: number, typical: boolean, force: boolean,
  fetchHourly: FetchHourly, log: Log,
): Promise<{ outcome: EventOutcome; horizon: boolean }> {
  const path = join(dataDir, t.series, "forecast", `${t.eventId}.json`);
  // Гейт формы prev: битый/недописанный файл или чужая schemaVersion — это
  // «prev нет», а не сырьё для sealGate (prev.hourly.time там разыменовывается,
  // и одна испорченная запись роняла бы ВЕСЬ прогон продьюсера TypeError'ом).
  const rawPrev = readJSON<ForecastDoc>(path);
  const prev = rawPrev?.schemaVersion === FORECAST_SCHEMA_VERSION &&
    Array.isArray(rawPrev.hourly?.time) ? rawPrev : null;

  // Запечатанное со свежей версией разбора — НОЛЬ запросов (resolveForecast
  // повторил бы этот вердикт, но уже после фетча): ровно этим ежечасный
  // бюджет не растёт с длиной архива.
  if (prev?.final && prev.parserVersion === FORECAST_PARSER_VERSION && !force) {
    return { outcome: "unchanged", horizon: false };
  }

  const base = {
    series: t.series, season: t.season, eventId: t.eventId,
    coord: t.coord, window: t.window, force,
  };
  let candidate: ForecastCandidate;
  let horizon = false;

  if (isFrozen(t.window.endMs, now)) {
    // Отстоялось — финальный факт из Archive API (ERA5); запас ±1 день вокруг
    // окна — тот же, что у клиентского archiveURL.
    const hourly = await fetchHourly(
      archiveURL(t.coord, t.window.startMs - DAY_MS, t.window.endMs + DAY_MS));
    candidate = { ...base, regime: "archive", seal: true, hourly };
  } else if (forecastRegime(t.window, now) === "typical") {
    // Дальнее будущее: пересборка только в суточном слоте. deferred — штатный
    // исход ежечасного прогона, файл (если есть) просто не трогается.
    if (!typical) return { outcome: "deferred", horizon: false };
    const blobs: TypicalBlob[] = [];
    for (let offset = 1; offset <= TYPICAL_YEARS; offset++) {
      const hourly = await fetchHourly(archiveURL(
        t.coord,
        shiftYearsUTC(t.window.startMs, -offset) - DAY_MS,
        shiftYearsUTC(t.window.endMs, -offset) + DAY_MS));
      if (hourly) blobs.push({ offset, hourly });
    }
    candidate = {
      ...base, regime: "typical", seal: false,
      hourly: makeTypical(blobs, t.window), typicalYears: blobs.length,
    };
  } else {
    horizon = true;
    const hourly = await fetchHourly(forecastURL(t.coord, t.window, now));
    candidate = { ...base, regime: "forecast", seal: false, hourly };
  }

  const d = resolveForecast(prev, candidate);
  switch (d.outcome) {
    case "write": {
      // doc уже несёт schemaVersion — конверт кладёт ту же версию, дубля
      // ключа в JSON не появляется (spread по одному имени).
      const changed = writeJSONWithEnvelope(path, d.doc, FORECAST_SCHEMA_VERSION);
      return { outcome: changed ? "written" : "unchanged", horizon };
    }
    case "kept-previous":
      log(`::warning::forecast ${t.eventId}: ${d.reason}`);
      return { outcome: "kept-previous", horizon };
    case "skipped":
      log(`  ${t.eventId}: пропуск — ${d.reason}`);
      return { outcome: "skipped", horizon };
    case "unchanged":
      return { outcome: "unchanged", horizon };
  }
}

// MARK: - «Сейчас на трассе» (weather/now.json)

async function buildNow(
  dataDir: string, refs: RefsMap, now: number, fetchHourly: FetchHourly, log: Log,
): Promise<string> {
  const path = join(dataDir, "weather", "now.json");
  const prevRaw = readJSON<NowDoc>(path);
  const prev = prevRaw?.schemaVersion === NOW_SCHEMA_VERSION ? prevRaw : null;

  const withCoord = refs.tracks.filter((t) => t.coord);
  if (withCoord.length === 0) return "now: трасс с coord нет";

  const tracks: Record<string, NowTrackEntry> = {};
  let fetched = 0;
  let kept = 0;
  let missed = 0;
  for (const t of withCoord) {
    const raw = await fetchHourly(nowURL(t.coord!));
    const clipped = raw ? clipNowHourly(raw, now) : null;
    if (clipped && clipped.time.length > 0) {
      tracks[t.slug] = { coord: t.coord!, hourly: clipped };
      fetched++;
    } else if (prev?.tracks?.[t.slug]) {
      // Пер-трековый kept-previous: осечка одной трассы не выбивает её из
      // файла — прежняя полоска часов лучше отсутствия записи.
      tracks[t.slug] = prev.tracks[t.slug];
      kept++;
    } else {
      missed++;
    }
  }

  if (fetched === 0 && kept === 0) {
    // Та же keep-семантика, что у событий, но на уровне целого документа:
    // пустой файл поверх прежнего не пишем.
    log("::warning::forecast now: ни одной трассы не снято — файл не тронут");
    return `now: пусто (мимо ${missed})`;
  }
  const changed = writeJSONWithEnvelope(path, { tracks }, NOW_SCHEMA_VERSION);
  return `now: ${changed ? "written" : "unchanged"} ` +
    `(снято ${fetched}, kept ${kept}${missed > 0 ? `, мимо ${missed}` : ""})`;
}

// MARK: - Прогон

export interface ForecastRunOpts {
  dataDir?: string;
  now?: number;
  /// Суточный слот климатологии (в кроне — FORECAST_TYPICAL=1).
  typical?: boolean;
  /// Операторская ручка: пересобрать даже запечатанное (FORECAST_FORCE=1).
  force?: boolean;
  fetchHourly?: FetchHourly;
  log?: Log;
}

const newTally = (): Record<EventOutcome, number> =>
  ({ written: 0, unchanged: 0, "kept-previous": 0, skipped: 0, deferred: 0 });

const fmtTally = (t: Record<EventOutcome, number>): string => {
  const parts = Object.entries(t).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? parts.join(", ") : "пусто";
};

/// ok=false — системная поломка (предполёт), а не «тихо пусто»: шаг стоит под
/// continue-on-error, поэтому exit 1 красит его и доезжает до письма через
/// гейт продьюсеров, а данные прогона публикуются как обычно (амендмент 4
/// плана: предполёт — тревога, не гейт коммита).
export async function buildForecast(
  opts: ForecastRunOpts = {},
): Promise<{ summary: string; ok: boolean }> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const now = opts.now ?? Date.now();
  const typical = opts.typical ?? envFlag("FORECAST_TYPICAL");
  const force = opts.force ?? envFlag("FORECAST_FORCE");
  const fetchHourly = opts.fetchHourly ?? pacedFetch;
  const log = opts.log ?? console.log;

  const refs = loadRefs(join(dataDir, "refs", "matching.json"));
  if (!refs) {
    // Без карты нет координат, без координат нет прогноза — это поломка
    // окружения, а не пустой сезон.
    log("::error::forecast: карта refs непригодна — координат нет, прогноз не считается");
    return { summary: "forecast: карта refs непригодна", ok: false };
  }

  const targets = collectTargets(dataDir, refs, log);
  const tally: Record<Series, Record<EventOutcome, number>> =
    { f1: newTally(), wec: newTally(), imsa: newTally() };
  // Предполёт считает только горизонт прогноза: у forecast-режима сеть
  // обязана отвечать каждый прогон, у seal/typical штатны паузы и retry.
  let horizonTotal = 0;
  let horizonAlive = 0;
  for (const t of targets) {
    const r = await buildEventForecast(dataDir, t, now, typical, force, fetchHourly, log);
    tally[t.series][r.outcome]++;
    if (r.horizon) {
      horizonTotal++;
      if (r.outcome === "written" || r.outcome === "unchanged" || r.outcome === "kept-previous") {
        horizonAlive++;
      }
    }
  }

  const nowLine = await buildNow(dataDir, refs, now, fetchHourly, log);

  let ok = true;
  if (horizonTotal > 0 && horizonAlive === 0) {
    log(`::error::forecast: в горизонте ${horizonTotal} событий, но ни одно не написано ` +
      "и не удержано — сеть или формы сломаны системно");
    ok = false;
  }
  const parts = (["f1", "wec", "imsa"] as const).map((s) => `${s}: ${fmtTally(tally[s])}`);
  return { summary: `прогноз — ${parts.join("; ")}; ${nowLine}; запросов: ${fetchCount}`, ok };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildForecast()
    .then(({ summary, ok }) => {
      console.log(summary);
      if (!ok) process.exitCode = 1;
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
