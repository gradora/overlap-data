// Продьюсер хайлайтов гонки WEC (THIS WEEKEND) — источник полап-овый
// Analysis CSV финального часа гонки из Results-архива Al Kamel: лучший круг
// гонки (LAP_TIME + DRIVER_NAME) и лучший пит-стоп (PIT_TIME; порог отсекает
// drive-through и проезды). Выход: data/wec/highlights/<season>_<round>.json.
// Пересборка до заморозки этапа (7 дней после финиша), потом файл вечен.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./mirror.js";
import { isFrozen } from "./freeze.js";
import {
  akEventHrefs, akSeasonContext, akTimeSeconds, ALKAMEL_WEC,
  fetchAkText, parseAkCsv, pickRaceCsv,
} from "./alkamelwec.js";
import { eventInfo } from "./wec.js";
import { crewSurnames } from "./wecwinners.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT_DIR = join(process.cwd(), "data", "wec", "highlights");
const MIRROR_DIR = join(process.cwd(), "data", "wec", "fiawec");
const NOW = Date.now();

// Реальные пит-стопы WEC (заправка+резина+смена пилота) длятся ~50–90 секунд;
// всё, что короче порога, — drive-through или проезд без работы, «лучшим
// питом» его называть нечестно.
const MIN_PIT_SECONDS = 35;

export interface WecHighlight {
  time: string;
  seconds: number;
  driver: string;   // «K. MAGNUSSEN»
  car: string;      // номер машины как в протоколе («007» сохраняем)
  team?: string;
  class?: string;
}

export interface WecRoundHighlights {
  season: number;
  round: number;
  fastestLap?: WecHighlight;
  fastestPitStop?: WecHighlight;
  /// Медиана пит-проездов гонки (без drive-through — порог MIN_PIT_SECONDS).
  medianPitStop?: { time: string; seconds: number };
  /// Нейтрализации гонки: периоды FCY/SF по флагу на финишной линии
  /// референс-машины (максимум кругов) + суммарное время под жёлтыми.
  cautions?: { fcy: number; seconds: number };
  /// Победители классов гонки — из финальной Classification (fiawec-страница
  /// отдаёт только головной класс, полная таблица живёт в архиве Al Kamel).
  classWinners?: WecClassWinner[];
}

export interface WecClassWinner {
  class: string;   // «HYPERCAR» / «LMGT3»
  car: string;
  team: string;
  crew: string;    // фамилии через « / »
}

