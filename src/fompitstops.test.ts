// Пострейс-канал питстопов из статики FOM (lib/fompitstops.ts + потребители).
// Проверяется ровно то, на чём этот канал ломается молча:
//  1. РАЗРЕЖЕННЫЕ ИНДЕКСЫ PitStopSeries — первый стоп машины приходит массивом
//     `[entry]`, следующие объектом-патчем `{"1": entry}`. Наивный
//     `Array.isArray` на второй форме роняет парсер (проверено на Монако-2026);
//  2. КРОСС-ЧЕК PitLaneTimeCollection — визит без пары в PSS обязан ДОЖИТЬ до
//     файла со `stationarySec: null`, иначе теряются стопы пачками (Венгрия
//     теряет 12 из 46, Монако 41 из 70);
//  3. СТОРОЖА ФОРМЫ — писатель бросает, а не пишет молча: правовая граница
//     держится тем, что в файл попадают только числа в нашей форме;
//  4. KEPT-PREVIOUS и заморозка продьюсера;
//  5. ПОРЯДОК ИСТОЧНИКОВ у потребителей (наш факт → openf1 → награды DHL) —
//     разъехавшись, он молча вернул бы витрину на сломанный openf1.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LANE_SUSPENDED_SEC, PITSTOPS_PARSER_VERSION, PITSTOPS_SCHEMA_VERSION,
  buildEventPitstops, mergePitStops, parsePitLaneTimes, parsePitStopSeries,
  pitSessionTag, pitstopsFactError, pitstopsPath, raceSessionsOf, readEventPitstops,
  readSeasonPitstops, stationaryCoverage, streamFrames, timedStops, writeEventPitstops,
  type EventPitstops,
} from "./lib/fompitstops.js";
import { parseIndex } from "./lib/fomstatic.js";
import { computeFastestPitStop, computeMedianPitStop, pitstopsFactStops }
  from "./producers/f1highlights.js";
import { buildPits, factPitsForRound, type SeasonRound, type TeamDriverForm }
  from "./producers/f1teams.js";
import { factPitRow, numberMap } from "./producers/f1beasts.js";
import { canSkip, pitstopTargets, poorerThan } from "./producers/f1pitstops.js";

// ── Фикстуры: кадры источника байт в байт как он их отдаёт ──────────────────

/// Кадр PitStopSeries: «<offset>{json}», разделитель `\r\n`, BOM в начале.
const pssLine = (off: string, body: string) => `${off}${body}`;

/// Монца-2026, гонка: три реальных кадра. Стоп car 31 (OCO) в этом топике
/// ОТСУТСТВУЕТ — он есть только в PitLaneTimeCollection.
const MONZA_PSS = "﻿" + [
  pssLine("01:50:02.032", '{"PitTimes":{"30":[{"Timestamp":"2026-09-06T13:56:37.207Z","PitStop":{"RacingNumber":"30","PitStopTime":"9.0","PitLaneTime":"31.197","Lap":"12"}}]}}'),
  pssLine("02:11:44.927", '{"PitTimes":{"27":[{"Timestamp":"2026-09-06T14:18:20.102Z","PitStop":{"RacingNumber":"27","PitStopTime":"2.4","PitLaneTime":"24.246","Lap":"27"}}]}}'),
  pssLine("02:39:51.770", '{"PitTimes":{"23":[{"Timestamp":"2026-09-06T14:46:26.945Z","PitStop":{"RacingNumber":"23","PitStopTime":"4.4","PitLaneTime":"26.394","Lap":"46"}}]}}'),
].join("\r\n") + "\r\n";

const MONZA_PLTC = "﻿" + [
  '01:32:33.134{"PitTimes":{"63":{"RacingNumber":"63","Duration":"1846.2","Lap":"3"}}}',
  '01:50:02.027{"PitTimes":{"30":{"RacingNumber":"30","Duration":"31.1","Lap":"12"}}}',
  '02:11:44.920{"PitTimes":{"27":{"RacingNumber":"27","Duration":"24.2","Lap":"27"}}}',
  '02:11:52.068{"PitTimes":{"31":{"RacingNumber":"31","Duration":"27.2","Lap":"27"}}}',
  '02:13:23.926{"PitTimes":{"_deleted":["3"]}}',
  '02:39:51.760{"PitTimes":{"23":{"RacingNumber":"23","Duration":"26.3","Lap":"46"}}}',
].join("\r\n") + "\r\n";

