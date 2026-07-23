// Чистые функции beasts: строка камбэка (grid→финиш), код пилота, карта
// фамилий, ключ для матчинга пита.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { comebackRow, driverCode, driverMap, familyKey } from "./beasts.js";

const result = (grid: string, position: string, code: string, family: string, team = "Red Bull", teamId = "red_bull") => ({
  grid,
  position,
  Driver: { code, familyName: family },
  Constructor: { name: team, constructorId: teamId },
});

test("comebackRow: прирост позиций grid→финиш, назад/на месте — null", () => {
  const row = comebackRow(result("21", "6", "HAD", "Hadjar"), "Belgian Grand Prix");
  assert.deepEqual(row, {
    value: "P21 → P6", detail: "15", event: "Belgian Grand Prix",
    code: "HAD", team: "Red Bull", teamId: "red_bull", gain: 15,
  });
  // Потерял позиции — не камбэк.
  assert.equal(comebackRow(result("2", "8", "VER", "Verstappen"), "GP"), null);
  // На месте — не камбэк.
  assert.equal(comebackRow(result("5", "5", "NOR", "Norris"), "GP"), null);
  // DNF (position «R» / нечисловой) — не камбэк.
  assert.equal(comebackRow(result("20", "R", "OCO", "Ocon"), "GP"), null);
  // С пит-лейн (grid 0) — стартовой позиции нет, пропускаем.
  assert.equal(comebackRow(result("0", "10", "STR", "Stroll"), "GP"), null);
});

test("driverCode: code приоритетно, фолбэк — 3 буквы фамилии", () => {
  assert.equal(driverCode({ code: "VER", familyName: "Verstappen" }), "VER");
  assert.equal(driverCode({ familyName: "Verstappen" }), "VER");
  assert.equal(driverCode({ familyName: "Hülkenberg" }), "HÜL");
});

test("driverMap строит карту фамилия→команда, первое вхождение", () => {
  const map = driverMap([
    result("1", "1", "ANT", "Antonelli", "Mercedes", "mercedes"),
    result("4", "2", "LEC", "Leclerc", "Ferrari", "ferrari"),
  ]);
  assert.deepEqual(map.get("leclerc"), { code: "LEC", team: "Ferrari", teamId: "ferrari" });
  assert.equal(map.size, 2);
});

test("familyKey: фамилия последним словом из короткого имени", () => {
  assert.equal(familyKey("C. Leclerc"), "leclerc");
  assert.equal(familyKey("K. Antonelli"), "antonelli");
  assert.equal(familyKey("Max Verstappen"), "verstappen");
});
