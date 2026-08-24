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
  mergeFiaEvent,
  type FiaEvent,
  type FiaPenalty,
  type FiaStartingGrid,
} from "./lib/fiadocs.js";
import { fetchWithRetry } from "./producers/fia.js";

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

// --- Реальный текст Doc 63 (штраф Ferrari, unsafe release, Спа-2026): слово
// «Competitor» живёт ВНУТРИ текста Decision — метки-ранние поля резать его
// не должны (регрессия: решение обрывалось на «…on condition that the»). ---
const DOC63 =
  "2026 BELGIAN GRAND PRIX 17 - 19 July 2026 The Stewards, having received a report " +
  "from the Race Director, summoned and heard from the team representative and determine the following: " +
  "No / Driver 44 - Lewis Hamilton Competitor Scuderia Ferrari HP Time 15:45 Session Race " +
  "Fact Unsafe release of car 44 from a pit stop. " +
  "Infringement Breach of Article B1.6.2a of the FIA F1 Regulations. " +
  "Decision The competitor (Scuderia Ferrari HP) is fined €30,000 of which €10,000 is suspended " +
  "for 12 months on condition that the Competitor does not commit a similar infringement in the " +
  "meantime and on the further condition that within 14 days the Competitor submits a report to " +
  "the FIA regarding the incident and protocols introduced to mitigate the risk of such an " +
  "incident occurring in the future. " +
  "Reason The Stewards heard from the team representative and reviewed video evidence.";

test("parsePenaltyDoc: «Competitor» внутри Decision не обрезает текст", () => {
  const p = parsePenaltyDoc(DOC63, ref({ doc: 63, title: "Infringement - Ferrari - Unsafe release of car 44" }));
  assert.ok(p);
  assert.equal(p!.car, 44);
  assert.equal(p!.type, "fine");
  // Полный текст: оба mid-text «Competitor» пережиты, конец — перед Reason.
  assert.match(p!.decision, /on condition that the Competitor does not commit/);
  assert.match(p!.decision, /occurring in the future\.$/);
  assert.doesNotMatch(p!.decision, /Reason The Stewards/);
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
  assert.equal(classifyDecision("Driver: Warning.").type, "warning");
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

// --- Слияние прогона с уже собранным файлом раунда (Zandvoort-2026 R12:
//     файл скакал 11 решений → 1 → 11 → 2, потому что прогон перезаписывал) ---

const pen = (over: Partial<FiaPenalty> & { doc: number }): FiaPenalty => ({
  car: 55, driver: "Carlos Sainz", session: "Race", type: "time", seconds: 5,
  appliesTo: "race", corrected: false, decision: "5 second time penalty.",
  url: `https://www.fia.com/doc${over.doc}.pdf`,
  publishedAt: `2026-08-23 1${over.doc % 10}:00 CET`,
  ...over,
});

const grid = (over: Partial<FiaStartingGrid> = {}): FiaStartingGrid => ({
  kind: "final", doc: 70, entries: [{ position: 1, car: 1 }], penaltySummary: [],
  url: "https://www.fia.com/grid.pdf", publishedAt: "2026-08-23 14:00 CET",
  ...over,
});

const eventFile = (penalties: FiaPenalty[], startingGrid?: FiaStartingGrid): FiaEvent => ({
  season: 2026, round: 12, event: "dutch_grand_prix", penalties,
  ...(startingGrid ? { startingGrid } : {}),
});

const DOCS_12 = [29, 30, 33, 38, 39, 40, 41, 42, 52, 60, 61];
const PREV_12 = eventFile(DOCS_12.map((doc) => pen({ doc })), grid());

test("mergeFiaEvent: прогон без единого распарсенного PDF не затирает файл", () => {
  // Ровно кейс R12: 50 документов, все PDF отвалились → раньше в файл летели 0-2
  // решения. Теперь неудачный прогон — no-op по данным.
  const m = mergeFiaEvent(PREV_12, {
    penalties: [], carried: [], startingGrid: undefined,
    listedDocs: DOCS_12, complete: false,
  });
  assert.equal(m.penalties.length, 11);
  assert.equal(m.kept, 11);
  assert.equal(m.dropped, 0);
  assert.deepEqual(m.penalties.map((p) => p.doc), DOCS_12);
  assert.equal(m.startingGrid?.kind, "final");   // грид тоже на месте
});

test("mergeFiaEvent: свежий документ добавляется к прежним", () => {
  const m = mergeFiaEvent(PREV_12, {
    penalties: [pen({ doc: 63, type: "dsq", decision: "Disqualified.", publishedAt: "2026-08-23 21:30 CET" })],
    carried: [], listedDocs: [...DOCS_12, 63], complete: true,
  });
  assert.equal(m.penalties.length, 12);
  assert.equal(m.kept, 11);
  assert.equal(m.penalties.at(-1)!.doc, 63);
  assert.equal(m.updated, "2026-08-23 21:30 CET");  // updated пересчитан по итоговому набору
});

test("mergeFiaEvent: спринт-штрафы прошлого прогона переживают частичный", () => {
  // Doc 29/30 — питлейн-старт в СПРИНТЕ: разобраны в первом прогоне, во втором
  // их PDF не дались. Пропасть они не должны (в приложении это отдельная секция).
  const m = mergeFiaEvent(PREV_12, {
    penalties: [pen({ doc: 60 })], carried: [],
    listedDocs: DOCS_12, complete: false,
  });
  const sprint = m.penalties.filter((p) => [29, 30].includes(p.doc));
  assert.equal(sprint.length, 2);
});

test("mergeFiaEvent: final-грид не откатывается к provisional", () => {
  const m = mergeFiaEvent(PREV_12, {
    penalties: [], carried: [], startingGrid: grid({ kind: "provisional", doc: 65 }),
    listedDocs: DOCS_12, complete: true,
  });
  assert.equal(m.startingGrid?.kind, "final");
  assert.equal(m.startingGrid?.doc, 70);
  // Обратно — свежий final поверх прежнего provisional — проходит.
  const up = mergeFiaEvent(eventFile([], grid({ kind: "provisional", doc: 65 })), {
    penalties: [], carried: [], startingGrid: grid({ kind: "final", doc: 70 }),
    listedDocs: [], complete: true,
  });
  assert.equal(up.startingGrid?.kind, "final");
  // Грид не распарсился в этом прогоне — остаётся прежний.
  const keep = mergeFiaEvent(PREV_12, {
    penalties: [], carried: [], listedDocs: DOCS_12, complete: true,
  });
  assert.equal(keep.startingGrid?.doc, 70);
});

test("mergeFiaEvent: corrected супер­седит original", () => {
  // Тем же номером (FIA перевыкладывает документ) — свежий разбор побеждает.
  const before = eventFile([pen({ doc: 25, type: "grid", gridDrop: 5, corrected: false })]);
  const m = mergeFiaEvent(before, {
    penalties: [pen({ doc: 25, type: "grid", gridDrop: 10, corrected: true })],
    carried: [], listedDocs: [25], complete: true,
  });
  assert.equal(m.penalties.length, 1);
  assert.equal(m.penalties[0].corrected, true);
  assert.equal(m.penalties[0].gridDrop, 10);
  // Новым номером — в файле живут оба (дедуп делает приложение).
  const two = mergeFiaEvent(before, {
    penalties: [pen({ doc: 44, type: "grid", gridDrop: 10, corrected: true })],
    carried: [], listedDocs: [25, 44], complete: true,
  });
  assert.deepEqual(two.penalties.map((p) => p.doc), [25, 44]);
});

test("mergeFiaEvent: отзыв документа — только по чистому прогону", () => {
  const listed = DOCS_12.filter((d) => d !== 52);   // doc 52 сняли со страницы
  const dirty = mergeFiaEvent(PREV_12, {
    penalties: [], carried: [], listedDocs: listed, complete: false,
  });
  assert.equal(dirty.penalties.length, 11);   // прогон с осечками не удаляет
  assert.equal(dirty.dropped, 0);
  const clean = mergeFiaEvent(PREV_12, {
    penalties: listed.map((doc) => pen({ doc })), carried: [],
    listedDocs: listed, complete: true,
  });
  assert.equal(clean.penalties.length, 10);
  assert.equal(clean.dropped, 1);
  assert.ok(!clean.penalties.some((p) => p.doc === 52));
});

test("mergeFiaEvent: переносы пересобираются, а не копятся", () => {
  // carriedFrom-штраф живёт в своём ключевом пространстве: doc 60 переноса из
  // R11 не конфликтует с собственным doc 60 этапа.
  const carried = pen({ doc: 60, type: "grid", gridDrop: 5, carriedFrom: 11 });
  const first = mergeFiaEvent(PREV_12, {
    penalties: [pen({ doc: 60 })], carried: [carried],
    listedDocs: DOCS_12, complete: true,
  });
  assert.equal(first.penalties.filter((p) => p.doc === 60).length, 2);
  assert.equal(first.penalties.at(-1)!.carriedFrom, 11);
  // Следующий прогон: перенос из R11 отменён — из файла он не воскресает.
  const second = mergeFiaEvent(eventFile(first.penalties, grid()), {
    penalties: [], carried: [], listedDocs: DOCS_12, complete: true,
  });
  assert.ok(!second.penalties.some((p) => p.carriedFrom != null));
  assert.equal(second.penalties.length, 11);
});

// --- Сетевой слой: диагностика и ретраи (fetch подменяем) ---

// Пауза в тестах — 1 мс: проверяем политику повторов, а не часы.
const NET = { label: "Doc 52", timeoutMs: 50, attempts: 3, pauseMs: 1 };

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  body: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    calls++;
    return handler(String(url), init);
  }) as typeof fetch;
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

