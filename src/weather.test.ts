// Историческая погода (lib/weather.ts). Архив write-once, поэтому проверяется
// то, что запечаталось бы навсегда: единицы, дубли, счёт агрегатов ПО ВРЕМЕНИ,
// накопление без удалений и предохранители записи.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOpenF1, summarize, summarizeEvent, weightsOf, msToKmh,
  mergeWeatherEvent, weatherRegression,
  WEATHER_SCHEMA_VERSION, WEATHER_PARSER_VERSION,
  type WeatherDoc, type WeatherSession,
} from "./lib/weather.js";

const T0 = Date.parse("2024-11-03T14:38:00Z");
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

const row = (offsetSec: number, over: Record<string, unknown> = {}) => ({
  date: iso(offsetSec),
  air_temperature: 22.2, track_temperature: 27.3, humidity: 86,
  pressure: 927.4, wind_speed: 1, wind_direction: 180, rainfall: 0,
  ...over,
});

// MARK: - Нормализация

test("нормализация: ветер переводится м/с → км/ч ровно один раз", () => {
  assert.equal(msToKmh(1), 3.6);
  assert.equal(msToKmh(0), 0);
  assert.equal(msToKmh(null), null);
  const { samples } = normalizeOpenF1([row(0, { wind_speed: 2.5 })]);
  assert.equal(samples.windKmh[0], 9, "2.5 м/с = 9 км/ч");
});

test("нормализация: дубли таймстампа схлопываются, ряд сортируется", () => {
  const { samples, reject } = normalizeOpenF1([
    row(120), row(0), row(120, { air_temperature: 99 }), row(60),
  ]);
  assert.equal(reject, null);
  assert.deepEqual(samples.t.map((t) => t - Math.round(T0 / 1000)), [0, 60, 120]);
  assert.equal(samples.airC[2], 22.2, "берётся ПЕРВЫЙ из дублей, а не последний");
});

test("нормализация: дождь — честный бинарный флаг датчика", () => {
  const { samples } = normalizeOpenF1([row(0, { rainfall: 1 }), row(60, { rainfall: 0 })]);
  assert.deepEqual(samples.rain, [1, 0]);
  // Ни миллиметров, ни вероятности, ни WMO-кода в отсчётах быть не может.
  assert.deepEqual(Object.keys(samples).sort(),
    ["airC", "humidity", "pressureHpa", "rain", "t", "trackC", "windDeg", "windKmh"]);
});

test("нормализация: пустой ответ — отказ, а не пустой валидный ряд", () => {
  assert.equal(normalizeOpenF1([]).reject, "нет отсчётов");
  assert.match(normalizeOpenF1([{ date: "не дата" }]).reject!, /метк/);
});

/// Перепутанные единицы — главный способ отравить архив навсегда: файл
/// запечатывается и больше не пересобирается. Значит ловить надо ДО записи.
test("нормализация: значение вне диапазона отвергает сессию целиком", () => {
  // Ветер, случайно оставленный в м/с там, где ждали км/ч, диапазон пройдёт —
  // а вот подсунутые узлы или мили дадут абсурд.
  const r = normalizeOpenF1([row(0), row(60, { wind_speed: 100 })]);
  assert.match(r.reject!, /windKmh=360 вне диапазона 0..150/);
  assert.deepEqual(r.samples.t, [], "отвергнутая сессия не отдаёт частичный ряд");

  assert.match(normalizeOpenF1([row(0, { air_temperature: 300 })]).reject!, /airC=300/);
  assert.match(normalizeOpenF1([row(0, { pressure: 27.3 })]).reject!, /pressureHpa=27.3/);
  // Мехико: 779 гПа — реальное давление, браковать нельзя.
  assert.equal(normalizeOpenF1([row(0, { pressure: 779 })]).reject, null);
  // Бахрейн: +58 °C на трассе — тоже реальность.
  assert.equal(normalizeOpenF1([row(0, { track_temperature: 58 })]).reject, null);
});

// MARK: - Агрегаты по времени

test("веса: последнему отсчёту достаётся типичный шаг, а не ноль и не провал", () => {
  assert.deepEqual(weightsOf([0, 60, 120]), [60, 60, 60]);
  assert.deepEqual(weightsOf([]), []);
  assert.deepEqual(weightsOf([5]), [1]);
  // Провал каденса не имеет права стать «типичным шагом»: на коротком ряду
  // верхняя медиана отдала бы последнему отсчёту вес дыры.
  assert.deepEqual(weightsOf([0, 60, 1500]), [60, 1440, 60]);
  assert.deepEqual(weightsOf([0, 60, 120, 1560, 1620]), [60, 60, 1440, 60, 60]);
});

