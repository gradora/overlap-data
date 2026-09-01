// Классификатор рейс-контрола (lib/racecontrol.ts) и сборка файла.
// Вербатим FIA в витрину не попадает ПО ПОСТРОЕНИЮ — здесь это проверяется
// буквально: ни одно поле факта не является свободным текстом.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRaceControl } from "./lib/racecontrol.js";
import { buildRaceControlDoc } from "./lib/racecontrolbuild.js";
import { buildProtocolsBlock, compoundsByCar, orderResults } from "./lib/f1protocols.js";

test("классификация: таблица канонических сообщений", () => {
  const t = (row: object, want: object | null) =>
    assert.deepEqual(classifyRaceControl(row), want, JSON.stringify(row));

  t({ category: "Flag", flag: "YELLOW", scope: "Sector", sector: 7, lap_number: 12 },
    { kind: "flag", lap: 12, flag: "YELLOW", scope: "Sector", sector: 7 });
  t({ message: "CAR 4 (NOR) TIME 1:23.456 DELETED - TRACK LIMITS AT TURN 4 LAP 11", lap_number: 11 },
    { kind: "lap_deleted", lap: 11, car: 4, reason: "track_limits", time: "1:23.456" });
  t({ message: "FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 81 (PIA) - CAUSING A COLLISION" },
    { kind: "penalty", car: 81, reason: "causing_a_collision" });
  t({ message: "FIA STEWARDS: CAR 44 (HAM) NOTED - INCIDENT INVOLVING CARS 44 AND 1" },
    { kind: "investigation", car: 44 });
  // NO FURTHER раньше INVESTIGATION: текст содержит оба слова.
  t({ message: "FIA STEWARDS: NO FURTHER INVESTIGATION CAR 63 (RUS)" },
    { kind: "no_further_action", car: 63 });
  t({ category: "SafetyCar", message: "VIRTUAL SAFETY CAR DEPLOYED" },
    { kind: "safety_car", virtual: true, deployed: true });
  t({ category: "SafetyCar", message: "SAFETY CAR IN THIS LAP" },
    { kind: "safety_car", virtual: false, deployed: false });
  t({ message: "DRS ENABLED IN ZONE 2" }, { kind: "drs", enabled: true });
  t({ message: "FIRST CAR TO TAKE THE FLAG - CAR 14 (ALO)" }, { kind: "finish", car: 14 });
  t({ message: "MEDICAL CAR DEPLOYED" }, { kind: "medical_car" });
  t({ message: "LOW GRIP CONDITIONS" }, { kind: "track_condition" });
  t({ message: "PIT EXIT CLOSED" }, { kind: "pit_status" });
  // Объявление без структурной ценности в витрину не попадает.
  t({ message: "PINK HEAD PADDING MATERIAL MUST BE USED" }, null);
});

/// ГЛАВНЫЙ ИНВАРИАНТ ФАЙЛА: свободного текста в фактах нет. Классификатор
/// возвращает только enum-поля и числа; message не переносится никогда.
test("в фактах рейс-контрола нет свободного текста", () => {
  const evil = { message: "A".repeat(500) + " PENALTY FOR CAR 7 " + "B".repeat(500) };
  const fact = classifyRaceControl(evil)!;
  for (const v of Object.values(fact)) {
    assert.ok(typeof v !== "string" || v.length <= 25, `строка утекла: ${v}`);
  }
});

test("сборка: сессии без событий и события без сессий файла не дают", () => {
  const root = mkdtempSync(join(tmpdir(), "rc-"));
  const dir = join(root, "f1", "openf1");
  mkdirSync(dir, { recursive: true });
  assert.equal(buildRaceControlDoc(root, 2026, "x", 9), null, "нет листинга сессий");
  writeFileSync(join(dir, "sessions_meeting_key_9"),
    JSON.stringify([{ session_key: 70, session_name: "Race" }]));
  assert.equal(buildRaceControlDoc(root, 2026, "x", 9), null, "нет лент — нет файла");
  writeFileSync(join(dir, "race_control_session_key_70"),
    JSON.stringify([{ category: "Flag", flag: "GREEN", scope: "Track" },
                    { message: "PINK HEAD PADDING MATERIAL MUST BE USED" }]));
  const doc = buildRaceControlDoc(root, 2026, "f1-2026-1", 9)!;
  assert.equal(doc.sessions.length, 1);
  assert.equal(doc.sessions[0].events.length, 1, "объявление просочилось в витрину");
  rmSync(root, { recursive: true, force: true });
});

test("протоколы: порядок классифицированные→DNF→DNS, компаунды по стинтам", () => {
  const rows: any = [
    { driver_number: 1, position: null, dns: true },
    { driver_number: 2, position: 2 },
    { driver_number: 3, position: null, dnf: true },
    { driver_number: 4, position: 1 },
  ];
  assert.deepEqual(orderResults(rows).map((r: any) => r.driver_number), [4, 2, 3, 1]);
  const cc = compoundsByCar([
    { driver_number: 7, stint_number: 2, compound: "HARD" },
    { driver_number: 7, stint_number: 1, compound: "SOFT" },
    { driver_number: 7, stint_number: 3, compound: "SOFT" },
    { driver_number: 8, stint_number: 1, compound: null },
  ] as any);
  assert.deepEqual(cc.get(7), ["SOFT", "HARD"], "порядок стинтов, без дублей");
  assert.equal(cc.has(8), false);
});

test("протоколы: будущая сессия без результатов в блок не входит", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-"));
  const dir = join(root, "f1", "openf1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sessions_meeting_key_9"), JSON.stringify([
    { session_key: 70, session_name: "Practice 1", date_start: "2026-03-06T10:00:00+00:00" },
    { session_key: 71, session_name: "Race", date_start: null },
  ]));
  writeFileSync(join(dir, "session_result_session_key_70"), JSON.stringify([
    { driver_number: 5, position: 1, number_of_laps: 20, duration: 88.1, gap_to_leader: 0 },
  ]));
  const block = buildProtocolsBlock(root, 9)!;
  assert.deepEqual(block.sessions.map((s) => s.name), ["Practice 1"]);
  assert.deepEqual(block.sessions[0].results[0],
    { car: 5, position: 1, laps: 20, best: 88.1, gap: 0 });
  rmSync(root, { recursive: true, force: true });
});
