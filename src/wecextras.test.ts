// Продьюсеры WEC-архива: хайлайты гонки, победители прошлых лет, SC/FCY.

import { test } from "node:test";
import assert from "node:assert/strict";
import { akTimeSeconds, matchAkRound, pickRaceCsv } from "./alkamelwec.js";
import { raceHighlights, shortDriver } from "./wechighlights.js";
import { buildWecWinners, crewSurnames, overallWinner, singleYearSeasons } from "./wecwinners.js";
import { raceFlags, summarize } from "./wecsafetycar.js";

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

test("matchAkRound: метки-трассы Results-архива (алиасы и токены)", () => {
  assert.equal(matchAkRound("IMOLA", SLUGS_2026), 1);
  assert.equal(matchAkRound("SPA FRANCORCHAMPS", SLUGS_2026), 2);
  assert.equal(matchAkRound("LE MANS", SLUGS_2026), 3);           // первый матч — не lone-star
  assert.equal(matchAkRound("SAO PAULO", SLUGS_2026), 4);
  assert.equal(matchAkRound("CIRCUIT OF THE AMERICAS", SLUGS_2026), 5); // алиас → lone-star
  assert.equal(matchAkRound("FUJI SPEEDWAY", SLUGS_2026), 6);     // токен fuji
  assert.equal(matchAkRound("LOSAIL", SLUGS_2026), 7);            // алиас → qatar
  assert.equal(matchAkRound("BAHRAIN INTERNATIONAL CIRCUIT", SLUGS_2026), 8);
});

test("akTimeSeconds: форматы Al Kamel", () => {
  assert.equal(akTimeSeconds("1'25.805"), 85.805);
  assert.equal(akTimeSeconds("2:57.046"), 177.046);
  assert.equal(akTimeSeconds("6:00'26.462"), 21626.462);
  assert.equal(akTimeSeconds("47.806"), 47.806);
  assert.equal(akTimeSeconds(""), null);
  assert.equal(akTimeSeconds("DNF"), null);
});

test("pickRaceCsv: финальный час, без ByCategory, толерантность к старым макетам", () => {
  const hrefs = [
    "Results/15_2026/04_SP/666_FIA%20WEC/202607121130_Race/01_Hour%201/03_Classification_Race_Hour%201.CSV",
    "Results/15_2026/04_SP/666_FIA%20WEC/202607121130_Race/06_Hour%206/03_Classification_Race_Hour%206.CSV",
    "Results/15_2026/04_SP/666_FIA%20WEC/202607121130_Race/06_Hour%206/05_ClassificationByCategory_Race_Hour%206.CSV",
    "Results/15_2026/04_SP/666_FIA%20WEC/202607121130_Race/06_Hour%206/23_Analysis_Race_Hour%206.CSV",
  ];
  assert.ok(pickRaceCsv(hrefs, "Classification")!.includes("Hour%206/03_Classification"));
  assert.ok(pickRaceCsv(hrefs, "Analysis")!.includes("23_Analysis"));
  // Старый макет: подпапки NH, файл без «Hour».
  const old = [
    "Results/02_2012/03_LM/14_X/201206161500_Race/6H/05_Classification_Race.CSV",
    "Results/02_2012/03_LM/14_X/201206161500_Race/24H/05_Classification_Race.CSV",
  ];
  assert.ok(pickRaceCsv(old, "Classification")!.includes("/24H/"));
  assert.equal(pickRaceCsv([], "Analysis"), null);
});

test("raceHighlights: лучший круг и пит с порогом", () => {
  const rows = [
    { NUMBER: "15", DRIVER_NAME: "Kevin MAGNUSSEN", LAP_TIME: "1:25.805", PIT_TIME: "", TEAM: "BMW M Team WRT", CLASS: "HYPERCAR" },
    { NUMBER: "51", DRIVER_NAME: "James CALADO", LAP_TIME: "1:25.700", PIT_TIME: "1:02.400", TEAM: "Ferrari AF Corse", CLASS: "HYPERCAR" },
    { NUMBER: "007", DRIVER_NAME: "Tom GAMBLE", LAP_TIME: "1:26.100", PIT_TIME: "0:28.100", TEAM: "Aston Martin", CLASS: "HYPERCAR" }, // drive-through — мимо
    { NUMBER: "92", DRIVER_NAME: "Loek HARTOG", LAP_TIME: "1:31.000", PIT_TIME: "0:58.900", TEAM: "Manthey", CLASS: "LMGT3" },
  ];
  const h = raceHighlights(rows, 2026, 4);
  assert.equal(h.fastestLap!.driver, "J. CALADO");
  assert.equal(h.fastestLap!.seconds, 85.7);
  assert.equal(h.fastestPitStop!.driver, "L. HARTOG");   // 58.9с — минимум над порогом
  assert.equal(h.fastestPitStop!.car, "92");
  assert.equal(shortDriver("Kevin MAGNUSSEN"), "K. MAGNUSSEN");
});

test("winners: экипаж, победитель, кумулятив, спан-сезоны мимо", () => {
  const row = {
    POSITION: "1", TEAM: "BMW M Team WRT", VEHICLE: "BMW M Hybrid V8",
    DRIVER_1: "Kevin MAGNUSSEN", DRIVER_2: "Raffaele MARCIELLO",
    DRIVER_3: "Dries VANTHOOR", DRIVER_4: "", DRIVER_5: "",
  };
  assert.equal(crewSurnames(row), "MAGNUSSEN / MARCIELLO / VANTHOOR");
  assert.equal(crewSurnames({ DRIVER_1: "Alessandro PIER GUIDI" }), "PIER GUIDI");
  assert.equal(overallWinner([{ POSITION: "2" }, row])!.TEAM, "BMW M Team WRT");

  const winners = buildWecWinners([
    { year: 2022, name: "A", team: "Toyota" },
    { year: 2023, name: "B", team: "Ferrari" },
    { year: 2024, name: "C", team: "Toyota" },
    { year: 2025, name: "D", team: "Toyota" },
  ], 2026);
  assert.equal(winners[0].year, 2025);
  assert.equal(winners[0].winsHere, 3);       // Toyota ×3 к 2025-му
  assert.equal(winners[1].winsHere, 2);

  const seasons = singleYearSeasons([
    { value: "08_2018-2019", label: "2018-2019" },
    { value: "10_2021", label: "2021" },
    { value: "15_2026", label: "2026" },
  ]);
  assert.deepEqual(seasons.map((s) => s.year), [2021, 2026]);
});

test("safetycar: флаги гонки и сводка по годам", () => {
  assert.deepEqual(raceFlags([{ FLAG_AT_FL: "GF" }, { FLAG_AT_FL: "FCY" }]), { sc: false, fcy: true });
  assert.deepEqual(raceFlags([{ FLAG_AT_FL: "SF" }]), { sc: true, fcy: false });
  const s = summarize(2026, 4, {
    "2022": { sc: true, fcy: true },
    "2023": { sc: false, fcy: true },
    "2024": { sc: false, fcy: false },
  });
  assert.equal(s.races, 3);
  assert.equal(s.withSafetyCar, 1);
  assert.equal(s.withFCY, 2);
});
