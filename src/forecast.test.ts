// Витринный прогноз (lib/forecast.ts + lib/openmeteo.ts). Проверяется то, что
// при осечке запечаталось бы или ушло клиенту кривым: выбор режима по датам
// (порт клиентского regime), усреднение климатологии (порт makeTypical —
// модальный WMO, «при равенстве хуже», кворум лет), гейт полноты seal,
// kept-previous и санация диапазонов. Всё бессетевое, фикстурами.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forecastRegime, makeTypical, shiftYearsUTC, sealGate, resolveForecast,
  clipNowHourly, FORECAST_SCHEMA_VERSION, FORECAST_PARSER_VERSION, TYPICAL_QUORUM,
  type ForecastDoc, type ForecastCandidate, type TypicalBlob,
} from "./lib/forecast.js";
import {
  sanitizeHourly, forecastURL, archiveURL, nowURL,
  type ForecastHourly, type EventWindow,
} from "./lib/openmeteo.js";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse("2026-09-08T12:00:00Z");

/// Однородный почасовой блок: n часов с шагом час от startSec.
const mkHourly = (startSec: number, n: number, over: Partial<ForecastHourly> = {}): ForecastHourly => ({
  time: Array.from({ length: n }, (_, i) => startSec + i * 3600),
  temperature_2m: Array(n).fill(20),
  precipitation_probability: Array(n).fill(10),
  precipitation: Array(n).fill(0),
  wind_speed_10m: Array(n).fill(12),
  weather_code: Array(n).fill(1),
  ...over,
});

// MARK: - Режим по датам (порт WeatherService.regime)

test("режим: решает дальняя кромка события (+1 день), семантика клиента 1:1", () => {
  // Конец окна за горизонтом прогноза → климатология целиком.
  const far = (days: number): EventWindow =>
    ({ startMs: NOW + (days - 2) * DAY_MS, endMs: NOW + days * DAY_MS });
  assert.equal(forecastRegime(far(20), NOW), "typical");
  // Граница строгая: end+1д ровно 16 дней — ещё прогноз, на миллисекунду
  // дальше — уже климатология.
  assert.equal(forecastRegime({ startMs: NOW + 13 * DAY_MS, endMs: NOW + 15 * DAY_MS }, NOW), "forecast");
  assert.equal(forecastRegime({ startMs: NOW + 13 * DAY_MS, endMs: NOW + 15 * DAY_MS + 1 }, NOW), "typical");
});

test("режим: недавно прошедшее — forecast (past_days достаёт), глубже 85 дней — archive", () => {
  const past = (days: number): EventWindow =>
    ({ startMs: NOW - (days + 2) * DAY_MS, endMs: NOW - days * DAY_MS });
  assert.equal(forecastRegime(past(30), NOW), "forecast", "≤85 дней — Forecast API с past_days");
  assert.equal(forecastRegime(past(85), NOW), "forecast", "граница строгая, как у клиента");
  assert.equal(forecastRegime(past(86), NOW), "archive");
  // Идущее прямо сейчас событие — прогноз.
  assert.equal(forecastRegime({ startMs: NOW - DAY_MS, endMs: NOW + DAY_MS }, NOW), "forecast");
});

// MARK: - Климатология (порт makeTypical)

/// Окно короткое, чтобы фикстуры оставались обозримыми.
const TW: EventWindow = {
  startMs: Date.parse("2026-06-05T10:00:00Z"),
  endMs: Date.parse("2026-06-05T12:00:00Z"),
};

/// Блок прошлого года: те же часы окна (+1 день хвоста), сдвинутые на offset
/// лет назад — ровно то, что вернул бы Archive API за прошлогодние даты.
function typicalBlob(offset: number, over: Partial<ForecastHourly> = {}): TypicalBlob {
  const time: number[] = [];
  for (let t = TW.startMs; t <= TW.endMs + DAY_MS; t += HOUR_MS) {
    time.push(Math.round(shiftYearsUTC(t, -offset) / 1000));
  }
  const n = time.length;
  return {
    offset,
    hourly: {
      time,
      temperature_2m: Array(n).fill(20),
      precipitation_probability: Array(n).fill(null),
      precipitation: Array(n).fill(0),
      wind_speed_10m: Array(n).fill(12),
      weather_code: Array(n).fill(1),
      ...over,
    },
  };
}

