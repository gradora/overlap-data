// Чистая сборка карточек рекордов: держатель → «new record», ближайший
// активный преследователь → «to beat» при прогрессе ≥ порога.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildCards, type DriverTotals } from "./f1records.js";

const t = (
  driverId: string, code: string, teamId: string,
  gp: number, wins: number, podiums: number, poles: number,
): DriverTotals => ({
  driverId, code, driver: `${code[0]}. ${code}`, number: "1", teamId,
  "Grands Prix": gp, wins, podiums, poles,
});

const tracked = [
  { stat: "wins", holder: "hamilton", holderName: "Lewis Hamilton" },
];

test("buildCards: держатель — new record, преследователь ≥ порога — to beat", () => {
  const totals = [
    t("hamilton", "HAM", "mercedes", 390, 106, 207, 118),
    t("max_verstappen", "VER", "red_bull", 220, 71, 120, 45), // 71/106 = 0.67 ≥ 0.5
    t("norris", "NOR", "mclaren", 150, 11, 40, 10),           // ниже — не преследователь
  ];
  const cards = buildCards(totals, tracked, 0.5);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].kind, "new record");
  assert.equal(cards[0].code, "HAM");
  assert.equal(cards[0].value, 106);
  assert.equal(cards[0].progress, 1);
  assert.equal(cards[1].kind, "to beat");
  assert.equal(cards[1].code, "VER");        // максимум среди не-держателей
  assert.equal(cards[1].value, 71);
  assert.equal(cards[1].record, 106);
});

test("buildCards: преследователь ниже порога — только new record", () => {
  const totals = [
    t("hamilton", "HAM", "mercedes", 390, 106, 207, 118),
    t("norris", "NOR", "mclaren", 150, 40, 90, 10),          // 40/106 = 0.38 < 0.5
  ];
  const cards = buildCards(totals, tracked, 0.5);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "new record");
});

test("buildCards: держатель не активен — рекорд пропущен", () => {
  const cards = buildCards([t("norris", "NOR", "mclaren", 150, 40, 90, 10)], tracked, 0.5);
  assert.equal(cards.length, 0);
});
