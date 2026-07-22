import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finalHourFolder, hourCount, imsaCrewSurnames, imsaShortDriver,
  imsaTimeSeconds, matchImsaTrack, pickImsaFile, wtFolderName,
} from "./alkamelimsa.js";
import {
  imsaDriveThroughCounts, imsaFastestLap, imsaFastestPitStop,
} from "./imsahighlights.js";
import { imsaOverallWinner } from "./imsawinners.js";
import { summarizeImsa } from "./imsasafetycar.js";
import { imsaDocFromName, parseImsaPenaltyPdf } from "./imsafia.js";

test("matchImsaTrack: точное, алиасы, суффиксы, префиксные события", () => {
  assert.ok(matchImsaTrack("12_Watkins Glen International", "Watkins Glen International"));
  assert.ok(matchImsaTrack("06_Long Beach Street Circuit", "Streets of Long Beach"));
  assert.ok(matchImsaTrack("02_Rolex 24 at Daytona", "Daytona International Speedway"));
  assert.ok(matchImsaTrack("02_Rolex 24 - Daytona International Speedway", "Daytona International Speedway"));
  assert.ok(matchImsaTrack("18_Mazda Raceway Laguna Seca", "WeatherTech Raceway Laguna Seca"));
  assert.ok(matchImsaTrack("10_Weathertech Raceway Laguna Seca", "WeatherTech Raceway Laguna Seca"));
  assert.ok(matchImsaTrack("11_Detroit Street Course", "Detroit Street Circuit"));
  assert.ok(matchImsaTrack("05_Sebring International Raceway (AEC)", "Sebring International Raceway"));
  assert.ok(matchImsaTrack("12_6H - Watkins Glen International", "Watkins Glen International"));
  assert.ok(matchImsaTrack("13_WeatherTech 240 - WGI", "Watkins Glen International"));
  assert.ok(matchImsaTrack("17_Tire Rack.com Battle On The Bricks", "Indianapolis Motor Speedway"));
  assert.ok(matchImsaTrack("12_Motul Petit Le Mans", "Michelin Raceway Road Atlanta"));
  assert.ok(matchImsaTrack("21_Road Atlanta", "Michelin Raceway Road Atlanta"));
  assert.ok(!matchImsaTrack("07_Barber Motorsports Park", "Daytona International Speedway"));
  assert.ok(!matchImsaTrack("15_Lime Rock Park", "Watkins Glen International"));
});

test("дерево: WT-папка, финальный час с дырами, выбор файла по статусу", () => {
  assert.equal(
    wtFolderName(["02_IMSA Michelin Pilot Challenge", "01_IMSA WeatherTech SportsCar Championship"]),
    "01_IMSA WeatherTech SportsCar Championship",
  );
  assert.equal(wtFolderName(["01_IMSA Michelin Pilot Challenge"]), null);
  // WGI-2024: пропуск 05_Hour 5 — финал всё равно 06.
  const dirs = ["01_Hour 1", "02_Hour 2", "03_Hour 3", "04_Hour 4", "06_Hour 6", "00_Starting Grids"];
  assert.equal(finalHourFolder(dirs), "06_Hour 6");
  assert.equal(hourCount(dirs), 5);
  assert.equal(finalHourFolder(["00_Starting Grids"]), null);
  const files = [
    "03_Results_Race_Unofficial.JSON", "03_Results_Race_Official.JSON",
    "03_Results_Race_Official.CSV", "23_Time Cards_Race.CSV",
  ];
  assert.equal(pickImsaFile(files, "03_Results", ".JSON"), "03_Results_Race_Official.JSON");
  assert.equal(pickImsaFile(files, "Time Cards", ".CSV"), "23_Time Cards_Race.CSV");
  assert.equal(pickImsaFile(files, "Pit Stops", ".JSON"), null);
});

test("форматтеры: экипаж, короткое имя, время", () => {
  assert.equal(
    imsaCrewSurnames([{ firstname: "Dane", surname: "Cameron" }, { firstname: "Felipe", surname: "Nasr" }]),
    "CAMERON / NASR",
  );
  assert.equal(imsaShortDriver("Jack", "Aitken"), "J. Aitken");
  assert.equal(imsaShortDriver(undefined, "Aitken"), "Aitken");
  assert.equal(imsaTimeSeconds("29.409"), 29.409);
  assert.equal(imsaTimeSeconds("1:35.826"), 95.826);
  assert.equal(imsaTimeSeconds("6:01:10.521"), 21670.521);
  assert.equal(imsaTimeSeconds("-"), null);
});

