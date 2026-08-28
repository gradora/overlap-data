// Витрина событий WEC (фаза 3b): узлы порта — маппинг ячеек протокола ПО ИМЕНИ
// шапки (включая строку, которую сегодняшний клиент теряет), бакеты сессий с
// двумя фазами хайперполя Ле-Мана, класс страницы, джойн экипажей по номеру
// машины — и мутационная самопроверка предохранителей записи НА ВЫЗОВЕ
// (образец wecsnapshot.test.ts): деградация входов не затирает прежний файл,
// замороженное событие не пересобирается.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorSlug } from "./lib/mirror.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWecEventDoc, buildWecEventFiles, crewByCarNumber, parseSessionRows, sessionClassOf, sessionKindOf, wecEventRegression, writeWecEvent, type WecEventDoc, trackTimeZone, WEC_EVENT_SCHEMA_VERSION, resetRefsCacheForTesting } from "./lib/wecevents.js";
import type { WecIndexEvent, WecStandingsDoc } from "./lib/wecsnapshot.js";

// MARK: Фикстуры

/// Таблица протокола в разметке fiawec: под шапкой Competitors у каждой строки
/// лишняя КАРТИНОЧНАЯ ячейка (логотип бренда + иллюстрация машины) — парсер
/// обязан её выбросить, иначе ячейки разъедутся с шапкой. Плюс строка-подпись
/// «N°», которую страница рисует под шапкой.
/// noLogo — машина без логотипа (2025 Ле-Ман, #199): ячейка пустая, но БЕЗ
/// <img>, и ячейки съезжают на одну.
function sessionHTML(
  headers: string[], rows: { cells: string[]; noLogo?: boolean }[],
): string {
  const head = `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  const body = rows.map((r) => {
    const logo = r.noLogo ? "<td><div></div></td>" : '<td><img src="x.png"/></td>';
    const [pos, ...rest] = r.cells;
    return `<tr><td>${pos}</td>${logo}${rest.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  }).join("");
  return `<html><table>${head}<tr><td>N°</td></tr>${body}</table></html>`;
}

const RACE_HEADERS = ["Pos.", "Competitors", "Team", "Laps", "Total time", "Gap",
  "Interval", "Avg. (km/h)", "Best lap", "On"];
const PRACTICE_HEADERS = ["Pos.", "Competitors", "Team", "Best lap", "Laps", "Gap",
  "Interval", "Avg. (km/h)", "Time of the day"];

/// Страница события: JSON-LD SportsEvent с расписанием (subEvent) +
/// экранированный raceId live-компонента.
function racePageHTML(opts: {
  name: string; start?: string; end?: string; raceId?: number;
  sessions?: { name: string; start?: string; status?: string }[];
}): string {
  const ld = {
    "@type": "SportsEvent",
    name: opts.name,
    ...(opts.start ? { startDate: opts.start } : {}),
    ...(opts.end ? { endDate: opts.end } : {}),
    eventStatus: "https://schema.org/EventCompleted",
    location: { name: "Circuit", address: "City, FRA" },
    subEvent: (opts.sessions ?? []).map((s) => ({
      name: `${s.name} - ${opts.name.replace(/^WEC /, "").replace(/\s+\d{4}$/, "")}`,
      ...(s.start ? { startDate: s.start } : {}),
      eventStatus: `https://schema.org/${s.status ?? "EventCompleted"}`,
    })),
  };
  const live = opts.raceId !== undefined
    ? `<div data-live="{&quot;raceId&quot;:${opts.raceId}}"></div>` : "";
  return `<html><script type="application/ld+json">${JSON.stringify(ld)}</script>${live}</html>`;
}

const indexEvent = (over: Partial<WecIndexEvent> = {}): WecIndexEvent => ({
  round: 1,
  slug: "6-hours-of-imola-2031",
  name: "6 Hours of Imola",
  venue: "Imola",
  trackRef: "imola",
  status: "EventCompleted",
  countryCode: "it",
  start: "2031-04-17T00:00:00+02:00",
  end: "2031-04-19T00:00:00+02:00",
  resultsPath: "wec/2031/01_6-hours-of-imola-2031.json",
  sourceIds: { fiawec: { slug: "6-hours-of-imola-2031", raceId: 41, sessions: [] } },
  ...over,
});

// MARK: Парсер протокола (порт WECResultsParser)