/// Монако-2026, машина 5: та самая последовательность «массив → патч → патч».
const MONACO_SPARSE = "﻿" + [
  '00:57:19.495{"PitTimes":{"5":[{"Timestamp":"2026-06-07T13:05:11.753Z","PitStop":{"RacingNumber":"5","PitStopTime":"3.0","PitLaneTime":"25.927","Lap":"1"}}]}}',
  '01:53:41.120{"PitTimes":{"5":{"1":{"Timestamp":"2026-06-07T14:01:33.378Z","PitStop":{"RacingNumber":"5","PitStopTime":"2.2","PitLaneTime":"24.690","Lap":"43"}}}}}',
  '02:16:14.571{"PitTimes":{"5":{"2":{"Timestamp":"2026-06-07T14:24:06.829Z","PitStop":{"RacingNumber":"5","PitStopTime":"2.5","PitLaneTime":"24.824","Lap":"59"}}}}}',
].join("\r\n");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "fompitstops-"));
}

// ── 1. Разбор потока ────────────────────────────────────────────────────────

test("кадры: BOM, CRLF и оборванная строка не роняют разбор", () => {
  assert.equal(streamFrames(MONZA_PSS).length, 3);
  // Обрыв посреди кадра — снятое до него сохраняем: терять файл из-за хвоста
  // хуже, чем потерять хвост.
  assert.equal(streamFrames('00:00:01.000{"a":1}\r\n00:00:02.000{"b":').length, 1);
  assert.deepEqual(streamFrames(""), []);
  // 403 отдаётся XML-ом, а не пустотой: фигурной скобки там нет вовсе.
  assert.deepEqual(streamFrames("<Error><Code>AccessDenied</Code></Error>"), []);
});

test("РАЗРЕЖЕННЫЕ ИНДЕКСЫ: кадр-массив и кадры-патчи дают ТРИ стопа, а не один", () => {
  const stops = parsePitStopSeries(MONACO_SPARSE);
  assert.equal(stops.length, 3, "патч {\"1\": …} — не мусор, а второй стоп машины");
  assert.deepEqual(stops.map((s) => s.lap), [1, 43, 59]);
  assert.deepEqual(stops.map((s) => s.stationarySec), [3, 2.2, 2.5]);
  // Порядок внутри машины — по индексу источника, а не по приходу кадра.
  assert.equal(stops[0].at, "2026-06-07T13:05:11.753Z");
});

test("поздний кадр по ЗАНЯТОМУ индексу перетирает ранний, а не двоит", () => {
  const revised = [
    '00:01:00.000{"PitTimes":{"7":[{"Timestamp":"2026-01-01T00:00:00.000Z","PitStop":{"RacingNumber":"7","PitStopTime":"3.0","PitLaneTime":"25.0","Lap":"5"}}]}}',
    '00:02:00.000{"PitTimes":{"7":{"0":{"Timestamp":"2026-01-01T00:00:01.000Z","PitStop":{"RacingNumber":"7","PitStopTime":"2.8","PitLaneTime":"24.8","Lap":"5"}}}}}',
  ].join("\r\n");
  const stops = parsePitStopSeries(revised);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].stationarySec, 2.8);
});

test("пустой круг источника («Lap»: \"\") — это null, а не ноль и не пропуск", () => {
  const noLap = '00:01:00.000{"PitTimes":{"4":[{"Timestamp":"2026-03-08T05:00:00.000Z",' +
    '"PitStop":{"RacingNumber":"4","PitStopTime":"2.4","PitLaneTime":"22.0","Lap":""}}]}}';
  const stops = parsePitStopSeries(noLap);
  assert.equal(stops.length, 1, "стоп без круга остаётся стопом");
  assert.equal(stops[0].lap, null);
});

test("PitLaneTimeCollection: другая форма, `_deleted` машиной не считается", () => {
  const visits = parsePitLaneTimes(MONZA_PLTC);
  assert.deepEqual(visits.map((v) => v.car), [63, 30, 27, 31, 23]);
  assert.equal(visits.find((v) => v.car === 63)!.laneSec, 1846.2);
});

// ── 2. Мёрдж и кросс-чек ────────────────────────────────────────────────────

