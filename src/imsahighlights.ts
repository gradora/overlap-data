// Продьюсер хайлайтов уикенда IMSA (THIS WEEKEND): быстрейший круг гонки —
// из готового блока fastest_lap финального Results JSON, быстрейший пит-стоп —
// из 20_Pit Stops Time Cards JSON (pit_time — время в пит-лейне). Формат
// выхода общий с wec/highlights (модель приложения F1EventHighlights).
// Выход: data/imsa/highlights/<season>_<round>.json. Прошедшие этапы
// замораживаются (freeze 7 дней), потом файл не трогаем.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fetchHTML, fetchJSON, folders } from "./alkamel.js";
import {
  imsaShortDriver, imsaTimeSeconds, pickImsaFile, trackCandidates,
} from "./alkamelimsa.js";
import { isFrozen } from "./freeze.js";
import { writeIfChanged } from "./mirror.js";
import { SCHEDULE } from "./schedule.js";
import { bestTrackStage } from "./imsawinners.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT_DIR = join(process.cwd(), "data", "imsa", "highlights");
const NOW = Date.now();
/// Отсечка проездов без остановки (drive-through): реальные стопы IMSA от ~29с.
const MIN_PIT_SECONDS = 20;

interface Highlight {
  time: string;
  seconds: number;
  driver: string;
  car?: string;
  team?: string;
  class?: string;
}

/// fastest_lap из Results JSON + команда/класс по номеру машины из классификации.
export function imsaFastestLap(json: unknown): Highlight | null {
  const j = json as {
    fastest_lap?: {
      time?: string; participant_number?: string | number;
      driver_firstname?: string; driver_surname?: string;
    };
    classification?: { number?: string | number; team?: string; class?: string }[];
  };
  const fl = j?.fastest_lap;
  const time = (fl?.time ?? "").trim();
  const seconds = time ? imsaTimeSeconds(time) : null;
  if (!fl || !time || seconds == null) return null;
  const car = String(fl.participant_number ?? "").trim();
  const row = (j.classification ?? []).find((r) => String(r.number ?? "").trim() === car);
  return {
    time,
    seconds,
    driver: imsaShortDriver(fl.driver_firstname, fl.driver_surname),
    ...(car ? { car } : {}),
    ...(row?.team ? { team: row.team.trim() } : {}),
    ...(row?.class ? { class: row.class.trim() } : {}),
  };
}

interface PitStopsJson {
  pit_stop_analysis?: {
    number?: string | number;
    team?: string;
    class?: string;
    pit_stops?: {
      pit_time?: string;
      in_driver_firstname?: string;
      in_driver_surname?: string;
    }[];
  }[];
}

const carKey = (n: string): string => n.trim().replace(/^0+(?=\d)/, "");

