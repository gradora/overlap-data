// Витрина WEC (фаза 3a): узлы порта — нумерация раундов по дате, прологи
// round=0, слаг Ле-Мана с числовым хвостом, слияние строк машины в экипаж
// (подменный пилот), выбор источника wins (real ↔ прокси), титул-кейс команд —
// и мутационная самопроверка предохранителей записи НА ВЫЗОВЕ (образец
// imsastandings.test.ts): деградация входов не затирает прежний файл.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRefs } from "./lib/refs.js";
import {
  assembleIndexEvents, buildCrews, buildWecSnapshot, buildWecStandings,
  displayTeam, isCompleted, parseRacePage, parseStandingsTables, proxyWins,
  realWinsByCar, standingsPageSeason, wecStandingsRegression, wecTrackRef,
  writeWecStandings, type WecRacePageInfo, type WecStandingsDoc,
  type WecStandingTableParsed,
} from "./lib/wecsnapshot.js";

// MARK: Фикстуры

/// Страница события /en/race/<slug> в разметке fiawec: JSON-LD SportsEvent +
/// экранированный raceId live-компонента.
function racePageHTML(opts: {
  name: string; start?: string; end?: string; status?: string;
  venue?: string; address?: string; raceId?: number;
}): string {
  const ld = {
    "@type": "SportsEvent",
    name: opts.name,
    ...(opts.start ? { startDate: opts.start } : {}),
    ...(opts.end ? { endDate: opts.end } : {}),
    eventStatus: `https://schema.org/${opts.status ?? "EventScheduled"}`,
    location: { name: opts.venue ?? "", address: opts.address ?? "" },
  };
  const race = opts.raceId !== undefined
    ? `<div data-live="{&quot;raceId&quot;:${opts.raceId}}"></div>` : "";
  return `<html><script type="application/ld+json">${JSON.stringify(ld)}</script>${race}</html>`;
}

const page = (slug: string, html: string): { slug: string; page: WecRacePageInfo } => {
  const parsed = parseRacePage(html);
  assert.ok(parsed, `страница ${slug} должна парситься`);
  return { slug, page: parsed };
};

/// Таблица зачёта в разметке fiawec: шапка с flag:XX, у строк — картиночная
/// ячейка (иллюстрация), которую парсер обязан выбросить.
function standingsTable(rows: string[][], flags = ["IT", "BE"]): string {
  const header = `<tr><th>Pos.</th><th></th><th>Name</th>${flags.map((f) => `<th><span>flag:${f}</span></th>`).join("")}<th>Total</th></tr>`;
  const body = rows.map((cells) =>
    `<tr>${cells.map((c, i) => (i === 1 && c === "" ? '<td><img src="x.png"/></td>' : `<td>${c}</td>`)).join("")}</tr>`).join("");
  return `<table>${header}${body}</table>`;
}

// MARK: Календарь

test("assembleIndexEvents: нумерация по дате старта, не по порядку страницы; без даты — в хвост", () => {
  const spa = page("spa-2031", racePageHTML({ name: "WEC 6 Hours of Spa 2031", start: "2031-05-08T00:00:00+02:00", end: "2031-05-10T00:00:00+02:00" }));
  const imola = page("imola-2031", racePageHTML({ name: "WEC 6 Hours of Imola 2031", start: "2031-04-18T00:00:00+02:00", end: "2031-04-20T00:00:00+02:00" }));
  const tba = page("tba-2031", racePageHTML({ name: "WEC Mystery 2031" }));
  // Порядок страницы сезона нарочно «неправильный»: нумерует дата, не навигация.
  const events = assembleIndexEvents(2031, [tba, spa, imola], [], undefined, new Map());
  assert.deepEqual(events.map((e) => [e.round, e.slug]), [
    [1, "imola-2031"], [2, "spa-2031"], [3, "tba-2031"],
  ]);
  // Имя чистится по-клиентски: «WEC …» и хвостовой год срезаны.
  assert.equal(events[0].name, "6 Hours of Imola");
});

test("assembleIndexEvents: ничья без дат — по слагу (клиентский тай-брейк)", () => {
  const a = page("b-race-2031", racePageHTML({ name: "B 2031" }));
  const b = page("a-race-2031", racePageHTML({ name: "A 2031" }));
  const events = assembleIndexEvents(2031, [a, b], [], undefined, new Map());
  assert.deepEqual(events.map((e) => e.slug), ["a-race-2031", "b-race-2031"]);
});

