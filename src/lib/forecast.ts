// Витринный прогноз погоды (фаза B кухни F1, план §2) — два семейства файлов,
// закрывающие прямые походы клиента в Open-Meteo:
//
//   1. `<серия>/forecast/<eventId>.json` — почасовой блок события. Ключ = id
//      витрины (как у weather/), форма hourly 1:1 с клиентским HourlyForecast.
//   2. `weather/now.json` — «сейчас на трассе», один файл на все трассы с
//      мини-hourly −3ч…+6ч: продьюсер бежит в :17, пользователь открывает в
//      :50 — полоска часов даёт клиенту ближайший час к НАСТОЯЩЕМУ «сейчас».
//
// Это НЕ сенсорный архив weather.ts и не его замена: там датчики трассы
// (trackC, бинарный дождь), здесь модель Open-Meteo (вероятность, мм, WMO).
// Recorded уже перекрывает forecast построчно на клиенте — семейства
// сосуществуют.
//
// Режим считает БЭК (порт клиентского WeatherService.regime — клиент перестаёт
// решать по датам), усреднение климатологии — порт makeTypical 1:1 (модальный
// WMO, при равенстве хуже; кворум лет). Запечатывание — ПО ПОЛНОТЕ, не по
// наличию файла (амендмент wec-facts): урезанный ответ не имеет права застыть
// навсегда. Конверт — writeJSONWithEnvelope, как у всех соседей.

import type { Coord, EventWindow, ForecastHourly } from "./openmeteo.js";

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

/// Версия ФОРМЫ файла прогноза события. Сверка на клиенте точная, fail-closed.
export const FORECAST_SCHEMA_VERSION = 1;

/// Версия РАЗБОРА, записанная в каждый файл (образец WEATHER_PARSER_VERSION):
/// чинит запечатанное подокументно, без глобального форса.
export const FORECAST_PARSER_VERSION = 1;

/// Версия формы now-файла — отдельная: семейства эволюционируют независимо.
export const NOW_SCHEMA_VERSION = 1;

// MARK: - Режим по горизонту (порт WeatherService.regime)

/// Предел прогноза Open-Meteo — физический горизонт ~14–16 дней.
export const FORECAST_HORIZON_MS = 16 * DAY_MS;
/// Дальше past_days Forecast API не достаёт — только Archive (ERA5).
export const ARCHIVE_THRESHOLD_MS = 85 * DAY_MS;
/// Лет усреднения климатологии и минимум ответивших лет, чтобы писать файл.
export const TYPICAL_YEARS = 5;
export const TYPICAL_QUORUM = 3;

export type ForecastRegime = "forecast" | "archive" | "typical";

/// Режим по положению события относительно «сейчас» — семантика клиента 1:1.
/// Решаем по ДАЛЬНЕЙ кромке события (+1 день, как в forecastURL): если даже
/// последняя сессия за горизонтом прогноза — идём в климатологию целиком,
/// иначе гонка/квала показали бы «—».
export function forecastRegime(window: EventWindow, nowMs: number): ForecastRegime {
  if (window.endMs + DAY_MS - nowMs > FORECAST_HORIZON_MS) return "typical";
  if (nowMs - window.endMs > ARCHIVE_THRESHOLD_MS) return "archive";
  return "forecast";
}

// MARK: - Формы файлов

export interface ForecastDoc {
  schemaVersion: number;
  series: string;
  season: number;
  eventId: string;
  parserVersion: number;
  regime: ForecastRegime;
  /// Окно события закрылось, отстоялось и hourly прошёл гейт полноты — файл
  /// больше не пересобирается (кроме случая «версия разбора устарела»).
  final: boolean;
  /// Из refs; lon нужен клиенту для isNight без словаря координат.
  coord: Coord;
  /// Обязателен при regime=typical: UI печатает «Typical for this date…»
  /// и опирается на число лет кворума.
  typical: { years: number } | null;
  hourly: ForecastHourly;
}

export interface NowTrackEntry {
  coord: Coord;
  hourly: ForecastHourly;
}

