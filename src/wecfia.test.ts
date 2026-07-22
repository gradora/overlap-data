// Продьюсер решений стюардов WEC: селекторы Notice Board, парс дерева
// документов, штрафные PDF (шаблон WEC), матчинг раундов.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAkRound, parseAkCsv, parseAkOptions, parseFileHrefs, slugifyAkEvent } from "./alkamelwec.js";
import { carFromTitle, docFromHref, isWecPenaltyDoc, parseWecPenaltyDoc, WEC_FIELD_LABELS } from "./wecfia.js";
import { fieldValue } from "./fia.js";

// --- Реальные фрагменты HTML Notice Board (июль 2026) ---

const SELECTORS_HTML = `
<select name="season" onchange="changeSeason()">
<option Value="13_2025">2025</option><option Value="14_2026" SELECTED>2026</option>
</select>
<select name="evvent" onchange="changeEvent()">
<option Value="01_6 Hours of Imola">6 Hours of Imola</option><option Value="02_6 Hours of Spa">6 Hours of Spa</option><option Value="03_24 Hours of Le Mans">24 Hours of Le Mans</option><option Value="05_6 Hours of Sao Paulo" SELECTED>6 Hours of Sao Paulo</option>
</select>`;

const TREE_HTML = `
<a href="Results_NoticeBoard/14_2026/05_6%20Hours%20of%20Sao%20Paulo/009_Doc%209%20-%20Decision%20no.%201%20-%20Car%2083.pdf" onclick="return openFile('Results_NoticeBoard/14_2026/05_6%20Hours%20of%20Sao%20Paulo/009_Doc%209%20-%20Decision%20no.%201%20-%20Car%2083.pdf')">DOC 9</a>
<a href="Results_NoticeBoard/14_2026/05_6%20Hours%20of%20Sao%20Paulo/009_Doc%209%20-%20Decision%20no.%201%20-%20Car%2083.pdf">DOC 9 dup</a>
<a href="Results_NoticeBoard/14_2026/05_6%20Hours%20of%20Sao%20Paulo/013_Doc%2013%20-%20Summons%20no.%201.pdf">DOC 13</a>`;

// Порядок слагов сезона 2026 со страницы fiawec (раунды 1..8).
const SLUGS_2026 = [
  "6-hours-of-imola-2026",
  "totalenergies-6-hours-of-spa-francorchamps-2026",
  "24-hours-of-le-mans-2026",
  "rolex-6-hours-of-sao-paulo-2026",
  "lone-star-le-mans-2026",
  "6-hours-of-fuji-2026",
  "qatar-1812km-2026",
  "bapco-energies-8-hours-of-bahrain-2026",
];

test("parseAkOptions: option с атрибутом Value (большая V) и SELECTED", () => {
  const seasons = parseAkOptions(SELECTORS_HTML, "season");
  assert.deepEqual(seasons.map((o) => o.label), ["2025", "2026"]);
  assert.equal(seasons[1].value, "14_2026");
  const events = parseAkOptions(SELECTORS_HTML, "evvent");
  assert.equal(events.length, 4);
  assert.equal(events[3].value, "05_6 Hours of Sao Paulo");
});

test("parseFileHrefs: дедуп href+onclick, порядок сохранён", () => {
  const hrefs = parseFileHrefs(TREE_HTML, "Results_NoticeBoard");
  assert.equal(hrefs.length, 2);
  assert.ok(hrefs[0].includes("009_Doc"));
  assert.ok(hrefs[1].includes("013_Doc"));
});

test("docFromHref: номер и заголовок из URL-encoded имени файла", () => {
  const d = docFromHref(
    "Results_NoticeBoard/14_2026/05_6%20Hours%20of%20Sao%20Paulo/012_Doc%2012%20-%20Decision%20no.%202%20AMENDED%20Time%20of%20fact%20-%20Car%2061.pdf",
  );
  assert.ok(d);
  assert.equal(d!.doc, 12);
  assert.equal(d!.title, "Decision no. 2 AMENDED Time of fact - Car 61");
  assert.ok(d!.url.startsWith("https://fiawec.alkamelsystems.com/Results_NoticeBoard/"));
  assert.equal(docFromHref("Results_NoticeBoard/14_2026/x/foo.pdf"), null);
});

test("isWecPenaltyDoc: одиночные решения — да, мульти и прочее — нет", () => {
  assert.equal(isWecPenaltyDoc("Decision no. 1 - Car 83"), true);
  assert.equal(isWecPenaltyDoc("Decision no. 2 AMENDED Time of fact - Car 61"), true);
  assert.equal(isWecPenaltyDoc("Decision no. 28-30"), false);          // мульти без машины
  assert.equal(isWecPenaltyDoc("Summons no. 1"), false);
  assert.equal(isWecPenaltyDoc("PROVISIONAL STARTING GRID"), false);
  assert.equal(carFromTitle("Decision no. 50 - Car 007"), 7);
});