test("прологи: round=0, впереди файла, нумерацию этапов не смещают", () => {
  const race = page("6-hours-of-imola-2031", racePageHTML({ name: "WEC 6 Hours of Imola 2031", start: "2031-04-18T00:00:00+02:00" }));
  const prologue = page("official-prologue-imola-2031", racePageHTML({ name: "WEC Official Prologue - IMOLA 2031", start: "2031-04-14T00:00:00+02:00" }));
  const events = assembleIndexEvents(2031, [race], [prologue], undefined, new Map());
  assert.deepEqual(events.map((e) => [e.round, e.slug]), [
    [0, "official-prologue-imola-2031"], [1, "6-hours-of-imola-2031"],
  ]);
  assert.equal(events[0].name, "Official Prologue - IMOLA");
});

test("parseRacePage: сырые ISO-строки с офсетом трассы, статус-токен, ISO-2, raceId", () => {
  const info = parseRacePage(racePageHTML({
    name: "WEC Lone Star Le Mans 2031", start: "2031-09-05T00:00:00+02:00",
    end: "2031-09-07T00:00:00+02:00", status: "EventCompleted",
    venue: "Circuit des Amériques", address: "Austin, USA", raceId: 4935,
  }))!;
  assert.equal(info.start, "2031-09-05T00:00:00+02:00"); // не нормализован в UTC
  assert.equal(info.status, "EventCompleted");
  assert.equal(info.iso2, "us");
  assert.equal(info.raceId, 4935);
  assert.equal(info.venue, "Circuit des Amériques");
  // Битый JSON первого SportsEvent-блока → null (клиент не перебирает дальше).
  assert.equal(parseRacePage('<script type="application/ld+json">{SportsEvent broken</script>'), null);
});

test("isCompleted: редакторский статус ИЛИ прошедший конец (+24ч)", () => {
  const now = Date.parse("2031-05-01T00:00:00Z");
  assert.ok(isCompleted({ status: "EventCompleted", end: null }, now));
  assert.ok(isCompleted({ status: "EventInProgress", end: "2031-04-20T00:00:00+02:00" }, now));
  assert.ok(!isCompleted({ status: "EventScheduled", end: "2031-04-30T12:00:00Z" }, now), "24ч ещё не прошли");
  assert.ok(!isCompleted({ status: null, end: null }, now));
});

// MARK: trackRef (правило 2: nullable ref + display рядом; карта — реальная)

test("wecTrackRef: Ле-Ман с числовым хвостом слага; fiawec-алиас бьёт вхождение слага", () => {
  const refs = loadRefs();
  assert.ok(refs, "карта data/refs/matching.json должна читаться");
  // «Двойной слот» Ле-Мана: fiawec публикует 24-hours-of-le-mans-<год>-1.
  assert.equal(wecTrackRef(refs, "24-hours-of-le-mans-2031-1", "24 Heures du Mans"), "le-mans");
  // «lone-star-le-mans» содержит и «le-mans»: без приоритета fiawec-алиаса
  // событие уехало бы на чужую трассу.
  assert.equal(wecTrackRef(refs, "lone-star-le-mans-2031", "Circuit des Amériques"), "circuit-of-the-americas");
  assert.equal(wecTrackRef(refs, "qatar-1812km-2031", "Lusail International Circuit"), "losail");
  // Слаг не содержит трассы — резолв по venue (слаг «interlagos»).
  assert.equal(wecTrackRef(refs, "rolex-6-hours-of-sao-paulo-2031", "Interlagos"), "interlagos");
  // Незнакомое — честный null (display-строка venue остаётся рядом).
  assert.equal(wecTrackRef(refs, "6-hours-of-atlantis-2031", "Atlantis Ring"), null);
  assert.equal(wecTrackRef(undefined, "24-hours-of-le-mans-2031", "x"), null, "карты нет — fail-open");
});

// MARK: Парсер зачёта

