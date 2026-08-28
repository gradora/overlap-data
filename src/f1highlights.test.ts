// Тесты деривации хайлайтов уик-энда из зеркала OpenF1.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestSeconds, computeFastestLap, computeFastestPitStop, computeRaceFastestLap,
  formatLap, lapSeconds, raceTag, sessionTag, shortDriver,
} from "./producers/f1highlights.js";

test("sessionTag: круговые сессии, гонки — нет", () => {
  assert.equal(sessionTag("Practice 1"), "FP1");
  assert.equal(sessionTag("Practice 3"), "FP3");
  assert.equal(sessionTag("Qualifying"), "Q");
  assert.equal(sessionTag("Sprint Qualifying"), "SQ");
  assert.equal(sessionTag("Sprint Shootout"), "SQ");
  assert.equal(sessionTag("Sprint"), null);
  assert.equal(sessionTag("Race"), null);
});

test("bestSeconds: число, массив квалы с null, мусор", () => {
  assert.equal(bestSeconds(104.361), 104.361);
  assert.equal(bestSeconds([105.1, 104.5, null]), 104.5);
  assert.equal(bestSeconds([null, null]), null);
  assert.equal(bestSeconds(undefined), null);
});

test("formatLap: M:SS.mmm с ведущим нулём секунд", () => {
  assert.equal(formatLap(104.361), "1:44.361");
  assert.equal(formatLap(66.113), "1:06.113");
});

test("computeFastestLap: минимум по круговым сессиям, имя из drivers", () => {
  const sessions = [
    { session_key: 1, session_name: "Practice 1" },
    { session_key: 2, session_name: "Qualifying" },
    { session_key: 3, session_name: "Race" },
  ];
  const results = new Map<number, any[]>([
    [1, [{ driver_number: 4, duration: 105.2 }]],
    [2, [{ driver_number: 12, duration: [105.0, 104.361, null] }, { driver_number: 4, duration: [104.8] }]],
    [3, [{ driver_number: 1, duration: 5400 }]],   // гонка — игнор
  ]);
  const drivers = [
    { driver_number: 4, first_name: "Lando", last_name: "Norris" },
    { driver_number: 12, first_name: "Kimi", last_name: "Antonelli" },
  ];
  const lap = computeFastestLap(sessions, results, drivers)!;
  assert.equal(lap.time, "1:44.361");
  assert.equal(lap.driver, "K. Antonelli");
  assert.equal(lap.tag, "Q");
  assert.equal(computeFastestLap([{ session_key: 9, session_name: "Race" }], new Map(), []), null);
});

test("shortDriver: инициал + фамилия, фолбэк broadcast", () => {
  assert.equal(shortDriver("Kimi", "Antonelli"), "K. Antonelli");
  assert.equal(shortDriver(undefined, undefined, "M VERSTAPPEN"), "M VERSTAPPEN");
});

test("computeFastestPitStop: минимум stop_duration по гонкам, практика — мимо", () => {
  const sessions = [
    { session_key: 1, session_name: "Practice 1" },
    { session_key: 2, session_name: "Sprint" },
    { session_key: 3, session_name: "Race" },
    { session_key: 4, session_name: "Sprint Qualifying" },
  ];
  const pits = new Map<number, any[]>([
    [1, [{ driver_number: 4, stop_duration: 1.0 }]],          // практика — игнор
    [2, [{ driver_number: 4, stop_duration: 2.6 }]],
    [3, [{ driver_number: 16, stop_duration: 2.3 }, { driver_number: 4, stop_duration: null }]],
    [4, [{ driver_number: 4, stop_duration: 0.5 }]],          // спринт-квала — игнор
  ]);
  const drivers = [
    { driver_number: 4, first_name: "Lando", last_name: "Norris" },
    { driver_number: 16, first_name: "Charles", last_name: "Leclerc" },
  ];
  const stop = computeFastestPitStop(sessions, pits, drivers)!;
  assert.equal(stop.seconds, 2.3);
  assert.equal(stop.driver, "C. Leclerc");
  assert.equal(stop.tag, "R");
  assert.equal(computeFastestPitStop(sessions, new Map(), drivers), null);
});

test("raceTag: гонки да, квалы нет", () => {
  assert.equal(raceTag("Race"), "R");
  assert.equal(raceTag("Sprint"), "SPR");
  assert.equal(raceTag("Sprint Qualifying"), null);
  assert.equal(raceTag("Qualifying"), null);
  assert.equal(raceTag("Practice 1"), null);
});

// MARK: - Быстрый круг ГОНКИ (fastestLapRace)
// Разведение двух величин, которые до сих пор жили под одним именем: лучший
// круг уик-энда (практики+квала, гонка исключена) и быстрый круг гонки —
// та самая классическая величина, которую на экране команды считает
// «Fastest laps».

const raceDoc = (results: any[]) => ({
  MRData: { RaceTable: { Races: [{ Results: results }] } },
});

const row = (given: string, family: string, rank: string, time: string, code = "") => ({
  Driver: { givenName: given, familyName: family, code },
  FastestLap: { rank, lap: "63", Time: { time } },
});

test("быстрый круг гонки берётся по РАНГУ, а не по минимуму времени", () => {
  // Ранг проставляет источник: круг, не засчитанный из-за лимитов трассы,
  // ранга не получает, хотя по времени может быть быстрее.
  const doc = raceDoc([
    row("Max", "Verstappen", "2", "1:13.900"),
    row("George", "Russell", "1", "1:14.119"),
  ]);
  const lap = computeRaceFastestLap(doc);
  assert.equal(lap?.driver, "G. Russell", "взяли по времени вместо ранга");
  assert.equal(lap?.time, "1:14.119");
  assert.equal(lap?.tag, "R", "тег обязан отличать круг гонки от круга уик-энда");
  assert.ok(Math.abs((lap?.seconds ?? 0) - 74.119) < 0.001);
});

test("быстрый круг гонки: нет протокола или нет ранга — поля просто нет", () => {
  assert.equal(computeRaceFastestLap(null), null);
  assert.equal(computeRaceFastestLap(raceDoc([])), null);
  // Гонка не классифицирована: круги есть, ранга 1 нет.
  assert.equal(computeRaceFastestLap(raceDoc([row("Max", "Verstappen", "3", "1:13.9")])), null);
});

test("разбор времени круга: минуты необязательны, мусор — null", () => {
  assert.ok(Math.abs((lapSeconds("1:14.119") ?? 0) - 74.119) < 1e-9);
  assert.ok(Math.abs((lapSeconds("58.921") ?? 0) - 58.921) < 1e-9);
  assert.equal(lapSeconds("1:28:03.403"), null, "полное время гонки — не круг");
  assert.equal(lapSeconds(""), null);
  assert.equal(lapSeconds("—"), null);
});

test("две величины не подменяют друг друга", () => {
  // Круг уик-энда считается ТОЛЬКО по круговым сессиям — гонка исключена
  // (в её протоколе дистанция, не круг), поэтому источники не пересекаются.
  assert.equal(sessionTag("Race"), null);
  assert.equal(sessionTag("Sprint"), null);
  assert.equal(sessionTag("Qualifying"), "Q");
  // А круг гонки приходит с тегом «R» — их всегда можно различить.
  const lap = computeRaceFastestLap(raceDoc([row("George", "Russell", "1", "1:14.119")]));
  assert.equal(lap?.tag, "R");
});
