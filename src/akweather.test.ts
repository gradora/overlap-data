// Погода Al Kamel (lib/akweather.ts) — шаг 5.6.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  akWeatherSession, normalizeAlKamel, pickWeatherCsvs, writeAkWeather,
} from "./lib/akweather.js";
import { WEATHER_SCHEMA_VERSION, summarizeEvent } from "./lib/weather.js";

test("нормализация: юниты из колонок, мусор за диапазонами отброшен, RAIN не пишется", () => {
  const s = normalizeAlKamel([
    { TIME_UTC_SECONDS: "1776596568", AIR_TEMP: "22", TRACK_TEMP: "36.1",
      HUMIDITY: "54", PRESSURE: "1010.7", WIND_SPEED: "5",
      AIR_TEMP_UNIT: "ºC", TRACK_TEMP_UNIT: "ºC", WIND_SPEED_UNIT: "KPH" },
    // IMSA-макет: фаренгейты и мили — конверсия по КОЛОНКАМ юнитов.
    { TIME_UTC_SECONDS: "1776596668", AIR_TEMP: "77", TRACK_TEMP: "212",
      WIND_SPEED: "10", AIR_TEMP_UNIT: "ºF", TRACK_TEMP_UNIT: "ºF",
      WIND_SPEED_UNIT: "MPH" },
    { TIME_UTC_SECONDS: "0", AIR_TEMP: "99" },       // нулевое время — мимо
  ] as never);
  assert.deepEqual(s.t.length, 2);
  assert.equal(s.airC[1]! - 25 < 0.01, true, "77°F → 25°C");
  assert.equal(s.trackC[1], null, "212°F = 100°C — за диапазоном полотна, отброшено");
  assert.ok(Math.abs(s.windKmh[1]! - 16.09344) < 0.001, "10 MPH → 16.09 км/ч");
  assert.deepEqual(s.rain, [], "RAIN Al Kamel непригоден — не пишется вовсе");
});

test("выбор CSV: оба макета гонки сводятся к сессии Race, огрызки Race N — дубли", () => {
  // Макет 6-часовых: срезы часами В ФАЙЛАХ каталога Race.
  const sixHours = pickWeatherCsvs([
    "x/202604191300_Race/26_Weather_Race_Hour%203.CSV",
    "x/202604191300_Race/26_Weather_Race_Hour%206.CSV",
    "x/202604171015_Free%20Practice%201/26_Weather_Free%20Practice%201.CSV",
  ]);
  assert.deepEqual(sixHours.map((p) => p.session).sort(), ["Free Practice 1", "Race"]);
  assert.match(decodeURIComponent(sixHours.find((p) => p.session === "Race")!.href), /Hour 6/);

  // Макет Ле-Мана: срезы часами КАТАЛОГАМИ (кумулятивные) + огрызки Race N.
  const leMans = pickWeatherCsvs([
    "x/202606141600_Hour%2012/26_Weather_Hour%2012.CSV",
    "x/202606142000_Hour%2024/26_Weather_Hour%2024.CSV",
    "x/202606131500_Race%201/26_Weather_Race%201.CSV",
    "x/202606131600_Race%202/26_Weather_Race%202.CSV",
  ]);
  assert.deepEqual(leMans.map((p) => p.session), ["Race"],
    "Hour-каталоги не слились в Race либо огрызки Race N выжили");
  assert.match(decodeURIComponent(leMans[0].href), /Hour 24/);
});

test("write-once по final: запечатанный док не трогается, force пробивает", () => {
  const root = mkdtempSync(join(tmpdir(), "akw-"));
  const sess = akWeatherSession("Race", normalizeAlKamel([
    { TIME_UTC_SECONDS: "100", AIR_TEMP: "20", AIR_TEMP_UNIT: "ºC" },
  ] as never))!;
  const doc = {
    schemaVersion: WEATHER_SCHEMA_VERSION, series: "wec", season: 2031,
    eventId: "wec-2031-imola", source: "alkamel", parserVersion: 1, final: true,
    timeAnchor: { method: "utc-column", confidenceSec: 0 },
    sessions: [sess], summary: summarizeEvent([sess]),
  };
  assert.equal(writeAkWeather(root, "wec", doc), "written");
  assert.equal(writeAkWeather(root, "wec", { ...doc, season: 1999 }), "frozen",
    "запечатанный док перезаписан без force");
  assert.equal(writeAkWeather(root, "wec", doc, true), "unchanged", "force не пробил");
  const disk = JSON.parse(readFileSync(join(root, "wec", "weather", "wec-2031-imola.json"), "utf8"));
  assert.equal(disk.season, 2031);
  rmSync(root, { recursive: true, force: true });
});