/// `weather/now.json`: ключи — asset-slug трасс (пространство trackRef/refs,
/// НЕ canonicalName клиента).
export interface NowDoc {
  schemaVersion: number;
  tracks: Record<string, NowTrackEntry>;
}

/// Окно мини-hourly в now-файле: −3ч (ближайший прошедший час всегда есть,
/// даже если прогон был давно) … +6ч (запас на протухание между прогонами).
export const NOW_WINDOW_BACK_MS = 3 * HOUR_MS;
export const NOW_WINDOW_AHEAD_MS = 6 * HOUR_MS;

/// Суточный блок из nowURL → полоска −3ч…+6ч вокруг nowMs (~10 строк).
export function clipNowHourly(hourly: ForecastHourly, nowMs: number): ForecastHourly {
  const lo = (nowMs - NOW_WINDOW_BACK_MS) / 1000;
  const hi = (nowMs + NOW_WINDOW_AHEAD_MS) / 1000;
  const keep: number[] = [];
  for (let i = 0; i < hourly.time.length; i++) {
    if (hourly.time[i] >= lo && hourly.time[i] <= hi) keep.push(i);
  }
  return {
    time: keep.map((i) => hourly.time[i]),
    temperature_2m: keep.map((i) => hourly.temperature_2m[i] ?? null),
    precipitation_probability: keep.map((i) => hourly.precipitation_probability[i] ?? null),
    precipitation: keep.map((i) => hourly.precipitation[i] ?? null),
    wind_speed_10m: keep.map((i) => hourly.wind_speed_10m[i] ?? null),
    weather_code: keep.map((i) => hourly.weather_code[i] ?? null),
  };
}

// MARK: - Климатология (порт WeatherService.makeTypical)

/// Округление как у Swift `Int(x.rounded())` — половина ОТ нуля. Math.round
/// тянет −22.5 к −22, Swift — к −23; порт обязан совпадать, иначе парный тест
/// формы TS↔Swift разойдётся на морозных трассах.
const roundHalfAwayFromZero = (v: number): number =>
  v < 0 ? -Math.round(-v) : Math.round(v);

/// Сдвиг инстанта на целые годы по григорианскому UTC-календарю — семантика
/// Calendar.date(byAdding: .year): 29 февраля в невисокосном году сползает
/// на 28-е, время суток сохраняется.
export function shiftYearsUTC(ms: number, deltaYears: number): number {
  const d = new Date(ms);
  const year = d.getUTCFullYear() + deltaYears;
  const month = d.getUTCMonth();
  // День 0 следующего месяца = последний день текущего: потолок для 29 фев.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/// Снимок часа — порт HourlyForecast.weather(at:): ближайший час в пределах
/// ±90 мин, часы без температуры ИЛИ без кода пропускаются при поиске (null-
/// хвост прогноза не съедает соседний валидный час).
function weatherAt(hourly: ForecastHourly, ms: number):
  { tempC: number; windKmh: number; code: number; precipMm: number | null } | null {
  const target = ms / 1000;
  let bestIndex = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < hourly.time.length; i++) {
    if (hourly.temperature_2m[i] === null || hourly.temperature_2m[i] === undefined) continue;
    if (hourly.weather_code[i] === null || hourly.weather_code[i] === undefined) continue;
    const d = Math.abs(hourly.time[i] - target);
    if (d < bestDelta) { bestDelta = d; bestIndex = i; }
  }
  if (bestIndex < 0 || bestDelta > 90 * 60) return null;
  return {
    tempC: roundHalfAwayFromZero(hourly.temperature_2m[bestIndex]!),
    windKmh: roundHalfAwayFromZero(hourly.wind_speed_10m[bestIndex] ?? 0),
    code: hourly.weather_code[bestIndex]!,
    precipMm: hourly.precipitation[bestIndex] ?? null,
  };
}