test("parseSessionRows: гонка — маппинг по имени шапки, картиночная ячейка и «N°» выброшены", () => {
  const rows = parseSessionRows(sessionHTML(RACE_HEADERS, [
    { cells: ["1", "#15", "BMW M TEAM WRT", "242", "6:00:26.462", "-", "-", "175.51", "1:25.805", "8"] },
    { cells: ["2", "#51", "FERRARI AF CORSE", "242", "6:00:28.716", "2.254", "2.254", "175.49", "1:25.856", "133"] },
  ]));
  assert.equal(rows.length, 2, "строка-подпись «N°» не протокол");
  assert.deepEqual(rows[0], {
    position: 1, carNumber: "15", team: "BMW M TEAM WRT", laps: 242,
    totalTime: "6:00:26.462", gapFirst: "", status: "classified",
  });
  // Прочерк гэпа у лидера — это «гэпа нет», а не строка «-».
  assert.equal(rows[1].gapFirst, "2.254");
});

test("parseSessionRows: практика ранжируется лучшим кругом — он и уезжает в totalTime", () => {
  const rows = parseSessionRows(sessionHTML(PRACTICE_HEADERS, [
    { cells: ["1", "#83", "AF CORSE", "1:31.739", "46", "-", "-", "192.6", "10:24:01"] },
    { cells: ["2", "#50", "FERRARI AF CORSE", "1:31.762", "46", "+0.023", "+0.023", "192.6", "10:22:33"] },
  ]));
  assert.equal(rows[0].totalTime, "1:31.739", "колонки Total у практики нет — берётся Best lap");
  assert.equal(rows[0].laps, 46, "Laps не путается с «Best lap»");
  assert.equal(rows[1].gapFirst, "+0.023");
});

test("parseSessionRows: машина без логотипа и команды выпадает из протокола (как у клиента)", () => {
  // 2025 Ле-Ман, #199 в сессиях LMP2 & LMGT3: картиночная ячейка пустая, но
  // без <img> — ячейки съезжают, номер уезжает в колонку Team, строка гибнет.
  // Это СЕГОДНЯШНЕЕ поведение экрана; порт обязан его повторить, не «чинить».
  const rows = parseSessionRows(sessionHTML(PRACTICE_HEADERS, [
    { cells: ["1", "#199", "", "3:35.472", "7", "-", "-", "227.7", "19:15:36"], noLogo: true },
    { cells: ["2", "#23", "UNITED AUTOSPORTS", "3:35.657", "7", "+0.185", "+0.185", "227.5", "19:18:02"] },
  ]));
  assert.deepEqual(rows.map((r) => r.carNumber), ["23"]);
});

test("parseSessionRows: строка без позиции — retired (клиент рисует ей DNF)", () => {
  // fiawec не печатает DNF/DNS/DSQ отдельной колонкой: незачёт виден по
  // ПУСТОЙ позиции. Все три случая на входе выглядят одинаково.
  const rows = parseSessionRows(sessionHTML(RACE_HEADERS, [
    { cells: ["1", "#7", "TOYOTA RACING", "242", "6:00:26.462", "-", "-", "175.5", "1:25.8", "8"] },
    { cells: ["DNF", "#8", "TOYOTA RACING", "120", "3:01:00.000", "122 Laps", "-", "170.0", "1:26.0", "44"] },
    { cells: ["DSQ", "#009", "ASTON MARTIN THOR TEAM", "240", "6:00:00.000", "2 Laps", "-", "174.0", "1:26.1", "12"] },
    { cells: ["DNS", "#12", "CADILLAC HERTZ TEAM JOTA", "", "", "-", "-", "", "", ""] },
  ]));
  assert.deepEqual(rows.map((r) => [r.carNumber, r.position, r.status]), [
    ["7", 1, "classified"], ["8", null, "retired"],
    ["009", null, "retired"], ["12", null, "retired"],
  ]);
  assert.equal(rows[3].laps, null, "у DNS ни кругов, ни времени");
  assert.equal(rows[2].carNumber, "009", "ведущие нули номера сохраняются");
});

test("parseSessionRows: нет таблицы протокола / нет шапки — пусто, а не мусор", () => {
  assert.deepEqual(parseSessionRows("<html>сессия ещё не сыграна</html>"), []);
  assert.deepEqual(parseSessionRows("<table><tr><td>1</td><td>#7</td></tr></table>"), []);
  // Навигационная таблица без Pos/Team игнорируется.
  assert.deepEqual(parseSessionRows("<table><tr><th>Season</th></tr><tr><td>2031</td></tr></table>"), []);
});

// MARK: Бакеты сессий (порт sessionKind) и класс страницы