test("климатология: температура и ветер усредняются по годам, оси параллельны", () => {
  const n = typicalBlob(1).hourly.time.length;
  const typ = makeTypical([
    typicalBlob(1, { temperature_2m: Array(n).fill(10), wind_speed_10m: Array(n).fill(10) }),
    typicalBlob(2, { temperature_2m: Array(n).fill(20), wind_speed_10m: Array(n).fill(14) }),
    typicalBlob(3, { temperature_2m: Array(n).fill(30), wind_speed_10m: Array(n).fill(18) }),
  ], TW)!;
  assert.equal(typ.time[0], TW.startMs / 1000, "ряд на датах ЭТОГО события, не прошлых лет");
  assert.equal(typ.temperature_2m[0], 20);
  assert.equal(typ.wind_speed_10m[0], 14);
  // Вероятности осадков у ERA5 нет: ось null-выровнена, а не пуста.
  assert.equal(typ.precipitation_probability.length, typ.time.length);
  assert.ok(typ.precipitation_probability.every((v) => v === null));
});

test("климатология: модальный WMO-код, при равенстве частот — хуже", () => {
  const n = typicalBlob(1).hourly.time.length;
  const withCode = (offset: number, code: number) =>
    typicalBlob(offset, { weather_code: Array(n).fill(code) });
  // Частота побеждает: два года ясно, один с грозой → ясно.
  const majority = makeTypical([withCode(1, 1), withCode(2, 1), withCode(3, 95)], TW)!;
  assert.equal(majority.weather_code[0], 1);
  // Равенство 1:1 → больший код (более «серьёзная» погода), не меньший.
  const tie = makeTypical([withCode(1, 3), withCode(2, 61)], TW)!;
  assert.equal(tie.weather_code[0], 61);
});

test("климатология: округление температур до усреднения — половина ОТ нуля (порт Swift)", () => {
  const n = typicalBlob(1).hourly.time.length;
  // 20.6 → 21 и 20.2 → 20 сначала, среднее уже по целым: 20.5, а не 20.4.
  const typ = makeTypical([
    typicalBlob(1, { temperature_2m: Array(n).fill(20.6) }),
    typicalBlob(2, { temperature_2m: Array(n).fill(20.2) }),
  ], TW)!;
  assert.equal(typ.temperature_2m[0], 20.5);
  // Морозная граница: Int((-22.5).rounded()) в Swift — это −23, не −22.
  const cold = makeTypical([typicalBlob(1, { temperature_2m: Array(n).fill(-22.5) })], TW)!;
  assert.equal(cold.temperature_2m[0], -23);
});

test("климатология: год без часа выпадает из среднего, час без единого года — из ряда", () => {
  const n = typicalBlob(1).hourly.time.length;
  const short = typicalBlob(2);
  // Второй год «ослеп» после первого часа: температура null не матчится.
  // Сосед в пределах ±90 мин ещё подтянется (семантика клиентского
  // weather(at:)), поэтому честная проверка — час на расстоянии 2ч.
  short.hourly.temperature_2m = short.hourly.temperature_2m.map((v, i) => (i === 0 ? v : null));
  short.hourly.temperature_2m[0] = 30;
  const typ = makeTypical([
    typicalBlob(1, { temperature_2m: Array(n).fill(10) }),
    short,
  ], TW)!;
  assert.equal(typ.temperature_2m[0], 20, "первый час — среднее двух лет");
  assert.equal(typ.temperature_2m[2], 10, "дальше 90 мин остался один год — без выдумки за второй");

  // Ни один год не покрыл окно → ряда нет вовсе, а не пустой валидный блок.
  const off = typicalBlob(1);
  off.hourly.temperature_2m = off.hourly.temperature_2m.map(() => null);
  assert.equal(makeTypical([off], TW), null);
  assert.equal(makeTypical([], TW), null);
});

