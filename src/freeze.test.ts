// Freeze-окно оседания результатов (7д): границы решают, дёргаем ли источник.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isFrozen, FREEZE_AFTER_MS } from "./lib/freeze.js";

test("isFrozen: границы окна оседания", () => {
  const now = 1_800_000_000_000;
  // Финиш только что — не заморожен (штрафы/апелляции ещё меняют результат).
  assert.equal(isFrozen(now - 1000, now), false);
  // Ровно на границе окна — ещё не заморожен (строгое >).
  assert.equal(isFrozen(now - FREEZE_AFTER_MS, now), false);
  // За границей — заморожен.
  assert.equal(isFrozen(now - FREEZE_AFTER_MS - 1, now), true);
  // Будущий финиш и неизвестный (null) — не заморожены.
  assert.equal(isFrozen(now + 1000, now), false);
  assert.equal(isFrozen(null, now), false);
});
