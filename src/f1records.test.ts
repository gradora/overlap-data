// Чистая сборка карточек: держатели по «вау-углам» (milestone / firstPast /
// rate) + погони за зафиксированной цифрой легенды (chase).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildCards, type Subject } from "./f1records.js";

const sub = (code: string, teamId: string, number = "1"): Subject => ({
  code, driver: `${code[0]}. ${code}`, number, teamId,
});

test("вау-углы держателей + погони", () => {
  const S: Record<string, Subject | null> = {
    alonso: sub("ALO", "aston_martin", "14"),
    hamilton: sub("HAM", "ferrari", "44"),
    max_verstappen: sub("VER", "red_bull", "3"),
  };
  const V: Record<string, number | null> = {
    "alonso:entries": 438,
    "hamilton:wins": 106,
    "hamilton:podiums": 207,
    "hamilton:entries": 390,
    "max_verstappen:wins": 71,
    "max_verstappen:podiums": 130,
  };
  const cards = buildCards(V, S);
  const by = (id: string) => cards.find((c) => c.id === id)!;

  // milestone — к красивой круглой цифре (438 → 450, 12 к цели).
  const gp = by("held-Grands Prix");
  assert.equal(gp.header, "MILESTONE");
  assert.equal(gp.title, "438 GRANDS PRIX");
  assert.match(gp.note, /12 more for a landmark 450/);
  assert.equal(gp.barRight, "438/450");

  // firstPast — единственный за порогом.
  const wins = by("held-wins");
  assert.equal(wins.header, "RECORD");
  assert.match(wins.note, /only driver.*pass 100 wins/i);

  // rate — доля подиумных гонок > половины.
  const pod = by("held-podiums");
  assert.match(pod.note, /more than half/i);
  assert.equal(pod.barRight, "207/390");
  assert.ok(pod.progress > 0.5 && pod.progress < 0.6);

  // chase — погоня за зафиксированной цифрой (71 → 91, 20 не хватает).
  const chase = by("chase-wins");
  assert.equal(chase.header, "CHASING");
  assert.match(chase.note, /20 wins from passing Michael Schumacher’s 91/);
  assert.equal(chase.barRight, "71/91");
});

test("погоня достигнута/пройдена — карточки нет", () => {
  const S = { max_verstappen: { code: "VER", driver: "M. Verstappen", number: "3", teamId: "red_bull" } };
  const V = { "max_verstappen:wins": 91, "max_verstappen:podiums": 200 };
  const cards = buildCards(V, S).filter((c) => c.id.startsWith("chase"));
  assert.equal(cards.length, 0);
});
