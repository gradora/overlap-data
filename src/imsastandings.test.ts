// Тесты билдера зачёта IMSA (lib/imsastandings.ts) — материализации
// клиентского IMSAStandingsBuilder.swift. Проверяются узлы семантики клиента
// (official vs computed, дыра середины сезона, смена пилота, тай-брейки,
// пустой класс) и мутационная самопроверка предохранителя записи: guard
// проверяется НА ВЫЗОВЕ writeStandings в песочнице, а не только предикатом —
// снятие guard из writeStandings роняет тест, а не только unit standingsRegression.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStandings, driverLookup, nameKey, pointsForClassPosition, raceRowsOf,
  standingsRegression, writeStandings, StandingsDoc, StandingsRound,
} from "./lib/imsastandings.js";
import type { OfficialPoints, ResultRow, Session } from "./lib/types.js";

// MARK: Хелперы

/// «Сейчас» тестов: против него due-гейт (конец раунда + 24ч).
const NOW = Date.parse("2026-08-26T12:00:00Z");
const PAST = "2026-08-01T00:00:00.000Z";           // завершённый раунд
const LIVE = "2026-08-26T02:00:00.000Z";           // конец < 24ч назад — live-окно

const row = (
  carNumber: string,
  classPosition: number,
  extra: Partial<ResultRow> = {},
): ResultRow => ({
  position: classPosition, classPosition, carNumber,
  chassis: "Porsche 963", raceClass: "GTP", team: `Team ${carNumber}`,
  drivers: [], laps: null, leaderTime: "", totalTime: "", interval: "", pitstops: null,
  ...extra,
});

const rnd = (round: number, raceRows: ResultRow[] | null, end: string | null = PAST): StandingsRound =>
  ({ round, slug: `r${round}`, end, raceRows });

const gtp = (doc: StandingsDoc) => doc.classes.find((c) => c.raceClass === "GTP")!;

// MARK: Шкала очков (копия клиентской points(forClassPosition:))

test("шкала очков: топ-5 фиксирован, дальше −10 до пола 10, вне мест — 0", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(pointsForClassPosition), [350, 320, 300, 280, 260]);
  assert.equal(pointsForClassPosition(6), 250);
  assert.equal(pointsForClassPosition(10), 210);
  assert.equal(pointsForClassPosition(30), 10, "пол шкалы — 10");
  assert.equal(pointsForClassPosition(0), 0);
  assert.equal(pointsForClassPosition(-3), 0);
});

// MARK: Выбор race-сессии (калька IMSAResultsSource)

test("raceRowsOf: берётся ПОСЛЕДНЯЯ race-сессия — как у клиента, без фолбэка на раннюю", () => {
  const s = (name: string, rows: ResultRow[], hasResults = true): Session =>
    ({ name, type: "", start: null, wallClock: null, hasResults, rows });
  const rows = [row("7", 1)];

  assert.deepEqual(raceRowsOf([s("Practice 1", rows), s("Race", rows)]), rows);
  // «Race 2» без результатов затмевает «Race 1» с результатами — клиентский
  // weekend.last(where:) ведёт себя ровно так; менять = расхождение с клиентом.
  assert.equal(raceRowsOf([s("Race 1", rows), s("Race 2", [], false)]), null);
  assert.equal(raceRowsOf([s("Race", [], true)]), null, "hasResults с пустыми строками — данных нет");
  assert.equal(raceRowsOf([s("Practice 1", rows), s("Qualifying", rows)]), null, "гонки нет");
  assert.equal(raceRowsOf([]), null);
});

// MARK: Накопление и official-оверлей

test("computed: очки из мест по шкале, позиции по тоталам, тай-брейк номера numeric", () => {
  const doc = buildStandings(2026, [
    rnd(1, [row("10", 1), row("7", 2)]),
    rnd(2, [row("7", 1), row("10", 2)]),
  ], null, NOW);

  const entries = gtp(doc).entries;
  assert.equal(entries.length, 2);
  // Тоталы равны (350+320 у обоих) → номер numeric: «7» раньше «10».
  assert.deepEqual(entries.map((e) => [e.carNumber, e.position, e.points, e.pointsSource]),
    [["7", 1, 670, "computed"], ["10", 2, 670, "computed"]]);
  assert.deepEqual(entries[0].byRound, [
    { round: 1, slug: "r1", points: 320, finish: 2, computed: true },
    { round: 2, slug: "r2", points: 350, finish: 1, computed: true },
  ]);
  assert.equal(gtp(doc).completeThroughRound, 2);
  assert.equal(doc.frozen, true, "все раунды расписания завершены и с данными");
});