test("sessionKindOf: подписи fiawec → бакеты экрана; у Ле-Мана две фазы хайперполя", () => {
  const k = (label: string) => {
    const r = sessionKindOf(label);
    return [r.kind, r.number, r.phase];
  };
  assert.deepEqual(k("RACE"), ["race", null, null]);
  assert.deepEqual(k("FREE PRACTICE 4"), ["practice", 4, null]);
  assert.deepEqual(k("HYPERPOLE 1 - HYPERCAR"), ["hyperpole", null, 1]);
  assert.deepEqual(k("HYPERPOLE 2 - HYPERCAR"), ["hyperpole", null, 2]);
  assert.deepEqual(k("HYPERPOLE - LMGT3"), ["hyperpole", null, null], "безномерная фаза");
  assert.deepEqual(k("QUALIFYING - HYPERCAR"), ["qualifying", null, null]);
  assert.deepEqual(k("Qualifying - Hypercar"), ["qualifying", null, null], "регистр fiawec гуляет");
  assert.deepEqual(k("WARM-UP"), ["warmup", null, null]);
  assert.deepEqual(k("MORNING SESSION"), ["other", null, null], "сессия пролога");
  // Ровно «RACE» — как у клиента: «RACE 2» он бы не показал, и файл не врёт.
  assert.deepEqual(k("RACE 2"), ["other", null, null]);
});

test("sessionClassOf: квалификатор подписи, иначе категория страницы по умолчанию", () => {
  assert.equal(sessionClassOf("QUALIFYING - LMGT3", true), "LMGT3");
  assert.equal(sessionClassOf("HYPERPOLE 1 - LMP2 & LMGT3", true), "LMP2 & LMGT3");
  assert.equal(sessionClassOf("Qualifying - Hypercar", true), "HYPERCAR");
  assert.equal(sessionClassOf("FREE PRACTICE 1", true), "HYPERCAR", "категория страницы");
  assert.equal(sessionClassOf("WARM-UP", true), "HYPERCAR", "дефис без пробелов — не квалификатор");
  assert.equal(sessionClassOf("MORNING SESSION", false), null, "протокола нет — класс неизвестен");
});

// MARK: Экипажи (порт crewByCarNumber)

test("crewByCarNumber: имена в порядке появления, без дублей, оба класса", () => {
  const doc = {
    series: "wec", season: 2031, frozen: false, rounds: ["IT"],
    classes: [
      {
        raceClass: "HYPERCAR", winsSource: "real", crews: [], driverRows: [
          { position: 1, carNumber: "7", drivers: ["K. KOBAYASHI", "M. CONWAY"], points: 50, pointsSource: "official", stagePoints: [50] },
          // Подменный пилот — отдельная строка той же машины; штатный пилот в
          // ней повторяется (зачётные категории пилотов пересекаются).
          { position: 5, carNumber: "7", drivers: ["N. DE VRIES", "K. KOBAYASHI"], points: 20, pointsSource: "official", stagePoints: [20] },
          { position: 2, carNumber: "20", drivers: ["R. RAST", "K. KOBAYASHI"], points: 40, pointsSource: "official", stagePoints: [40] },
        ],
      },
      {
        raceClass: "LMGT3", winsSource: "real", crews: [], driverRows: [
          { position: 1, carNumber: "33", drivers: ["B. KEATING"], points: 30, pointsSource: "official", stagePoints: [30] },
          { position: 2, carNumber: null, drivers: ["БЕЗ МАШИНЫ"], points: 1, pointsSource: "official", stagePoints: [1] },
        ],
      },
    ],
  } as unknown as WecStandingsDoc;
  const map = crewByCarNumber(doc);
  assert.deepEqual(map.get("7"), ["K. KOBAYASHI", "M. CONWAY", "N. DE VRIES"]);
  assert.deepEqual(map.get("20"), ["R. RAST", "K. KOBAYASHI"], "тёзка в другой машине не дублируется в чужой экипаж");
  assert.deepEqual(map.get("33"), ["B. KEATING"], "LMGT3 в той же карте");
  assert.equal(map.size, 3, "строка без номера машины экипажа не образует");
  assert.equal(crewByCarNumber(null).size, 0, "нет зачёта сезона — нет джойна");
});

// MARK: Сборка документа события

