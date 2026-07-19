// Тесты парсеров FIA на РЕАЛЬНЫХ фикстурах (текст извлечён unpdf из PDF fia.com).
// Запуск: npm test (node:test через tsx, без внешних зависимостей).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDocList,
  eventSlugFromUrl,
  isPenaltyDoc,
  classifyDecision,
  parsePenaltyDoc,
  parseStartingGridDoc,
  matchRound,
  normalizePublished,
  findSeasonUrl,
  raceStartWall,
  markNextRace,
  carryOver,
  parseEventOptions,
  slugifyRace,
} from "./fia.js";

const ref = (over: Partial<{ doc: number; title: string; url: string; publishedAt: string }> = {}) => ({
  doc: 23,
  title: "Infringement - Car 1 - Change to PU element",
  url: "https://www.fia.com/system/files/decision-document/2026_belgian_grand_prix_-_infringement_-_car_1_-_change_to_pu_element.pdf",
  publishedAt: "2026-07-17 16:53 CET",
  ...over,
});

// --- Реальный текст штрафного PDF (Doc 23, грид-дроп Норриса) ---
const DOC23 =
  "2026 BELGIAN GRAND PRIX 17 - 19 July 2026 The Stewards From The Stewards To The Team Manager, McLaren Mastercard F1 Team Document 23 Date 17 July 2026 Time 16:51 The Stewards, having received a report from the Technical Delegate (document 14), have considered the following matter and determine the following: No / Driver 1 - Lando Norris Competitor McLaren Mastercard F1 Team Time 13:36 Session Free Practice 1 Fact The following Power Unit element has been used: 4th Control Electronics Unit (PU-CE) Infringement Breach of Article B8.2.2 (read with B8.2.3) of the FIA F1 Regulations. Decision Drop of 10 grid positions for the next Race in which the driver participates. Reason The penalty is imposed in accordance with Article B8.2.8 of the FIA F1 Regulations.";

// --- Реальный текст Decision PDF (Doc 43, «No further action») ---
const DOC43 =
  "2026 BELGIAN GRAND PRIX 17 - 19 July 2026 From The Stewards To The Team Manager, Atlassian Williams F1 Team Document 43 Date 18 July 2026 Time 15:05 The Stewards, having received a report from the Race Director, summoned (documents 39 & 40) and heard from the drivers and team representatives, have considered the following matter and determine the following: No / Driver 55 - Carlos Sainz Competitor Atlassian Williams F1 Team Time 13:33 Session Free Practice 3 Fact Alleged failing to slow under yellow flags Infringement Alleged breaches of Appendix H, Article 2.5.5 b) of the International Sporting Code and Article 1.8.4.b of the FIA F1 Regulations. Decision No further action. Reason The Stewards heard from the driver of Car 55 (Carlos Sainz), the driver of Car 3 (Max Verstappen), team representatives and reviewed evidence.";

// --- Реальный текст официального Final Starting Grid (Doc 70, British GP) ---
const GRID70 =
  "2026 BRITISH GRAND PRIX 03 - 05 July 2026 The Stewards From The Stewards To All Teams, All Officials Document 70 Date 05 July 2026 Time 14:00 Title Final Starting Grid Description Final Starting Grid Enclosed GBR DOC 70 - Final Starting Grid.pdf Gerd Ennser Tanja Geilhausen Mathieu Remmerie Pedro Lamy Richard Norbury 2 16 Charles LECLERC Scuderia Ferrari HP 1:28.286 4 63 George RUSSELL Mercedes-AMG PETRONAS F1 Team 1:28.481 6 1 Lando NORRIS McLaren Mastercard F1 Team 1:28.877 8 81 Oscar PIASTRI McLaren Mastercard F1 Team 1:29.032 10 30 Liam LAWSON Visa Cash App Racing Bulls F1 Team 1:29.716 12 27 Nico HULKENBERG Audi Revolut F1 Team 1:30.076 14 55 Carlos SAINZ Atlassian Williams F1 Team 1:30.623 16 23 Alexander ALBON Atlassian Williams F1 Team 1:31.341 18 77 Valtteri BOTTAS Cadillac Formula 1 Team 1:31.227 20 11 Sergio PEREZ Cadillac Formula 1 Team 1:31.451 22 18 Lance STROLL * Aston Martin Aramco F1 Team 1:32.863 1 12 Kimi ANTONELLI Mercedes-AMG PETRONAS F1 Team 1:28.111 3 44 Lewis HAMILTON Scuderia Ferrari HP 1:28.458 5 6 Isack HADJAR Oracle Red Bull Racing 1:28.746 7 3 Max VERSTAPPEN Oracle Red Bull Racing 1:28.893 9 41 Arvid LINDBLAD Visa Cash App Racing Bulls F1 Team 1:29.305 11 5 Gabriel BORTOLETO Audi Revolut F1 Team 1:29.461 13 87 Oliver BEARMAN TGR Haas F1 Team 1:30.501 15 10 Pierre GASLY * BWT Alpine F1 Team 1:30.063 17 31 Esteban OCON TGR Haas F1 Team 1:30.680 19 43 Franco COLAPINTO BWT Alpine F1 Team 1:31.321 21 14 Fernando ALONSO Aston Martin Aramco F1 Team 1:33.025 * PENALTIES Car 10 - 3 place grid penalty - Impeding another driver - Stewards' document no. 60 Car 18 - 10 place grid penalty - Additional power unit elements have been used - Stewards' document no. 68 Gerd Ennser The Stewards Doc 70 Time 14:00";

