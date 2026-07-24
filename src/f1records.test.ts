// Чистая сборка карточек: held (активный держатель) → «new record»,
// chase (погоня за зафиксированной цифрой) → «to beat», пока не достигнута.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildCards, type Subject } from "./f1records.js";

const info = (code: string, teamId: string, number = "1"): Subject => ({
  code, driver: `${code[0]}. ${code}`, number, teamId,
});

test("held → new record, chase → to beat (пока не догнал)", () => {
  const held = [{ stat: "wins", holderName: "Lewis Hamilton", value: 106, info: info("HAM", "ferrari") }];
  const chases = [{ stat: "poles", record: 68, holder: "Michael Schumacher", value: 64, info: info("VER", "red_bull") }];
  const cards = buildCards(held, chases);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].kind, "new record");
  assert.equal(cards[0].value, 106);
  assert.equal(cards[0].record, 106);
  assert.equal(cards[1].kind, "to beat");
  assert.equal(cards[1].value, 64);
  assert.equal(cards[1].record, 68);
  assert.equal(cards[1].holder, "Michael Schumacher");
  assert.ok(cards[1].progress > 0.9 && cards[1].progress < 1);
});

test("погоня уже достигнута/пройдена — карточки нет", () => {
  const chases = [{ stat: "poles", record: 68, holder: "Michael Schumacher", value: 68, info: info("VER", "red_bull") }];
  assert.equal(buildCards([], chases).length, 0);
});

test("субъект ушёл (info null) или нет данных (value null) — пропуск", () => {
  const held = [{ stat: "wins", holderName: "X", value: null, info: info("A", "t") }];
  const chases = [{ stat: "poles", record: 68, holder: "S", value: 40, info: null }];
  assert.equal(buildCards(held, chases).length, 0);
});
