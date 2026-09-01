// Документ зачётов сезона F1 (lib/f1standings.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildF1StandingsDoc } from "./lib/f1standings.js";

function seed(root: string) {
  const dir = join(root, "f1", "jolpica");
  mkdirSync(dir, { recursive: true });
  const w = (name: string, doc: object) =>
    writeFileSync(join(dir, name), JSON.stringify(doc));
  w("2031.json", { MRData: { RaceTable: { season: "2031", Races: [
    { round: "1", Circuit: { Location: { locality: "Melbourne" } } },
    { round: "2", Circuit: { Location: { locality: "Shanghai" } } },
  ] } } });
  w("2031_driverStandings.json", { MRData: { StandingsTable: { season: "2031",
    StandingsLists: [{ DriverStandings: [
      { position: "1", points: "44", wins: "1",
        Driver: { driverId: "norris", givenName: "Lando", familyName: "Norris",
                  code: "NOR", permanentNumber: "4" },
        Constructors: [{ constructorId: "mclaren", name: "McLaren" }] },
      { position: "2", points: "18", wins: "0",
        Driver: { driverId: "alonso", givenName: "Fernando", familyName: "Alonso" },
        Constructors: [{ constructorId: "aston_martin", name: "Aston Martin" }] },
    ] }] } } });
  w("2031_constructorStandings.json", { MRData: { StandingsTable: { season: "2031",
    StandingsLists: [{ ConstructorStandings: [
      { position: "1", points: "44", wins: "1",
        Constructor: { constructorId: "mclaren", name: "McLaren" } },
    ] }] } } });
  w("2031_results.json_limit_100_offset_0", { MRData: { RaceTable: { season: "2031", Races: [
    { season: "2031", round: "1", Results: [
      { position: "1", positionText: "1", points: "25",
        Driver: { driverId: "norris" }, Constructor: { constructorId: "mclaren" } },
      { position: "18", positionText: "R", points: "0",
        Driver: { driverId: "alonso" }, Constructor: { constructorId: "aston_martin" } },
    ] },
    { season: "2031", round: "2", Results: [
      { position: "1", positionText: "1", points: "11",
        Driver: { driverId: "norris" }, Constructor: { constructorId: "mclaren" } },
      { position: "2", positionText: "2", points: "18",
        Driver: { driverId: "alonso" }, Constructor: { constructorId: "aston_martin" } },
    ] },
  ] } } });
  w("2031_sprint.json_limit_100_offset_0", { MRData: { RaceTable: { season: "2031", Races: [
    { season: "2031", round: "2", SprintResults: [
      { position: "1", positionText: "1", points: "8",
        Driver: { driverId: "norris" }, Constructor: { constructorId: "mclaren" } },
    ] },
  ] } } });
}

test("документ зачётов: раундовые очки, спринт, DNF-ячейка, победитель спринта", () => {
  const root = mkdtempSync(join(tmpdir(), "f1st-"));
  seed(root);
  const doc = buildF1StandingsDoc(root, 2031)!;

  assert.deepEqual(doc.rounds.map((r) => [r.round, r.locality, r.sprint ?? false]),
                   [[1, "Melbourne", false], [2, "Shanghai", true]]);
  assert.deepEqual(doc.rounds[1].sprintWinner, { driverId: "norris", constructorId: "mclaren" });

  const norris = doc.drivers[0];
  assert.equal(norris.code, "NOR");
  assert.equal(norris.permanentNumber, 4);
  assert.deepEqual(norris.stages, [
    { round: 1, race: { points: 25, classified: true } },
    { round: 2, race: { points: 11, classified: true }, sprint: { points: 8, classified: true } },
  ]);
  // ИНВАРИАНТ, который держит весь документ: сумма раундовых очков равна
  // итогу зачёта. Источники РАЗНЫЕ (standings против results) — расхождение
  // означает дыру в страницах, и его обязан увидеть тест, а не пользователь.
  assert.equal(norris.stages.reduce(
    (n, s) => n + (s.race?.points ?? 0) + (s.sprint?.points ?? 0), 0), norris.points);

  // DNF: очки нулевые, classified false — клиент рисует дэш.
  const alonso = doc.drivers[1];
  assert.deepEqual(alonso.stages[0], { round: 1, race: { points: 0, classified: false } });

  // Конструктор: сумма обеих машин (здесь одна) и те же инварианты.
  assert.equal(doc.constructors[0].stages.length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("сезон не начался (зачётов нет) — документа нет, а не пустышка", () => {
  const root = mkdtempSync(join(tmpdir(), "f1st-"));
  mkdirSync(join(root, "f1", "jolpica"), { recursive: true });
  assert.equal(buildF1StandingsDoc(root, 2031), null);
  rmSync(root, { recursive: true, force: true });
});

/// Season-guard: файл за чужой сезон (январское отравление алиасов) не
/// подмешивается — документ честно пропускается.
test("зачёты чужого сезона отбиваются season-guard'ом", () => {
  const root = mkdtempSync(join(tmpdir(), "f1st-"));
  seed(root);
  const f = join(root, "f1", "jolpica", "2031_driverStandings.json");
  const doc = JSON.parse(readFileSync(f, "utf8"));
  doc.MRData.StandingsTable.season = "2030";
  writeFileSync(f, JSON.stringify(doc));
  const built = buildF1StandingsDoc(root, 2031);
  assert.equal(built?.drivers.length ?? 0, 0, "чужой сезон попал в документ");
  rmSync(root, { recursive: true, force: true });
});

/// БОЕВОЙ инвариант: на настоящих данных сумма раундовых очков каждой строки
/// обоих сезонов равна итогу зачёта. Ловит дыры пагинации и дрейф разбора.
test("боевые сезоны: раундовые суммы сходятся с итогами зачёта", () => {
  for (const year of [2025, 2026]) {
    const doc = buildF1StandingsDoc(join(process.cwd(), "data"), year);
    if (!doc) continue;   // зеркала может не быть в урезанном чекауте
    for (const row of [...doc.drivers, ...doc.constructors]) {
      const total = row.stages.reduce(
        (n, s) => n + (s.race?.points ?? 0) + (s.sprint?.points ?? 0), 0);
      assert.equal(total, row.points,
        `${year}: у ${"driverId" in row ? row.driverId : row.constructorId} ` +
        `раунды дают ${total}, зачёт говорит ${row.points}`);
    }
  }
});