test("parsePenaltyDoc: грид-дроп извлекается из поля Decision", () => {
  const p = parsePenaltyDoc(DOC23, ref());
  assert.ok(p);
  assert.equal(p!.car, 1);
  assert.equal(p!.driver, "Lando Norris");
  assert.equal(p!.session, "Free Practice 1");
  assert.equal(p!.type, "grid");
  assert.equal(p!.gridDrop, 10);
  assert.equal(p!.appliesTo, "race"); // «for the next Race»
  assert.equal(p!.corrected, false);
  assert.match(p!.decision, /Drop of 10 grid positions/);
  assert.doesNotMatch(p!.decision, /Reason/); // Decision не захватил следующее поле
  assert.equal(p!.fact, "The following Power Unit element has been used: 4th Control Electronics Unit (PU-CE)");
});

test("parsePenaltyDoc: «No further action» → type none, тот же шаблон", () => {
  const p = parsePenaltyDoc(DOC43, ref({ doc: 43, title: "Decision - Car 55 - Alleged failure to slow" }));
  assert.ok(p);
  assert.equal(p!.car, 55);
  assert.equal(p!.driver, "Carlos Sainz");
  assert.equal(p!.type, "none");
  assert.equal(p!.decision, "No further action.");
});

test("classifyDecision: все типы штрафов генерически", () => {
  assert.deepEqual(classifyDecision("Drop of 5 grid positions for the next Race."), { type: "grid", gridDrop: 5 });
  assert.deepEqual(classifyDecision("10 grid place penalty."), { type: "grid", gridDrop: 10 });
  assert.deepEqual(classifyDecision("The car must start from the pit lane."), { type: "grid", pitlane: true });
  assert.deepEqual(classifyDecision("Required to start the Race from the back of the starting grid."), { type: "grid", backOfGrid: true });
  assert.deepEqual(classifyDecision("5 second time penalty and 2 penalty points."), { type: "time", seconds: 5 });
  assert.equal(classifyDecision("Car 44 is disqualified from the race classification.").type, "dsq");
  assert.equal(classifyDecision("The driver is excluded from the Qualifying classification.").type, "dsq");
  assert.equal(classifyDecision("Reprimand (driving).").type, "reprimand");
  assert.equal(classifyDecision("Fine of €25,000.").type, "fine");
  assert.equal(classifyDecision("No further action.").type, "none");
  assert.equal(classifyDecision("The matter is referred to the Stewards.").type, "other");
});