test("matchAkRound: события Notice Board → раунды по слагам сезона", () => {
  assert.equal(matchAkRound("6 Hours of Imola", SLUGS_2026), 1);
  assert.equal(matchAkRound("6 Hours of Spa", SLUGS_2026), 2);       // ⊂ totalenergies-…
  assert.equal(matchAkRound("24 Hours of Le Mans", SLUGS_2026), 3);
  assert.equal(matchAkRound("6 Hours of Sao Paulo", SLUGS_2026), 4); // Round 4 — как в шапке PDF
  assert.equal(matchAkRound("Lone Star Le Mans", SLUGS_2026), 5);    // не путается с Ле-Маном
  assert.equal(matchAkRound("Qatar 1812km", SLUGS_2026), 7);
  assert.equal(matchAkRound("6 Hours of Monza", SLUGS_2026), null);
  assert.equal(slugifyAkEvent("6 Hours of São Paulo"), "6-hours-of-sao-paulo");
});

// --- Реальные тексты штрафных PDF (Сан-Паулу 2026) ---

const DOC10 =
  "FIA World Endurance Championship Round 4 – 6 Hours of São Paulo 2026 July 9th - 12th " +
  "Decision no. 2 The Stewards, having received a report from the FIA Race Director, determined " +
  "a breach of the regulations has been committed by the competitor named below and impose the " +
  "penalty referred to. N° / Driver: 61 / Martin BERRY Competitor: IRON LYNX Session: FP1 " +
  "Time (fact): 11:15 Fact: Speeding in the pitlane Offence: Article 12.1.4 of FIA WEC Sporting " +
  "Regulations Decision: Fine of 600 € and cancellation of the times set by the Driver during " +
  "the practice session since the previous pit stop up to the moment of the infringement. " +
  "Reason: The driver of car 61 was reported speeding in the pitlane (65.48kph) between the pit " +
  "entry loop and the stopping area.";

const DOC90 =
  "FIA World Endurance Championship Round 4 – 6 Hours of São Paulo 2026 July 9th - 12th " +
  "Decision no. 50 The Stewards, having received a report from the Race Director, having checked " +
  "the video evidence, have considered the following matter N° / Driver: 007 / Tom GAMBLE " +
  "Competitor: ASTON MARTIN THOR TEAM Session: Race Time (fact): 14:10 Fact: Contact between " +
  "cars 007 and 79 at T1. Offence: Appendix L Chap. IV, art 2d) of International Sporting Code " +
  "Decision: 10 seconds added at the next pit stop Reason: Having reviewed the video evidence, " +
  "the Stewards determined that Car 007 was wholly responsible for the collision.";

test("parseWecPenaltyDoc: штраф-файн FP1 (Doc 10)", () => {
  const p = parseWecPenaltyDoc(DOC10, { doc: 10, title: "Decision no. 2 - Car 61", url: "u" }, "2026-07-10T15:17:41.000Z");
  assert.ok(p);
  assert.equal(p!.car, 61);
  assert.equal(p!.driver, "Martin BERRY");
  assert.equal(p!.session, "FP1");
  assert.equal(p!.type, "fine");
  assert.equal(p!.fact, "Speeding in the pitlane");
  assert.match(p!.decision, /^Fine of 600 €/);
  assert.match(p!.decision, /moment of the infringement\.$/); // Reason не захвачен
  assert.equal(p!.corrected, false);
  assert.equal(p!.publishedAt, "2026-07-10T15:17:41.000Z");
});

test("parseWecPenaltyDoc: тайм-пенальти к питу (Doc 90) + номер 007", () => {
  const p = parseWecPenaltyDoc(DOC90, { doc: 90, title: "Decision no. 50 - Car 007", url: "u" });
  assert.ok(p);
  assert.equal(p!.car, 7);
  assert.equal(p!.driver, "Tom GAMBLE");
  assert.equal(p!.type, "time");
  assert.equal(p!.seconds, 10);
  assert.equal(p!.appliesTo, "race");
  assert.equal(p!.session, "Race");
});

test("parseWecPenaltyDoc: AMENDED → corrected", () => {
  const p = parseWecPenaltyDoc(DOC10, { doc: 12, title: "Decision no. 2 AMENDED Time of fact - Car 61", url: "u" });
  assert.equal(p!.corrected, true);
});

test("fieldValue с WEC-метками: Session не режется на слове Time внутри текста", () => {
  // «Time (fact):» — поздняя метка для Session; слова ранних меток в значениях
  // не режут (то же правило, что чинило Competitor у F1).
  assert.equal(fieldValue(DOC10, "Session:", WEC_FIELD_LABELS), "FP1");
  assert.equal(fieldValue(DOC10, "Time (fact):", WEC_FIELD_LABELS), "11:15");
});

test("parseAkCsv: BOM, «;», ведущие пробелы заголовков, хвостовой «;»", () => {
  const csv = "﻿NUMBER; DRIVER_NAME;LAP_TIME;\r\n61;Martin BERRY;1:24.001;\r\n007;Tom GAMBLE;1:25.777;\r\n";
  const rows = parseAkCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].NUMBER, "61");
  assert.equal(rows[0].DRIVER_NAME, "Martin BERRY");
  assert.equal(rows[1].LAP_TIME, "1:25.777");
});