test("КРОСС-ЧЕК: визит без пары в PSS доживает до файла со stationarySec null", () => {
  const merged = mergePitStops(parsePitStopSeries(MONZA_PSS), parsePitLaneTimes(MONZA_PLTC));
  const oco = merged.stops.find((s) => s.car === 31);
  assert.ok(oco, "стоп OCO есть в пит-лейне и обязан не потеряться");
  assert.equal(oco!.stationarySec, null, "стационарного времени у него нет — и врать нельзя");
  assert.equal(oco!.laneSec, 27.2);
  assert.equal(oco!.at, undefined, "отметки времени у сироты не бывает");
  // Три стопа PSS + сирота; визит car 63 под красным флагом в stops не идёт.
  assert.equal(merged.stops.length, 4);
  assert.equal(merged.suspended, 1);
});

test("сматченный визит НЕ двоит стоп: у пары один и тот же круг", () => {
  const merged = mergePitStops(parsePitStopSeries(MONZA_PSS), parsePitLaneTimes(MONZA_PLTC));
  assert.equal(merged.stops.filter((s) => s.car === 30).length, 1);
  // Время пит-лейна берётся из PSS (три знака), а не из PLTC (один).
  assert.equal(merged.stops.find((s) => s.car === 30)!.laneSec, 31.197);
});

test("два визита одной машины на РАЗНЫХ кругах не схлопываются в один", () => {
  // Двухстоповая гонка: каждая строка PSS расходуется не более раза, иначе
  // второй визит «съел» бы чужую строку по допуску времени.
  const pss = parsePitStopSeries(MONACO_SPARSE);
  const pltc = parsePitLaneTimes([
    '00:01:00.000{"PitTimes":{"5":{"RacingNumber":"5","Duration":"25.9","Lap":"1"}}}',
    '00:02:00.000{"PitTimes":{"5":{"RacingNumber":"5","Duration":"24.6","Lap":"43"}}}',
    '00:03:00.000{"PitTimes":{"5":{"RacingNumber":"5","Duration":"24.8","Lap":"59"}}}',
  ].join("\r\n"));
  const merged = mergePitStops(pss, pltc);
  assert.equal(merged.stops.length, 3);
  assert.equal(merged.stops.every((s) => s.stationarySec !== null), true);
});

test("сирота матчится по ВРЕМЕНИ, когда круга у источника нет", () => {
  // Австралия-2026: у всех 17 стопов `Lap: ""`. Без допуска по пит-лейну
  // каждый визит стал бы сиротой, и гонка потеряла бы все стационарные.
  const pss = parsePitStopSeries(
    '00:01:00.000{"PitTimes":{"4":[{"Timestamp":"2026-03-08T05:00:00.000Z",' +
    '"PitStop":{"RacingNumber":"4","PitStopTime":"2.4","PitLaneTime":"22.043","Lap":""}}]}}');
  const pltc = parsePitLaneTimes(
    '00:01:00.000{"PitTimes":{"4":{"RacingNumber":"4","Duration":"22.0","Lap":""}}}');
  const merged = mergePitStops(pss, pltc);
  assert.equal(merged.stops.length, 1, "тот же визит, не два");
  assert.equal(merged.stops[0].stationarySec, 2.4);
});

test("остановка гонки — не питстоп: считается счётчиком, в stops не идёт", () => {
  const pltc = parsePitLaneTimes(
    `00:01:00.000{"PitTimes":{"63":{"RacingNumber":"63","Duration":"${LANE_SUSPENDED_SEC + 1}","Lap":"3"}}}`);
  const merged = mergePitStops([], pltc);
  assert.deepEqual(merged.stops, []);
  assert.equal(merged.suspended, 1);
});

test("порядок стопов детерминированный — иначе git дёргался бы каждый прогон", () => {
  const a = mergePitStops(parsePitStopSeries(MONZA_PSS), parsePitLaneTimes(MONZA_PLTC));
  const b = mergePitStops(parsePitStopSeries(MONZA_PSS),
    [...parsePitLaneTimes(MONZA_PLTC)].reverse());
  assert.equal(JSON.stringify(a.stops), JSON.stringify(b.stops));
});

// ── 3. Сборка, сторожа формы, запись ────────────────────────────────────────

const monzaDoc = (): EventPitstops => buildEventPitstops({
  eventKey: "f1-2026-monza-1", eventId: "f1-2026-13", season: 2026, round: 13,
  sessions: [{ tag: "R", pss: MONZA_PSS, pltc: MONZA_PLTC }],
})!;

test("сборка: сессия без снятых топиков и событие без стопов дают null", () => {
  assert.equal(buildEventPitstops({
    eventKey: "f1-2026-monza-1", eventId: "f1-2026-13", season: 2026, round: 13,
    sessions: [{ tag: "R", pss: null, pltc: null }],
  }), null, "«не сняли» — не «стопов нет»");
});