test("parseStandingsTables: kind по заголовку, flag-раунды, правый якорь очков, картиночные ячейки", () => {
  const html = `
    <button class="season-selector btn active" data-season="2">Season 2031</button>
    <button>FIA Hypercar World Endurance Manufacturers&rsquo; Championship</button>
    ${standingsTable([["1", "TOYOTA", "15", "25", "40"]]).replace('<th></th><th>Name</th>', "<th>Name</th>")}
    <button>FIA Hypercar World Endurance Drivers Championship</button>
    ${standingsTable([
      ["1", "", "#7", "KAMUI KOBAYASHI , MIKE CONWAY", "25", "10", "35"],
      ["2", "", "#20", "RENÉ RAST", "-", "36 +1", "36"],
    ])}`;
  const tables = parseStandingsTables(html);
  assert.equal(tables.length, 2);
  const [mfr, drv] = tables;
  assert.equal(mfr.kind, "hypercarManufacturers");
  assert.deepEqual(mfr.rounds, ["IT", "BE"]);
  assert.deepEqual(mfr.rows[0], {
    position: 1, name: "TOYOTA", carNumber: null, totalPoints: 40, stagePoints: [15, 25],
  });
  assert.equal(drv.kind, "hypercarDrivers");
  // Экипаж в одной ячейке нормализуется «A , B» → «A, B»; номер без «#».
  assert.deepEqual(drv.rows[0], {
    position: 1, name: "KAMUI KOBAYASHI, MIKE CONWAY", carNumber: "7",
    totalPoints: 35, stagePoints: [25, 10],
  });
  // «-» → null (дэш, не ноль); «36 +1» → 36 (клиентский префикс цифр).
  assert.deepEqual(drv.rows[1].stagePoints, [null, 36]);
});

test("standingsPageSeason: год активной кнопки; ссылка-селектор и неактивные не считаются", () => {
  const html = `
    <a class="season-selector season-selector--link active" href="/en/season/2030">PREVIOUS</a>
    <button class="season-selector btn btn-link active" data-season="2">Season 2031</button>
    <button class="season-selector btn btn-link" data-season="15">Season 2032</button>`;
  assert.equal(standingsPageSeason(html), 2031);
  assert.equal(standingsPageSeason("<div>no buttons</div>"), null);
});

// MARK: Экипажи

const driversTable = (rows: [string, string, number | null, number | null, number][]): WecStandingTableParsed => ({
  kind: "hypercarDrivers",
  title: "FIA Hypercar World Endurance Drivers Championship",
  rounds: ["IT", "BE"],
  rows: rows.map(([car, name, r1, r2, total]) => ({
    position: null, name, carNumber: car, totalPoints: total, stagePoints: [r1, r2],
  })),
});

test("слияние экипажа: подменный пилот — объединение имён, максимум очков, поэлементный максимум этапов", () => {
  const tables = [driversTable([
    ["20", "RENÉ RAST, ROBIN FRIJNS", 10, 25, 35],
    ["20", "SHELDON VAN DER LINDE", null, 25, 25],   // подмена: своя строка той же машины
    ["7", "KAMUI KOBAYASHI, MIKE CONWAY", 25, 10, 35],
  ])];
  const crews = buildCrews("HYPERCAR", tables, [
    { carNumber: "7", team: "TOYOTA GAZOO RACING", raceClass: "HYPERCAR" },
    { carNumber: "20", team: "BMW M TEAM WRT", raceClass: "LMGT3" }, // чужой класс — не для Hypercar
  ]);
  assert.equal(crews.length, 2);
  // Ничья 35:35 → тай-брейк по номеру numeric («7» < «20») — клиентский
  // localizedStandardCompare, а не позиция официальной таблицы.
  assert.equal(crews[0].carNumber, "7");
  assert.equal(crews[0].team, "Toyota Gazoo Racing");
  assert.equal(crews[0].position, 1);
  const bmw = crews[1];
  assert.deepEqual(bmw.drivers, ["RENÉ RAST", "ROBIN FRIJNS", "SHELDON VAN DER LINDE"]);
  assert.equal(bmw.points, 35);              // максимум по строкам, не сумма
  assert.deepEqual(bmw.stagePoints, [10, 25]); // поэлементный максимум непустых
  assert.equal(bmw.team, "", "классификация чужого класса команду не даёт");
});

test("displayTeam: титул-кейс с аббревиатурами — сверено с реальным Swift .capitalized", () => {
  for (const [raw, expected] of [
    ["FERRARI AF CORSE", "Ferrari AF Corse"],
    ["BMW M TEAM WRT", "BMW M Team WRT"],
    ["CADILLAC HERTZ TEAM JOTA", "Cadillac Hertz Team JOTA"],
    ["MANTHEY 1ST PHORM", "Manthey 1St Phorm"],       // ICU: цифра рвёт слово
    ["D'STATION RACING", "D'station Racing"],          // апостроф клеит
    ["SPA-FRANCORCHAMPS TEAM", "Spa-Francorchamps Team"], // дефис рвёт
    ["MCLAREN UNITED AUTOSPORTS", "Mclaren United Autosports"],
    ["TF SPORT", "TF Sport"],
    ["ASTON MARTIN THOR TEAM", "Aston Martin THOR Team"],
  ] as const) {
    assert.equal(displayTeam(raw), expected);
  }
});