/// Ключевой тест шага: счёт по СТРОКАМ дал бы неверную долю мокрого времени,
/// и она застыла бы в архиве. Каденс источников плавает — у FOM провалы до
/// 24 минут между отсчётами.
test("сводка: доля мокрого времени считается по ВРЕМЕНИ, а не по строкам", () => {
  // Три отсчёта: сухо 60 с, сухо 1440 с (провал каденса), мокро 60 с.
  const { samples } = normalizeOpenF1([
    row(0, { rainfall: 0 }),
    row(60, { rainfall: 0 }),
    row(1500, { rainfall: 1 }),
  ]);
  const s = summarize(samples);
  // По строкам вышло бы 1/3 = 0.333. По времени последний отсчёт весит
  // медианный шаг (60 с) из 60 + 1440 + 60 = 1560.
  assert.equal(s.wetShare, Math.round((60 / 1560) * 1000) / 1000);
  assert.ok(s.wetShare < 0.05, "одиночная капля в конце — не дождевая гонка");
  assert.equal(s.wet, false);
});

test("сводка: min/max честные, среднее взвешенное", () => {
  const { samples } = normalizeOpenF1([
    row(0, { air_temperature: 10 }),
    row(60, { air_temperature: 20 }),
    row(120, { air_temperature: 30 }),
  ]);
  const s = summarize(samples);
  assert.deepEqual(s.airC, { min: 10, max: 30, avg: 20 });
});

test("сводка события: ночь между сессиями не размывает дождь", () => {
  // Практика в пятницу (сухо) и гонка в воскресенье (мокро). Сквозной расчёт
  // по объединённому ряду дал бы промежутку вес в двое суток.
  const dry = normalizeOpenF1([row(0), row(60), row(120)]).samples;
  const wet = normalizeOpenF1([
    row(200000, { rainfall: 1 }), row(200060, { rainfall: 1 }), row(200120, { rainfall: 1 }),
  ]).samples;
  const sessions: WeatherSession[] = [
    { key: "1", name: "Practice 1", startedAt: dry.t[0], endedAt: dry.t[2],
      samples: dry, summary: summarize(dry) },
    { key: "2", name: "Race", startedAt: wet.t[0], endedAt: wet.t[2],
      samples: wet, summary: summarize(wet) },
  ];
  const s = summarizeEvent(sessions);
  assert.equal(s.wetShare, 0.5, "половина наблюдавшегося времени — мокрая");
  assert.equal(s.wet, true);
});

// MARK: - Накопление и предохранители

const doc = (sessions: WeatherSession[], over: Partial<WeatherDoc> = {}): WeatherDoc => ({
  schemaVersion: WEATHER_SCHEMA_VERSION, series: "f1", season: 2025, eventId: "f1-2025-1",
  parserVersion: WEATHER_PARSER_VERSION, final: false,
  timeAnchor: { method: "native", confidenceSec: 0 },
  sessions, summary: summarizeEvent(sessions), ...over,
});

const session = (key: string, n: number): WeatherSession => {
  const { samples } = normalizeOpenF1(Array.from({ length: n }, (_, i) => row(i * 60)));
  return { key, name: `S${key}`, startedAt: samples.t[0] ?? null,
           endedAt: samples.t[n - 1] ?? null, samples, summary: summarize(samples) };
};

test("слияние: сессия, пропавшая у источника, остаётся в архиве", () => {
  const prev = doc([session("1", 3), session("2", 3)]);
  const next = doc([session("1", 3)]);           // источник отдал только одну
  const merged = mergeWeatherEvent(prev, next);
  assert.deepEqual(merged.sessions.map((s) => s.key), ["1", "2"],
                   "снятое не стирается: у источника мог отвалиться один файл");
});

test("слияние: короткий ряд не затирает длинный", () => {
  const prev = doc([session("1", 10)]);
  const next = doc([session("1", 3)]);           // обрезанный ответ во время лайва
  const merged = mergeWeatherEvent(prev, next);
  assert.equal(merged.sessions[0].samples.t.length, 10);
});

test("слияние: более полный ряд побеждает — архив дозаполняется", () => {
  const prev = doc([session("1", 3)]);
  const next = doc([session("1", 12)]);
  assert.equal(mergeWeatherEvent(prev, next).sessions[0].samples.t.length, 12);
});

test("предохранитель: сессий или отсчётов стало меньше — файл не трогаем", () => {
  const prev = doc([session("1", 5), session("2", 5)]);
  assert.equal(weatherRegression(prev, prev), null);
  assert.match(weatherRegression(prev, doc([session("1", 5)]))!, /сессий стало меньше/);
  assert.match(weatherRegression(prev, doc([session("1", 2), session("2", 5)]))!,
               /отсчётов стало меньше/);
  assert.match(weatherRegression(prev, doc([session("1", 5), session("9", 5)]))!,
               /сессия 2 пропала/);
  assert.equal(weatherRegression(null, doc([session("1", 1)])), null,
               "первая запись сравнивать не с чем");
});