test("климатология: сдвиг на год — григорианский UTC, 29 февраля сползает на 28-е", () => {
  const feb29 = Date.parse("2024-02-29T14:00:00Z");
  assert.equal(new Date(shiftYearsUTC(feb29, -1)).toISOString(), "2023-02-28T14:00:00.000Z");
  const plain = Date.parse("2026-06-05T10:30:00Z");
  assert.equal(new Date(shiftYearsUTC(plain, -3)).toISOString(), "2023-06-05T10:30:00.000Z");
});

// MARK: - Гейт полноты seal

/// Окно из 10 часовых меток; hourly с запасом −1ч…+1ч вокруг.
const SW: EventWindow = { startMs: NOW, endMs: NOW + 9 * HOUR_MS };
const sealHourly = (over: Partial<ForecastHourly> = {}) =>
  mkHourly(NOW / 1000 - 3600, 12, over);

test("гейт seal: пропуск только при полном покрытии окна", () => {
  assert.equal(sealGate(sealHourly(), SW, null), null);
  // Ряд обрывается до конца окна — печатать нельзя.
  const cut = mkHourly(NOW / 1000 - 3600, 8);
  assert.match(sealGate(cut, SW, null)!, /не покрывает окно/);
  // Ряд начинается после старта окна — тоже.
  const late = mkHourly(NOW / 1000 + 3600, 12);
  assert.match(sealGate(late, SW, null)!, /не покрывает окно/);
});

test("гейт seal: ≥90 % часов ОКНА с температурой; null-хвост за окном не в счёт", () => {
  // 2 из 10 часов окна без температуры → 80 % — мало.
  const holes = sealHourly();
  holes.temperature_2m[2] = null;
  holes.temperature_2m[3] = null;
  assert.match(sealGate(holes, SW, null)!, /меньше 90 %/);
  // 1 из 10 → ровно 90 % — проходит.
  const one = sealHourly();
  one.temperature_2m[2] = null;
  assert.equal(sealGate(one, SW, null), null);
  // null на часах ЗА пределами окна (запас −1/+1 ч) полноту окна не портит.
  const tail = sealHourly();
  tail.temperature_2m[0] = null;
  tail.temperature_2m[11] = null;
  assert.equal(sealGate(tail, SW, null), null);
});

test("гейт seal: часов В ОКНЕ не может стать меньше, чем у prev в том же окне", () => {
  // Кандидат с выбитым внутренним часом окна: 9 против 10 у prev — регрессия.
  const full = sealHourly();
  const gapped: typeof full = {
    time: full.time.filter((_, i) => i !== 5),
    temperature_2m: full.temperature_2m.filter((_, i) => i !== 5),
    precipitation_probability: full.precipitation_probability.filter((_, i) => i !== 5),
    precipitation: full.precipitation.filter((_, i) => i !== 5),
    wind_speed_10m: full.wind_speed_10m.filter((_, i) => i !== 5),
    weather_code: full.weather_code.filter((_, i) => i !== 5),
  };
  const prev = prevDoc({ hourly: mkHourly(NOW / 1000 - 3600, 12) });
  assert.match(sealGate(gapped, SW, prev)!, /часов в окне стало меньше \(10 → 9\)/);
  assert.equal(sealGate(sealHourly(), SW, prev), null);
  // Репро блокера ревью: prev форекаст-фазы с РЯДОМ сильно шире окна (аналог
  // 289 часов Монцы) обязан пропускать archive-кандидата, покрывающего окно:
  // сравнение ПОЛНЫХ длин отвергало бы seal навсегда.
  const widePrev = prevDoc({ hourly: mkHourly(NOW / 1000 - 90 * 3600, 200) });
  assert.equal(sealGate(sealHourly(), SW, widePrev), null,
    "широкий forecast-prev не должен блокировать запечатывание");
});

// MARK: - resolveForecast: kept-previous и сборка документа

function prevDoc(over: Partial<ForecastDoc> = {}): ForecastDoc {
  return {
    schemaVersion: FORECAST_SCHEMA_VERSION, series: "f1", season: 2026, eventId: "e1",
    parserVersion: FORECAST_PARSER_VERSION, regime: "forecast", final: false,
    coord: { lat: 1, lon: 2 }, typical: null, hourly: mkHourly(NOW / 1000, 10),
    ...over,
  };
}