test("official-оверлей: тоталы и позиции из points.json, несматченное остаётся computed", () => {
  const drv = (name: string, nat = "USA") => ({ name, nationality: nat });
  const officialPoints: OfficialPoints = {
    teams: { GTP: [{ key: "10", points: 800, position: 1 }, { key: "7", points: 750, position: 2 }] },
    drivers: { GTP: [{ key: "Jack Aitken", points: 800, position: 1 }] },
  };
  const doc = buildStandings(2026, [
    rnd(1, [
      row("7", 1, { drivers: [drv("F. Nasr", "BRA")] }),
      row("10", 2, { drivers: [drv("J. Aitken", "GBR")] }),
      row("99", 3, { drivers: [drv("Z. Unknown")] }),
    ]),
  ], officialPoints, NOW);

  const entries = gtp(doc).entries;
  // Позиции перевёрнуты официальной таблицей; car 99 в ней нет — computed.
  assert.deepEqual(entries.map((e) => [e.carNumber, e.position, e.points, e.pointsSource]), [
    ["10", 1, 800, "official"],
    ["7", 2, 750, "official"],
    ["99", 3, 300, "computed"],
  ]);
  // Пилоты матчатся по «инициал|фамилия»: «J. Aitken» ↔ «Jack Aitken».
  const aitken = gtp(doc).driverEntries.find((d) => d.name === "J. Aitken")!;
  assert.deepEqual([aitken.points, aitken.position, aitken.pointsSource], [800, 1, "official"]);
  const nasr = gtp(doc).driverEntries.find((d) => d.name === "F. Nasr")!;
  assert.equal(nasr.pointsSource, "computed");
  assert.equal(nasr.points, 350, "пилот получает очки машины целиком");
});

test("nameKey и коллизии официальной таблицы: спорный ключ не матчится вовсе", () => {
  assert.equal(nameKey("J. Aitken"), "j|aitken");
  assert.equal(nameKey("Jack Aitken"), "j|aitken");
  assert.equal(nameKey("Kelvin van der Linde"), "k|linde", "фамилия — последнее слово");
  assert.equal(nameKey("Zhou"), "zhou", "однословное — как есть");

  const lookup = driverLookup([
    { key: "Jack Aitken", points: 800, position: 1 },
    { key: "John Aitken", points: 700, position: 2 },   // тот же «j|aitken»
    { key: "Nick Yelloly", points: 650, position: 3 },
  ]);
  assert.equal(lookup.has("j|aitken"), false, "коллизия выброшена — лучше расчётное, чем чужое");
  assert.equal(lookup.get("n|yelloly")?.points, 650);
});

test("реальные wins/podiums из финишей в классе — не прокси максимума очков", () => {
  const officialPoints: OfficialPoints = {
    // Официальные тоталы нарочно «переворачивают» лидера: у прокси по очкам
    // wins поплыли бы, у реальных финишей — нет.
    teams: { GTP: [{ key: "10", points: 900, position: 1 }, { key: "7", points: 880, position: 2 }] },
    drivers: {},
  };
  const doc = buildStandings(2026, [
    rnd(1, [row("7", 1), row("10", 2), row("31", 4)]),
    rnd(2, [row("7", 1), row("10", 3), row("31", 2)]),
    rnd(3, [row("7", 2), row("10", 1), row("31", 5)]),
  ], officialPoints, NOW);

  const byCar = Object.fromEntries(gtp(doc).entries.map((e) => [e.carNumber, e]));
  assert.deepEqual([byCar["7"].wins, byCar["7"].podiums], [2, 3]);
  assert.deepEqual([byCar["10"].wins, byCar["10"].podiums], [1, 3]);
  assert.deepEqual([byCar["31"].wins, byCar["31"].podiums], [0, 1]);
});

// MARK: Идентичность экипажа и пилота

