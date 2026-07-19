// Тесты деривации хайлайтов уик-энда из зеркала OpenF1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bestSeconds, computeFastestLap, formatLap, sessionTag, shortDriver } from "./f1highlights.js";

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