test("highlights: fastest lap из Results JSON, пит с фильтром drive-through", () => {
  const results = {
    fastest_lap: {
      time: "1:34.967", participant_number: "31",
      driver_firstname: "Jack", driver_surname: "Aitken",
    },
    classification: [{ number: "31", team: "Cadillac Whelen", class: "GTP" }],
  };
  const fl = imsaFastestLap(results);
  assert.equal(fl?.driver, "J. Aitken");
  assert.equal(fl?.team, "Cadillac Whelen");
  assert.equal(fl?.seconds, 94.967);

  // CTMP-2026: у #27 drive-through 23.3с — фильтруется по числу наказаний.
  const pits = {
    pit_stop_analysis: [
      { number: "27", team: "A", class: "GTP", pit_stops: [
        { pit_time: "23.300", in_driver_surname: "Fast" },
        { pit_time: "31.000", in_driver_surname: "Fast" },
      ] },
      { number: "016", team: "B", class: "GTP", pit_stops: [
        { pit_time: "29.900", in_driver_firstname: "Real", in_driver_surname: "Stopper" },
      ] },
    ],
  };
  const rcCsv = [
    "TIME;ELAPSED;REC_TYPE;FLAG;SECTOR;MESSAGE;FLAG_TIME;ACCUM_TIME;LAP",
    "14:40:07.794;34:31.418;RCMessage;;;Car 27: Penalty - Too many crew over wall - Drive Through;-;-;0",
  ].join("\n");
  const dt = imsaDriveThroughCounts(rcCsv);
  assert.equal(dt.get("27"), 1);
  const pit = imsaFastestPitStop(pits, dt);
  assert.equal(pit?.time, "29.900");
  assert.equal(pit?.driver, "R. Stopper");
  // Без фильтра drive-through выигрывает нечестно.
  assert.equal(imsaFastestPitStop(pits)?.time, "23.300");
});

test("winners: победитель из Results JSON; safetycar: сводка caution", () => {
  const winner = imsaOverallWinner({
    classification: [
      { position: "2", team: "B" },
      { position: "1", team: "Porsche Penske Motorsport", vehicle: "Porsche 963",
        drivers: [{ firstname: "Dane", surname: "Cameron" }, { firstname: "Felipe", surname: "Nasr" }] },
    ],
  });
  assert.equal(winner?.team, "Porsche Penske Motorsport");

  const sc = summarizeImsa(2026, 7, {
    "2022": { sc: false, fcy: true },
    "2023": { sc: false, fcy: false },
    "2024": { sc: true, fcy: false },
  });
  assert.equal(sc.races, 3);
  assert.equal(sc.withSafetyCar, 2); // caution = sc || fcy
  assert.ok(!("withFCY" in sc));
});

test("penalties: имя дока, парс PDF-текста, фильтр серии", () => {
  assert.deepEqual(imsaDocFromName("TP 26-11.pdf"), { kind: "Technical", doc: 11 });
  assert.deepEqual(imsaDocFromName("SP 26-9.pdf"), { kind: "Sporting", doc: 9 });
  assert.equal(imsaDocFromName("00_Championship Points - Official.pdf"), null);

  // Реальный текст SP 26-9 (Себринг-2026, IWSC): все поля на месте.
  const iwsc = "EVENT: SERIES: TEAM: Mobil 1 12 Hours of Sebring IWSC Manthey 1St Phorm ENTRANT REPRESENTATIVE: Tobias Hansonis DRIVER: Riccardo Pera (07/04/99) AFFECTED PARTY: INFRACTION ENTRY OFFICIAL: David Pees The Official listed above has reviewed the following matter FACTS: Riccardo Pera completed a Drive Time of 2:38:11.220 under the minimum 3 hours PENALTY FINE: CHANGE: Moved to back of class SIGNATURES Approved by: Beaux Barfield RETURN TROPHY 912 GTD TYPE: Sporting IMSA PENALTY NOTICE SP - 26 - 9";
  const p = parseImsaPenaltyPdf(iwsc, "Sporting", 9, "u");
  assert.equal(p?.car, 912);
  assert.equal(p?.driver, "Riccardo Pera");
  assert.equal(p?.decision, "Moved to back of class");
  assert.equal(p?.session, "Sporting");
  assert.ok(p?.fact?.includes("Drive Time"));

  // Реальный текст TP 26-11 (Уоткинс-Глен, IMPC — чужая серия) → скип.
  const impc = "EVENT: SERIES: TEAM: Sahlen's Six Hours of the Glen IMPC KMW Motorsports With TMR Engineering ENTRANT REPRESENTATIVE: Louis Milone DRIVER: AFFECTED PARTY: N/A FACTS: TCR Car #5 was found below minimum PENALTY FINE: N/A CHANGE: Lap times are invalidated, Car is moved to the back of the Class. SIGNATURES RETURN TROPHY 5 TCR TYPE: Technical";
  assert.equal(parseImsaPenaltyPdf(impc, "Technical", 11, "u"), null);

  // Пустой DRIVER → фолбэк на команду; «invalidated» → deleted_laps.
  const noDriver = iwsc
    .replace("DRIVER: Riccardo Pera (07/04/99) AFFECTED", "DRIVER: AFFECTED")
    .replace("CHANGE: Moved to back of class", "CHANGE: Lap times are invalidated");
  const p2 = parseImsaPenaltyPdf(noDriver, "Sporting", 9, "u");
  assert.equal(p2?.driver, "Manthey 1St Phorm");
  assert.equal(p2?.type, "deleted_laps");
});