test("parseStartingGridDoc: позиции+машины и сводка пенальти", () => {
  const g = parseStartingGridDoc(GRID70, ref({ doc: 70, title: "Final Starting Grid" }));
  assert.ok(g);
  assert.equal(g!.kind, "final");
  assert.equal(g!.entries.length, 22);
  // Отсортировано по позиции; поул — Антонелли (12), P2 — Леклер (16).
  assert.deepEqual(g!.entries[0], { position: 1, car: 12 });
  assert.deepEqual(g!.entries[1], { position: 2, car: 16 });
  assert.deepEqual(g!.entries[21], { position: 22, car: 18 });
  // Сводка пенальти из футера.
  assert.equal(g!.penaltySummary.length, 2);
  assert.deepEqual(g!.penaltySummary[0], { car: 10, text: "3 place grid penalty - Impeding another driver", doc: 60 });
  assert.deepEqual(g!.penaltySummary[1], { car: 18, text: "10 place grid penalty - Additional power unit elements have been used", doc: 68 });
});

test("parseStartingGridDoc: Provisional распознаётся по Title", () => {
  const g = parseStartingGridDoc(GRID70.replace("Final Starting Grid", "Provisional Starting Grid"), ref({ doc: 65 }));
  assert.equal(g!.kind, "provisional");
});

test("parseStartingGridDoc: запись БЕЗ лаптайма не теряет следующий слот", () => {
  // Реальный кейс Spa: у P21 (Hadjar, штраф) нет лаптайма — хвост-якорь
  // проглатывал бы P2 (Верстаппен). Якорь на начало слота это чинит.
  const text =
    "Title Provisional Starting Grid Gerd Ennser " +
    "1 12 Kimi ANTONELLI Mercedes 1:44.361 " +
    "21 6 Isack HADJAR * Oracle Red Bull Racing " +   // без лаптайма
    "2 3 Max VERSTAPPEN Oracle Red Bull Racing 1:44.678 " +
    "4 16 Charles LECLERC Ferrari 1:44.893 " +
    "* PENALTIES Car 6 - 30 place grid penalty - x - Stewards' document no. 44";
  const g = parseStartingGridDoc(text, ref({ doc: 50 }));
  const byPos = Object.fromEntries(g!.entries.map((e) => [e.position, e.car]));
  assert.equal(g!.entries.length, 4);
  assert.equal(byPos[2], 3);    // Верстаппен на P2 НЕ потерян
  assert.equal(byPos[21], 6);   // Hadjar на P21 есть (без лаптайма)
  assert.equal(byPos[1], 12);
  assert.equal(byPos[4], 16);
});

test("parseDocList + eventSlugFromUrl: обе HTML-структуры (плоская + вложенная)", () => {
  // Структура A (плоская, свежие доки) + структура B (Drupal field-обёртки,
  // старые доки) — FIA рендерит и так, и так; парсер должен ловить обе.
  const html = `
  <li class="document-row key-46">
    <a href="/system/files/decision-document/2026_belgian_grand_prix_-_infringement_-_car_1_-_change_to_pu_element.pdf" download target="_blank">
      <div class="file-type"><div class="pdf"></div></div>
      <div class="title">   Doc 23 - Infringement - Car 1 - Change to PU element   </div>
      <div class="published">  Published on <span class="date-display-single">17.07.26 16:53</span> CET  </div>
    </a>
  </li>
  <li class="document-row key-35">
    <div class="panelizer-view-mode node node-teaser node-decision-document node-63144">
      <a href="/system/files/decision-document/2026_belgian_grand_prix_-_post-qualifying_procedure.pdf" download target="_blank">
        <div class="file-type"><div class="field field-name-field-decision-document"><div class="field-items"><div class="field-item even"><div class="pdf"></div></div></div></div></div>
        <div class="panel-separator"></div>
        <div class="title"><div class="field field-name-title-field"><div class="field-items"><div class="field-item even">Doc 35 - Post-Qualifying Procedure</div></div></div></div>
        <div class="published"><div class="field field-name-field-published"><div class="field-items"><div class="field-item even">Published on <span class="date-display-single">18.07.26 09:32</span> CET</div></div></div></div>
      </a>
    </div>
  </li>`;
  const docs = parseDocList(html);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].doc, 23);
  assert.equal(docs[0].title, "Infringement - Car 1 - Change to PU element");
  assert.equal(docs[0].url, "https://www.fia.com/system/files/decision-document/2026_belgian_grand_prix_-_infringement_-_car_1_-_change_to_pu_element.pdf");
  assert.equal(docs[0].publishedAt, "2026-07-17 16:53 CET");
  assert.equal(eventSlugFromUrl(docs[0].url), "belgian_grand_prix");
  // Вложенная структура-B тоже распарсилась.
  assert.equal(docs[1].doc, 35);
  assert.equal(docs[1].title, "Post-Qualifying Procedure");
  assert.equal(docs[1].publishedAt, "2026-07-18 09:32 CET");
});