function cand(over: Partial<ForecastCandidate> = {}): ForecastCandidate {
  return {
    series: "f1", season: 2026, eventId: "e1", regime: "forecast",
    coord: { lat: 1, lon: 2 }, window: SW, seal: false, hourly: sealHourly(),
    ...over,
  };
}

test("kept-previous: сеть/пустой ответ не трогает прежний файл, без prev — skip", () => {
  const kept = resolveForecast(prevDoc(), cand({ hourly: null }));
  assert.equal(kept.outcome, "kept-previous");
  const skipped = resolveForecast(null, cand({ hourly: null }));
  assert.equal(skipped.outcome, "skipped");
  // Пустой ряд равносилен отсутствию ответа.
  const empty = resolveForecast(prevDoc(), cand({ hourly: mkHourly(0, 0) }));
  assert.equal(empty.outcome, "kept-previous");
});

test("кворум typical: меньше 3 лет — файл не пишется и не затирается", () => {
  const short = cand({ regime: "typical", typicalYears: TYPICAL_QUORUM - 1 });
  assert.equal(resolveForecast(prevDoc(), short).outcome, "kept-previous");
  assert.equal(resolveForecast(null, short).outcome, "skipped");

  const ok = resolveForecast(null, cand({ regime: "typical", typicalYears: 4 }));
  assert.equal(ok.outcome, "write");
  assert.deepEqual((ok as { doc: ForecastDoc }).doc.typical, { years: 4 },
    "метка «типично» несёт число лет кворума");
});

test("resolveForecast: seal при полном ряде печатает final, при неполном — kept-previous", () => {
  const sealed = resolveForecast(null, cand({ seal: true }));
  assert.equal(sealed.outcome, "write");
  const doc = (sealed as { doc: ForecastDoc }).doc;
  assert.equal(doc.final, true);
  assert.equal(doc.schemaVersion, FORECAST_SCHEMA_VERSION);
  assert.equal(doc.parserVersion, FORECAST_PARSER_VERSION);
  assert.equal(doc.typical, null, "не-typical режим typical не несёт");

  // Обрезанный ответ при попытке запечатать не пишется даже non-final:
  // retry следующим прогоном.
  const cut = resolveForecast(prevDoc(), cand({ seal: true, hourly: mkHourly(NOW / 1000, 4) }));
  assert.equal(cut.outcome, "kept-previous");
  const fresh = resolveForecast(null, cand());
  assert.equal((fresh as { doc: ForecastDoc }).doc.final, false, "без seal файл живой");
});

test("resolveForecast: запечатанное пересобирается только при смене parserVersion или форсе", () => {
  const sealedPrev = prevDoc({ final: true });
  assert.equal(resolveForecast(sealedPrev, cand()).outcome, "unchanged");
  // Устаревшая версия разбора чинит подокументно.
  const stale = prevDoc({ final: true, parserVersion: FORECAST_PARSER_VERSION - 1 });
  assert.equal(resolveForecast(stale, cand({ seal: true })).outcome, "write");
  assert.equal(resolveForecast(sealedPrev, cand({ seal: true, force: true })).outcome, "write");
});

// MARK: - Санация диапазонов (lib/openmeteo.ts)

test("санация: значение вне диапазона → null, а не отказ и не выдумка", () => {
  const h = sanitizeHourly({
    time: [0, 3600],
    temperature_2m: [21.5, 300],           // 300 °C — мусор
    precipitation_probability: [50, 146],  // >100 % — мусор
    precipitation: [0.2, -1],              // отрицательные мм — мусор
    wind_speed_10m: [15, 999],             // 999 км/ч — мусор
    weather_code: [61, 120],               // WMO — 0..99
  })!;
  assert.deepEqual(h.temperature_2m, [21.5, null]);
  assert.deepEqual(h.precipitation_probability, [50, null]);
  assert.deepEqual(h.precipitation, [0.2, null]);
  assert.deepEqual(h.wind_speed_10m, [15, null]);
  assert.deepEqual(h.weather_code, [61, null]);
});

