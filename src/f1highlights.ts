// Продьюсер «THIS WEEKEND» хайлайтов (быстрый круг уик-энда) — ЧИСТАЯ
// деривация из уже-зеркалированных файлов OpenF1 (сессии/протоколы/пилоты),
// ноль сетевых запросов. Пишет data/f1/highlights/<season>_<round>.json;
// приложение читает mirror-first и не зависит от живого OpenF1 (который
// 401-гейтится во время лайв-сессий и туго дышит в гоночный день).
// Замороженные раунды с существующим файлом не пересчитываем.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mirrorSlug, writeIfChanged } from "./mirror.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OPENF1_DIR = join(process.cwd(), "data", "f1", "openf1");
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const OUT_DIR = join(process.cwd(), "data", "f1", "highlights");
const NOW = Date.now();

export interface FastestLap {
  time: string;      // «1:44.361»
  seconds: number;
  driver: string;    // «K. Antonelli»
  tag: string;       // «FP1..FP3» | «Q» | «SQ»
}

export interface FastestPitStop {
  time: string;      // «2.3» (stop_duration OpenF1 — стационарное время)
  seconds: number;
  driver: string;    // «C. Leclerc»
  tag: string;       // «R» | «SPR»
}

export interface RoundHighlights {
  season: number;
  round: number;
  fastestLap?: FastestLap;
  fastestPitStop?: FastestPitStop;
}

function readMirror(relative: string): any | null {
  try {
    return JSON.parse(readFileSync(join(OPENF1_DIR, mirrorSlug(relative)), "utf8"));
  } catch {
    return null;
  }
}

// «Practice 1» → FP1, «Qualifying» → Q, «Sprint Qualifying/Shootout» → SQ;
// гонки/спринты (в протоколе дистанция, не круг) → null.
export function sessionTag(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes("practice")) {
    const d = n.match(/\d/)?.[0];
    return d ? `FP${d}` : "FP";
  }
  if (n.includes("sprint") && (n.includes("qual") || n.includes("shootout"))) return "SQ";
  if (n.includes("qualifying")) return "Q";
  return null;
}

// duration у OpenF1: число (практика) или массив [Q1,Q2,Q3] с null (квала).
export function bestSeconds(duration: unknown): number | null {
  const nums = (Array.isArray(duration) ? duration : [duration])
    .filter((x): x is number => typeof x === "number" && x > 0);
  return nums.length ? Math.min(...nums) : null;
}

export function formatLap(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

// «Kimi Antonelli» → «K. Antonelli».
export function shortDriver(first?: string, last?: string, fallback?: string): string {
  if (first && last) return `${first[0]}. ${last}`;
  return fallback ?? "";
}

// «Race» → R, «Sprint» → SPR; квалы/прочее — null (питстопы значимы в гонках).
export function raceTag(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes("qual") || n.includes("shootout")) return null;
  if (n.includes("sprint")) return "SPR";
  if (n.includes("race")) return "R";
  return null;
}

// Быстрейший питстоп уик-энда: минимум stop_duration (стационарное время
// OpenF1) по гоночным сессиям.
export function computeFastestPitStop(
  sessions: { session_key: number; session_name: string }[],
  pitBySession: Map<number, any[]>,
  drivers: any[],
): FastestPitStop | null {
  const byNumber = new Map<number, any>(drivers.map((d) => [d.driver_number, d]));
  let best: FastestPitStop | null = null;
  for (const s of sessions) {
    const tag = raceTag(s.session_name);
    if (!tag) continue;
    for (const row of pitBySession.get(s.session_key) ?? []) {
      const sec = row.stop_duration;
      if (typeof sec !== "number" || sec <= 0 || (best && sec >= best.seconds)) continue;
      const d = byNumber.get(row.driver_number);
      best = {
        time: String(sec),
        seconds: sec,
        driver: shortDriver(d?.first_name, d?.last_name, d?.broadcast_name),
        tag,
      };
    }
  }
  return best;
}