test("isPenaltyDoc: фильтр штрафных доков", () => {
  assert.equal(isPenaltyDoc("Infringement - Car 1 - Change to PU element"), true);
  assert.equal(isPenaltyDoc("Decision - Car 55 - Alleged failure to slow"), true);
  assert.equal(isPenaltyDoc("Corrected Infringement - Car 14 - Change to PU elements"), true);
  assert.equal(isPenaltyDoc("Summons - Car 55 - Alleged failure to slow"), false);
  assert.equal(isPenaltyDoc("Final Starting Grid"), false);
  assert.equal(isPenaltyDoc("Free Practice 2 Classification"), false);
  assert.equal(isPenaltyDoc("Infringement - Free Practice 3 Deleted Lap Times"), false); // нет «Car N»
});

test("matchRound: event-slug → round из расписания Jolpica", () => {
  const races = [
    { round: "9", date: "2026-07-05", raceName: "British Grand Prix" },
    { round: "10", date: "2026-07-19", time: "13:00:00Z", raceName: "Belgian Grand Prix" },
  ];
  assert.deepEqual(matchRound("belgian_grand_prix", races),
    { round: 10, raceDate: "2026-07-19", raceTime: "13:00:00Z" });
  assert.deepEqual(matchRound("british_grand_prix", races),
    { round: 9, raceDate: "2026-07-05", raceTime: undefined });
  assert.equal(matchRound("hungarian_grand_prix", races), null);
});

test("normalizePublished: DD.MM.YY HH:MM → сортируемая строка", () => {
  assert.equal(normalizePublished("17.07.26 16:53"), "2026-07-17 16:53 CET");
});

test("findSeasonUrl: node-id из селектора, не путая с Formula E (path-scoped)", () => {
  // В общей навигации FIA двухлетний сезон Formula E даёт токен
  // «season-2026-2027» РАНЬШЕ F1-опции — незаякоренный regex увёл бы туда.
  const html = `
    <a href="/events/abb-fia-formula-e-world-championship/season-2026-2027/x">Formula E</a>
    <select>
      <option value="/documents/championships/fia-formula-one-world-championship-14/season/season-2025-2071">2025</option>
      <option value="/documents/championships/fia-formula-one-world-championship-14/season/season-2026-2072">2026</option>
    </select>`;
  assert.equal(
    findSeasonUrl(html, 2026),
    "https://www.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2026-2072",
  );
  assert.equal(
    findSeasonUrl(html, 2025),
    "https://www.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2025-2071",
  );
  assert.equal(findSeasonUrl(html, 2099), null);
});

test("raceStartWall: UTC-старт Jolpica → парижский wall-clock", () => {
  // Спа: 13:00 UTC = 15:00 в Париже (лето, CEST) — CET/CEST-метка FIA не важна,
  // сравнение идёт wall-clock с wall-clock.
  assert.equal(raceStartWall("2026-07-19", "13:00:00Z"), "2026-07-19 15:00");
  // Зимний пример: Лас-Вегас 04:00 UTC = 05:00 в Париже (CET).
  assert.equal(raceStartWall("2026-11-22", "04:00:00Z"), "2026-11-22 05:00");
  assert.equal(raceStartWall("2026-07-19", undefined), null);
  assert.equal(raceStartWall("2026-07-19", "garbage"), null);
});