test("buildWecEventDoc: расписание — костяк, протоколы приклеены по подписи, порядок хронологический", () => {
  const event = indexEvent({
    round: 4, slug: "24-hours-of-le-mans-2031-1", name: "24 Hours of Le Mans",
    start: "2031-06-11T00:00:00+02:00", end: "2031-06-15T00:00:00+02:00",
    sourceIds: {
      fiawec: {
        slug: "24-hours-of-le-mans-2031-1", raceId: 42,
        sessions: [
          // Порядок и id как у fiawec: RACE выдан раньше, id не по времени.
          { id: 7608, label: "RACE" },
          { id: 7616, label: "FREE PRACTICE 1" },
          { id: 7623, label: "HYPERPOLE 1 - HYPERCAR" },
          { id: 7624, label: "HYPERPOLE 2 - HYPERCAR" },
        ],
      },
    },
  });
  const rowsBySessionId = new Map([
    [7608, [{ position: 1, carNumber: "83", team: "AF CORSE", laps: 387, totalTime: "24:02:53.332", gapFirst: "", status: "classified" as const }]],
    [7616, [{ position: 1, carNumber: "38", team: "CADILLAC HERTZ TEAM JOTA", laps: 31, totalTime: "3:25.148", gapFirst: "", status: "classified" as const }]],
    [7623, [{ position: 1, carNumber: "311", team: "CADILLAC WHELEN", laps: 6, totalTime: "3:22.742", gapFirst: "", status: "classified" as const }]],
    [7624, [{ position: 1, carNumber: "12", team: "CADILLAC HERTZ TEAM JOTA", laps: 5, totalTime: "3:23.166", gapFirst: "", status: "classified" as const }]],
  ]);
  const doc = buildWecEventDoc({
    season: 2031,
    event,
    schedule: [
      { name: "Race", start: "2031-06-14T16:00:00+02:00", status: "EventCompleted" },
      { name: "Free Practice 1", start: "2031-06-11T14:00:00+02:00", status: "EventCompleted" },
      { name: "HYPERPOLE 1 - HYPERCAR", start: "2031-06-12T21:05:00+02:00", status: "EventCompleted" },
      { name: "HYPERPOLE 2 - HYPERCAR", start: "2031-06-12T21:40:00+02:00", status: "EventCompleted" },
      { name: "Warm-up", start: "2031-06-14T12:00:00+02:00", status: "EventCompleted" },
    ],
    rowsBySessionId,
    crewByCar: new Map([["83", ["R. KUBICA", "P. HANSON", "Y. YE"]]]),
    crewSource: "seasonStandings",
    now: Date.parse("2031-12-01T00:00:00Z"),
  });

  // Порядок — по времени старта, а не по id дропдауна и не по порядку JSON-LD.
  assert.deepEqual(doc.sessions.map((s) => [s.name, s.kind, s.phase]), [
    ["Free Practice 1", "practice", null],
    ["HYPERPOLE 1 - HYPERCAR", "hyperpole", 1],
    ["HYPERPOLE 2 - HYPERCAR", "hyperpole", 2],
    ["Warm-up", "warmup", null],
    ["Race", "race", null],
  ]);
  // Обе фазы хайперполя живут в файле: какая решает решётку — правило экрана
  // (последняя), а данные обеих обязаны быть.
  assert.deepEqual(doc.sessions[1].rows.map((r) => r.carNumber), ["311"]);
  assert.deepEqual(doc.sessions[2].rows.map((r) => r.carNumber), ["12"]);
  // Warm-up есть в расписании, но не в дропдауне результатов — без протокола.
  assert.equal(doc.sessions[3].sourceIds.sessionId, null);
  assert.deepEqual(doc.sessions[3].rows, []);
  assert.equal(doc.sessions[3].raceClass, null);
  // Экипаж подставлен по номеру машины; незнакомая машина — пустой список.
  assert.deepEqual(doc.sessions[4].rows[0].drivers, ["R. KUBICA", "P. HANSON", "Y. YE"]);
  assert.deepEqual(doc.sessions[0].rows[0].drivers, []);
  assert.equal(doc.round, 4);
  assert.equal(doc.crewSource, "seasonStandings");
  assert.ok(doc.frozen, "событие завершено и отстоялось");
});

test("buildWecEventDoc: сессия результатов без расписания не теряется", () => {
  const event = indexEvent({
    sourceIds: {
      fiawec: {
        slug: "6-hours-of-imola-2031", raceId: 41,
        sessions: [{ id: 51, label: "RACE" }, { id: 52, label: "QUALIFYING - LMGT3" }],
      },
    },
  });
  const doc = buildWecEventDoc({
    season: 2031, event,
    schedule: [{ name: "Race", start: "2031-04-19T13:00:00+02:00", status: "EventCompleted" }],
    rowsBySessionId: new Map([[52, [
      { position: 1, carNumber: "34", team: "RACING TEAM TURKEY BY TF", laps: 6, totalTime: "1:41.642", gapFirst: "", status: "classified" as const },
    ]]]),
    crewByCar: new Map(), crewSource: null, now: Date.parse("2031-12-01T00:00:00Z"),
  });
  assert.deepEqual(doc.sessions.map((s) => [s.name, s.start, s.rows.length]), [
    ["Race", "2031-04-19T13:00:00+02:00", 0],
    ["QUALIFYING - LMGT3", null, 1],   // без времени — в хвост
  ]);
  assert.equal(doc.sessions[1].raceClass, "LMGT3");
  assert.equal(doc.crewSource, null, "нет зачёта сезона — говорим честно");
});