/// Карта «машина → сколько drive-through назначено» из RC-сообщений гонки
/// (25_FlagsAnalysisWithRCMessages CSV). Drive-through попадают в Pit Stops
/// Time Cards как обычные проезды — и на коротких пит-лейнах короче реальных
/// стопов, фикс-порог их не режет (CTMP-2026: 23.3с у наказанных машин).
export function imsaDriveThroughCounts(csv: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of csv.split(/\r?\n/)) {
    const m = line.match(/Car\s+(\w+)\s*:?\s+Penalty\b[^;]*Drive\s*Through/i);
    if (!m) continue;
    const key = carKey(m[1]);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/// Медиана честных пит-проездов гонки (после drive-through-фильтра и порога).
/// «78.4» → «1:18.4»: медиана эндуранс-пита бывает за минуту.
function medianLabel(seconds: number): string {
  if (seconds < 60) return seconds.toFixed(1);
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function imsaMedianPitStop(
  json: unknown,
  driveThroughs: Map<string, number> = new Map(),
): { time: string; seconds: number } | null {
  const cars = (json as PitStopsJson)?.pit_stop_analysis;
  if (!Array.isArray(cars)) return null;
  const secs: number[] = [];
  for (const car of cars) {
    const stops = (car.pit_stops ?? [])
      .map((stop) => imsaTimeSeconds((stop.pit_time ?? "").trim() || "-"))
      .filter((x): x is number => x != null)
      .sort((a, b) => a - b);
    const skip = driveThroughs.get(carKey(String(car.number ?? ""))) ?? 0;
    for (const sec of stops.slice(skip)) {
      if (sec >= MIN_PIT_SECONDS) secs.push(sec);
    }
  }
  if (!secs.length) return null;
  secs.sort((a, b) => a - b);
  const mid = secs.length % 2
    ? secs[(secs.length - 1) / 2]
    : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2;
  const rounded = Math.round(mid * 10) / 10;
  return { time: medianLabel(rounded), seconds: rounded };
}

/// Минимальный pit_time по всем машинам. У машин с drive-through отбрасываем
/// столько их кратчайших проездов, сколько наказаний выписано; порог —
/// страховка от совсем коротких артефактов.
export function imsaFastestPitStop(
  json: unknown,
  driveThroughs: Map<string, number> = new Map(),
): Highlight | null {
  const cars = (json as PitStopsJson)?.pit_stop_analysis;
  if (!Array.isArray(cars)) return null;
  let best: Highlight | null = null;
  for (const car of cars) {
    const stops = (car.pit_stops ?? [])
      .map((stop) => {
        const raw = (stop.pit_time ?? "").trim();
        const seconds = raw ? imsaTimeSeconds(raw) : null;
        return seconds == null ? null : { stop, raw, seconds };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => a.seconds - b.seconds);
    const skip = driveThroughs.get(carKey(String(car.number ?? ""))) ?? 0;
    for (const { stop, raw, seconds } of stops.slice(skip)) {
      if (seconds < MIN_PIT_SECONDS) continue;
      if (!best || seconds < best.seconds) {
        best = {
          time: raw,
          seconds,
          driver: imsaShortDriver(stop.in_driver_firstname, stop.in_driver_surname),
          ...(car.number ? { car: String(car.number).trim() } : {}),
          ...(car.team ? { team: car.team.trim() } : {}),
          ...(car.class ? { class: car.class.trim() } : {}),
        };
      }
    }
  }
  return best;
}

async function main(): Promise<void> {
  console.log(`IMSA weekend highlights, season ${YEAR}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const schedule = SCHEDULE[YEAR];
  if (!schedule) {
    console.log(`  нет курируемого расписания ${YEAR} — выходим`);
    return;
  }
  const season = `${YEAR % 100}_${YEAR}`;
  const seasonHTML = await fetchHTML([season]);
  if (!seasonHTML) {
    console.log("  сезон в архиве не найден — выходим");
    return;
  }
  const seasonFolders = folders(seasonHTML);

  for (const entry of schedule) {
    const endMs = Date.parse(`${entry.endDate}T23:59:59Z`);
    if (!(endMs < NOW)) continue; // хайлайты — только по прошедшим гонкам
    const path = join(OUT_DIR, `${YEAR}_${entry.round}.json`);
    if (existsSync(path) && isFrozen(endMs, NOW) && !process.env.IMSA_HL_FORCE) continue;

    const candidates = trackCandidates(seasonFolders, entry.venue);
    const best = candidates.length ? await bestTrackStage(season, candidates) : null;
    if (!best?.stage) {
      console.log(`  R${entry.round} (${entry.venue}): гонка в архиве не найдена — скип`);
      continue;
    }
    const resultsFile = pickImsaFile(best.stage.files, "03_Results", ".JSON");
    const pitsFile = pickImsaFile(best.stage.files, "Pit Stops Time Cards", ".JSON");
    const rcFile = pickImsaFile(best.stage.files, "FlagsAnalysisWithRCMessages", ".CSV");
    const resultsJson = resultsFile ? await fetchJSON([...best.stage.segments, resultsFile]) : null;
    const pitsJson = pitsFile ? await fetchJSON([...best.stage.segments, pitsFile]) : null;
    const rcCsv = rcFile ? await fetchHTML([...best.stage.segments, rcFile]) : null;
    const driveThroughs = rcCsv ? imsaDriveThroughCounts(rcCsv) : new Map<string, number>();
    const fastestLap = resultsJson ? imsaFastestLap(resultsJson) : null;
    const fastestPitStop = pitsJson ? imsaFastestPitStop(pitsJson, driveThroughs) : null;
    const medianPitStop = pitsJson ? imsaMedianPitStop(pitsJson, driveThroughs) : null;
    if (!fastestLap && !fastestPitStop) {
      console.log(`  R${entry.round}: данных нет — скип`);
      continue;
    }
    const out = {
      season: YEAR,
      round: entry.round,
      ...(fastestLap ? { fastestLap } : {}),
      ...(fastestPitStop ? { fastestPitStop } : {}),
      ...(medianPitStop ? { medianPitStop } : {}),
    };
    writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
    console.log(`  R${entry.round} (${entry.venue}): FL ${fastestLap?.time ?? "—"} ${fastestLap?.driver ?? ""}, пит ${fastestPitStop?.time ?? "—"}`);
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
