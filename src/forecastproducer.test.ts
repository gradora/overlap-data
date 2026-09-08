// Продьюсер витринного прогноза (producers/forecast.ts). Либы (режимы,
// makeTypical, гейт seal, санация) покрыты src/forecast.test.ts — здесь
// проверяется ПРОВОДКА и бюджет сети: какие события ходят в какой API и
// сколько раз, куда ложатся файлы, что не трогается при осечке и когда
// прогон обязан покраснеть. Всё бессетевое: фетч подменён стабом, который
// отвечает блоком часов ровно на запрошенный диапазон.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildForecast } from "./producers/forecast.js";
import type { ForecastHourly } from "./lib/openmeteo.js";

const NOW = Date.parse("2026-09-08T12:00:00Z");
const HOUR = 3600;
const DAY_MS = 24 * 3600 * 1000;

// MARK: - Фикстуры

/// Карта refs: две трассы с coord (одна — с imsaVenue-алиасом) и одна без —
/// событие на ней обязано выпадать из прогноза без похода в сеть.
const REFS = {
  schemaVersion: 1,
  tracks: [
    { slug: "monza", display: "Monza", country: "Italy", timezone: "Europe/Rome",
      coord: { lat: 45.6156, lon: 9.2811 },
      aliases: { imsaVenue: ["Monza International Speedway"] } },
    { slug: "spa-francorchamps", display: "Spa-Francorchamps", country: "Belgium",
      timezone: "Europe/Brussels", coord: { lat: 50.4372, lon: 5.9714 }, aliases: {} },
    { slug: "phantom", display: "Phantom", country: "X", timezone: "UTC", aliases: {} },
  ],
  pins: [], f1Teams: [], enduranceTeams: [],
  driverExceptions: { particles: [], suffixes: [], special: [] },
  countries: { iso3ToIso2: {}, nameToIso2: {} },
};

interface SeedOpts { f1?: object[]; wec?: object[]; imsa?: object[] }

function seed(opts: SeedOpts = {}): string {
  const root = mkdtempSync(join(tmpdir(), "forecastprod-"));
  mkdirSync(join(root, "refs"), { recursive: true });
  writeFileSync(join(root, "refs", "matching.json"), JSON.stringify(REFS));
  if (opts.f1) {
    mkdirSync(join(root, "f1", "calendar"), { recursive: true });
    writeFileSync(join(root, "f1", "calendar", "2026.json"), JSON.stringify({
      schemaVersion: 2, series: "f1", season: 2026, events: opts.f1,
    }));
  }
  for (const series of ["wec", "imsa"] as const) {
    const events = opts[series];
    if (!events) continue;
    mkdirSync(join(root, series, "2026"), { recursive: true });
    writeFileSync(join(root, series, "2026", "index.json"), JSON.stringify({
      schemaVersion: 1, series, season: 2026, events,
    }));
  }
  return root;
}

const f1Event = (id: string, start: string, race: string, over: object = {}) => ({
  id, round: 1, kind: "race", status: "confirmed", name: id, trackRef: "monza",
  dates: { start, race, raceTime: "13:00:00Z" }, ...over,
});

/// Однородный блок часов, покрывающий [fromMs, toMs] с суточным запасом с
/// обеих сторон — гейту полноты seal этого всегда достаточно.
const block = (fromMs: number, toMs: number): ForecastHourly => {
  const from = Math.floor(fromMs / 3_600_000) * HOUR - 24 * HOUR;
  const n = Math.ceil((toMs - fromMs) / 3_600_000) + 49;
  return {
    time: Array.from({ length: n }, (_, i) => from + i * HOUR),
    temperature_2m: Array(n).fill(21),
    precipitation_probability: Array(n).fill(10),
    precipitation: Array(n).fill(0),
    wind_speed_10m: Array(n).fill(9),
    weather_code: Array(n).fill(2),
  };
};