export function computeFastestLap(
  sessions: { session_key: number; session_name: string; date_end?: string }[],
  resultsBySession: Map<number, any[]>,
  drivers: any[],
): FastestLap | null {
  const byNumber = new Map<number, any>(drivers.map((d) => [d.driver_number, d]));
  let best: FastestLap | null = null;
  for (const s of sessions) {
    const tag = sessionTag(s.session_name);
    if (!tag) continue;
    for (const row of resultsBySession.get(s.session_key) ?? []) {
      const sec = bestSeconds(row.duration);
      if (sec == null || (best && sec >= best.seconds)) continue;
      const d = byNumber.get(row.driver_number);
      best = {
        time: formatLap(sec),
        seconds: sec,
        driver: shortDriver(d?.first_name, d?.last_name, d?.broadcast_name),
        tag,
      };
    }
  }
  return best;
}

// Митинг по дню гонки (порт matchMeeting из openf1.ts).
function matchMeeting(meetings: any[], raceDate: string): any | undefined {
  const dayStart = Date.parse(`${raceDate}T00:00:00Z`);
  const dayEnd = dayStart + 86400000;
  return meetings.find((m) => {
    const s = Date.parse(m.date_start);
    const e = Date.parse(m.date_end ?? m.date_start);
    if (Number.isNaN(s)) return String(m.date_start ?? "").startsWith(raceDate);
    return s < dayEnd && (Number.isNaN(e) ? s : e) > dayStart;
  });
}

async function main() {
  console.log(`F1 highlights, season ${YEAR}`);
  let races: { round: string; date: string }[] = [];
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
    races = (d?.MRData?.RaceTable?.Races ?? [])
      .filter((r: any) => r.date && Date.parse(r.date) < NOW);
  } catch {
    console.warn("highlights: нет зеркала расписания — пропускаем");
    return;
  }
  const meetings = readMirror(`meetings?year=${YEAR}`);
  if (!Array.isArray(meetings)) {
    console.warn("highlights: нет зеркала meetings — пропускаем");
    return;
  }
  // Деривация чисто офлайн (сеть не трогаем) → пересчитываем ВСЕ прошедшие
  // раунды каждый прогон: writeIfChanged держит git чистым, а обновление
  // формата/зеркала само доезжает до старых файлов.
  for (const r of races) {
    const round = Number(r.round);
    const path = join(OUT_DIR, `${YEAR}_${round}.json`);
    const meeting = matchMeeting(meetings, r.date);
    if (!meeting) continue;
    const sessions = readMirror(`sessions?meeting_key=${meeting.meeting_key}`);
    const drivers = readMirror(`drivers?meeting_key=${meeting.meeting_key}`);
    if (!Array.isArray(sessions) || !Array.isArray(drivers)) {
      console.log(`  R${round}: зеркала сессий/пилотов нет — пропускаем`);
      continue;
    }
    const results = new Map<number, any[]>();
    const pits = new Map<number, any[]>();
    for (const s of sessions) {
      const rows = readMirror(`session_result?session_key=${s.session_key}`);
      if (Array.isArray(rows)) results.set(s.session_key, rows);
      const pit = readMirror(`pit?session_key=${s.session_key}`);
      if (Array.isArray(pit)) pits.set(s.session_key, pit);
    }
    const lap = computeFastestLap(sessions, results, drivers);
    const stop = computeFastestPitStop(sessions, pits, drivers);
    const out: RoundHighlights = {
      season: YEAR,
      round,
      ...(lap ? { fastestLap: lap } : {}),
      ...(stop ? { fastestPitStop: stop } : {}),
    };
    const changed = writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
    console.log(
      `  R${round}: ${lap ? `${lap.time} ${lap.driver} (${lap.tag})` : "нет круга"}` +
      `${stop ? `, пит ${stop.time} ${stop.driver}` : ""} → ${changed ? "записано" : "без изменений"}`,
    );
  }
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