test("смена пилота в машине: экипаж один, состав накапливается, у пилотов свои раунды", () => {
  const doc = buildStandings(2026, [
    rnd(1, [row("5", 1, { drivers: [{ name: "A. One", nationality: "USA" }, { name: "B. Two", nationality: "" }] })]),
    rnd(2, [row("5", 2, { drivers: [{ name: "A. One", nationality: "USA" }, { name: "C. Three", nationality: "FRA" }] })]),
  ], null, NOW);

  const entries = gtp(doc).entries;
  assert.equal(entries.length, 1, "идентичность экипажа — (класс, номер), не состав");
  assert.deepEqual(entries[0].drivers.map((d) => d.name), ["A. One", "B. Two", "C. Three"]);
  assert.equal(entries[0].points, 670);

  const byName = Object.fromEntries(gtp(doc).driverEntries.map((d) => [d.name, d]));
  assert.equal(byName["A. One"].points, 670);
  assert.equal(byName["B. Two"].points, 350, "только раунд 1");
  assert.equal(byName["C. Three"].points, 320, "только раунд 2");
  assert.deepEqual(byName["C. Three"].byRound.map((c) => c.round), [2]);
});

test("пилот в двух машинах класса за раунд: очки суммируются, финиш — лучший, номера копятся", () => {
  const d = [{ name: "D. Both", nationality: "" }];
  const doc = buildStandings(2026, [
    rnd(1, [row("1", 1, { drivers: d }), row("2", 3, { drivers: d })]),
  ], null, NOW);

  const driver = gtp(doc).driverEntries.find((x) => x.name === "D. Both")!;
  assert.equal(driver.points, 650, "350 + 300 — клиентский add() суммирует, не перезаписывает");
  assert.deepEqual(driver.carNumbers, ["1", "2"]);
  assert.deepEqual(driver.byRound, [{ round: 1, slug: "r1", points: 650, finish: 1, computed: true }]);
  assert.equal(driver.wins, 1);
});

test("тай-брейк пилотов при равных очках — имя по возрастанию", () => {
  const doc = buildStandings(2026, [
    rnd(1, [
      row("1", 1, { drivers: [{ name: "B. Beta", nationality: "" }] }),
      row("2", 2, { drivers: [{ name: "A. Alpha", nationality: "" }] }),
    ]),
    rnd(2, [
      row("1", 2, { drivers: [{ name: "B. Beta", nationality: "" }] }),
      row("2", 1, { drivers: [{ name: "A. Alpha", nationality: "" }] }),
    ]),
  ], null, NOW);
  assert.deepEqual(gtp(doc).driverEntries.map((d) => [d.name, d.position]),
    [["A. Alpha", 1], ["B. Beta", 2]]);
});

// MARK: Дыры, live-окно, пустой класс

test("дыра середины сезона: completeThroughRound останавливается на ней, хвост честно входит в byRound", () => {
  const doc = buildStandings(2026, [
    rnd(1, [row("7", 1)]),
    rnd(2, null),                    // завершён, данных нет — дыра
    rnd(3, [row("7", 1)]),
  ], null, NOW);

  assert.equal(gtp(doc).completeThroughRound, 1);
  // Данные за дырой не выбрасываются (клиент тоже их суммировал — гейтился
  // только показ): маркер < последнего byRound и есть сигнал дыры.
  assert.deepEqual(gtp(doc).entries[0].byRound.map((c) => c.round), [1, 3]);
  assert.equal(doc.frozen, false);
});

test("live-окно (конец +24ч не прошёл) не считается — как клиентский completedAfter", () => {
  const doc = buildStandings(2026, [
    rnd(1, [row("7", 2)]),
    rnd(2, [row("7", 1)], LIVE),     // данные уже есть, но раунд ещё «не завершён»
    rnd(3, null, "2026-09-18T00:00:00.000Z"),
  ], null, NOW);

  assert.deepEqual(gtp(doc).entries[0].byRound.map((c) => c.round), [1],
    "результаты live-раунда войдут только после закрытия окна");
  assert.equal(gtp(doc).entries[0].points, 320);
  assert.equal(gtp(doc).completeThroughRound, 1);
  assert.equal(doc.frozen, false);
});

test("пустой класс присутствует в контракте с пустыми списками", () => {
  const doc = buildStandings(2026, [rnd(1, [row("7", 1)])], null, NOW);
  const lmp2 = doc.classes.find((c) => c.raceClass === "LMP2")!;
  assert.deepEqual([lmp2.entries, lmp2.driverEntries], [[], []]);
  assert.equal(lmp2.completeThroughRound, 1, "маркер полноты общий — класс просто не ездил");
  assert.deepEqual(doc.classes.map((c) => c.raceClass), ["GTP", "LMP2", "GTD"], "порядок классов клиентский");
});

