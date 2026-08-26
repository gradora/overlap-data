// Отпечаток зачёта — гейт кэша карьерной статистики. Свойства, на которых
// держатся продьюсеры: вектор (не сумма), нечувствительность к порядку строк,
// пустой список = «кэшу верить нельзя».

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { standingsFingerprint } from "./lib/fingerprint.js";

const driverList = (rows: [string, string, string][], round = "12") => ({
  season: "2026",
  round,
  DriverStandings: rows.map(([id, points, wins]) => ({
    Driver: { driverId: id }, points, wins,
  })),
});

test("standingsFingerprint: вектор, а не сумма — обмен очков меняет отпечаток", () => {
  // Апелляция переставила двух пилотов местами: сумма очков та же.
  const a = standingsFingerprint(driverList([["ver", "200", "5"], ["nor", "180", "4"]]));
  const b = standingsFingerprint(driverList([["ver", "180", "4"], ["nor", "200", "5"]]));
  assert.notEqual(a, b);
});

test("standingsFingerprint: порядок строк не важен (вектор сортируется)", () => {
  const a = standingsFingerprint(driverList([["ver", "200", "5"], ["nor", "180", "4"]]));
  const b = standingsFingerprint(driverList([["nor", "180", "4"], ["ver", "200", "5"]]));
  assert.equal(a, b);
});

test("standingsFingerprint: раунд вшит в отпечаток", () => {
  const rows: [string, string, string][] = [["ver", "200", "5"]];
  assert.notEqual(
    standingsFingerprint(driverList(rows, "12")),
    standingsFingerprint(driverList(rows, "13")),
  );
});

test("standingsFingerprint: пустой/битый список — пустая строка (кэш отключён)", () => {
  assert.equal(standingsFingerprint(undefined), "");
  assert.equal(standingsFingerprint({ season: "2026", round: "1", DriverStandings: [] }), "");
  // Строки без id вектора не дают.
  assert.equal(standingsFingerprint({ season: "2026", round: "1", DriverStandings: [{ points: "1" }] }), "");
});

test("standingsFingerprint: понимает и зачёт конструкторов", () => {
  const fp = standingsFingerprint({
    season: "2026", round: "12",
    ConstructorStandings: [{ Constructor: { constructorId: "mclaren" }, points: "400", wins: "9" }],
  });
  assert.match(fp, /^2026-12-/);
});
