// Тесты продьюсера «победители прошлых лет».
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWinners } from "./f1winners.js";

test("buildWinners: последние 5 до сезона, кумулятивные победы, свежие первыми", () => {
  const rows = [
    { season: 2020, driverId: "hamilton", code: "HAM", name: "Lewis Hamilton", constructor: "Mercedes" },
    { season: 2021, driverId: "verstappen", code: "VER", name: "Max Verstappen", constructor: "Red Bull" },
    { season: 2022, driverId: "verstappen", code: "VER", name: "Max Verstappen", constructor: "Red Bull" },
    { season: 2023, driverId: "verstappen", code: "VER", name: "Max Verstappen", constructor: "Red Bull" },
    { season: 2024, driverId: "hamilton", code: "HAM", name: "Lewis Hamilton", constructor: "Mercedes" },
    { season: 2025, driverId: "piastri", code: "PIA", name: "Oscar Piastri", constructor: "McLaren" },
    { season: 2026, driverId: "norris", code: "NOR", name: "Lando Norris", constructor: "McLaren" }, // текущий — не входит
  ];
  const w = buildWinners(rows, 2026);
  assert.equal(w.length, 5);
  assert.deepEqual(w.map((x) => x.year), [2025, 2024, 2023, 2022, 2021]);   // свежие первыми
  assert.equal(w[0].name, "Oscar Piastri");
  assert.equal(w[0].winsHere, 1);
  assert.equal(w[1].winsHere, 2);   // Хэмилтон '24 — вторая победа здесь ('20 + '24)
  assert.equal(w[2].winsHere, 3);   // Ферстаппен '23 — третья ('21..'23)
  assert.equal(w[4].winsHere, 1);   // Ферстаппен '21 — первая
});

test("buildWinners: меньше 5 лет истории и пустая история", () => {
  const rows = [
    { season: 2024, driverId: "a", name: "A B", constructor: "T" },
    { season: 2025, driverId: "a", name: "A B", constructor: "T" },
  ];
  const w = buildWinners(rows, 2026);
  assert.equal(w.length, 2);
  assert.equal(w[0].winsHere, 2);
  assert.deepEqual(buildWinners([], 2026), []);
});
