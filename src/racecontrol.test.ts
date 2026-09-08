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
import { buildProtocolsBlock, buildScheduleBlock, compoundsByCar, orderResults }
  from "./lib/f1protocols.js";

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

// MARK: - Блок расписания (Б1: Day 1/2/3 тестов и структура оверлей-этапа)

/// Фикстура — реальный листинг Бахрейн-теста 1305: ключи НЕ монотонны
/// (Day 1/2/3 = 11470/11469/11468), порядок листинга — не порядок дней.
const day = (key: number, n: number, extra: object = {}) => ({
  session_key: key, session_type: "Practice", session_name: `Day ${n}`,
  date_start: `2026-02-${17 + n}T07:00:00+00:00`,
  date_end: `2026-02-${17 + n}T16:00:00+00:00`, is_cancelled: false, ...extra,
});

test("расписание: ВСЕ сессии листинга, порядок — по началу, не по ключам", () => {
  const root = mkdtempSync(join(tmpdir(), "sched-"));
  const dir = join(root, "f1", "openf1");
  mkdirSync(dir, { recursive: true });
  // Перемешанный листинг: Day 2 первым — сортировка обязана собрать дни.
  writeFileSync(join(dir, "sessions_meeting_key_1305"),
    JSON.stringify([day(11469, 2), day(11470, 1), day(11468, 3)]));

  const block = buildScheduleBlock(root, 1305)!;
  assert.deepEqual(block.sessions.map((s) => s.name), ["Day 1", "Day 2", "Day 3"],
    "порядок дней обязан идти по start: ключи OpenF1 не монотонны");
  // Будущий тест: результатов нет ни у одной сессии, но расписание полное —
  // ради этого блок и существует (протоколы такой листинг не отдали бы вовсе).
  assert.equal(buildProtocolsBlock(root, 1305), null);
  assert.deepEqual(block.sessions[0], {
    key: 11470, name: "Day 1", type: "Practice",
    start: "2026-02-18T07:00:00+00:00", end: "2026-02-18T16:00:00+00:00",
  }, "key/name/type/start/end — и БЕЗ cancelled у обычной сессии");
  rmSync(root, { recursive: true, force: true });
});

test("расписание: нет листинга — нет блока; поля источника не выдумываются", () => {
  const root = mkdtempSync(join(tmpdir(), "sched-"));
  const dir = join(root, "f1", "openf1");
  mkdirSync(dir, { recursive: true });
  assert.equal(buildScheduleBlock(root, 7), null, "листинга нет");
  writeFileSync(join(dir, "sessions_meeting_key_7"), "[]");
  assert.equal(buildScheduleBlock(root, 7), null, "пустой листинг — не блок");

  // Сессия без дат и типа (так выглядит свежий митинг) — в конец, поля
  // отсутствуют, а не null/пустые; отменённая несёт флаг.
  writeFileSync(join(dir, "sessions_meeting_key_7"), JSON.stringify([
    { session_key: 71, session_name: "Race", date_start: null },
    day(70, 1, { is_cancelled: true }),
  ]));
  const block = buildScheduleBlock(root, 7)!;
  assert.deepEqual(block.sessions.map((s) => s.name), ["Day 1", "Race"]);
  assert.deepEqual(block.sessions[1], { key: 71, name: "Race", start: null });
  assert.equal(block.sessions[0].cancelled, true);
  rmSync(root, { recursive: true, force: true });
});

/// ИНВАРИАНТ ДЖОЙНА: клиент сшивает протоколы с расписанием по имени сессии,
/// поэтому имена обоих блоков обязаны совпадать вербатим — они из одного
/// листинга по построению, и тест не даст этому построению разъехаться.
test("расписание и протоколы отдают одинаковые имена сессий", () => {
  const root = mkdtempSync(join(tmpdir(), "sched-"));
  const dir = join(root, "f1", "openf1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sessions_meeting_key_9"),
    JSON.stringify([day(70, 1), day(71, 2)]));
  writeFileSync(join(dir, "session_result_session_key_70"),
    JSON.stringify([{ driver_number: 5, position: 1 }]));

  const schedule = buildScheduleBlock(root, 9)!;
  const protocols = buildProtocolsBlock(root, 9)!;
  const names = new Set(schedule.sessions.map((s) => s.name));
  for (const s of protocols.sessions) {
    assert.ok(names.has(s.name), `протокол «${s.name}» не сшивается с расписанием`);
  }
  rmSync(root, { recursive: true, force: true });
});