test("fetchWithRetry: 404 не ретраится (документа на сервере нет)", async () => {
  const { result, calls } = await withFetch(
    async () => new Response("nope", { status: 404 }),
    () => fetchWithRetry("https://fia.test/doc.pdf", (r) => r.text(), NET),
  );
  assert.equal(result, null);
  assert.equal(calls, 1);
});

test("fetchWithRetry: 503 и 429 ретраятся, успех со второй попытки", async () => {
  const codes = [503, 429];
  const { result, calls } = await withFetch(
    async () => {
      const code = codes.shift();
      return code ? new Response("busy", { status: code }) : new Response("ok");
    },
    () => fetchWithRetry("https://fia.test/doc.pdf", (r) => r.text(), NET),
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);   // 503 → 429 → 200, ровно в пределах attempts
});

test("fetchWithRetry: сетевой отказ ретраится, после attempts — null", async () => {
  const { result, calls } = await withFetch(
    async () => { throw new TypeError("fetch failed"); },
    () => fetchWithRetry("https://fia.test/doc.pdf", (r) => r.text(), NET),
  );
  assert.equal(result, null);
  assert.equal(calls, 3);
});

test("fetchWithRetry: таймаут обрывает попытку и ретраится", async () => {
  const { result, calls } = await withFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        // Висящий ответ: обрывается нашим AbortController по timeoutMs.
        (init as any).signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    () => fetchWithRetry("https://fia.test/doc.pdf", (r) => r.text(), { ...NET, attempts: 2 }),
  );
  assert.equal(result, null);
  assert.equal(calls, 2);
});
