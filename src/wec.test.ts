// WEC-зеркало: нормализация live-отсчёта и GC осиротевших race-файлов.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripCountdown, expectedRaceMirrors, raceSlugs, raceIdOf, isRaceMirrorOfSeason, testSlugs,
  ldJsonBlocks, eventInfo, sessionOptions, raceOptions,
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

// MARK: - Парсеры, которые становятся несущими В МОМЕНТ ЗАПИСИ
//
// До перехода на слой фактов их промах был обратим: HTML лежал в репозитории,
// чинишь функцию — и архив перечитывается на следующем прогоне бесплатно.
// После перехода промах отравляет сохранённые факты, а лечение — только
// перекачка с чужого сервера. Поэтому сначала тесты, потом переход.

test("ldJsonBlocks: все блоки в порядке документа, без обёртки script", () => {
  const html = `<head>
    <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
    <script src="x.js"></script>
    <script type='application/ld+json'>{"@type":"SportsEvent","startDate":"2026-04-17"}</script>
  </head>`;
  const blocks = ldJsonBlocks(html);
  assert.equal(blocks.length, 2, "второй блок объявлен одинарными кавычками — тоже наш");
  assert.match(blocks[0], /BreadcrumbList/);
  assert.match(blocks[1], /SportsEvent/);
  for (const b of blocks) assert.doesNotMatch(b, /<\/?script/i);
  assert.deepEqual(ldJsonBlocks("<html>без блоков</html>"), []);
});

/// eventInfo принимает решение О ЗАМОРОЗКЕ события. Промах здесь означает не
/// кривую дату на экране, а этап, который перестанут перекачивать.
test("eventInfo: даты и страна из первого РАЗБИРАЕМОГО SportsEvent-блока", () => {
  const page = (body: string) => `<script type="application/ld+json">${body}</script>`;
  const ok = page(JSON.stringify({
    "@type": "SportsEvent", startDate: "2026-04-17T10:00:00+02:00",
    endDate: "2026-04-19T16:00:00+02:00", location: { address: "Imola, ITA" },
  }));
  const info = eventInfo(ok);
  assert.equal(info.startMs, Date.parse("2026-04-17T10:00:00+02:00"));
  assert.equal(info.endMs, Date.parse("2026-04-19T16:00:00+02:00"));
  assert.equal(info.iso2, "it");

  // Блок без SportsEvent пропускается, а битый JSON НЕ роняет разбор: страница
  // fiawec несёт несколько блоков, и первый регулярно оказывается чужим.
  const mixed = page('{"@type":"BreadcrumbList"}') + page("{сломанный") + ok;
  assert.deepEqual(eventInfo(mixed), info, "перебор блоков остановился раньше времени");

  // Ни одного пригодного блока — тройка null, а не исключение и не нули:
  // нулевая дата означала бы «1970», и заморозка сработала бы навсегда.
  assert.deepEqual(eventInfo("<html>пусто</html>"),
                   { startMs: null, endMs: null, iso2: null });
  // Даты нет, а блок есть — тоже null, а не NaN.
  assert.deepEqual(eventInfo(page('{"@type":"SportsEvent"}')),
                   { startMs: null, endMs: null, iso2: null });
  // Страна не по ISO-3 — null, а не мусорный код.
  assert.equal(eventInfo(page(JSON.stringify({
    "@type": "SportsEvent", location: { address: "Imola, Italy" },
  }))).iso2, null);
});

/// Дропдаун сессий — вход для протоколов. Пустой список тихо обнуляет
/// sourceIds.fiawec.sessions у этапа, и витрина теряет уик-энд целиком.
test("sessionOptions/raceOptions: сессии отделены от годов, классов и этапов", () => {
  const opt = (id: number, label: string) => `<option value="${id}">${label}</option>`;
  const html = [
    opt(1, "2026"), opt(2, "HYPERCAR"), opt(3, "LMGT3"),
    opt(4, "Free Practice 1"), opt(5, "Qualifying - LMGT3"), opt(6, "HYPERPOLE 1"),
    opt(7, "Warm Up"), opt(8, "RACE"), opt(9, "6 Hours of Imola"),
    "<option>без value</option>", '<option value="10"></option>',
  ].join("");

  assert.deepEqual(sessionOptions(html).map((o) => o.id), [4, 5, 6, 7, 8],
    "в сессии затесались год, класс или этап — протоколы поедут не по тем id");
  assert.deepEqual(raceOptions(html).map((o) => o.label), ["6 Hours of Imola"]);
  // Опция без value или без подписи — не опция: id обязателен для URL сессии.
  assert.equal(sessionOptions(html).concat(raceOptions(html)).length, 6);
  // Сущности в подписи разворачиваются: иначе метка не совпадёт с витриной.
  assert.equal(sessionOptions(opt(11, "Qualifying &amp; Hyperpole"))[0].label,
               "Qualifying & Hyperpole");
});