// MARK: Wins

test("proxyWins: максимум колонки — победа, ничьи всем, нулевые колонки не считаются", () => {
  assert.deepEqual(proxyWins([
    [25, 10, 0],
    [25, 12, 0],
    [null, 5, 0],
  ]), [1, 2, 0]); // R1 ничья 25:25 → обоим; R2 → второму; R3 все нули → никому
});

test("wins-выбор: real только при полном покрытии; любой изъян — прокси всему классу", () => {
  const crews = [
    { carNumber: "7", stagePoints: [25, 10] as (number | null)[] },
    { carNumber: "20", stagePoints: [10, 25] as (number | null)[] },
  ];
  // Полное покрытие: победители обоих завершённых раундов сматчились по номеру.
  const ok = realWinsByCar(crews, [1, 2], new Map([[1, "7"], [2, "20"]]));
  assert.deepEqual([...ok!.entries()], [["7", 1], ["20", 1]]);
  // Нет победителя одного из раундов → null (прокси).
  assert.equal(realWinsByCar(crews, [1, 2], new Map([[1, "7"]])), null);
  // Победитель не матчится ни в один экипаж → null.
  assert.equal(realWinsByCar(crews, [1, 2], new Map([[1, "7"], [2, "99"]])), null);
  // Номер машины неоднозначен (две строки) → null.
  const dup = [...crews, { carNumber: "7", stagePoints: [0, 0] as (number | null)[] }];
  assert.equal(realWinsByCar(dup, [1, 2], new Map([[1, "7"], [2, "20"]])), null);
  // Таблица отстаёт от календаря (сыграно колонок ≠ завершено раундов) → null:
  // иначе Wins и Points были бы из разных моментов сезона.
  assert.equal(realWinsByCar(crews, [1], new Map([[1, "7"]])), null);
});

test("buildWecStandings: winsSource на классе, official-происхождение, frozen по закрытому сезону", () => {
  const tables: WecStandingTableParsed[] = [
    driversTable([
      ["7", "A DRIVER", 25, 10, 35],
      ["20", "B DRIVER", 10, 25, 35],
    ]),
    {
      kind: "hypercarManufacturers", title: "Manufacturers Championship",
      rounds: ["IT", "BE"],
      rows: [{ position: 1, name: "TOYOTA", carNumber: null, totalPoints: 70, stagePoints: [35, 35] }],
    },
  ];
  const doc = buildWecStandings({
    season: 2031, tables, classificationRows: [], completedRounds: [1, 2],
    winnersByClass: { HYPERCAR: new Map([[1, "7"], [2, "20"]]) },
  })!;
  assert.equal(doc.classes.length, 1, "LMGT3 без таблицы не выдумывается");
  const hyper = doc.classes[0];
  assert.equal(hyper.winsSource, "real");
  assert.deepEqual(hyper.crews.map((c) => [c.carNumber, c.wins]), [["7", 1], ["20", 1]]);
  assert.equal(hyper.crews[0].pointsSource, "official");
  assert.equal(hyper.manufacturers?.[0].name, "TOYOTA");
  assert.equal(hyper.driverRows.length, 2, "сырые строки Drivers-таблицы сохранены");
  assert.ok(doc.frozen, "оба раунда завершены и сыграны — сезон закрыт");

  // Победителей нет → честный откат всего класса на прокси.
  const proxy = buildWecStandings({
    season: 2031, tables, classificationRows: [], completedRounds: [1, 2], winnersByClass: {},
  })!;
  assert.equal(proxy.classes[0].winsSource, "maxPointsProxy");
  assert.deepEqual(proxy.classes[0].crews.map((c) => c.wins), [1, 1]);

  // Шапки таблиц разъехались (полурендер) → null, файл не трогается выше.
  const skewed = [tables[0], { ...tables[1], rounds: ["IT"] }];
  assert.equal(buildWecStandings({
    season: 2031, tables: skewed, classificationRows: [], completedRounds: [1, 2], winnersByClass: {},
  }), null);
});

// MARK: Предохранитель записи — мутационная самопроверка НА ВЫЗОВЕ