// MARK: Предохранитель записи — мутационная самопроверка НА ВЫЗОВЕ

/// Минимальный документ события для проверок записи.
function eventDoc(over: Partial<WecEventDoc> = {}): WecEventDoc {
  return {
    series: "wec", season: 2031, round: 1, slug: "6-hours-of-imola-2031",
    name: "6 Hours of Imola", venue: "Imola", trackRef: "imola", countryCode: "it",
    status: "EventCompleted", start: "2031-04-17T00:00:00+02:00",
    end: "2031-04-19T00:00:00+02:00", frozen: false, crewSource: "seasonStandings",
    sourceIds: { fiawec: { slug: "6-hours-of-imola-2031", raceId: 41 } },
    sessions: [
      {
        kind: "race", name: "Race", number: null, phase: null, raceClass: "HYPERCAR",
        start: "2031-04-19T13:00:00+02:00", status: "EventCompleted",
        sourceIds: { sessionId: 51 },
        rows: [
          { position: 1, carNumber: "8", team: "TOYOTA RACING", drivers: ["B. HARTLEY"], laps: 213, totalTime: "6:00:10.939", gapFirst: "", status: "classified" },
          { position: 2, carNumber: "51", team: "FERRARI AF CORSE", drivers: ["J. CALADO"], laps: 213, totalTime: "6:00:24.291", gapFirst: "13.352", status: "classified" },
        ],
      },
    ],
    ...over,
  };
}

