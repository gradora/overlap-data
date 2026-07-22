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
import { fetchHTML, fetchJSON, folders } from "./alkamel.js";
import {
  imsaCrewSurnames, imsaRaceStage, pickImsaFile, trackCandidates,
  IMSA_SEASONS_FIRST, type ImsaDriverRef,
} from "./alkamelimsa.js";
import { parseAkCsv } from "./alkamelwec.js";
import { writeIfChanged } from "./mirror.js";
import { SCHEDULE } from "./schedule.js";
import { buildWecWinners, crewSurnames, overallWinner } from "./wecwinners.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT_DIR = join(process.cwd(), "data", "imsa", "winners");

const seasonDir = (year: number): string => `${year % 100}_${year}`;

interface ResultsClassificationRow {
  position?: number | string;
  team?: string;
  vehicle?: string;
  drivers?: ImsaDriverRef[];
}

/// Победитель гонки из финального Results JSON: position 1 общей таблицы
/// (классы отсортированы сквозь — топ-класс сверху).
export function imsaOverallWinner(json: unknown): ResultsClassificationRow | null {
  const rows = (json as { classification?: ResultsClassificationRow[] })?.classification;
  if (!Array.isArray(rows)) return null;
  return rows.find((r) => String(r.position ?? "").trim() === "1") ?? null;
}

/// Лучшее из событий-кандидатов трассы за сезон: max Hour-папок, затем позднее.
export async function bestTrackStage(
  season: string,
  candidates: string[],
): Promise<{ stage: Awaited<ReturnType<typeof imsaRaceStage>>; round: string } | null> {
  let best: { stage: NonNullable<Awaited<ReturnType<typeof imsaRaceStage>>>; round: string } | null = null;
  for (const round of candidates) {
    const stage = await imsaRaceStage(season, round);
    if (!stage) continue;
    if (!best || stage.hours > best.stage.hours ||
        (stage.hours === best.stage.hours && stage.stamp > best.stage.stamp)) {
      best = { stage, round };
    }
  }
  return best;
}

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

  let backfill = Number(process.env.IMSA_WINNERS_BACKFILL ?? 1);

  for (const entry of schedule) {
    const path = join(OUT_DIR, `${YEAR}_${entry.round}.json`);
    if (existsSync(path)) continue; // история неизменна — пишем один раз
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
    writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
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
