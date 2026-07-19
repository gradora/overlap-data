// Смена сезона: guard'ы гонки флипов и кросс-сезонные помощники.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleSeasonMismatch } from "./season.js";
import { finalRoundFile, seasonUrlYear } from "./fia.js";
import { yearEquivalent } from "./f1.js";
import { seasonStarted } from "./wec.js";
import { hasSeasonSnapshots } from "./imsa.js";

test("scheduleSeasonMismatch: рассинхрон только при явном чужом сезоне", () => {
  assert.equal(scheduleSeasonMismatch("2026", 2027), true);   // январское окно
  assert.equal(scheduleSeasonMismatch("2027", 2026), true);   // обратное окно
  assert.equal(scheduleSeasonMismatch("2026", 2026), false);
  assert.equal(scheduleSeasonMismatch(null, 2027), false);    // нет данных — нет решения
  assert.equal(scheduleSeasonMismatch(undefined, 2027), false);
  assert.equal(scheduleSeasonMismatch("", 2027), false);
});

test("seasonUrlYear: год из сезонного URL FIA", () => {
  assert.equal(
    seasonUrlYear("https://www.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2026-2072"),
    2026,
  );
  assert.equal(seasonUrlYear("https://www.fia.com/documents"), null);
});

test("finalRoundFile: максимальный раунд сезона по файлам", () => {
  const files = ["2026_1.json", "2026_10.json", "2026_9.json", "2027_1.json", "notes.txt"];
  assert.equal(finalRoundFile(files, 2026), "2026_10.json");
  assert.equal(finalRoundFile(files, 2027), "2027_1.json");
  assert.equal(finalRoundFile(files, 2025), null);
  assert.equal(finalRoundFile([], 2026), null);
});

test("yearEquivalent: годовые пути current-алиасов из сезона ответа", () => {
  const schedule = { MRData: { RaceTable: { season: "2026", Races: [] } } };
  assert.equal(yearEquivalent("current.json", schedule), "2026.json");

  const standings = { MRData: { StandingsTable: { season: "2026" } } };
  assert.equal(yearEquivalent("current/driverStandings.json", standings), "2026/driverStandings.json");
  assert.equal(
    yearEquivalent("current/constructorStandings.json", standings),
    "2026/constructorStandings.json",
  );

  const last = { MRData: { RaceTable: { season: "2026", Races: [{ round: "10" }] } } };
  assert.equal(yearEquivalent("current/last/results.json", last), "2026/10/results.json");
  // Пустой сезон без гонок — у last-results года-эквивалента нет.
  assert.equal(yearEquivalent("current/last/results.json", schedule), null);

  const results = { MRData: { RaceTable: { season: "2026", Races: [{ round: "1" }] } } };
  assert.equal(
    yearEquivalent("current/results.json?limit=100&offset=100", results),
    "2026/results.json?limit=100&offset=100",
  );

  // «next» относителен во времени, сезонного эквивалента не имеет.
  assert.equal(yearEquivalent("current/next.json", schedule), null);
  // Без сезона в ответе копия не пишется.
  assert.equal(yearEquivalent("current.json", { MRData: {} }), null);
});

test("seasonStarted: первый этап в недельном окне открывает E5/E6", () => {
  const day = 24 * 3600 * 1000;
  const now = Date.parse("2027-01-15T00:00:00Z");
  // Все события сезона в далёком будущем (пред-сезонье) — не начался.
  assert.equal(seasonStarted([now + 40 * day, now + 90 * day], now), false);
  // Первый этап через 3 дня — уже в lead-окне.
  assert.equal(seasonStarted([now + 3 * day, now + 90 * day], now), true);
  // Сыгранный этап (конец в прошлом) — сезон идёт.
  assert.equal(seasonStarted([now - 10 * day, now + 90 * day], now), true);
  // Нет данных о датах — решить нечем, скрейпить вслепую не надо.
  assert.equal(seasonStarted([], now), false);
});

test("hasSeasonSnapshots: отличает пред-сезонье от аутэйджа", () => {
  assert.equal(hasSeasonSnapshots([]), false);
  assert.equal(hasSeasonSnapshots(["index.json", "points.json"]), false);
  assert.equal(hasSeasonSnapshots(["index.json", "01_daytona.json"]), true);
});