/// «Kevin MAGNUSSEN» → «K. MAGNUSSEN» (фамилия у Al Kamel капсом).
export function shortDriver(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full.trim();
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

/// Лучший круг и лучший пит из строк Analysis CSV.
export function raceHighlights(
  rows: Record<string, string>[],
  season: number,
  round: number,
): WecRoundHighlights {
  let lap: WecHighlight | undefined;
  let pit: WecHighlight | undefined;
  for (const r of rows) {
    const lapSec = akTimeSeconds(r.LAP_TIME ?? "");
    if (lapSec != null && lapSec > 0 && (!lap || lapSec < lap.seconds)) {
      lap = {
        time: r.LAP_TIME.trim(), seconds: lapSec,
        driver: shortDriver(r.DRIVER_NAME ?? ""), car: r.NUMBER ?? "",
        ...(r.TEAM ? { team: r.TEAM } : {}),
        ...(r.CLASS ? { class: r.CLASS } : {}),
      };
    }
    const pitSec = akTimeSeconds(r.PIT_TIME ?? "");
    if (pitSec != null && pitSec >= MIN_PIT_SECONDS && (!pit || pitSec < pit.seconds)) {
      pit = {
        time: r.PIT_TIME.trim(), seconds: pitSec,
        driver: shortDriver(r.DRIVER_NAME ?? ""), car: r.NUMBER ?? "",
        ...(r.TEAM ? { team: r.TEAM } : {}),
        ...(r.CLASS ? { class: r.CLASS } : {}),
      };
    }
  }
  const pitSecs = rows
    .map((r) => akTimeSeconds(r.PIT_TIME ?? ""))
    .filter((x): x is number => x != null && x >= MIN_PIT_SECONDS)
    .sort((a, b) => a - b);
  let median: { time: string; seconds: number } | undefined;
  if (pitSecs.length) {
    const mid = pitSecs.length % 2
      ? pitSecs[(pitSecs.length - 1) / 2]
      : (pitSecs[pitSecs.length / 2 - 1] + pitSecs[pitSecs.length / 2]) / 2;
    const rounded = Math.round(mid * 10) / 10;
    median = { time: medianLabel(rounded), seconds: rounded };
  }

  const cautions = raceCautions(rows);

  return {
    season, round,
    ...(lap ? { fastestLap: lap } : {}),
    ...(pit ? { fastestPitStop: pit } : {}),
    ...(median ? { medianPitStop: median } : {}),
    ...(cautions ? { cautions } : {}),
  };
}

/// Периоды нейтрализации из полап-ового Analysis: круги референс-машины
/// (у неё больше всех кругов — лидер) с FLAG_AT_FL ∈ {FCY, SF}; подряд идущие
/// жёлтые круги = один период, время — сумма их LAP_TIME.
/// «78.4» → «1:18.4»: медиана эндуранс-пита бывает за минуту.
function medianLabel(seconds: number): string {
  if (seconds < 60) return seconds.toFixed(1);
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function raceCautions(
  rows: Record<string, string>[],
): { fcy: number; seconds: number } | null {
  const byCar = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const n = (r.NUMBER ?? "").trim();
    if (!n) continue;
    const list = byCar.get(n) ?? [];
    list.push(r);
    byCar.set(n, list);
  }
  let ref: Record<string, string>[] | null = null;
  for (const list of byCar.values()) {
    if (!ref || list.length > ref.length) ref = list;
  }
  if (!ref) return null;
  let periods = 0;
  let seconds = 0;
  let inYellow = false;
  for (const r of ref) {
    const flag = (r.FLAG_AT_FL ?? "").trim().toUpperCase();
    const yellow = flag === "FCY" || flag === "SF";
    if (yellow) {
      if (!inYellow) periods++;
      seconds += akTimeSeconds(r.LAP_TIME ?? "") ?? 0;
    }
    inYellow = yellow;
  }
  if (!periods) return null;
  return { fcy: periods, seconds: Math.round(seconds) };
}

/// Победители классов из строк финальной Classification: минимальная сквозная
/// POSITION в каждом CLASS.
export function classWinnersFromClassification(rows: Record<string, string>[]): WecClassWinner[] {
  const best = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const cls = (r.CLASS ?? "").trim();
    const pos = Number((r.POSITION ?? "").trim());
    if (!cls || !Number.isFinite(pos) || pos <= 0) continue;
    const prev = best.get(cls);
    if (!prev || pos < Number(prev.POSITION)) best.set(cls, r);
  }
  return [...best.entries()]
    .sort((a, b) => Number(a[1].POSITION) - Number(b[1].POSITION))
    .map(([cls, r]) => ({
      class: cls,
      car: (r.NUMBER ?? "").trim(),
      team: (r.TEAM ?? "").trim(),
      crew: crewSurnames(r),
    }));
}

function raceMirror(slug: string): string | null {
  const key = `en_race_${slug.replace(/[^a-z0-9.]+/gi, "_")}`;
  try {
    return readFileSync(join(MIRROR_DIR, key), "utf8");
  } catch {
    return null;
  }
}

async function main() {
  console.log(`WEC highlights, season ${YEAR}`);
  const ctx = await akSeasonContext(YEAR);
  if (!ctx) return;

  for (const ev of ctx.events) {
    const path = join(OUT_DIR, `${YEAR}_${ev.round}.json`);
    const page = raceMirror(ev.slug);
    const dates = page ? eventInfo(page) : { startMs: null, endMs: null, iso2: null };
    const raced = dates.endMs != null && dates.endMs < NOW;
    if (!raced) continue; // гонки ещё не было — хайлайтить нечего
    if (existsSync(path) && isFrozen(dates.endMs, NOW) && process.env.WEC_HL_FORCE !== "1") continue;

    const hrefs = await akEventHrefs(ctx.seasonValue, ev.value);
    const csvHref = pickRaceCsv(hrefs, "Analysis");
    if (!csvHref) {
      console.warn(`  R${ev.round} (${ev.label}): Analysis гонки не найден`);
      continue;
    }
    const csv = await fetchAkText(`${ALKAMEL_WEC}/${csvHref}`, 60000);
    if (!csv) {
      console.warn(`  R${ev.round}: CSV недоступен`);
      continue;
    }
    const out = raceHighlights(parseAkCsv(csv), YEAR, ev.round);
    const clsHref = pickRaceCsv(hrefs, "Classification");
    const clsCsv = clsHref ? await fetchAkText(`${ALKAMEL_WEC}/${clsHref}`, 60000) : null;
    const classWinners = clsCsv ? classWinnersFromClassification(parseAkCsv(clsCsv)) : [];
    if (classWinners.length > 1) out.classWinners = classWinners;
    const changed = writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
    console.log(
      `  R${ev.round} (${ev.label}): круг ${out.fastestLap?.time ?? "—"} ${out.fastestLap?.driver ?? ""}, ` +
      `пит ${out.fastestPitStop?.time ?? "—"} → ${changed ? "записано" : "без изменений"}`,
    );
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
