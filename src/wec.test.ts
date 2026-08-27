// WEC-зеркало: нормализация live-отсчёта и GC осиротевших race-файлов.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripCountdown, expectedRaceMirrors, raceSlugs, raceIdOf, isRaceMirrorOfSeason, testSlugs,
} from "./lib/fiawecsite.js";

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

// ПАРНЫЙ тест с приложением: OverlapTests/WECParsersTests.swift,
// WECSeasonParserTests — та же фикстура, тот же ожидаемый список. Менять только
// вместе: продюсер зеркалит ровно те страницы, которые назовёт этот фильтр,
// а приложение по ним же строит календарь и нумерует раунды.
// Раньше это была ПАРНАЯ фикстура: те же входы и тот же ожидаемый список
// стояли в приложении (WECSeasonParserTests). С шага 3c клиентского парсера
// нет — сторона осталась одна, и правило про числовой хвост / прологи / чужие
// годы держится только здесь.
test("raceSlugs: числовой хвост, прологи, чужие годы", () => {
  const html = `
    <a href="/en/race/official-prologue-imola-2026">Prologue</a>
    <a href="/en/race/6-hours-of-imola-2026">Imola</a>
    <a href="/en/race/24-hours-of-le-mans-2026-1">Le Mans (numbered tail)</a>
    <a href="/en/race/6-hours-of-imola-2026">Imola dup</a>
    <a href="/en/race/6-hours-of-fuji-2027">Next season</a>
    <a href="/en/race/6-hours-of-imola-2026-2027">Double year</a>
    <a href="/en/race/official-prologue-imola-2026-1">Prologue with tail</a>`;
  assert.deepEqual(raceSlugs(html, 2026), ["6-hours-of-imola-2026", "24-hours-of-le-mans-2026-1"]);
  // Ле-Ман-2025 виден только своему сезону.
  assert.deepEqual(raceSlugs('<a href="/en/race/24-hours-of-le-mans-2025-1">LM</a>', 2025),
    ["24-hours-of-le-mans-2025-1"]);
  assert.deepEqual(raceSlugs('<a href="/en/race/24-hours-of-le-mans-2025-1">LM</a>', 2026), []);
});

// ПАРНЫЙ тест с приложением: OverlapTests/WECParsersTests.swift,
// WECRacePageRaceIdTests — те же входные строки. raceId берётся со страницы
// события, потому что индекс /en/page/resultats-1 всегда отдаёт текущий сезон.
test("raceIdOf: id гонки со страницы события", () => {
  assert.equal(raceIdOf('<div data-live-props-value="{&quot;raceId&quot;:4933,&quot;x&quot;:1}"></div>'), 4933);
  assert.equal(raceIdOf('<div data-live-props-value="{&quot;raceIds&quot;:[4936]}"></div>'), 4936);
  assert.equal(raceIdOf("<html><body>no live props</body></html>"), null);
});

// GC удаляет файлы, поэтому предикат сезона у зеркала обязан совпадать с
// предикатом слага: иначе файл Ле-Мана либо не чистится никогда, либо сносится
// при живом этапе.
test("isRaceMirrorOfSeason: числовой хвост принадлежит своему сезону", () => {
  assert.equal(isRaceMirrorOfSeason("en_race_24_hours_of_le_mans_2025_1", 2025), true);
  assert.equal(isRaceMirrorOfSeason("en_race_24_hours_of_le_mans_2025_1", 2026), false);
  assert.equal(isRaceMirrorOfSeason("en_race_6_hours_of_fuji_2025", 2025), true);
  assert.equal(isRaceMirrorOfSeason("en_season_2025", 2025), false, "не race-файл");
  assert.equal(isRaceMirrorOfSeason("en_race_6_hours_of_imola_2025_2026", 2025), false);
});

// ПАРНЫЙ тест с приложением (WECSeasonParser.testSlugs). Пролог обязан жить в
// СВОЁМ списке: raceSlugs задаёт нумерацию раундов и имена derived-файлов.
test("testSlugs: прологи отдельно от зачётных этапов", () => {
  const html = `
    <a href="/en/race/official-prologue-imola-2026">Prologue</a>
    <a href="/en/race/6-hours-of-imola-2026">Imola</a>
    <a href="/en/race/official-prologue-qatar-2025">Prologue 2025</a>`;
  assert.deepEqual(raceSlugs(html, 2026), ["6-hours-of-imola-2026"]);
  assert.deepEqual(testSlugs(html, 2026), ["official-prologue-imola-2026"]);
  assert.deepEqual(testSlugs(html, 2025), ["official-prologue-qatar-2025"]);
});