/// Самый частый код; при равенстве частот — БОЛЬШИЙ (более «серьёзная»
/// погода): типичный час не имеет права выглядеть лучше половины своих лет.
function modalCode(codes: number[]): number {
  const counts = new Map<number, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best = codes[0] ?? 0;
  let bestCount = -1;
  for (const [code, count] of counts) {
    if (count > bestCount || (count === bestCount && code > best)) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/// Архивный блок одного прошлого года: offset — на сколько лет назад сдвинуты
/// его даты относительно окна ЭТОГО события.
export interface TypicalBlob { offset: number; hourly: ForecastHourly }

/// Синтез «типичного» почасового блока: по каждому часу окна события берётся
/// тот же час-инстант в прошлых годах (сдвиг на год), t°/ветер/осадки
/// усредняются, код — модальный. Час, не набравший ни одного года, честно
/// выпадает из ряда. Кворум лет проверяет НЕ эта функция, а resolveForecast:
/// усреднить можно и по одному году, писать такое в файл — нельзя.
export function makeTypical(blobs: TypicalBlob[], window: EventWindow): ForecastHourly | null {
  if (blobs.length === 0) return null;
  const time: number[] = [];
  const temps: (number | null)[] = [];
  const winds: (number | null)[] = [];
  const codes: (number | null)[] = [];
  const precs: (number | null)[] = [];

  const stopMs = window.endMs + DAY_MS;
  let t = window.startMs;
  // Страховка от битого окна — как guardStep клиента: 800 часов ≈ месяц.
  let guardStep = 0;
  while (t <= stopMs && guardStep < 800) {
    guardStep++;
    const ts: number[] = [];
    const ws: number[] = [];
    const cs: number[] = [];
    const ps: number[] = [];
    for (const b of blobs) {
      const sw = weatherAt(b.hourly, shiftYearsUTC(t, -b.offset));
      if (sw) {
        ts.push(sw.tempC);
        ws.push(sw.windKmh);
        cs.push(sw.code);
        if (sw.precipMm !== null) ps.push(sw.precipMm);
      }
    }
    if (ts.length > 0) {
      time.push(Math.round(t / 1000));
      temps.push(avg(ts));
      winds.push(avg(ws));
      codes.push(modalCode(cs));
      precs.push(ps.length === 0 ? 0 : avg(ps));
    }
    t += HOUR_MS;
  }
  if (time.length === 0) return null;
  return {
    time,
    temperature_2m: temps,
    // Вероятности осадков у ERA5 нет — ось null-выровнена, а не пуста:
    // все шесть осей файла всегда параллельны.
    precipitation_probability: time.map(() => null),
    precipitation: precs,
    wind_speed_10m: winds,
    weather_code: codes,
  };
}

// MARK: - Гейт запечатывания и kept-previous

/// Минимальная доля часов окна с непустой температурой для final.
export const SEAL_MIN_TEMP_SHARE = 0.9;

/// null — печатать final можно; строка — причина оставить прежний файл.
/// Гейт ПО ПОЛНОТЕ, не по наличию файла: (1) hourly покрывает всё окно
/// события, (2) ≥90 % часов ОКНА с непустой температурой (null-хвост за
/// пределами окна не в счёт), (3) часов В ОКНЕ не меньше, чем у prev в том
/// же окне — аналог weatherRegression: погода прошедшего уик-энда не редеет.
///
/// Регрессия (3) обязана мерить ОДНО И ТО ЖЕ: prev forecast-фазы несёт
/// широкий ряд (past_days растёт к freeze до ~289 часов ≈ 12 дней), а
/// archive-кандидат — только окно ±1 день (~121 час). Сравнение полных длин
/// отвергало бы seal у ЛЮБОГО события, прожившего forecast-фазу, — файл
/// навечно оставался бы regime="forecast" с лишним archive-запросом каждый
/// час (репро ревью: Монца-2026, 289 → 121). Поэтому обе стороны считаются
/// одним циклом по часам внутри окна события.
export function sealGate(
  hourly: ForecastHourly, window: EventWindow, prev: ForecastDoc | null,
): string | null {
  const first = hourly.time[0];
  const last = hourly.time[hourly.time.length - 1];
  const startSec = window.startMs / 1000;
  const endSec = window.endMs / 1000;
  if (first === undefined || first > startSec || last < endSec) {
    return "hourly не покрывает окно события";
  }
  const hoursInWindow = (h: ForecastHourly): { inWindow: number; withTemp: number } => {
    let inWindow = 0;
    let withTemp = 0;
    for (let i = 0; i < h.time.length; i++) {
      if (h.time[i] < startSec || h.time[i] > endSec) continue;
      inWindow++;
      if (h.temperature_2m[i] !== null && h.temperature_2m[i] !== undefined) withTemp++;
    }
    return { inWindow, withTemp };
  };
  const cand = hoursInWindow(hourly);
  if (cand.inWindow === 0 || cand.withTemp / cand.inWindow < SEAL_MIN_TEMP_SHARE) {
    return `температура лишь в ${cand.withTemp}/${cand.inWindow} часов окна — меньше 90 %`;
  }
  if (prev) {
    const prevWin = hoursInWindow(prev.hourly).inWindow;
    if (cand.inWindow < prevWin) {
      return `часов в окне стало меньше (${prevWin} → ${cand.inWindow})`;
    }
  }
  return null;
}

/// Кандидат на запись после фетча — всё, что продьюсер узнал за прогон.
export interface ForecastCandidate {
  series: string;
  season: number;
  eventId: string;
  regime: ForecastRegime;
  coord: Coord;
  window: EventWindow;
  /// Прогон намерен запечатать (окно freeze прошло) — включает гейт полноты.
  seal: boolean;
  /// null — сеть промолчала или ответ пуст.
  hourly: ForecastHourly | null;
  /// Сколько прошлых лет реально ответило (только для typical).
  typicalYears?: number;
  /// Операторская ручка: пересобрать даже запечатанное (FORECAST_FORCE=1).
  force?: boolean;
}

export type ForecastDecision =
  | { outcome: "write"; doc: ForecastDoc }
  | { outcome: "unchanged"; reason: string }
  | { outcome: "kept-previous"; reason: string }
  | { outcome: "skipped"; reason: string };

/// prev есть → не трогаем (kept-previous), prev нет → skip. Общий хвост всех
/// предохранителей: пропавший источник не морозит сезон молча и ничего не
/// затирает.
const keepOrSkip = (prev: ForecastDoc | null, reason: string): ForecastDecision =>
  prev
    ? { outcome: "kept-previous", reason: `${reason} — прежний файл не тронут` }
    : { outcome: "skipped", reason };

/// Решение по одному событию. Чистая функция — вся политика записи здесь,
/// продьюсеру остаётся фетч и writeJSONWithEnvelope.
export function resolveForecast(prev: ForecastDoc | null, c: ForecastCandidate): ForecastDecision {
  // Запечатанное пересобираем ТОЛЬКО при устаревшей версии разбора или форсе —
  // образец пер-документной версии f1weather.
  if (prev?.final && prev.parserVersion === FORECAST_PARSER_VERSION && !c.force) {
    return { outcome: "unchanged", reason: "запечатано" };
  }
  if (!c.hourly || c.hourly.time.length === 0) {
    return keepOrSkip(prev, "сеть/пустой ответ");
  }
  if (c.regime === "typical" && (c.typicalYears ?? 0) < TYPICAL_QUORUM) {
    // Разовая осечка 3 из 5 archive-запросов не имеет права заморозить
    // «средний год по двум годам» — тот же мотив, что кворум кэша клиента.
    return keepOrSkip(prev, `кворум климатологии не набран (${c.typicalYears ?? 0} < ${TYPICAL_QUORUM} лет)`);
  }
  let final = false;
  if (c.seal) {
    const gate = sealGate(c.hourly, c.window, prev);
    // Гейт не прошёл — НЕ пишем и non-final: retry следующим прогоном, а
    // покороченный ряд не подсовывается клиенту даже временно.
    if (gate) return keepOrSkip(prev, `гейт полноты: ${gate}`);
    final = true;
  }
  return {
    outcome: "write",
    doc: {
      schemaVersion: FORECAST_SCHEMA_VERSION,
      series: c.series,
      season: c.season,
      eventId: c.eventId,
      parserVersion: FORECAST_PARSER_VERSION,
      regime: c.regime,
      final,
      coord: c.coord,
      typical: c.regime === "typical" ? { years: c.typicalYears ?? 0 } : null,
      hourly: c.hourly,
    },
  };
}
