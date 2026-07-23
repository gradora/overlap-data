// Чистые функции индекса «Day in history»: группировка по MM-DD, merge
// победителей, сортировка внутри дня, високосный день.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergeSeason, winnersMap, type HistoryIndex } from "./f1history.js";

const race = (round: number, date: string, name = "GP") => ({
  round: String(round),
  raceName: name,
  date,
  Circuit: { circuitName: "Circuit", Location: { country: "UK" } },
});

test("mergeSeason раскладывает гонки по MM-DD и подтягивает победителей", () => {
  const index: HistoryIndex = { seasons: [], days: {} };
  const winners = new Map([[1, { winner: "Farina", given: "Nino", team: "Alfa Romeo" }]]);
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
    { round: "3", Results: [{ Driver: { familyName: "Senna", givenName: "Ayrton" }, Constructor: { name: "McLaren" } }] },
    { round: "4", Results: [] },   // без результата — не попадает
  ]);
  assert.deepEqual(map.get(3), { winner: "Senna", given: "Ayrton", team: "McLaren" });
  assert.equal(map.has(4), false);
});
