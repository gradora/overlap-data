// Лестница круглых цифр: next/prev должны быть согласованы (между соседними
// ступенями нет дыр и нет перекрытий), иначе карточка «вот-вот возьмёт» будет
// звать к цифре, которую субъект уже прошёл.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { nextLandmark, ordinal, possessive, prevLandmark, singular } from "./lib/landmarks.js";

test("лестница побед: десятка, потом четверти, потом полусотни", () => {
  assert.equal(nextLandmark("wins", 0), 10);
  assert.equal(nextLandmark("wins", 9), 10);   // Леклер — одна победа до двузначных
  assert.equal(nextLandmark("wins", 10), 25);  // взял десятку — цель уехала сама
  assert.equal(nextLandmark("wins", 12), 25);
  assert.equal(nextLandmark("wins", 48), 50);  // поулы Ферстаппена
  assert.equal(nextLandmark("wins", 100), 150);
  assert.equal(nextLandmark("wins", 251), 300); // победы Феррари
});

test("лестница стартов — шаг 50, как у юбилеев", () => {
  assert.equal(nextLandmark("starts", 391), 400);
  assert.equal(nextLandmark("starts", 400), 450);
  assert.equal(nextLandmark("starts", 439), 450);
});

test("prev — последняя ВЗЯТАЯ ступень, next от неё уходит вперёд", () => {
  assert.equal(prevLandmark("wins", 9), 0);
  assert.equal(prevLandmark("wins", 24), 10);
  assert.equal(prevLandmark("wins", 26), 25);
  assert.equal(prevLandmark("wins", 200), 200);  // ровно на рубеже
  assert.equal(prevLandmark("starts", 401), 400);

  for (const metric of ["wins", "podiums", "poles", "starts"] as const) {
    for (let v = 1; v <= 500; v++) {
      const prev = prevLandmark(metric, v);
      const next = nextLandmark(metric, v);
      assert.ok(prev <= v, `${metric} ${v}: prev ${prev} выше значения`);
      assert.ok(next > v, `${metric} ${v}: next ${next} не впереди`);
      // Между взятой ступенью и следующей нет третьей: next от prev — это
      // ровно та цель, к которой карточка и должна звать.
      if (prev > 0) assert.equal(nextLandmark(metric, prev), next, `${metric} ${v}: дыра в лестнице`);
    }
  }
});

test("порядковые и единственное число", () => {
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(2), "2nd");
  assert.equal(ordinal(3), "3rd");
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(12), "12th");
  assert.equal(ordinal(13), "13th");
  assert.equal(ordinal(200), "200th");
  assert.equal(ordinal(251), "251st");
  assert.equal(ordinal(450), "450th");

  assert.equal(singular("wins"), "win");
  assert.equal(singular("podiums"), "podium");
  assert.equal(singular("poles"), "pole");
  assert.equal(singular("Grands Prix"), "Grand Prix");
  assert.equal(possessive("McLaren"), "McLaren’s");
});
