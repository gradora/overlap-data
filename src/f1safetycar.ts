// Продьюсер статистики сейфти-каров по трассам — для F1 MILESTONES (About
// Race). Источник: OpenF1 race_control гоночных сессий, покрытие с 2023 года
// (раньше данных нет — статистика ЧЕСТНО ограничена эрой, sinceYear в файле).
// Митинги матчатся между сезонами по circuit_key. Все ответы кладутся в
// openf1-зеркало и читаются кэш-первым — после первого наполнения прогоны
// офлайн; свежая гонка текущего сезона доезжает через зеркало openf1.ts.
// Выход: data/f1/safetycar/<season>_<round>.json.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchText, mirrorSlug, writeIfChanged } from "./mirror.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const SINCE = 2023;                        // старт покрытия OpenF1
const OPENF1 = "https://api.openf1.org/v1";
const OPENF1_DIR = join(process.cwd(), "data", "f1", "openf1");
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const OUT_DIR = join(process.cwd(), "data", "f1", "safetycar");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CircuitSafetyCar {
  season: number;
  round: number;
  sinceYear: number;       // с какого года считаем (покрытие данных)
  races: number;           // проанализировано гонок на этой трассе
  withSafetyCar: number;   // из них с выездом SC (не VSC)
  firstYear?: number;      // первый год с SC в покрытии
}

/// В гонке был полноценный SC (VSC не считается).
export function raceHadSafetyCar(events: any[]): boolean {
  return events.some((e) =>
    e?.category === "SafetyCar" &&
    typeof e?.message === "string" &&
    e.message.toUpperCase().includes("SAFETY CAR") &&
    !e.message.toUpperCase().includes("VIRTUAL"),
  );
}

// Кэш-первый доступ к OpenF1: файл в зеркале есть — читаем локально (история
// неизменна), нет — тянем с паузой и кладём в зеркало.
async function cached(relative: string): Promise<any | null> {
  const path = join(OPENF1_DIR, mirrorSlug(relative));
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  }
  // 429 (гоночные вечера) — backoff-ретраи как у openf1.ts; недобранное
  // доедет следующими прогонами крона (кэш накапливается).
  for (let attempt = 0; attempt <= 3; attempt++) {
    await sleep(attempt === 0 ? 1500 : 8000 * attempt);
    const res = await fetchText(`${OPENF1}/${relative}`);
    if (res?.status === 200) {
      writeIfChanged(path, res.text);
      try { return JSON.parse(res.text); } catch { return null; }
    }
    if (res?.status !== 429) {
      console.log(`  MISS ${relative} (${res?.status ?? "net"})`);
      return null;
    }
  }
  console.log(`  MISS ${relative} (429 после ретраев)`);
  return null;
}

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
  console.log(`F1 safety car stats, since ${SINCE}`);
  let races: { round: string; date: string }[] = [];
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
    races = d?.MRData?.RaceTable?.Races ?? [];
  } catch {
    console.warn("safetycar: нет зеркала расписания — пропускаем");
    return;
  }
  const currentMeetings = await cached(`meetings?year=${YEAR}`);
  if (!Array.isArray(currentMeetings)) {
    console.warn("safetycar: meetings текущего сезона недоступны — пропускаем");
    return;
  }
  // Митинги прошлых сезонов эры — по разу на прогон.
  const meetingsByYear = new Map<number, any[]>([[YEAR, currentMeetings]]);
  for (let y = SINCE; y < YEAR; y++) {
    const m = await cached(`meetings?year=${y}`);
    if (Array.isArray(m)) meetingsByYear.set(y, m);
  }

  for (const r of races) {
    const round = Number(r.round);
    const meeting = matchMeeting(currentMeetings, r.date);
    if (!meeting?.circuit_key) continue;

    let analyzed = 0;
    let withSC = 0;
    let firstYear: number | undefined;
    for (let y = SINCE; y <= YEAR; y++) {
      const m = (meetingsByYear.get(y) ?? []).find((x) => x.circuit_key === meeting.circuit_key);
      if (!m) continue;
      const sessions = await cached(`sessions?meeting_key=${m.meeting_key}`);
      const race = (Array.isArray(sessions) ? sessions : []).find((s) => s.session_name === "Race");
      if (!race) continue;
      const feed = await cached(`race_control?session_key=${race.session_key}`);
      if (!Array.isArray(feed) || !feed.length) continue;   // гонка ещё не прошла / нет данных
      analyzed++;
      if (raceHadSafetyCar(feed)) {
        withSC++;
        if (firstYear == null || y < firstYear) firstYear = y;
      }
    }
    if (analyzed === 0) {
      console.log(`  R${round}: данных нет — не пишем`);
      continue;
    }
    const out: CircuitSafetyCar = {
      season: YEAR, round, sinceYear: SINCE,
      races: analyzed, withSafetyCar: withSC,
      ...(firstYear != null ? { firstYear } : {}),
    };
    const changed = writeIfChanged(join(OUT_DIR, `${YEAR}_${round}.json`),
                                   JSON.stringify(out, null, 2) + "\n");
    console.log(`  R${round}: SC ${withSC}/${analyzed}${firstYear ? ` (первый ${firstYear})` : ""} → ${changed ? "записано" : "без изменений"}`);
  }
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