test("writeWecStandings: деградация не затирает прежний файл, рост пишется, повтор — unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "wecsnapshot-"));
  try {
    const path = join(dir, "standings.json");
    const mk = (stage: (number | null)[], crews = 2, team = "Toyota Gazoo Racing"): WecStandingsDoc => ({
      series: "wec", season: 2031, frozen: false, rounds: ["IT", "BE"],
      classes: [{
        raceClass: "HYPERCAR", winsSource: "maxPointsProxy",
        crews: Array.from({ length: crews }, (_, i) => ({
          position: i + 1, carNumber: String(i + 7), team, drivers: ["A B"],
          points: 25, pointsSource: "official" as const, wins: 0, stagePoints: stage,
        })),
        driverRows: [],
      }],
    });

    assert.equal(writeWecStandings(path, mk([25, 10])), "written");
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.schemaVersion, 1);
    assert.ok(written.generatedAt, "конверт writeJSONWithEnvelope");
    assert.equal(writeWecStandings(path, mk([25, 10])), "unchanged");
    const bytes = readFileSync(path, "utf8");

    // Деградация №1: сыгранных раундов стало меньше (полурендер страницы).
    assert.equal(writeWecStandings(path, mk([25, null])), "kept-previous");
    assert.equal(readFileSync(path, "utf8"), bytes, "прежний файл байт в байт");
    // Деградация №2: экипажи схлопнулись.
    assert.equal(writeWecStandings(path, mk([25, 10], 1)), "kept-previous");
    // Деградация №3: команды пропали разом (дыра зеркала классификации).
    assert.equal(writeWecStandings(path, mk([25, 10], 2, "")), "kept-previous");
    assert.equal(readFileSync(path, "utf8"), bytes);
    // Класс исчез.
    const noClass = { ...mk([25, 10]), classes: [] };
    assert.equal(writeWecStandings(path, noClass), "kept-previous");

    // Рост — штатная запись.
    assert.equal(writeWecStandings(path, mk([25, 25])), "written");
    assert.notEqual(readFileSync(path, "utf8"), bytes);

    // Битый прежний файл — не «хорошее прежнее состояние».
    writeFileSync(path, "{нет");
    assert.equal(writeWecStandings(path, mk([25, 10])), "written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wecStandingsRegression: первый файл пишется всегда, рост — норма", () => {
  const cls = (stage: (number | null)[]): WecStandingsDoc["classes"] => [{
    raceClass: "HYPERCAR", winsSource: "maxPointsProxy",
    crews: [{ position: 1, carNumber: "7", team: "T", drivers: [], points: 0, pointsSource: "official", wins: 0, stagePoints: stage }],
    driverRows: [],
  }];
  assert.equal(wecStandingsRegression(null, { classes: cls([25]) }), null);
  assert.equal(wecStandingsRegression({ classes: cls([25]) }, { classes: cls([25, 10]) }), null);
  assert.match(wecStandingsRegression({ classes: cls([25, 10]) }, { classes: cls([25]) })!, /стало меньше/);
});

// MARK: Интеграция: сборка из зеркала (fail-closed целиком + идемпотентность)

test("buildWecSnapshot: полный цикл из зеркала; повтор без изменений; пропавшая страница не трогает файлы", () => {
  const root = mkdtempSync(join(tmpdir(), "wecdata-"));
  const NOW = Date.parse("2031-12-01T00:00:00Z"); // сезон 2031 давно закончился
  try {
    const mirrorDir = join(root, "wec", "fiawec");
    mkdirSync(mirrorDir, { recursive: true });
    mkdirSync(join(root, "wec", "highlights"), { recursive: true });

    // Сезонная страница: пролог + два этапа, порядок навигации НЕ хронологический.
    writeFileSync(join(mirrorDir, "en_season_2031"), `
      <a href="/en/race/totalenergies-6-hours-of-spa-francorchamps-2031">Spa</a>
      <a href="/en/race/24-hours-of-le-mans-2031-1">Le Mans</a>
      <a href="/en/race/official-prologue-imola-2031">Prologue</a>`);
    writeFileSync(join(mirrorDir, "en_race_totalenergies_6_hours_of_spa_francorchamps_2031"),
      racePageHTML({
        name: "WEC TotalEnergies 6 Hours of Spa-Francorchamps 2031",
        start: "2031-05-08T00:00:00+02:00", end: "2031-05-10T00:00:00+02:00",
        status: "EventCompleted", venue: "Spa-Francorchamps",
        address: "Spa-Francorchamps, BEL", raceId: 41,
      }));
    writeFileSync(join(mirrorDir, "en_race_24_hours_of_le_mans_2031_1"),
      racePageHTML({
        name: "WEC 24 Hours of Le Mans 2031",
        start: "2031-06-11T00:00:00+02:00", end: "2031-06-15T00:00:00+02:00",
        status: "EventCompleted", venue: "24 Heures du Mans",
        address: "24 Heures du Mans, FRA", raceId: 42,
      }));
    writeFileSync(join(mirrorDir, "en_race_official_prologue_imola_2031"),
      racePageHTML({
        name: "WEC Official Prologue - IMOLA 2031",
        start: "2031-04-14T00:00:00+02:00", end: "2031-04-14T12:00:00+02:00",
        status: "EventCompleted", venue: "Imola", address: "Imola, ITA", raceId: 40,
      }));
    // E5: дропдауны сессий обоих этапов (у Ле-Мана RACE первым — id не по порядку).
    writeFileSync(join(mirrorDir, "en_page_resultats_1_raceId_41"),
      '<select><option value="71">FREE PRACTICE 1</option><option value="72">RACE</option></select>');
    writeFileSync(join(mirrorDir, "en_page_resultats_1_raceId_42"),
      '<select><option value="80">RACE</option><option value="81">HYPERPOLE 1 - HYPERCAR</option></select>');
    // E6 гонки Ле-Мана (последний завершённый) — команды экипажей Hypercar.
    writeFileSync(join(mirrorDir, "en_page_resultats_1_raceId_42_sessionId_80"), `
      <table><tr><th>Pos.</th><th>Competitors</th><th>Team</th><th>Laps</th></tr>
      <tr><td>N°</td></tr>
      <tr><td>1</td><td><img src="x"/></td><td>#7</td><td>TOYOTA GAZOO RACING</td><td>380</td></tr>
      <tr><td>2</td><td><img src="x"/></td><td>#20</td><td>BMW M TEAM WRT</td><td>379</td></tr>
      </table>`);
    // Зачёт: активный сезон совпадает; Hypercar Drivers с подменным пилотом.
    writeFileSync(join(mirrorDir, "en_page_manufacturers_classification"), `
      <button class="season-selector btn active" data-season="2">Season 2031</button>
      <button>FIA Hypercar World Endurance Manufacturers&rsquo; Championship</button>
      <table>
        <tr><th>Pos.</th><th>Name</th><th>flag:BE</th><th>flag:FR</th><th>Total</th></tr>
        <tr><td>1</td><td>TOYOTA</td><td>25</td><td>50</td><td>75</td></tr>
      </table>
      <button>FIA Hypercar World Endurance Drivers Championship</button>
      <table>
        <tr><th>Pos.</th><th></th><th>Name</th><th>flag:BE</th><th>flag:FR</th><th>Total</th></tr>
        <tr><td>1</td><td><img src="x"/></td><td>#7</td><td>SÉBASTIEN BUEMI , BRENDON HARTLEY</td><td>10</td><td>50</td><td>60</td></tr>
        <tr><td>2</td><td><img src="x"/></td><td>#20</td><td>RENÉ RAST , ROBIN FRIJNS</td><td>25</td><td>30</td><td>55</td></tr>
        <tr><td>3</td><td><img src="x"/></td><td>#20</td><td>SHELDON VAN DER LINDE</td><td>25</td><td>-</td><td>25</td></tr>
      </table>`);
    // Победители сезона — highlights этой же системы (реальные wins).
    writeFileSync(join(root, "wec", "highlights", "2031_1.json"), JSON.stringify({
      season: 2031, round: 1, classWinners: [{ class: "HYPERCAR", car: "20", team: "BMW M Team WRT" }],
    }));
    writeFileSync(join(root, "wec", "highlights", "2031_2.json"), JSON.stringify({
      season: 2031, round: 2, classWinners: [{ class: "HYPERCAR", car: "7", team: "Toyota Gazoo Racing" }],
    }));

    assert.match(buildWecSnapshot(2031, NOW, root), /index written; standings written/);

    const index = JSON.parse(readFileSync(join(root, "wec", "2031", "index.json"), "utf8"));
    assert.equal(index.schemaVersion, 1);
    assert.equal(index.series, "wec");
    assert.ok(index.frozen, "сезон завершён и отстоялся");
    // Пролог round=0 впереди; этапы пронумерованы ПО ДАТЕ, не по навигации
    // (Спа раньше Ле-Мана, хотя на странице сезона он первый).
    assert.deepEqual(index.events.map((e: any) => [e.round, e.slug]), [
      [0, "official-prologue-imola-2031"],
      [1, "totalenergies-6-hours-of-spa-francorchamps-2031"],
      [2, "24-hours-of-le-mans-2031-1"],
    ]);
    // Путь файла сессий события (шаг 3b) публикует индекс: имя считает ОДНА
    // функция на обе стороны контракта, клиент его сам не выводит.
    assert.deepEqual(index.events.map((e: any) => e.resultsPath), [
      "wec/2031/test_official-prologue-imola-2031.json",
      "wec/2031/01_totalenergies-6-hours-of-spa-francorchamps-2031.json",
      "wec/2031/02_24-hours-of-le-mans-2031-1.json",
    ]);
    const leMans = index.events[2];
    assert.equal(leMans.trackRef, "le-mans", "числовой хвост слага Ле-Мана не мешает рефу");
    assert.equal(leMans.countryCode, "fr");
    assert.equal(leMans.start, "2031-06-11T00:00:00+02:00", "сырая ISO-строка с офсетом");
    assert.deepEqual(leMans.sourceIds.fiawec,
      { slug: "24-hours-of-le-mans-2031-1", raceId: 42, sessions: [{ id: 80, label: "RACE" }, { id: 81, label: "HYPERPOLE 1 - HYPERCAR" }] });

    const standings = JSON.parse(readFileSync(join(root, "wec", "2031", "standings.json"), "utf8"));
    assert.deepEqual(standings.rounds, ["BE", "FR"]);
    assert.ok(standings.frozen);
    const hyper = standings.classes[0];
    assert.equal(hyper.raceClass, "HYPERCAR");
    assert.equal(hyper.winsSource, "real");
    // Экипаж #20 слит из двух строк; команды — из E6 последней гонки.
    assert.deepEqual(hyper.crews.map((c: any) => [c.position, c.carNumber, c.team, c.points, c.wins]), [
      [1, "7", "Toyota Gazoo Racing", 60, 1],
      [2, "20", "BMW M Team WRT", 55, 1],
    ]);
    assert.deepEqual(hyper.crews[1].drivers, ["RENÉ RAST", "ROBIN FRIJNS", "SHELDON VAN DER LINDE"]);
    assert.deepEqual(hyper.crews[1].stagePoints, [25, 30], "поэлементный максимум строк машины");
    assert.equal(hyper.driverRows.length, 3, "сырые строки сохранены для экрана пилотов");
    assert.equal(hyper.manufacturers[0].name, "TOYOTA");

    // Идемпотентность: повторный прогон не дёргает файлы.
    const indexBytes = readFileSync(join(root, "wec", "2031", "index.json"), "utf8");
    const standingsBytes = readFileSync(join(root, "wec", "2031", "standings.json"), "utf8");
    assert.match(buildWecSnapshot(2031, NOW, root), /index unchanged; standings unchanged/);
    assert.equal(readFileSync(join(root, "wec", "2031", "index.json"), "utf8"), indexBytes);
    assert.equal(readFileSync(join(root, "wec", "2031", "standings.json"), "utf8"), standingsBytes);

    // Fail-closed целиком: пропала страница этапа → ни index, ни standings не тронуты
    // (иначе нумерация съехала бы на файле навсегда).
    rmSync(join(mirrorDir, "en_race_24_hours_of_le_mans_2031_1"));
    assert.match(buildWecSnapshot(2031, NOW, root), /файлы не тронуты/);
    assert.equal(readFileSync(join(root, "wec", "2031", "index.json"), "utf8"), indexBytes);
    assert.equal(readFileSync(join(root, "wec", "2031", "standings.json"), "utf8"), standingsBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWecSnapshot: season-guard зачёта — страница чужого сезона не пишет standings", () => {
  const root = mkdtempSync(join(tmpdir(), "wecdata-"));
  const NOW = Date.parse("2031-12-01T00:00:00Z");
  try {
    const mirrorDir = join(root, "wec", "fiawec");
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, "en_season_2030"),
      '<a href="/en/race/6-hours-of-imola-2030">Imola</a>');
    writeFileSync(join(mirrorDir, "en_race_6_hours_of_imola_2030"),
      racePageHTML({
        name: "WEC 6 Hours of Imola 2030", start: "2030-04-18T00:00:00+02:00",
        end: "2030-04-20T00:00:00+02:00", status: "EventCompleted",
        venue: "Imola", address: "Imola, ITA", raceId: 30,
      }));
    // Страница зачёта живёт ТЕКУЩИМ сезоном (2031) — архивных fiawec не хранит.
    writeFileSync(join(mirrorDir, "en_page_manufacturers_classification"),
      '<button class="season-selector active">Season 2031</button><table><tr><th>flag:IT</th></tr><tr><td>1</td><td>TOYOTA</td><td>25</td><td>25</td></tr></table>');

    assert.match(buildWecSnapshot(2030, NOW, root), /standings: страница зачёта за 2031 — пропуск/);
    assert.ok(existsSync(join(root, "wec", "2030", "index.json")), "индекс архива собрался");
    assert.ok(!existsSync(join(root, "wec", "2030", "standings.json")),
      "чужой сезон в свой файл не пишется (январские отравления)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("команда экипажа: Teams-таблица класса ПОБЕЖДАЕТ классификацию", () => {
  // Тест-гэп скептика 3a: приоритет teamByCar не был закреплён — инверсия
  // «классификация перебивает Teams-таблицу» выживала. На сегодняшних данных
  // эффекта нет (источники согласны), но Swift-семантика однозначна: таблица
  // зачёта — официальный список заявок, классификация — лишь дозаполнение для
  // машин, которых в ней нет (Hypercar своей Teams-таблицы не имеет).
  const tables: WecStandingTableParsed[] = [
    driversTable([["33", "BEN KEATING", 10, 5, 15]]).kind === "hypercarDrivers"
      ? {
          kind: "lmgt3Drivers", title: "t", rounds: ["IT", "BE"],
          rows: [{ position: null, name: "BEN KEATING", carNumber: "33", totalPoints: 15, stagePoints: [10, 5] }],
        }
      : (undefined as never),
    {
      kind: "lmgt3Teams", title: "t", rounds: ["IT", "BE"],
      rows: [{ position: null, name: "TF SPORT", carNumber: "33", totalPoints: 15, stagePoints: [10, 5] }],
    },
  ];
  const crews = buildCrews("LMGT3", tables, [
    { carNumber: "33", team: "SOME RACE ENTRANT LLC", raceClass: "LMGT3" }, // классификация ВРЁТ
  ]);
  assert.equal(crews.length, 1);
  assert.equal(crews[0].team, "TF Sport", "Teams-таблица обязана победить классификацию");
});

test("standingsPageSeason: активная кнопка не обязана стоять первой", () => {
  // Тест-гэп скептика 3a: в прежней фикстуре активная кнопка шла первой, и
  // мутация «первый матч вместо активного» проходила мимо.
  const html = `
    <button class="season-selector btn btn-link" data-season="15">Season 2032</button>
    <button class="season-selector btn btn-link active" data-season="2">Season 2031</button>`;
  assert.equal(standingsPageSeason(html), 2031, "нужен год АКТИВНОЙ кнопки, не первой");
});

test("parseRacePage: расписание уик-энда — время и статус каждой сессии", () => {
  // Находка скептика 3b: порт времени и статуса сессий (subEvent) не был
  // покрыт НИЧЕМ — два мутанта (start: null, status: null) переживали весь
  // прогон. Между тем именно эти поля определяют, что экран показывает у
  // карточки сессии и считает ли билдер её завершённой.
  const ld = {
    "@type": "SportsEvent",
    name: "6 Hours of Imola",
    startDate: "2026-04-17T00:00:00+02:00",
    eventStatus: "https://schema.org/EventScheduled",
    location: { name: "Imola", address: "ITA" },
    subEvent: [
      {
        "@type": "SportsEvent", name: "Free Practice 1",
        startDate: "2026-04-17T12:30:00+02:00",
        eventStatus: "https://schema.org/EventCompleted",
      },
      {
        "@type": "SportsEvent", name: "Race",
        startDate: "2026-04-19T13:00:00+02:00",
        eventStatus: "https://schema.org/EventScheduled",
      },
      // Сессия без времени — расписание объявлено, слот ещё не назначен.
      { "@type": "SportsEvent", name: "Warm Up" },
    ],
  };
  const parsed = parseRacePage(
    `<html><script type="application/ld+json">${JSON.stringify(ld)}</script></html>`,
  );
  assert.ok(parsed);
  assert.deepEqual(parsed!.sessions, [
    { name: "Free Practice 1", start: "2026-04-17T12:30:00+02:00", status: "EventCompleted" },
    { name: "Race", start: "2026-04-19T13:00:00+02:00", status: "EventScheduled" },
    { name: "Warm Up", start: null, status: null },
  ]);
});
