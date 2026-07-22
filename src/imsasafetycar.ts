// Продьюсер SC-статистики трасс IMSA (строка в серийных MILESTONES на About
// Race) — источник колонка FLAG_AT_FL полап-ового Time Cards CSV гонок
// WeatherTech (формат идентичен WEC-шному Analysis). В IMSA каждый full course
// yellow сопровождается пейс-каром, отдельного «виртуального» режима нет —
// caution считаем как SC (FCY или SF в колонке), поле withFCY не пишем.
// Выход: data/imsa/safetycar/<season>_<round>.json с раскладкой по годам —
// крон дописывает только свежий год, историю не перекачивает.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchHTML, folders } from "./alkamel.js";
import { pickImsaFile, trackCandidates } from "./alkamelimsa.js";
import { parseAkCsv } from "./alkamelwec.js";
import { writeIfChanged } from "./mirror.js";
import { SCHEDULE } from "./schedule.js";
import { bestTrackStage } from "./imsawinners.js";
import { raceFlags, type WecYearFlags } from "./wecsafetycar.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT_DIR = join(process.cwd(), "data", "imsa", "safetycar");
const NOW = Date.now();
const SINCE = 2022; // эра покрытия — как у WEC-карточки (’22+)

const seasonDir = (year: number): string => `${year % 100}_${year}`;

export interface ImsaCircuitSafetyCar {
  season: number;
  round: number;
  sinceYear: number;
  years: Record<string, WecYearFlags>;
  races: number;
  withSafetyCar: number;
}

/// Сводка: в IMSA caution = пейс-кар, поэтому SC = (sc || fcy) года.
export function summarizeImsa(
  season: number, round: number, years: Record<string, WecYearFlags>,
): ImsaCircuitSafetyCar {
  const list = Object.values(years);
  return {
    season, round, sinceYear: SINCE, years,
    races: list.length,
    withSafetyCar: list.filter((y) => y.sc || y.fcy).length,
  };
}

function readExistingYears(path: string): Record<string, WecYearFlags> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ImsaCircuitSafetyCar;
    return parsed.years ?? {};
  } catch {
    return {};
  }
}

async function yearFlags(year: number, venue: string,
                         seasonFoldersCache: Map<number, string[]>): Promise<WecYearFlags | null> {
  let list = seasonFoldersCache.get(year);
  if (!list) {
    const html = await fetchHTML([seasonDir(year)]);
    list = html ? folders(html) : [];
    seasonFoldersCache.set(year, list);
  }
  const candidates = trackCandidates(list, venue);
  if (!candidates.length) return null;
  const best = await bestTrackStage(seasonDir(year), candidates);
  if (!best?.stage) return null;
  const csvFile = pickImsaFile(best.stage.files, "Time Cards", ".CSV");
  if (!csvFile) return null;
  const csv = await fetchHTML([...best.stage.segments, csvFile]);
  if (!csv) return null;
  return raceFlags(parseAkCsv(csv));
}

async function main(): Promise<void> {
  console.log(`IMSA safety car stats, season ${YEAR} (since ${SINCE})`);
  mkdirSync(OUT_DIR, { recursive: true });

  const schedule = SCHEDULE[YEAR];
  if (!schedule) {
    console.log(`  нет курируемого расписания ${YEAR} — выходим`);
    return;
  }

  const cache = new Map<number, string[]>();
  let backfill = Number(process.env.IMSA_SC_BACKFILL ?? 1);

  for (const entry of schedule) {
    const path = join(OUT_DIR, `${YEAR}_${entry.round}.json`);
    const endMs = Date.parse(`${entry.endDate}T23:59:59Z`);
    const raced = endMs < NOW;
    const exists = existsSync(path);
    if (!exists) {
      if (backfill <= 0) continue;
      backfill--;
    }

    const years = readExistingYears(path);
    let changed = false;
    // История SINCE..прошлый год + текущий год после финиша гонки.
    for (let year = SINCE; year <= YEAR; year++) {
      if (years[String(year)]) continue;       // уже посчитан — не перекачиваем
      if (year === YEAR && !raced) continue;   // текущий — только после гонки
      const flags = await yearFlags(year, entry.venue, cache);
      if (!flags) continue;                    // трассы не было в сезоне
      years[String(year)] = flags;
      changed = true;
      await new Promise((res) => setTimeout(res, 250));
    }
    if (!changed && exists) continue;
    if (!Object.keys(years).length) {
      console.log(`  R${entry.round} (${entry.venue}): истории нет — скип`);
      continue;
    }
    const out = summarizeImsa(YEAR, entry.round, years);
    writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
    console.log(`  R${entry.round} (${entry.venue}): SC ${out.withSafetyCar}/${out.races}`);
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
