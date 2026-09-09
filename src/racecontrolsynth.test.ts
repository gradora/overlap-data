// Синтезатор message R1-строк race_control (lib/racecontrolsynth.ts, этап 3).
// Два инварианта: (1) каждый синтез матчится РОВНО ОДНИМ шаблоном замкнутого
// множества, а вербатим FIA — нулём; (2) круг «сырьё → R1-строка → факт
// витрины» возвращает ровно выход classifyRaceControl, включая ПОРЯДОК ключей
// (на нём стоит побайтовая неизменность data/f1/racecontrol после переезда
// сборки с классификации-на-чтении на чтение готовых фактов).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RACECONTROL_PARSER_VERSION, classifyRaceControl, type RaceControlFact,
} from "./lib/racecontrol.js";
import {
  R1_ALLOWED_KEYS, R1_EMPTY_KIND, R1_FACT_KEYS, R1_KINDS,
  RACECONTROL_MESSAGE_TEMPLATES, matchedTemplates, r1EmptyMarker, r1RowToFact,
  synthesizeRaceControlMessage, toR1Row,
} from "./lib/racecontrolsynth.js";
import { OPENF1_MAX_STRING } from "./lib/openf1facts.js";

/// Матрица фактов по всем kind — с необязательными полями и без: покрывает
/// каждую ветку синтезатора (полнота множества kind — компайл-таймом через
/// Record в R1_CATEGORY, здесь — поведение).
const FACTS: RaceControlFact[] = [
  { kind: "flag", flag: "YELLOW", scope: "Sector", sector: 7 },
  { kind: "flag", flag: "DOUBLE YELLOW", scope: "Sector", sector: 12 },
  { kind: "flag", flag: "RED", scope: "Track" },
  { kind: "flag", flag: "BLUE", scope: "Driver", car: 55, lap: 30 },
  { kind: "flag", flag: "BLACK AND WHITE", car: 4 },
  { kind: "flag", flag: "CHEQUERED" },
  { kind: "flag", flag: "CLEAR", scope: "Sector", sector: 3 },
  { kind: "flag", flag: "GREEN" },
  { kind: "safety_car", virtual: true, deployed: true },
  { kind: "safety_car", virtual: true, deployed: false },
  { kind: "safety_car", virtual: false, deployed: true },
  { kind: "safety_car", virtual: false, deployed: false },
  { kind: "medical_car" },
  { kind: "penalty", car: 81, reason: "causing_a_collision" },
  { kind: "penalty", car: 16 },
  { kind: "penalty" },
  { kind: "penalty_served", car: 10 },
  { kind: "investigation", car: 44, reason: "impeding" },
  { kind: "investigation" },
  { kind: "no_further_action", car: 63 },
  { kind: "no_further_action" },
  { kind: "lap_deleted", car: 4, time: "1:23.456", reason: "track_limits", lap: 11 },
  { kind: "lap_deleted" },
  { kind: "lap_reinstated", time: "1:19.021" },
  { kind: "lap_reinstated" },
  { kind: "finish", car: 14 },
  { kind: "drs", enabled: true },
  { kind: "drs", enabled: false },
  { kind: "session_status" },
  { kind: "pit_status" },
  { kind: "track_condition" },
  { kind: "car_event", car: 27 },
  { kind: "car_event" },
  { kind: "weighbridge", car: 31 },
  { kind: "weighbridge" },
];

test("синтез: каждый message матчится ровно одним шаблоном и влезает в потолок", () => {
  let synthesized = 0;
  for (const f of FACTS) {
    const msg = synthesizeRaceControlMessage(f);
    if (msg === null) continue;   // строка без синтеза легальна (finish без машины)
    synthesized++;
    assert.equal(matchedTemplates(msg), 1,
      `«${msg}» (${f.kind}) матчится ${matchedTemplates(msg)} шаблонами, не одним`);
    assert.ok(msg.length <= OPENF1_MAX_STRING,
      `«${msg}» длиннее потолка строки ${OPENF1_MAX_STRING}`);
  }
  assert.ok(synthesized >= 30, `матрица дала подозрительно мало синтезов: ${synthesized}`);
  // Худший случай длины — lap_deleted со временем, трёхзначной машиной и
  // самой длинной причиной: пин, чтобы правка шаблонов не разъехалась с
  // OPENF1_MAX_STRING молча.
  const worst = synthesizeRaceControlMessage(
    { kind: "lap_deleted", car: 999, time: "1:23.456", reason: "causing_a_collision" })!;
  assert.equal(worst, "Lap time 1:23.456 deleted — car 999 (causing a collision)");
  assert.ok(worst.length <= OPENF1_MAX_STRING);
});

