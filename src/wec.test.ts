// WEC-зеркало: нормализация live-отсчёта и GC осиротевших race-файлов.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripCountdown, expectedRaceMirrors } from "./lib/fiawecsite.js";

test("stripCountdown: цифры отсчёта вырезаются, разметка и данные остаются", () => {
  const html = `
    <div class="fs-10 lh-1 fw-bold" data-countdown="hours">09</div>
    <div class="fs-10 lh-1 fw-bold" data-countdown="minutes">45</div>
    <script type="application/ld+json">{"@type":"SportsEvent","startDate":"2026-09-25"}</script>
    <table><tr><td>51</td></tr></table>
<!-- 2026-07-29 13:09:29 -->
</html>`;
  const out = stripCountdown(html);
  // Отсчёт пуст, но контейнеры на месте (вёрстка не ломается).
  assert.ok(out.includes('data-countdown="hours"></div>'));
  assert.ok(out.includes('data-countdown="minutes"></div>'));
  // Данные не тронуты.
  assert.ok(out.includes('"startDate":"2026-09-25"'));
  assert.ok(out.includes("<td>51</td>"));
  // Таймстамп рендера вырезан.
  assert.ok(!out.includes("2026-07-29 13:09:29"));
  assert.ok(out.includes("</html>"));
  // Идемпотентность: повторная нормализация ничего не меняет.
  assert.equal(stripCountdown(out), out);
});

test("expectedRaceMirrors: ключи совпадают со slug-конвенцией зеркала", () => {
  const set = expectedRaceMirrors(["lone-star-le-mans-2026", "6-hours-of-fuji-2026"]);
  assert.ok(set.has("en_race_lone_star_le_mans_2026"));
  assert.ok(set.has("en_race_6_hours_of_fuji_2026"));
  assert.equal(set.size, 2);
});