test("СТОРОЖ ФОРМЫ: чистый факт проходит, вербатим и мусор — нет", () => {
  const text = JSON.stringify({ schemaVersion: PITSTOPS_SCHEMA_VERSION, ...monzaDoc() });
  assert.equal(pitstopsFactError(text), null);

  const broken = (mutate: (d: any) => void): string => {
    const d = JSON.parse(text);
    mutate(d);
    return JSON.stringify(d);
  };
  // Сырьё источника не должно пролезть ни целиком, ни по одному ключу.
  assert.match(pitstopsFactError(broken((d) => { d.sessions[0].stops[0].RacingNumber = "30"; }))!,
    /посторонний ключ стопа/);
  assert.match(pitstopsFactError(broken((d) => { d.PitTimes = {}; }))!,
    /посторонний ключ документа/);
  // Строка чужого выражения длиннее любого нашего значения.
  assert.match(pitstopsFactError(broken((d) => {
    d.sessions[0].stops[0].at = "Car 30 was released in an unsafe condition"; }))!,
    /не ISO-8601/);
  // Физика: минуты на домкратах и километровый пит-лейн — не наши числа.
  assert.match(pitstopsFactError(broken((d) => { d.sessions[0].stops[0].stationarySec = 900; }))!,
    /стационарное время вне диапазона/);
  assert.match(pitstopsFactError(broken((d) => { d.sessions[0].stops[0].laneSec = 1846.2; }))!,
    /время в пит-лейне вне диапазона/);
  assert.match(pitstopsFactError(broken((d) => { d.sessions[0].stops[0].car = 0; }))!,
    /номер машины вне диапазона/);
  assert.match(pitstopsFactError(broken((d) => { d.sessions[0].tag = "FP1"; }))!,
    /чужой тег сессии/);
  assert.match(pitstopsFactError(broken((d) => { d.sessions = []; }))!, /сессий нет/);
  assert.match(pitstopsFactError("<Error><Code>AccessDenied</Code></Error>")!, /не JSON/);
});