test("writeWecEvent: деградация не затирает прежний файл, рост пишется, повтор — unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "wecev-"));
  const path = join(dir, "01_6-hours-of-imola-2031.json");
  try {
    const base = eventDoc();
    assert.equal(writeWecEvent(path, base), "written");
    assert.equal(writeWecEvent(path, base), "unchanged", "идемпотентность: тот же вход — тот же файл");
    const bytes = readFileSync(path, "utf8");

    // Мутация 1: пропала сессия (дыра дропдауна/зеркала).
    const noSession = eventDoc({ sessions: [] });
    assert.equal(writeWecEvent(path, noSession), "kept-previous");
    // Мутация 2: сессия осталась, протокол опустел.
    const noRows = eventDoc();
    noRows.sessions[0].rows = [];
    assert.equal(writeWecEvent(path, noRows), "kept-previous");
    // Мутация 3: не доехала страница события — пропали времена сессий.
    const noStart = eventDoc();
    noStart.sessions[0].start = null;
    assert.equal(writeWecEvent(path, noStart), "kept-previous");
    // Мутация 4: не собрался зачёт — пропали имена экипажей.
    const noCrew = eventDoc({ crewSource: null });
    noCrew.sessions[0].rows = noCrew.sessions[0].rows.map((r) => ({ ...r, drivers: [] }));
    assert.equal(writeWecEvent(path, noCrew), "kept-previous");
    assert.equal(readFileSync(path, "utf8"), bytes, "ни одна деградация файл не тронула");

    // Рост (доехала ещё одна сессия) — норма, пишем.
    const grown = eventDoc();
    grown.sessions.push({
      kind: "qualifying", name: "Qualifying - HYPERCAR", number: null, phase: null,
      raceClass: "HYPERCAR", start: "2031-04-18T15:10:00+02:00", status: "EventCompleted",
      sourceIds: { sessionId: 50 }, rows: [],
    });
    assert.equal(writeWecEvent(path, grown), "written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeWecEvent: замороженное событие не пересобирается; WEC_EVENTS_FORCE перебивает", () => {
  const dir = mkdtempSync(join(tmpdir(), "wecev-"));
  const path = join(dir, "01_6-hours-of-imola-2031.json");
  try {
    const frozen = eventDoc({ frozen: true });
    assert.equal(writeWecEvent(path, frozen), "written", "первая запись истории");
    const bytes = readFileSync(path, "utf8");
    // Кумулятивный зачёт добавил в экипаж подменного пилота — историю это
    // двигать не должно (иначе каждая замена переписывала бы все прошлые этапы).
    const changed = eventDoc({ frozen: true });
    changed.sessions[0].rows[0].drivers = ["B. HARTLEY", "R. HIRAKAWA"];
    assert.equal(writeWecEvent(path, changed), "frozen");
    assert.equal(readFileSync(path, "utf8"), bytes);
    process.env.WEC_EVENTS_FORCE = "1";
    try {
      assert.equal(writeWecEvent(path, changed), "written", "ручка оператора работает");
    } finally {
      delete process.env.WEC_EVENTS_FORCE;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wecEventRegression: каждая деградация ловится СВОЕЙ проверкой", () => {
  // Проверки перекрываются (пропажа протокола убивает и строки, и экипажи),
  // поэтому сверяем именно ПРИЧИНУ: иначе выпадение любой из них живёт
  // незамеченным за спиной соседней.
  assert.equal(wecEventRegression(null, { sessions: [] }), null, "первого файла нет — пишем");
  const one = eventDoc();
  assert.equal(wecEventRegression(one, eventDoc()), null, "тот же вход — не деградация");
  assert.match(wecEventRegression(one, { sessions: [] }) ?? "", /сессий стало меньше/);

  // Строки: экипажей нет ни до, ни после (архивный сезон) — работает только
  // проверка строк.
  const bare = eventDoc({ crewSource: null });
  bare.sessions[0].rows = bare.sessions[0].rows.map((r) => ({ ...r, drivers: [] }));
  const bareEmpty = eventDoc({ crewSource: null });
  bareEmpty.sessions[0].rows = [];
  assert.match(wecEventRegression(bare, bareEmpty) ?? "", /строк протоколов стало меньше/);

  // Времена: строки и экипажи на месте, пропала только страница события.
  const noStart = eventDoc();
  noStart.sessions[0].start = null;
  assert.match(wecEventRegression(one, noStart) ?? "", /со временем старта/);

  // Экипажи: строки на месте, имена пропали.
  const noCrew = eventDoc();
  noCrew.sessions[0].rows = noCrew.sessions[0].rows.map((r) => ({ ...r, drivers: [] }));
  assert.match(wecEventRegression(one, noCrew) ?? "", /имена экипажей пропали/);
});

// MARK: Интеграция: сборка из зеркала (полный цикл + идемпотентность + GC)

test("buildWecEventFiles: полный цикл из зеркала, идемпотентность, GC выбывшего события", () => {
  const root = mkdtempSync(join(tmpdir(), "wecdata-"));
  const NOW = Date.parse("2031-04-25T00:00:00Z"); // этап 19.04 ещё НЕ заморожен (окно 7д)
  try {
    const mirrorDir = join(root, "wec", "fiawec");
    const seasonDir = join(root, "wec", "2031");
    mkdirSync(mirrorDir, { recursive: true });
    mkdirSync(seasonDir, { recursive: true });

    const sessions = [{ id: 50, label: "QUALIFYING - HYPERCAR" }, { id: 51, label: "RACE" }];
    writeFileSync(join(seasonDir, "index.json"), JSON.stringify({
      schemaVersion: 1, series: "wec", season: 2031, frozen: false,
      events: [
        {
          ...indexEvent({ sourceIds: { fiawec: { slug: "6-hours-of-imola-2031", raceId: 41, sessions } } }),
        },
        indexEvent({
          round: 0, slug: "official-prologue-imola-2031", name: "Official Prologue - IMOLA",
          start: "2031-04-14T00:00:00+02:00", end: "2031-04-14T12:00:00+02:00",
          resultsPath: "wec/2031/test_official-prologue-imola-2031.json",
          sourceIds: { fiawec: { slug: "official-prologue-imola-2031", raceId: 40, sessions: [] } },
        }),
      ],
    }));
    writeFileSync(join(seasonDir, "standings.json"), JSON.stringify({
      schemaVersion: 1, series: "wec", season: 2031, frozen: false, rounds: ["IT"],
      classes: [{
        raceClass: "HYPERCAR", winsSource: "real", crews: [],
        driverRows: [{ position: 1, carNumber: "8", drivers: ["B. HARTLEY", "R. HIRAKAWA"], points: 25, pointsSource: "official", stagePoints: [25] }],
      }],
    }));
    // Осиротевший файл прошлого прогона: этап уехал в другой сезон.
    writeFileSync(join(seasonDir, "09_qatar-1812km-2031.json"), '{"series":"wec"}');

    writeFileSync(join(mirrorDir, "en_race_6_hours_of_imola_2031"), racePageHTML({
      name: "WEC 6 Hours of Imola 2031", start: "2031-04-17T00:00:00+02:00",
      end: "2031-04-19T00:00:00+02:00", raceId: 41,
      sessions: [
        { name: "Qualifying - HYPERCAR", start: "2031-04-18T15:10:00+02:00" },
        { name: "Race", start: "2031-04-19T13:00:00+02:00" },
      ],
    }));
    writeFileSync(join(mirrorDir, "en_race_official_prologue_imola_2031"), racePageHTML({
      name: "WEC Official Prologue - IMOLA 2031", start: "2031-04-14T00:00:00+02:00",
      end: "2031-04-14T12:00:00+02:00", raceId: 40,
      sessions: [{ name: "MORNING SESSION", start: "2031-04-14T09:00:00+02:00" }],
    }));
    writeFileSync(join(mirrorDir, "en_page_resultats_1_raceId_41_sessionId_51"),
      sessionHTML(RACE_HEADERS, [
        { cells: ["1", "#8", "TOYOTA RACING", "213", "6:00:10.939", "-", "-", "180.37", "1:32.490", "88"] },
        { cells: ["2", "#51", "FERRARI AF CORSE", "213", "6:00:24.291", "13.352", "13.352", "180.36", "1:32.462", "90"] },
      ]));
    // Квала: зеркала нет — сессия отдаёт расписание без протокола.

    assert.match(buildWecEventFiles(2031, NOW, root), /events 2031: 2 written/);
    const racePath = join(seasonDir, "01_6-hours-of-imola-2031.json");
    const doc = JSON.parse(readFileSync(racePath, "utf8"));
    assert.equal(doc.schemaVersion, WEC_EVENT_SCHEMA_VERSION);
    assert.equal(doc.series, "wec");
    assert.equal(doc.round, 1);
    assert.equal(doc.trackRef, "imola", "ref события едет из index.json");
    assert.ok(!doc.frozen, "окно оседания результата ещё не прошло");
    assert.deepEqual(doc.sessions.map((s: any) => [s.name, s.kind, s.rows.length]), [
      ["Qualifying - HYPERCAR", "qualifying", 0],
      ["Race", "race", 2],
    ]);
    assert.deepEqual(doc.sessions[1].rows[0].drivers, ["B. HARTLEY", "R. HIRAKAWA"],
      "экипаж разрезолвлен зачётом СЕЗОНА события");
    assert.equal(doc.crewSource, "seasonStandings");

    const prologue = JSON.parse(readFileSync(join(seasonDir, "test_official-prologue-imola-2031.json"), "utf8"));
    assert.deepEqual(prologue.sessions.map((s: any) => [s.name, s.kind, s.raceClass]),
      [["MORNING SESSION", "other", null]], "у пролога протоколов нет вовсе — только расписание");

    assert.ok(!existsSync(join(seasonDir, "09_qatar-1812km-2031.json")), "осиротевший файл убран");

    // Идемпотентность: повторный прогон не дёргает файлы. Пролог к этому
    // моменту уже отстоялся (14.04 + 7д) — он не пересобирается вовсе.
    const bytes = readFileSync(racePath, "utf8");
    assert.match(buildWecEventFiles(2031, NOW, root), /1 unchanged, 1 frozen/);
    assert.equal(readFileSync(racePath, "utf8"), bytes);

    // Дыра зеркала: протокол пропал → прежний файл не тронут.
    rmSync(join(mirrorDir, "en_page_resultats_1_raceId_41_sessionId_51"));
    assert.match(buildWecEventFiles(2031, NOW, root), /kept-previous/);
    assert.equal(readFileSync(racePath, "utf8"), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWecEventFiles: архивный сезон без зачёта — файлы есть, экипажи пустые и честные", () => {
  const root = mkdtempSync(join(tmpdir(), "wecdata-"));
  const NOW = Date.parse("2032-01-01T00:00:00Z");
  try {
    const mirrorDir = join(root, "wec", "fiawec");
    const seasonDir = join(root, "wec", "2031");
    mkdirSync(mirrorDir, { recursive: true });
    mkdirSync(seasonDir, { recursive: true });
    writeFileSync(join(seasonDir, "index.json"), JSON.stringify({
      schemaVersion: 1, series: "wec", season: 2031, frozen: true,
      events: [indexEvent({
        sourceIds: { fiawec: { slug: "6-hours-of-imola-2031", raceId: 41, sessions: [{ id: 51, label: "RACE" }] } },
      })],
    }));
    writeFileSync(join(mirrorDir, "en_race_6_hours_of_imola_2031"), racePageHTML({
      name: "WEC 6 Hours of Imola 2031", raceId: 41,
      sessions: [{ name: "Race", start: "2031-04-19T13:00:00+02:00" }],
    }));
    writeFileSync(join(mirrorDir, "en_page_resultats_1_raceId_41_sessionId_51"),
      sessionHTML(RACE_HEADERS, [
        { cells: ["1", "#8", "TOYOTA RACING", "213", "6:00:10.939", "-", "-", "180.37", "1:32.490", "88"] },
      ]));

    assert.match(buildWecEventFiles(2031, NOW, root), /экипажи не резолвятся/);
    const doc = JSON.parse(readFileSync(join(seasonDir, "01_6-hours-of-imola-2031.json"), "utf8"));
    assert.equal(doc.crewSource, null);
    assert.deepEqual(doc.sessions[0].rows[0].drivers, [],
      "чужой сезон в архивные экипажи не подставляем");
    assert.ok(doc.frozen);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWecEventFiles: нет индекса сезона — ни одного файла (fail-closed)", () => {
  const root = mkdtempSync(join(tmpdir(), "wecdata-"));
  try {
    mkdirSync(join(root, "wec", "fiawec"), { recursive: true });
    assert.match(buildWecEventFiles(2031, Date.now(), root), /нет index.json/);
    assert.ok(!existsSync(join(root, "wec", "2031")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// MARK: - Часовой пояс площадки (починка ложного офсета источника)

/// fiawec штампует расписанию ПАРИЖСКИЙ офсет независимо от места этапа: у
/// Фудзи «10:15+02:00» вместо «+09:00» — ошибка семь часов, видимая
/// пользователю в расписании. Настенное время верное, врёт только офсет.
///
/// Тест гоняет СБОРКУ, а не читает готовый файл: проверка по коммиченным
/// данным зелена и с выключенной починкой — файл-то уже пересобран.
test("сборка: момент сессии пересобирается по часовому поясу трассы", () => {
  const root = mkdtempSync(join(tmpdir(), "wectz-"));
  const NOW = Date.parse("2031-10-01T00:00:00Z");
  try {
    const mirrorDir = join(root, "wec", "fiawec");
    const seasonDir = join(root, "wec", "2031");
    mkdirSync(mirrorDir, { recursive: true });
    mkdirSync(seasonDir, { recursive: true });

    const sessions = [{ id: 70, label: "RACE" }];
    writeFileSync(join(seasonDir, "index.json"), JSON.stringify({
      schemaVersion: 1, series: "wec", season: 2031, frozen: false,
      events: [indexEvent({
        round: 1, slug: "6-hours-of-fuji-2031", name: "6 Hours of Fuji",
        venue: "Fuji Speedway", trackRef: "fuji", countryCode: "jp",
        start: "2031-09-26T00:00:00+02:00", end: "2031-09-28T00:00:00+02:00",
        resultsPath: "wec/2031/01_6-hours-of-fuji-2031.json",
        sourceIds: { fiawec: { slug: "6-hours-of-fuji-2031", raceId: 70, sessions } },
      })],
    }));
    // Страница события: расписание с ЛОЖНЫМ парижским офсетом — ровно как у
    // источника.
    writeFileSync(join(mirrorDir, mirrorSlug("/en/race/6-hours-of-fuji-2031")), `
      <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"SportsEvent","name":"6 Hours of Fuji",
       "startDate":"2031-09-26T00:00:00+02:00","endDate":"2031-09-28T00:00:00+02:00",
       "subEvent":[{"name":"Race","startDate":"2031-09-28T11:00:00+02:00",
                    "eventStatus":"https://schema.org/EventCompleted"}]}
      </script>`);
    writeFileSync(join(mirrorDir, mirrorSlug("/en/page/resultats-1?raceId=70")),
                  `<select><option value="70" selected>RACE</option></select>`);

    resetRefsCacheForTesting();
    buildWecEventFiles(2031, NOW, root);
    const doc = JSON.parse(
      readFileSync(join(seasonDir, "01_6-hours-of-fuji-2031.json"), "utf8"));
    const payload = doc.payload ?? doc;
    const race = payload.sessions.find((x: any) => x.name === "Race");
    assert.equal(String(race.start).slice(-6), "+09:00",
                 "офсет остался парижским — момент смещён на семь часов");
    assert.match(String(race.start), /T11:00:00/,
                 "настенное время обязано остаться дословным");
    assert.equal(new Date(Date.parse(race.start)).toISOString(), "2031-09-28T02:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("сессии: у европейских этапов офсет остаётся прежним", () => {
  // Обратная сторона: починка не имеет права ломать то, что и так было верно
  // (Ле-Ман в июне — тот же CEST, что штампует источник).
  const doc = JSON.parse(readFileSync("data/wec/2025/04_24-hours-of-le-mans-2025-1.json", "utf8"));
  const payload = doc.payload ?? doc;
  for (const s of payload.sessions.filter((x: any) => x.start)) {
    assert.equal(String(s.start).slice(-6), "+02:00", s.name);
  }
});

test("сессии: зона неизвестна — строка остаётся как была (fail-open)", () => {
  assert.equal(trackTimeZone(null), null);
  assert.equal(trackTimeZone("нет-такой-трассы"), null);
  assert.equal(trackTimeZone("fuji"), "Asia/Tokyo");
});
