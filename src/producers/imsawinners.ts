// Продьюсер «победители прошлых лет» IMSA (PAST WINNERS на About Race) —
// источник финальные Results JSON гонок WeatherTech из архива Al Kamel
// (imsa.results.alkamelcloud.com, сезоны 16_2016+). Для каждого раунда
// текущего сезона — абсолютные победители той же трассы за прошлые сезоны.
// Выход: data/imsa/winners/<season>_<round>.json — формат общий с
// data/wec/winners (модель приложения F1PastWinners).
// История неизменна → write-once.
//
// Матчинг раунда — по имени трассы (NN-префикс не уникален), валидность —
// наличие WeatherTech-папки с сессией Race; при нескольких событиях на трассе
// за сезон (ковидный 2020) главное = больше Hour-папок, затем позднее.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fetchHTML, fetchJSON, folders } from "../lib/alkamel.js";
import {
  imsaCrewSurnames, pickImsaFile, trackCandidates,
  IMSA_SEASONS_FIRST,
} from "../lib/alkamelimsa.js";
import { parseAkCsv } from "../lib/alkamelwec.js";
import {writeJSONWithEnvelope } from "../lib/mirror.js";
import { SCHEDULE } from "../lib/schedule.js";
import {
  bestTrackStage, buildWecWinners, crewSurnames, imsaOverallWinner, overallWinner,
} from "../lib/winnersbuild.js";
import { envFlag, envNumber } from "../lib/env.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT_DIR = join(process.cwd(), "data", "imsa", "winners");

const seasonDir = (year: number): string => `${year % 100}_${year}`;

async function main(): Promise<void> {
  console.log(`IMSA past winners, season ${YEAR}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const schedule = SCHEDULE[YEAR];
  if (!schedule) {
    console.log(`  нет курируемого расписания ${YEAR} — выходим`);
    return;
  }

  // Листинги прошлых сезонов — один fetch на сезон, кэш в пределах прогона.
  const seasonFolders = new Map<number, string[]>();
  async function foldersOf(year: number): Promise<string[]> {
    const cached = seasonFolders.get(year);
    if (cached) return cached;
    const html = await fetchHTML([seasonDir(year)]);
    const list = html ? folders(html) : [];
    seasonFolders.set(year, list);
    return list;
  }

  let backfill = envNumber("IMSA_WINNERS_BACKFILL", 1);
  // Разовая пересборка после правки СЧЁТА побед. Файл победителей пишется
  // один раз (история трассы неизменна в сезоне), и это верно — но означает,
  // что изменение логики подсчёта до старых файлов НЕ ДОХОДИТ никогда.
  //
  // Пересчитать локально нельзя: кумулятив winsHere считается по ВСЕЙ истории
  // трассы, а в файл попадают только последние пять строк — из них счёт
  // восстанавливается с занижением. Поэтому именно пересборка.
  //
  // Прогон: IMSA_WINNERS_FORCE=1 IMSA_WINNERS_BACKFILL=99 npm run imsawinners
  const force = envFlag("IMSA_WINNERS_FORCE");

  for (const entry of schedule) {
    const path = join(OUT_DIR, `${YEAR}_${entry.round}.json`);
    if (existsSync(path) && !force) continue; // история неизменна — пишем один раз
    if (backfill <= 0) continue;
    backfill--;

    const rows: { year: number; name: string; team: string; vehicle?: string }[] = [];
    for (let year = IMSA_SEASONS_FIRST; year < YEAR; year++) {
      const candidates = trackCandidates(await foldersOf(year), entry.venue);
      if (!candidates.length) continue;
      const best = await bestTrackStage(seasonDir(year), candidates);
      if (!best?.stage) continue;
      // Results JSON появился в архиве ~2023; раньше — только CSV того же
      // Al Kamel-макета (DRIVERn_FIRSTNAME/SECONDNAME), парсим фолбэком.
      const jsonFile = pickImsaFile(best.stage.files, "03_Results", ".JSON");
      const json = jsonFile ? await fetchJSON([...best.stage.segments, jsonFile]) : null;
      const winner = json ? imsaOverallWinner(json) : null;
      if (winner?.team) {
        rows.push({
          year,
          name: imsaCrewSurnames(winner.drivers ?? []),
          team: winner.team.trim(),
          ...(winner.vehicle ? { vehicle: winner.vehicle.trim() } : {}),
        });
      } else {
        const csvFile = pickImsaFile(best.stage.files, "03_Results", ".CSV");
        const csv = csvFile ? await fetchHTML([...best.stage.segments, csvFile]) : null;
        const row = csv ? overallWinner(parseAkCsv(csv)) : null;
        if (!row?.TEAM) continue;
        rows.push({
          year,
          name: crewSurnames(row).toUpperCase(),
          team: row.TEAM.trim(),
          ...(row.VEHICLE ? { vehicle: row.VEHICLE.trim() } : {}),
        });
      }
      await new Promise((res) => setTimeout(res, 250)); // вежливая пауза
    }

    const out = {
      season: YEAR,
      round: entry.round,
      circuit: entry.venue,
      winners: buildWecWinners(rows, YEAR),
    };
    writeJSONWithEnvelope(path, out);
    console.log(`  R${entry.round} (${entry.venue}): ${out.winners.length} победителей (${rows.length} сезонов)`);
  }
  console.log("Done.");
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