test("писатель БРОСАЕТ на битой форме, а не пишет молча", () => {
  const root = tempRoot();
  try {
    const doc = monzaDoc();
    // Так выглядит регресс парсера: число уехало в строку источника.
    (doc.sessions[0].stops[0] as any).stationarySec = "9.0";
    assert.throws(() => writeEventPitstops(root, doc, () => true), /вне диапазона/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("чтение применяет ТЕ ЖЕ сторожа, что запись", () => {
  const root = tempRoot();
  try {
    const doc = monzaDoc();
    const written = writeEventPitstops(root, doc, (path, payload, v) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify({ schemaVersion: v, ...payload }, null, 2) + "\n");
      return true;
    });
    assert.equal(written, true);
    const back = readEventPitstops(root, "f1-2026-monza-1")!;
    assert.equal(back.eventId, "f1-2026-13");
    assert.equal(back.parserVersion, PITSTOPS_PARSER_VERSION);
    assert.equal(back.sessions[0].stops.length, 4);

    // Испорченный руками файл до витрины не доезжает.
    writeFileSync(pitstopsPath(root, "f1-2026-monza-1"), '{"schemaVersion":1,"sessions":[]}');
    assert.equal(readEventPitstops(root, "f1-2026-monza-1"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("полнота: covered/total считают измеренное против известного", () => {
  assert.deepEqual(stationaryCoverage(monzaDoc()), { covered: 3, total: 4 });
  assert.equal(timedStops(monzaDoc()).length, 3, "визит без времени измерением не является");
  assert.deepEqual(stationaryCoverage(null), { covered: 0, total: 0 });
});

// ── 4. Резолв сессий индекса ────────────────────────────────────────────────

test("сессии митинга: спринт у источника тоже Type «Race», различает только Name", () => {
  const index = JSON.stringify({
    Year: 2026,
    Meetings: [{
      Key: 1292, Name: "Dutch Grand Prix",
      Sessions: [
        { Key: 11346, Type: "Qualifying", Name: "Sprint Qualifying", Path: "2026/d/sq/" },
        { Key: 11348, Type: "Race", Name: "Sprint", Path: "2026/d/spr/" },
        { Key: 11353, Type: "Race", Name: "Race", Path: "2026/d/r/" },
        { Key: 11340, Type: "Practice", Name: "Practice 1", Path: "2026/d/fp1/" },
      ],
    }, {
      Key: 1293, Name: "Italian Grand Prix",
      Sessions: [{ Key: 11361, Type: "Race", Name: "Race", Path: "2026/i/r/" }],
    }],
  });
  const sessions = parseIndex(index);
  const dutch = raceSessionsOf(sessions, 1292);
  assert.deepEqual(dutch.map((x) => x.tag), ["SPR", "R"]);
  // Чужой митинг не приезжает: сшивка по mk, а не по датам и именам.
  assert.deepEqual(raceSessionsOf(sessions, 1293).map((x) => x.session.path), ["2026/i/r/"]);
  assert.deepEqual(raceSessionsOf(sessions, 9999), []);
});

test("тег сессии: квалы и спринт-квалы питстопами не считаются", () => {
  assert.equal(pitSessionTag("Race"), "R");
  assert.equal(pitSessionTag("Sprint"), "SPR");
  assert.equal(pitSessionTag("Sprint Qualifying"), null);
  assert.equal(pitSessionTag("Qualifying"), null);
  assert.equal(pitSessionTag("Practice 2"), null);
});

// ── 5. Резолв «раунд → eventKey» и порядок источников у потребителей ────────

/// Витрина календаря + факт события на диске — вход всех трёх потребителей.
function seededRoot(): string {
  const root = tempRoot();
  mkdirSync(join(root, "f1", "calendar"), { recursive: true });
  writeFileSync(join(root, "f1", "calendar", "2026.json"), JSON.stringify({
    series: "f1", season: 2026, frozen: false,
    events: [
      { id: "f1-2026-0", round: 0, kind: "testing", eventKey: "f1-2026-bahrain-testing-1" },
      { id: "f1-2026-13", round: 13, kind: "race", eventKey: "f1-2026-monza-1" },
      { id: "f1-2026-14", round: 14, kind: "cancelled", eventKey: "f1-2026-jeddah-1" },
    ],
  }));
  writeEventPitstops(root, monzaDoc(), (path, payload, v) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ schemaVersion: v, ...payload }, null, 2) + "\n");
    return true;
  });
  return root;
}

test("резолв сезона: только гонки витрины, тест и отмена мимо", () => {
  const root = seededRoot();
  try {
    const byRound = readSeasonPitstops(root, 2026);
    assert.deepEqual([...byRound.keys()], [13], "round 0 — сентинел, а не раунд");
    assert.equal(byRound.get(13)!.eventKey, "f1-2026-monza-1");
    // Витрины сезона нет — резолвить нечем, но падать не за что.
    assert.equal(readSeasonPitstops(root, 2025).size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- highlights --

const OPENF1_SESSIONS = [
  { session_key: 1, session_name: "Practice 1" },
  { session_key: 3, session_name: "Race" },
];
const OPENF1_PITS = new Map<number, any[]>([
  [1, [{ driver_number: 4, stop_duration: 1.0 }]],
  [3, [{ driver_number: 16, stop_duration: 5.5 }, { driver_number: 30, stop_duration: 6.0 }]],
]);
const OPENF1_DRIVERS = [
  { driver_number: 27, first_name: "Nico", last_name: "Hulkenberg" },
  { driver_number: 16, first_name: "Charles", last_name: "Leclerc" },
];

test("highlights: наш факт ВЫТЕСНЯЕТ openf1, а не дополняет его", () => {
  const preferred = pitstopsFactStops(monzaDoc());
  const stop = computeFastestPitStop(OPENF1_SESSIONS, OPENF1_PITS, OPENF1_DRIVERS, preferred)!;
  assert.equal(stop.seconds, 2.4, "минимум нашего факта, а не openf1");
  assert.equal(stop.driver, "N. Hulkenberg", "пилот резолвится по номеру машины");
  assert.equal(stop.tag, "R");

  // Факта на раунд нет — фолбэк работает ровно как прежде.
  const fallback = computeFastestPitStop(OPENF1_SESSIONS, OPENF1_PITS, OPENF1_DRIVERS, [])!;
  assert.equal(fallback.seconds, 5.5);
  assert.equal(fallback.driver, "C. Leclerc");
});

test("highlights: медиана несёт СВОЮ ПОЛНОТУ — иначе молча врёт", () => {
  const median = computeMedianPitStop(OPENF1_SESSIONS, OPENF1_PITS,
    pitstopsFactStops(monzaDoc()))!;
  // Измерены 9.0 / 2.4 / 4.4 → медиана 4.4; четвёртый визит без времени.
  assert.equal(median.seconds, 4.4);
  assert.deepEqual([median.covered, median.total], [3, 4]);

  // У фолбэка openf1 известны ровно измеренные — сравнивать не с чем.
  const fallback = computeMedianPitStop(OPENF1_SESSIONS, OPENF1_PITS, [])!;
  assert.deepEqual([fallback.covered, fallback.total], [2, 2]);
});

/// Факт БЕЗ ЕДИНОГО измерения (PitStopSeries отдал 403, живы только визиты
/// пит-лейна — реальное состояние архива до US GP 2024) обязан пустить в дело
/// фолбэк openf1: гейт каскада считает ИЗМЕРЕНИЯ, а не строки, иначе непустой
/// но бесполезный факт навсегда глушил бы нижние источники.
test("highlights: факт без измерений уступает место фолбэку openf1", () => {
  const orphanOnly = buildEventPitstops({
    eventKey: "f1-2026-monza-1", eventId: "f1-2026-13", season: 2026, round: 13,
    sessions: [{ tag: "R", pss: null, pltc: MONZA_PLTC }],
  })!;
  const rows = pitstopsFactStops(orphanOnly);
  assert.ok(rows.length > 0, "фикстура: визиты пит-лейна есть");
  assert.ok(rows.every((r) => r.seconds === null), "фикстура: измерений нет ни одного");

  const stop = computeFastestPitStop(OPENF1_SESSIONS, OPENF1_PITS, OPENF1_DRIVERS, rows);
  assert.equal(stop?.seconds, 5.5, "фолбэк openf1 обязан включиться");

  // Ни там, ни там измерений нет — вот тогда «быстрейшего» действительно нет.
  assert.equal(
    computeFastestPitStop(OPENF1_SESSIONS, new Map(), OPENF1_DRIVERS, rows), null,
    "измерений нет ни в факте, ни в фолбэке — быстрейшего нет");
});

// -- teams --

const teamForm = (driverId: string, number: string, rounds: number[]): TeamDriverForm => ({
  driverId, code: driverId.slice(0, 3).toUpperCase(), number, name: driverId,
  results: rounds.map((round) => ({ round, race: `R${round}`, position: 5, status: "Finished" })),
  sprintWins: 0, qualiWins: 0,
});
const TEAM_ROUNDS: SeasonRound[] = [{ round: 13, code: "ITA", race: "Italian Grand Prix" }];
const TEAM_DATES = new Map([[13, "2026-09-06"]]);

/// Зеркало openf1 с ЗАВЕДОМО ХУДШИМ временем: если оно попало в карточку,
/// значит порядок источников разъехался.
const openf1Read = (relative: string): any | null => {
  if (relative.startsWith("meetings")) {
    return [{ meeting_key: 1293, date_start: "2026-09-04", date_end: "2026-09-06T15:00:00" }];
  }
  if (relative.startsWith("sessions")) return [{ session_key: 11361, session_name: "Race" }];
  if (relative.startsWith("pit")) return [{ driver_number: 27, stop_duration: 8.8 }];
  return null;
};

test("teams: наш факт первым приоритетом, зеркало openf1 — фолбэком", () => {
  const form = [teamForm("hulkenberg", "27", [13])];
  const facts = new Map([[13, monzaDoc()]]);
  const withFact = buildPits(form, TEAM_ROUNDS, 2026, TEAM_DATES, openf1Read, facts)!;
  assert.deepEqual(withFact.map((p) => [p.driverId, p.value]), [["hulkenberg", "2.400"]]);

  const withoutFact = buildPits(form, TEAM_ROUNDS, 2026, TEAM_DATES, openf1Read, new Map())!;
  assert.deepEqual(withoutFact.map((p) => [p.driverId, p.value]), [["hulkenberg", "8.800"]]);
});

test("teams: «не знаем» остаётся «не знаем» — ни факта, ни зеркала = null", () => {
  const form = [teamForm("hulkenberg", "27", [13])];
  assert.equal(buildPits(form, TEAM_ROUNDS, 2026, TEAM_DATES, () => null, new Map()), null);
  // Зеркала нет, но факт покрывает ВСЕ раунды — это уже знание.
  const onlyFact = buildPits(form, TEAM_ROUNDS, 2026, TEAM_DATES, () => null,
    new Map([[13, monzaDoc()]]))!;
  assert.deepEqual(onlyFact.map((p) => p.value), ["2.400"]);
});

/// Мёртвое зеркало + факт НЕ НА ВСЕ раунды — это «знаем частично», и оно
/// обязано читаться как «не знаем»: иначе stale.pits становится false,
/// прежние карточки не переносятся, а пилоты непокрытых раундов молча
/// теряют свои (ревью канала питстопов).
test("teams: факт покрывает не все раунды при мёртвом зеркале — тоже null", () => {
  const form = [teamForm("hulkenberg", "27", [12, 13])];
  const rounds: SeasonRound[] = [
    { round: 12, code: "NED", race: "Dutch Grand Prix" },
    ...TEAM_ROUNDS,
  ];
  const dates = new Map([[12, "2026-08-30"], [13, "2026-09-06"]]);
  assert.equal(
    buildPits(form, rounds, 2026, dates, () => null, new Map([[13, monzaDoc()]])), null,
    "раунд 12 не покрыт ни зеркалом, ни фактом — знание неполно");
  // Живое зеркало закрывает непокрытый раунд — знание снова полное.
  assert.ok(buildPits(form, rounds, 2026, dates, openf1Read, new Map([[13, monzaDoc()]])));
});

test("teams: визиты без стационарного в карточку пилота не идут", () => {
  // Машина 31 есть в факте, но только как визит пит-лейна.
  const form = [teamForm("ocon", "31", [13])];
  const pits = buildPits(form, TEAM_ROUNDS, 2026, TEAM_DATES, () => null,
    new Map([[13, monzaDoc()]]))!;
  assert.deepEqual(pits, [], "карточка показывает измерение, а не свидетельство визита");
  assert.equal(factPitsForRound(monzaDoc()).some((p) => p.car === 31), false);
});

// -- beasts --

const RESULTS = [
  { number: "27", Driver: { code: "HUL", familyName: "Hulkenberg" },
    Constructor: { constructorId: "audi", name: "Audi" } },
  { number: "30", Driver: { code: "LAW", familyName: "Lawson" },
    Constructor: { constructorId: "red_bull", name: "Red Bull" } },
];

test("beasts: строка из факта приезжает С ПИЛОТОМ (в отличие от награды DHL)", () => {
  const row = factPitRow(monzaDoc(), "Italian Grand Prix", numberMap(RESULTS), 13)!;
  assert.equal(row.value, "2.400");
  assert.equal(row.code, "HUL", "у награды DHL здесь была бы пустая строка");
  assert.equal(row.teamId, "audi");
  assert.equal(row.round, 13);
});

test("beasts: номер машины берётся из ПРОТОКОЛА РАУНДА — иначе стоп уедет чужой команде", () => {
  // Лоусон 2026: rb → red_bull. Карта по раунду 13 отдаёт red_bull.
  assert.equal(numberMap(RESULTS).get(30)!.teamId, "red_bull");
  const stale = numberMap([{ number: "30", Driver: { code: "LAW", familyName: "Lawson" },
    Constructor: { constructorId: "rb", name: "Racing Bulls" } }]);
  assert.equal(stale.get(30)!.teamId, "rb");
});

test("beasts: факта нет — строки нет, раунд уходит следующему источнику", () => {
  assert.equal(factPitRow(null, "Italian Grand Prix", numberMap(RESULTS), 13), null);
  const orphanOnly = buildEventPitstops({
    eventKey: "f1-2026-monza-1", eventId: "f1-2026-13", season: 2026, round: 13,
    sessions: [{ tag: "R", pss: null, pltc: MONZA_PLTC }],
  })!;
  assert.equal(factPitRow(orphanOnly, "Italian Grand Prix", numberMap(RESULTS), 13), null);
});

// ── 6. Цели и пропуск собранного (продьюсер) ────────────────────────────────

const RACE_DAY_2026_13 = Date.parse("2026-09-06T23:59:59Z");
const DAY = 24 * 3600 * 1000;

test("цели: только прошедшие ГОНКИ витрины с mk", () => {
  const events = [
    { id: "f1-2026-13", eventKey: "f1-2026-monza-1", round: 13, kind: "race", mk: 1293,
      dates: { race: "2026-09-06" } },
    { id: "f1-2026-14", eventKey: "f1-2026-14-1", round: 14, kind: "race", mk: 1294,
      dates: { race: "2026-09-20" } },                        // ещё не прошла
    { id: "f1-2026-bahrain-testing-1", eventKey: "f1-2026-bahrain-testing-1", round: 0,
      kind: "testing", mk: 1304, dates: { race: "2026-02-13" } },   // тест
    { id: "f1-2026-jeddah-1", eventKey: "f1-2026-jeddah-1", round: 0, kind: "cancelled",
      mk: 1306, dates: { race: "2026-04-12" } },                    // отмена
    { id: "f1-override-2026-05-01", eventKey: "f1-2026-x-1", round: 0, kind: "race",
      mk: null, dates: { race: "2026-05-01" } },                    // курируемый: mk нет
  ];
  const targets = pitstopTargets(events, RACE_DAY_2026_13 + DAY);
  assert.deepEqual(targets.map((t) => t.eventKey), ["f1-2026-monza-1"]);
  assert.equal(targets[0].mk, 1293);
  assert.equal(targets[0].id, "f1-2026-13", "внутрь файла едет id витрины, а не ключ");
});

test("пропуск собранного: только полный файл текущего парсера у ЗАМОРОЖЕННОГО раунда", () => {
  const prev = monzaDoc();
  const settled = RACE_DAY_2026_13 + 8 * DAY;
  const fresh = RACE_DAY_2026_13 + DAY;

  assert.equal(canSkip(prev, ["R"], "2026-09-06", settled), true);
  // Раунд ещё оседает — архив дописывается после финиша, и «сняли через час
  // после клетчатого» не должно застыть навсегда.
  assert.equal(canSkip(prev, ["R"], "2026-09-06", fresh), false);
  // Спринт снят не был — файл неполон, сколько бы ни прошло времени.
  assert.equal(canSkip(prev, ["SPR", "R"], "2026-09-06", settled), false);
  // Парсер бампнули — пересъём обязателен, иначе правка никогда не доедет.
  assert.equal(canSkip({ ...prev, parserVersion: PITSTOPS_PARSER_VERSION + 1 },
    ["R"], "2026-09-06", settled), false);
  assert.equal(canSkip(null, ["R"], "2026-09-06", settled), false);
});

// ── 7. Сторож содержимого боевого каталога ──────────────────────────────────

test("СТОРОЖ КАТАЛОГА: каждый снятый файл проходит сторожа формы", () => {
  // Тот же оракул, что у писателя, но пост-фактум и по всему каталогу: правка
  // руками, недокачанный файл и возврат сырья ловятся здесь, а не глазами.
  const dir = join(process.cwd(), "data", "f1", "pitstops");
  if (!existsSync(dir)) return;   // канал ещё не снимали — сторожить нечего
  const bad: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) { bad.push(`${name}: не .json`); continue; }
    const err = pitstopsFactError(readFileSync(join(dir, name), "utf8"));
    if (err) bad.push(`${name}: ${err}`);
  }
  assert.deepEqual(bad, []);
});

/// БЛОКЕР ревью: kept-previous обязан мерить ИЗМЕРЕНИЯ, а не строки.
/// Прогон, где PitStopSeries отдал 403, а PitLaneTimeCollection жив, даёт
/// ровно то же число строк со сплошным stationarySec:null — счёт строк такую
/// деградацию не видит и молча затирает измеренный факт (воспроизведено на
/// боевой Монце-2026).
test("kept-previous: деградация «те же строки, ноль измерений» не проходит", () => {
  const measured = buildEventPitstops({
    eventKey: "f1-2026-monza-1", eventId: "f1-2026-13", season: 2026, round: 13,
    sessions: [{ tag: "R", pss: MONZA_PSS, pltc: MONZA_PLTC }],
  })!;
  const degraded = buildEventPitstops({
    eventKey: "f1-2026-monza-1", eventId: "f1-2026-13", season: 2026, round: 13,
    sessions: [{ tag: "R", pss: null, pltc: MONZA_PLTC }],
  })!;
  const cov = (d: typeof measured) => stationaryCoverage(d);
  assert.equal(cov(degraded).total, cov(measured).total, "фикстура: строк столько же");
  assert.equal(cov(degraded).covered, 0, "фикстура: измерений не осталось");

  assert.match(poorerThan(degraded, measured) ?? "", /измерено/,
    "деградация измерений обязана удержать прежний файл");
  assert.equal(poorerThan(measured, measured), null, "тот же факт — не регрессия");
  assert.equal(poorerThan(measured, degraded), null, "обогащение — не регрессия");
  assert.equal(poorerThan(measured, null), null, "первого файла регрессия не касается");
});

test("СТОРОЖ ИМЁН: имя файла — ключ события, и он же лежит внутри", () => {
  const dir = join(process.cwd(), "data", "f1", "pitstops");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
    assert.equal(`${doc.eventKey}.json`, name,
      "файл под чужим ключом осиротеет при первом же прогоне потребителя");
  }
});