test("markNextRace: пост-гоночный грид-штраф → next_race, догоночный — race", () => {
  const wall = raceStartWall("2026-07-19", "13:00:00Z")!; // 15:00 Paris
  const base = {
    car: 55, driver: "Carlos Sainz", session: "Qualifying",
    appliesTo: "race", corrected: false, decision: "d", url: "u",
  };
  const pens = [
    { ...base, doc: 54, type: "grid" as const, gridDrop: 10, publishedAt: "2026-07-19 12:22 CET" },
    { ...base, doc: 60, type: "grid" as const, gridDrop: 5, publishedAt: "2026-07-19 18:41 CET" },
    { ...base, doc: 61, type: "time" as const, seconds: 5, publishedAt: "2026-07-19 18:50 CET" },
    { ...base, doc: 62, type: "grid" as const, gridDrop: 3 }, // без publishedAt — не трогаем
  ];
  const out = markNextRace(pens, wall);
  assert.equal(out[0].appliesTo, "race");       // 12:22 < 15:00 — применён к этой гонке (Сайнц)
  assert.equal(out[1].appliesTo, "next_race");  // 18:41 > 15:00 — на следующую
  assert.equal(out[2].appliesTo, "race");       // тайм-штраф — не грид, не трогаем
  assert.equal(out[3].appliesTo, "race");       // нет даты — толерантно
  // Без времени гонки — всё как было.
  assert.equal(markNextRace(pens, null)[1].appliesTo, "race");
});

test("carryOver: next_race-штрафы предыдущего раунда → race текущего с carriedFrom", () => {
  const prev = {
    season: 2026, round: 10, event: "belgian_grand_prix",
    penalties: [
      { doc: 60, car: 55, driver: "Carlos Sainz", session: "Race", type: "grid" as const,
        gridDrop: 5, appliesTo: "next_race", corrected: false, decision: "d", url: "u",
        publishedAt: "2026-07-19 18:41 CET" },
      { doc: 61, car: 1, driver: "Lando Norris", session: "Race", type: "time" as const,
        seconds: 5, appliesTo: "race", corrected: false, decision: "d", url: "u" },
    ],
  };
  const carried = carryOver(prev);
  assert.equal(carried.length, 1);              // только next_race-грид
  assert.equal(carried[0].appliesTo, "race");   // в новом раунде — обычный race-штраф
  assert.equal(carried[0].carriedFrom, 10);
  assert.equal(carried[0].gridDrop, 5);
  assert.deepEqual(carryOver(null), []);
});

test("parseEventOptions: селектор этапов со страницы сезона", () => {
  const html = `
    <option value="0">Event</option>
    <option value="/documents/championships/fia-formula-one-world-championship-14/season/season-2026-2072/event/Chinese%20Grand%20Prix">Chinese Grand Prix</option>
    <option value="/documents/championships/fia-formula-one-world-championship-14/season/season-2026-2072/event/British%20Grand%20Prix">British Grand Prix</option>
    <option value="/documents/season/season-2026-2072/championships/formula-2-championship-44">Formula 2 Championship</option>`;
  const evs = parseEventOptions(html);
  assert.equal(evs.length, 2);   // F2 и служебные option не попали
  assert.equal(evs[0].name, "Chinese Grand Prix");
  assert.ok(evs[0].url.startsWith("https://www.fia.com/documents/championships/"));
  assert.ok(evs[0].url.endsWith("/event/Chinese%20Grand%20Prix"));
  // Имя из селектора матчится с расписанием Jolpica через slugifyRace.
  assert.equal(slugifyRace(evs[0].name), "chinese_grand_prix");
});

test("classifyDecision: питлейн со вставкой сессии + appliesTo спринта", () => {
  // Китай-2026 doc 68 (Албон): вставка «the Race» между start и from.
  assert.deepEqual(
    classifyDecision("Required to start the Race from the pit lane under Article B3.5.3 b)."),
    { type: "grid", pitlane: true },
  );
  // Сильверстоун-2026 doc 35 (Албон): питлейн СПРИНТА.
  assert.deepEqual(
    classifyDecision("Required to start the Sprint from the pit lane."),
    { type: "grid", pitlane: true },
  );
  // appliesTo различает: спринт-решение не должно трогать решётку гонки.
  const sprint = parsePenaltyDoc(
    DOC23.replace("Drop of 10 grid positions for the next Race in which the driver participates.",
                  "Required to start the Sprint from the pit lane."),
    ref());
  assert.equal(sprint!.appliesTo, "sprint");
  const race = parsePenaltyDoc(
    DOC23.replace("Drop of 10 grid positions for the next Race in which the driver participates.",
                  "Required to start the Race from the pit lane."),
    ref());
  assert.equal(race!.appliesTo, "race");
});
