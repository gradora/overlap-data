// Чистые функции юбилеев: что считается стартом, прогноз на раунд, кратность.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isStart, milestoneCount, startsAtRound } from "./f1milestones.js";

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