test("санация: отсутствующая ось (probability у Archive) дозаполняется null", () => {
  const h = sanitizeHourly({
    time: [0, 3600],
    temperature_2m: [20, 21],
    precipitation: [0, 0],
    weather_code: [1, 1],
    wind_speed_10m: [10, 10],
  })!;
  assert.deepEqual(h.precipitation_probability, [null, null], "все шесть осей всегда параллельны");
});

test("санация: битая метка времени уносит всю строку, оси не разъезжаются", () => {
  const h = sanitizeHourly({
    time: [0, "не число", 7200],
    temperature_2m: [20, 99, 22],
    precipitation_probability: [1, 2, 3],
    precipitation: [0, 0, 0],
    wind_speed_10m: [10, 10, 10],
    weather_code: [1, 1, 1],
  })!;
  assert.deepEqual(h.time, [0, 7200]);
  assert.deepEqual(h.temperature_2m, [20, 22], "значение выпавшей строки не сместилось на соседа");
});

test("санация: пустой или чужой блок — null, не пустой валидный ряд", () => {
  assert.equal(sanitizeHourly(null), null);
  assert.equal(sanitizeHourly("hourly"), null);
  assert.equal(sanitizeHourly({ time: [] }), null);
  assert.equal(sanitizeHourly({ temperature_2m: [20] }), null);
});

// MARK: - URL-билдеры и полоска now

test("URL: forecast масштабирует past_days/forecast_days под окно, формулы клиентские", () => {
  // Событие целиком в будущем: past_days — минимальный запас 2, вперёд — до
  // конца окна +1 день и ещё +1 запас.
  const future = forecastURL({ lat: 1.5, lon: 2.5 },
    { startMs: NOW + 2 * DAY_MS, endMs: NOW + 4 * DAY_MS }, NOW);
  assert.match(future, /past_days=2&forecast_days=6/);
  assert.match(future, /hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,weather_code/);
  assert.match(future, /timeformat=unixtime&windspeed_unit=kmh/);
  // Недавно прошедшее: past_days накрывает начало окна, forecast_days — минимум.
  const past = forecastURL({ lat: 1.5, lon: 2.5 },
    { startMs: NOW - 12 * DAY_MS, endMs: NOW - 10 * DAY_MS }, NOW);
  assert.match(past, /past_days=14&forecast_days=1/);
  // Клампы API: дальше 92/16 дней не просим.
  const wide = forecastURL({ lat: 1.5, lon: 2.5 },
    { startMs: NOW - 200 * DAY_MS, endMs: NOW + 200 * DAY_MS }, NOW);
  assert.match(wide, /past_days=92&forecast_days=16/);
});

test("URL: archive — ISO-дни и оси без precipitation_probability (у ERA5 её нет)", () => {
  const url = archiveURL({ lat: 47.956, lon: 0.2074 },
    Date.parse("2011-06-10T00:00:00Z"), Date.parse("2011-06-13T00:00:00Z"));
  assert.match(url, /^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?/);
  assert.match(url, /start_date=2011-06-10&end_date=2011-06-13/);
  assert.match(url, /hourly=temperature_2m,precipitation,weather_code,wind_speed_10m&/);
  assert.ok(!url.includes("precipitation_probability"));
});

test("URL: now — лёгкий запрос сутки назад + сутки вперёд, как клиентский fetchCurrent", () => {
  assert.match(nowURL({ lat: 1, lon: 2 }), /past_days=1&forecast_days=1/);
});

test("полоска now: клип −3ч…+6ч вокруг «сейчас»", () => {
  const dayBlock = mkHourly((NOW - DAY_MS) / 1000, 48);
  const clipped = clipNowHourly(dayBlock, NOW);
  assert.equal(clipped.time.length, 10, "−3…+6 часов включительно");
  assert.equal(clipped.time[0], (NOW - 3 * HOUR_MS) / 1000);
  assert.equal(clipped.time[clipped.time.length - 1], (NOW + 6 * HOUR_MS) / 1000);
  assert.equal(clipped.temperature_2m.length, clipped.time.length);
});