test("синтез: вербатим FIA не матчится ни одним шаблоном", () => {
  const verbatims = [
    "CAR 4 (NOR) TIME 1:23.456 DELETED - TRACK LIMITS AT TURN 4 LAP 11",
    "FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 81 (PIA) - CAUSING A COLLISION",
    "VIRTUAL SAFETY CAR DEPLOYED",
    "PINK HEAD PADDING MATERIAL MUST BE USED",
    "RISK OF RAIN FOR F1 FIRST PRACTICE SESSION IS 10%",
    "GREEN LIGHT - PIT EXIT OPEN",
    "TURN 12 INCIDENT INVOLVING CARS 30 (LAW) AND 22 (BOR) NOTED - CAUSING A COLLISION",
  ];
  for (const v of verbatims) {
    assert.equal(matchedTemplates(v), 0, `вербатим прошёл шаблоны: «${v}»`);
  }
  // Шаблоны — якорёные регулярки: без ^…$ вербатим с нашей фразой внутри
  // пролез бы подстрокой.
  for (const re of RACECONTROL_MESSAGE_TEMPLATES) {
    assert.ok(re.source.startsWith("^") && re.source.endsWith("$"),
      `шаблон без якорей: ${re.source}`);
  }
});

test("toR1Row: parser + факт-ключи порядком классификатора + legacy + синтез", () => {
  // Жёлтый секторный флаг: порядок ключей несущий (см. r1RowToFact ниже).
  const row = toR1Row({ category: "Flag", flag: "YELLOW", scope: "Sector",
    sector: 7, lap_number: 12, message: "YELLOW IN TRACK SECTOR 7" })!;
  assert.equal(JSON.stringify(row),
    `{"parser":${RACECONTROL_PARSER_VERSION},"kind":"flag","lap":12,` +
    `"flag":"YELLOW","scope":"Sector","sector":7,"category":"Flag",` +
    `"lap_number":12,"message":"Yellow flag in sector 7"}`);

  // SC: category SafetyCar + слова VIRTUAL/DEPLOYED — на них живёт иконка
  // старых сборок (RaceControl.swift: icon читает category и message).
  const sc = toR1Row({ category: "SafetyCar", message: "VIRTUAL SAFETY CAR DEPLOYED" })!;
  assert.equal(sc.category, "SafetyCar");
  assert.equal(sc.message, "Virtual safety car deployed");

  // Машина из ТЕКСТА (driver_number источника null) доезжает и до факта, и
  // до legacy-ключа driver_number — старые сборки берут номер из него.
  const pen = toR1Row({ message: "FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 81 (PIA) - CAUSING A COLLISION" })!;
  assert.equal(pen.car, 81);
  assert.equal(pen.driver_number, 81);
  assert.equal(pen.message, "Penalty — car 81 (causing a collision)");

  // Шум классификатора → null: строка в заготовку не пишется.
  assert.equal(toR1Row({ message: "PINK HEAD PADDING MATERIAL MUST BE USED" }), null);

  // Ключи любой R1-строки — из белого списка оракула; сырьевые
  // date/session_key/meeting_key не появляются по построению.
  for (const k of Object.keys(row)) assert.ok(R1_ALLOWED_KEYS.has(k), k);
});

test("r1RowToFact: круг запись→чтение возвращает выход классификатора побайтово", () => {
  const raws = [
    { category: "Flag", flag: "YELLOW", scope: "Sector", sector: 7, lap_number: 12 },
    { category: "SafetyCar", message: "SAFETY CAR IN THIS LAP" },
    { message: "CAR 4 (NOR) TIME 1:23.456 DELETED - TRACK LIMITS AT TURN 4 LAP 11", lap_number: 11 },
    { message: "FIRST CAR TO TAKE THE FLAG - CAR 14 (ALO)" },
    { message: "DRS ENABLED IN ZONE 2" },
    { driver_number: 44, message: "FIA STEWARDS: CAR 44 (HAM) NOTED" },
  ];
  for (const raw of raws) {
    const expected = classifyRaceControl(raw)!;
    const fact = r1RowToFact(toR1Row(raw)!);
    assert.deepEqual(fact, expected);
    // deepEqual не видит порядок ключей — а на нём стоит побайтовая
    // неизменность витрины racecontrol: сверяем сериализацию.
    assert.equal(JSON.stringify(fact), JSON.stringify(expected), JSON.stringify(raw));
  }
  // Маркер пустой сессии, устаревшая строка и мусор — не факты витрины.
  assert.equal(r1RowToFact(r1EmptyMarker()), null);
  assert.equal(r1RowToFact({ parser: RACECONTROL_PARSER_VERSION - 1, kind: "flag" }), null,
    "строку устаревшего парсера обязан перечитать добор, а не витрина");
  assert.equal(r1RowToFact("строка"), null);
  assert.equal(r1RowToFact(null), null);
  // Маркер известен закрытому множеству kind и сам является валидной строкой.
  assert.ok(R1_KINDS.has(R1_EMPTY_KIND));
  assert.ok(!R1_FACT_KEYS.has("parser") && !R1_FACT_KEYS.has("message"));
});
