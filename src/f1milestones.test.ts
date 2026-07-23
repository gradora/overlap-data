// Чистые функции юбилеев: что считается стартом, прогноз на раунд, кратность.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isStart, milestoneCount, seasonMilestones, startsAtRound } from "./f1milestones.js";

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
