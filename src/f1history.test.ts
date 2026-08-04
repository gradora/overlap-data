// Чистые функции индекса «Day in history»: группировка по MM-DD, merge
// победителей, сортировка внутри дня, високосный день.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  applyMoments, computeFacts, mergeSeason, winnersMap, type HistoryIndex,
} from "./producers/f1history.js";

const race = (round: number, date: string, name = "GP") => ({
  round: String(round),
  raceName: name,
  date,
  Circuit: { circuitName: "Circuit", Location: { country: "UK" } },
});

test("mergeSeason раскладывает гонки по MM-DD и подтягивает победителей", () => {
  const index: HistoryIndex = { seasons: [], days: {} };
  const winners = new Map([[1, { winner: "Farina", given: "Nino", team: "Alfa Romeo", driverId: "farina" }]]);
  mergeSeason(index, 1950, [race(1, "1950-05-13", "British Grand Prix")], winners);

  assert.deepEqual(index.seasons, [1950]);
  const day = index.days["05-13"];
  assert.equal(day.length, 1);
  assert.equal(day[0].name, "British Grand Prix");
  assert.equal(day[0].winner, "Farina");
  assert.equal(day[0].given, "Nino");
  assert.equal(day[0].team, "Alfa Romeo");
});

test("день сортируется по году убыванием, победитель без данных — без поля", () => {
  const index: HistoryIndex = { seasons: [], days: {} };
  mergeSeason(index, 1950, [race(1, "1950-07-23")], new Map());
  mergeSeason(index, 2000, [race(10, "2000-07-23")], new Map());

  const day = index.days["07-23"];
  assert.deepEqual(day.map((r) => r.year), [2000, 1950]);
  assert.equal(day[1].winner, undefined);
});

test("високосный день 02-29 валиден, мусорная дата пропускается", () => {
  const index: HistoryIndex = { seasons: [], days: {} };
  mergeSeason(index, 2004, [race(1, "2004-02-29"), race(2, "bad-date")], new Map());
  assert.equal(index.days["02-29"].length, 1);
  assert.equal(Object.keys(index.days).length, 1);
});

test("winnersMap строит карту раунд → победитель", () => {
  const map = winnersMap([
    { round: "3", Results: [{ Driver: { familyName: "Senna", givenName: "Ayrton", driverId: "senna", nationality: "Brazilian" }, Constructor: { name: "McLaren" }, grid: "2" }] },
    { round: "4", Results: [] },   // без результата — не попадает
  ]);
  assert.deepEqual(map.get(3), {
    winner: "Senna", given: "Ayrton", team: "McLaren",
    driverId: "senna", grid: 2, nat: "Brazilian",
  });
  assert.equal(map.has(4), false);
});

// MARK: Факты

const entry = (year: number, round: number, over: object = {}) => ({
  year, round, name: "British Grand Prix", circuit: "Silverstone", country: "UK",
  winner: "Hamilton", given: "Lewis", team: "Mercedes", driverId: "hamilton",
  grid: 1, nat: "German", ...over,
});

test("computeFacts: первая победа — MAIDEN WIN, номер растёт по датам", () => {
  const index: HistoryIndex = {
    seasons: [2007, 2008],
    days: {
      "06-10": [entry(2007, 7)],
      "04-06": [entry(2008, 3)],
    },
  };
  computeFacts(index);
  const first = index.days["06-10"][0];
  const second = index.days["04-06"][0];
  assert.equal(first.tag, "MAIDEN WIN");
  assert.ok(first.fact!.includes("Lewis Hamilton"), "в факте полное имя");
  assert.ok(second.fact!.includes("No. 2"), "вторая победа пронумерована");
});

test("computeFacts: камбэк с P10+ и домашняя победа получают ярлыки", () => {
  const index: HistoryIndex = {
    seasons: [2000, 2001, 2002],
    days: {
      "05-01": [entry(2000, 1)],                       // maiden
      "05-02": [entry(2001, 1, { grid: 14 })],          // камбэк
      "05-03": [entry(2002, 1, { nat: "British" })],    // домашняя (UK)
    },
  };
  computeFacts(index);
  assert.equal(index.days["05-02"][0].tag, "FROM P14");
  assert.equal(index.days["05-03"][0].tag, "HOME WIN");
  for (const day of Object.values(index.days)) {
    assert.ok(day[0].fact!.length <= 112, "длина факта в лимите карточки");
  }
});

test("computeFacts: пит-лейн старт важнее прочего, дефолт — без tag", () => {
  const index: HistoryIndex = {
    seasons: [1990, 1991, 1992],
    days: {
      "05-01": [entry(1990, 1)],
      "05-02": [entry(1991, 2, { grid: 0 })],
      "05-03": [entry(1992, 2, { grid: 3, nat: "German" })],  // ничего яркого
    },
  };
  computeFacts(index);
  assert.equal(index.days["05-02"][0].tag, "PIT LANE START");
  assert.equal(index.days["05-03"][0].tag, undefined);
  assert.ok(index.days["05-03"][0].fact!.includes("Lewis Hamilton"));
});

test("applyMoments: строгий матч, промах и длина — в отчёт", () => {
  const index: HistoryIndex = { seasons: [2020], days: { "08-02": [entry(2020, 4)] } };
  computeFacts(index);
  const misses = applyMoments(index, [
    { day: "08-02", year: 2020, race: "British Grand Prix",
      tag: "3-WHEEL WIN", fact: "Lewis Hamilton wins on three wheels" },
    { day: "08-02", year: 2019, race: "British Grand Prix", tag: "X", fact: "мимо года" },
    { day: "08-02", year: 2020, race: "British Grand Prix", tag: "СЛИШКОМ ДЛИННЫЙ ТЭГ БОЛЬШЕ ЛИМИТА", fact: "ok" },
  ]);
  assert.equal(index.days["08-02"][0].tag, "3-WHEEL WIN");
  assert.equal(index.days["08-02"][0].fact, "Lewis Hamilton wins on three wheels");
  assert.equal(misses.length, 2);
});