/// Стаб сети: пишет URL в calls и отвечает блоком ровно на запрошенный
/// диапазон (archive — по start/end_date, forecast — по past/forecast_days
/// вокруг NOW).
const stubFetch = (calls: string[]) => async (url: string): Promise<ForecastHourly | null> => {
  calls.push(url);
  const u = new URL(url);
  if (u.hostname.startsWith("archive")) {
    return block(
      Date.parse(`${u.searchParams.get("start_date")}T00:00:00Z`),
      Date.parse(`${u.searchParams.get("end_date")}T23:59:59Z`));
  }
  return block(
    NOW - Number(u.searchParams.get("past_days")) * DAY_MS,
    NOW + Number(u.searchParams.get("forecast_days")) * DAY_MS);
};

const archiveCalls = (calls: string[]) => calls.filter((u) => u.includes("archive-api"));
const readDoc = (root: string, ...p: string[]) =>
  JSON.parse(readFileSync(join(root, ...p), "utf8"));

// MARK: - Горизонт прогноза

test("горизонт: 1 запрос Forecast API, файл под id витрины, оси параллельны", async () => {
  const root = seed({ f1: [f1Event("f1-2026-17", "2026-09-11", "2026-09-13")] });
  try {
    const calls: string[] = [];
    const r = await buildForecast({ dataDir: root, now: NOW, fetchHourly: stubFetch(calls), log: () => {} });
    assert.equal(r.ok, true);

    const doc = readDoc(root, "f1", "forecast", "f1-2026-17.json");
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.series, "f1");
    assert.equal(doc.eventId, "f1-2026-17");
    assert.equal(doc.regime, "forecast");
    assert.equal(doc.final, false);
    assert.equal(doc.typical, null);
    assert.deepEqual(doc.coord, { lat: 45.6156, lon: 9.2811 }, "lon нужен клиентскому isNight");
    for (const axis of ["temperature_2m", "precipitation_probability", "precipitation",
                        "wind_speed_10m", "weather_code"]) {
      assert.equal(doc.hourly[axis].length, doc.hourly.time.length, `ось ${axis} параллельна time`);
    }

    // Бюджет: 1 запрос на событие + по одному now-запросу на трассу с coord;
    // archive не трогается вовсе.
    assert.equal(archiveCalls(calls).length, 0);
    assert.equal(calls.length, 1 + 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("отстоявшееся: Archive API и печать final; запечатанное дальше — ноль запросов", async () => {
  // Гонка 5 июля при «сейчас» 8 сентября: по клиентскому расчёту дат это ещё
  // forecast (≤85 дней), но окно freeze прошло — файл честно называет свой
  // источник archive и печатается final.
  const root = seed({ f1: [f1Event("f1-2026-13", "2026-07-03", "2026-07-05")] });
  try {
    const calls: string[] = [];
    await buildForecast({ dataDir: root, now: NOW, fetchHourly: stubFetch(calls), log: () => {} });
    const doc = readDoc(root, "f1", "forecast", "f1-2026-13.json");
    assert.equal(doc.regime, "archive");
    assert.equal(doc.final, true);
    assert.equal(archiveCalls(calls).length, 1);

    await buildForecast({ dataDir: root, now: NOW, fetchHourly: stubFetch(calls), log: () => {} });
    assert.equal(archiveCalls(calls).length, 1, "запечатанное не перекачивается");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Боевая траектория живого события сезона — ЕДИНСТВЕННЫЙ путь, которым оно
// попадает в запечатывание: forecast-фаза оставляет prev с ШИРОКИМ рядом
// (past_days+forecast_days ≈ 8–9 суток), archive-кандидат несёт только окно
// ±1 день. Регрессия sealGate, сравнивавшая ПОЛНЫЕ длины рядов, отвергала
// такой seal навсегда (289 → 121 у Монцы-2026) — файл вечно forecast, лишний
// archive-запрос каждый час. Гейт обязан мерить часы В ОКНЕ с обеих сторон.
test("переход forecast → freeze → seal: prev форекаст-фазы не блокирует final", async () => {
  const root = seed({ f1: [f1Event("f1-2026-16", "2026-09-11", "2026-09-13")] });
  try {
    const calls: string[] = [];
    // Прогон в горизонте: живой forecast-файл с рядом сильно шире окна.
    await buildForecast({ dataDir: root, now: NOW, fetchHourly: stubFetch(calls), log: () => {} });
    const live = readDoc(root, "f1", "forecast", "f1-2026-16.json");
    assert.equal(live.regime, "forecast");
    assert.equal(live.final, false);
    const windowHours = 3 * 24 + 1;
    assert.ok(live.hourly.time.length > windowHours * 1.5,
      `фикстура обязана дать ряд шире окна (${live.hourly.time.length})`);

    // Прогон после freeze (гонка + 9 дней): ровно один archive-запрос,
    // файл запечатан, широкий prev — не помеха.
    const afterFreeze = Date.parse("2026-09-22T12:00:00Z");
    await buildForecast({ dataDir: root, now: afterFreeze, fetchHourly: stubFetch(calls), log: () => {} });
    const sealed = readDoc(root, "f1", "forecast", "f1-2026-16.json");
    assert.equal(sealed.regime, "archive");
    assert.equal(sealed.final, true);
    assert.equal(archiveCalls(calls).length, 1, "seal — ровно один archive-запрос");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// MARK: - Климатология

test("климатология: отложена вне суточного слота; в слоте — 5 archive-лет и метка typical", async () => {
  const root = seed({
    wec: [{ round: 8, slug: "6-hours-of-monza-2026", name: "6H Monza", trackRef: "monza",
            start: "2026-11-06T00:00:00+01:00", end: "2026-11-08T23:59:00+01:00" }],
  });
  try {
    const calls: string[] = [];
    // Ежечасный прогон: дальнее будущее не ходит в сеть и файла не создаёт.
    const hourly = await buildForecast({ dataDir: root, now: NOW, fetchHourly: stubFetch(calls), log: () => {} });
    assert.equal(hourly.ok, true);
    assert.equal(existsSync(join(root, "wec", "forecast", "wec-2026-6-hours-of-monza-2026.json")), false);
    assert.equal(archiveCalls(calls).length, 0);

    // Суточный слот: по одному archive-запросу на каждый из 5 прошлых лет.
    await buildForecast({ dataDir: root, now: NOW, typical: true, fetchHourly: stubFetch(calls), log: () => {} });
    assert.equal(archiveCalls(calls).length, 5);
    const doc = readDoc(root, "wec", "forecast", "wec-2026-6-hours-of-monza-2026.json");
    assert.equal(doc.regime, "typical");
    assert.equal(doc.final, false);
    assert.deepEqual(doc.typical, { years: 5 }, "UI печатает «Typical…» и кворум лет");
    assert.ok(doc.hourly.precipitation_probability.every((v: unknown) => v === null),
      "вероятности у ERA5 нет — ось null-выровнена");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("климатология: кворум 2 года из 5 — файл не пишется", async () => {
  const root = seed({
    wec: [{ round: 8, slug: "6-hours-of-monza-2026", name: "6H Monza", trackRef: "monza",
            start: "2026-11-06T00:00:00+01:00", end: "2026-11-08T23:59:00+01:00" }],
  });
  try {
    const calls: string[] = [];
    const flaky = async (url: string): Promise<ForecastHourly | null> => {
      // Отвечают только 2025 и 2024 — три старших года «падают».
      if (url.includes("archive-api") && !/start_date=202[45]/.test(url)) { calls.push(url); return null; }
      return stubFetch(calls)(url);
    };
    const r = await buildForecast({ dataDir: root, now: NOW, typical: true, fetchHourly: flaky, log: () => {} });
    assert.equal(r.ok, true, "недобор кворума — штатный skip, не системная поломка");
    assert.equal(existsSync(join(root, "wec", "forecast", "wec-2026-6-hours-of-monza-2026.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// MARK: - Предохранители

test("kept-previous: осечка сети не трогает файл; мёртвая сеть без prev красит прогон", async () => {
  const root = seed({ f1: [f1Event("f1-2026-17", "2026-09-11", "2026-09-13")] });
  try {
    await buildForecast({ dataDir: root, now: NOW, fetchHourly: stubFetch([]), log: () => {} });
    const path = join(root, "f1", "forecast", "f1-2026-17.json");
    const before = readFileSync(path, "utf8");

    const r2 = await buildForecast({ dataDir: root, now: NOW, fetchHourly: async () => null, log: () => {} });
    assert.equal(readFileSync(path, "utf8"), before, "прежний файл не тронут");
    assert.equal(r2.ok, true, "kept-previous — штатная деградация: файл жив");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // Тот же отказ сети, но удерживать нечего: событие в горизонте есть, а на
  // выходе ноль — системная поломка, прогон обязан покраснеть (предполёт).
  const fresh = seed({ f1: [f1Event("f1-2026-17", "2026-09-11", "2026-09-13")] });
  try {
    const r = await buildForecast({ dataDir: fresh, now: NOW, fetchHourly: async () => null, log: () => {} });
    assert.equal(r.ok, false);
    assert.equal(existsSync(join(fresh, "f1", "forecast", "f1-2026-17.json")), false);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

// MARK: - weather/now.json

test("now.json: полоска −3ч…+6ч по трекам с coord; осечка трассы держит прежнюю запись", async () => {
  const root = seed({});
  try {
    const calls: string[] = [];
    await buildForecast({ dataDir: root, now: NOW, fetchHourly: stubFetch(calls), log: () => {} });
    const doc = readDoc(root, "weather", "now.json");
    assert.equal(doc.schemaVersion, 1);
    assert.deepEqual(Object.keys(doc.tracks).sort(), ["monza", "spa-francorchamps"],
      "трек без coord в файл не попадает");
    const strip = doc.tracks.monza.hourly;
    assert.equal(strip.time.length, 10, "−3ч…+6ч вокруг «сейчас» — 10 круглых часов");
    assert.ok(strip.time[0] >= NOW / 1000 - 3 * HOUR && strip.time[strip.time.length - 1] <= NOW / 1000 + 6 * HOUR);
    assert.deepEqual(doc.tracks.monza.coord, { lat: 45.6156, lon: 9.2811 });

    // Спа не отвечает — её запись остаётся из прежнего файла (пер-трековый
    // kept-previous), Монца обновляется.
    const flaky = async (url: string): Promise<ForecastHourly | null> =>
      url.includes("5.9714") ? null : stubFetch(calls)(url);
    await buildForecast({ dataDir: root, now: NOW + 3_600_000, fetchHourly: flaky, log: () => {} });
    const doc2 = readDoc(root, "weather", "now.json");
    assert.deepEqual(doc2.tracks["spa-francorchamps"], doc.tracks["spa-francorchamps"]);
    assert.notDeepEqual(doc2.tracks.monza.hourly.time, doc.tracks.monza.hourly.time);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// MARK: - Привязка к трассе

test("привязка: IMSA-venue через imsaVenue-алиас; отмена и трасса без coord — мимо сети", async () => {
  const root = seed({
    f1: [
      f1Event("f1-meeting-1282", "2026-09-11", "2026-09-13", { kind: "cancelled" }),
      f1Event("f1-2026-x", "2026-09-18", "2026-09-20", { trackRef: "phantom" }),
    ],
    imsa: [{ round: 11, slug: "monza", name: "Monza IMSA", venue: "Monza International Speedway",
             start: "2026-09-10T12:00:00.000Z", end: "2026-09-12T20:00:00.000Z" }],
  });
  try {
    const calls: string[] = [];
    const r = await buildForecast({ dataDir: root, now: NOW, fetchHourly: stubFetch(calls), log: () => {} });
    assert.equal(r.ok, true);
    const doc = readDoc(root, "imsa", "forecast", "imsa-2026-11.json");
    assert.equal(doc.regime, "forecast");
    assert.equal(doc.eventId, "imsa-2026-11", "ключ IMSA — раунд, конвенция weather/");
    // Отменённый этап и трасса без координат не породили ни файлов, ни
    // запросов: 1 событие + 2 now-трека.
    assert.equal(existsSync(join(root, "f1", "forecast", "f1-meeting-1282.json")), false);
    assert.equal(existsSync(join(root, "f1", "forecast", "f1-2026-x.json")), false);
    assert.equal(calls.length, 1 + 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
