// Чистые функции юбилеев: что считается стартом, прогноз на раунд, кратность,
// упаковка/распаковка кэша хронологий.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isStart, milestoneCount, packLog, seasonMilestones, startsAtRound,
  unpackLog, unpackState,
} from "./producers/f1milestones.js";

test("isStart: DNS/DNQ/Withdrew/Excluded — не старты, всё остальное — старты", () => {
  assert.equal(isStart("Finished", "10"), true);
  assert.equal(isStart("Accident", "R"), true);       // сход = старт
  assert.equal(isStart("Engine", "R"), true);
  assert.equal(isStart("Did not start", "W"), false); // Албон Сан-Паулу-24
  assert.equal(isStart("Withdrew", "W"), false);
  assert.equal(isStart("Did not qualify", "F"), false);
  assert.equal(isStart("Excluded", "E"), false);
});

test("startsAtRound не ломается пропусками пилота в прошедших раундах", () => {
  // Албон: 99 стартов за Williams к 10 прошедшим раундам (1 DNS в сезоне),
  // Венгрия R11 → ровно 100-й старт.
  assert.equal(startsAtRound(99, 10, 11), 100);
});

test("milestoneCount — только кратные 50", () => {
  assert.equal(milestoneCount(100), 100);
  assert.equal(milestoneCount(99), null);
  assert.equal(milestoneCount(0), null);
});

test("packLog/unpackLog: пары переживают роундтрип, мусор — null (кэша нет)", () => {
  const log = [{ season: 2005, round: 3 }, { season: 2026, round: 12 }];
  assert.deepEqual(unpackLog(packLog(log)), log);
  assert.deepEqual(unpackLog([]), []);
  // Битый кэш обязан читаться как «кэша нет», а не как пустая хронология:
  // пустая хронология — это ноль стартов, то есть ложный факт.
  assert.equal(unpackLog(undefined), null);
  assert.equal(unpackLog({ season: 2005 }), null);
  assert.equal(unpackLog([[2005, "x"]]), null);
  assert.equal(unpackLog([{ season: 2005, round: 3 }]), null);
});

test("unpackState: кэш обязан крыть всех пилотов, иначе им нельзя пользоваться", () => {
  const drivers = [
    { driverId: "alonso", givenName: "Fernando", familyName: "Alonso" },
    { driverId: "albon", givenName: "Alexander", familyName: "Albon" },
  ];
  const full = {
    drivers,
    careerLogs: { alonso: [[2005, 3]], albon: [[2026, 1]] } as Record<string, [number, number][]>,
    teamLogs: { albon: { team: "Williams", log: [[2026, 1]] as [number, number][] } },
  };
  const cache = unpackState(full);
  assert.ok(cache);
  assert.deepEqual(cache!.careerLogs.get("alonso"), [{ season: 2005, round: 3 }]);
  assert.deepEqual(cache!.teamLogs.get("albon"), { team: "Williams", log: [{ season: 2026, round: 1 }] });
  // Командная хронология не у всех — это норма (нет зеркала зачёта на момент
  // сбора), кэш валиден.
  assert.ok(unpackState({ ...full, teamLogs: {} }));

  // Нет карьерной хронологии одного пилота — весь кэш непригоден: неполный
  // набор стирал бы юбилеи пропавшего из файлов раундов.
  assert.equal(unpackState({ ...full, careerLogs: { alonso: [[2005, 3]] } }), null);
  // Битая командная хронология — тоже.
  assert.equal(
    unpackState({ ...full, teamLogs: { albon: { team: "Williams", log: [["x", 1]] as any } } }),
    null,
  );
  // Пустой список пилотов кэшем не считается.
  assert.equal(unpackState({ drivers: [], careerLogs: {}, teamLogs: {} }), null);
});

test("seasonMilestones: фактические юбилеи из хронологии, только свой сезон", () => {
  // 199 стартов до сезона + гонки сезона 2026: R1, R2, (R3 пропуск — DNS),
  // R4 — 200-й старт фактически случился на R2.
  const before = Array.from({ length: 198 }, (_, i) => ({ season: 2000 + (i % 20), round: 1 + (i % 20) }));
  const log = [...before, { season: 2026, round: 1 }, { season: 2026, round: 2 }, { season: 2026, round: 4 }];
  const map = seasonMilestones(log, 2026);
  assert.deepEqual([...map.entries()], [[2, 200]]);
  // Юбилей чужого сезона (150-й старт где-то в прошлом) в карту не попадает.
  assert.equal(seasonMilestones(log, 2027).size, 0);
});