test("участие без места в классе: очков нет (null), не ноль", () => {
  const doc = buildStandings(2026, [rnd(1, [row("7", 0)])], null, NOW);
  assert.deepEqual(gtp(doc).entries[0].byRound,
    [{ round: 1, slug: "r1", points: null, finish: 0, computed: true }]);
  assert.equal(gtp(doc).entries[0].points, 0);
  assert.equal(gtp(doc).entries[0].wins, 0);
});

// MARK: Предохранитель записи — предикат

test("standingsRegression: ловит сжатие раундов и пропажу official-тоталов", () => {
  const mk = (rounds: number[], source: "official" | "computed"): Pick<StandingsDoc, "classes"> => ({
    classes: [{
      raceClass: "GTP",
      entries: [{
        position: 1, carNumber: "7", team: "", chassis: "", drivers: [],
        points: 1, pointsSource: source, wins: 0, podiums: 0,
        byRound: rounds.map((round) => ({ round, slug: `r${round}`, points: 1, finish: 1, computed: true })),
      }],
      driverEntries: [], completeThroughRound: rounds.length,
    }],
  });

  assert.equal(standingsRegression(null, mk([1], "computed")), null, "первый файл пишется всегда");
  assert.equal(standingsRegression(mk([1, 2], "official"), mk([1, 2, 3], "official")), null, "рост — норма");
  assert.match(standingsRegression(mk([1, 2, 3], "computed"), mk([1, 2], "computed"))!, /раундов с данными стало меньше/);
  assert.match(standingsRegression(mk([1, 2], "official"), mk([1, 2], "computed"))!, /официальные тоталы пропали/);
  assert.equal(standingsRegression(mk([1], "computed"), mk([1], "computed")), null,
    "official не было и нет — не деградация (начало сезона)");
});

// MARK: Предохранитель записи — мутационная самопроверка НА ВЫЗОВЕ

test("writeStandings: деградация не затирает прежний файл, рост пишется, повтор — без изменений", () => {
  const dir = mkdtempSync(join(tmpdir(), "imsastandings-"));
  try {
    const path = join(dir, "standings.json");
    const good = buildStandings(2026, [
      rnd(1, [row("7", 1)]),
      rnd(2, [row("7", 1)]),
    ], { teams: { GTP: [{ key: "7", points: 700, position: 1 }] }, drivers: {} }, NOW);

    assert.equal(writeStandings(path, good), "written");
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.schemaVersion, 1);
    assert.ok(written.generatedAt, "конверт writeJSONWithEnvelope");
    assert.equal(written.series, "imsa");

    // Идемпотентность: тот же документ → файл не дёргается.
    assert.equal(writeStandings(path, good), "unchanged");
    const bytes = readFileSync(path, "utf8");

    // Деградация №1: раундов стало меньше (файлы раундов «исчезли»).
    const degraded = buildStandings(2026, [rnd(1, [row("7", 1)]), rnd(2, null)],
      { teams: { GTP: [{ key: "7", points: 700, position: 1 }] }, drivers: {} }, NOW);
    assert.equal(writeStandings(path, degraded), "kept-previous");
    assert.equal(readFileSync(path, "utf8"), bytes, "прежний файл не тронут байт в байт");

    // Деградация №2: пропал points.json — official схлопнулся в computed.
    const noOfficial = buildStandings(2026, [rnd(1, [row("7", 1)]), rnd(2, [row("7", 1)])], null, NOW);
    assert.equal(writeStandings(path, noOfficial), "kept-previous");
    assert.equal(readFileSync(path, "utf8"), bytes);

    // Рост (новый раунд) — штатная запись поверх.
    const grown = buildStandings(2026, [
      rnd(1, [row("7", 1)]), rnd(2, [row("7", 1)]), rnd(3, [row("7", 2)]),
    ], { teams: { GTP: [{ key: "7", points: 1000, position: 1 }] }, drivers: {} }, NOW);
    assert.equal(writeStandings(path, grown), "written");
    assert.notEqual(readFileSync(path, "utf8"), bytes);

    // Битый прежний файл — не «хорошее прежнее состояние», пишем заново.
    writeFileSync(path, "{нет");
    assert.equal(writeStandings(path, good), "written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
