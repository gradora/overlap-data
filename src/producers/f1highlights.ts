// Продьюсер «THIS WEEKEND» хайлайтов (быстрый круг уик-энда) — ЧИСТАЯ
// деривация из уже-зеркалированных файлов OpenF1 (сессии/протоколы/пилоты),
// ноль сетевых запросов. Пишет data/f1/highlights/<season>_<round>.json;
// приложение читает mirror-first и не зависит от живого OpenF1 (который
// 401-гейтится во время лайв-сессий и туго дышит в гоночный день).
// Пересчитывает ВСЕ прошедшие раунды сезона каждый прогон (деривация дешёвая,
// writeIfChanged держит git чистым) — задним числом дозаполняются pit-данные.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mirrorSlug, scheduleMirrorFile, writeJSONWithEnvelope } from "../lib/mirror.js";
import { readSeasonPitstops, type EventPitstops } from "../lib/fompitstops.js";

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
  time: string;      // «2.3» — стационарное время (машина на домкратах)
  seconds: number;
  driver: string;    // «C. Leclerc»
  tag: string;       // «R» | «SPR»
}

export interface MedianPitStop {
  time: string;      // «2.4» — медиана стационарных стопов гонки
  seconds: number;
  /// Признак неполноты: сколько стопов гонки ИЗМЕРЕНО из скольких ИЗВЕСТНО.
  /// Без него метрика молча врёт — PitStopSeries теряет стопы (Венгрия 34 из
  /// 46, Монако 29 из 70), и медиана по измеренным смещается. У фолбэка
  /// openf1 сравнивать не с чем — там известны ровно измеренные, covered==total.
  covered?: number;
  total?: number;
}

/// Стоп уик-энда в форме, общей для ОБОИХ источников: наш факт f1/pitstops и
/// pit-факт openf1 сводятся сюда, дальше метрики их не различают.
export interface WeekendStop {
  car: number;               // driver_number
  seconds: number | null;    // стационарное; null — визит известен, времени нет
  tag: string;               // «R» | «SPR»
}

export interface RoundHighlights {
  season: number;
  round: number;
  /// Лучший круг УИК-ЭНДА: практики, квала, спринт-квала. Гонка и спринт
  /// исключены намеренно (в их протоколе дистанция, а не круг) — то есть это
  /// НЕ «быстрый круг» в гоночном смысле. Имя историческое; смысл — в теге.
  fastestLap?: FastestLap;
  /// Быстрый круг ГОНКИ — та самая классическая величина, которую на экране
  /// команды считает «Fastest laps». Источник — jolpica (FastestLap с рангом
  /// 1 в протоколе), а не OpenF1: в session_result гонки лежит дистанция.
  fastestLapRace?: FastestLap;
  fastestPitStop?: FastestPitStop;
  medianPitStop?: MedianPitStop;
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

// «1:14.119» / «58.921» → секунды. Обратная к formatLap; отдельная, потому
// что jolpica отдаёт время строкой, а OpenF1 — числом.
export function lapSeconds(time: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/.exec(time.trim());
  if (!m) return null;
  const secs = Number(m[1] ?? 0) * 60 + Number(m[2]);
  return Number.isFinite(secs) && secs > 0 ? secs : null;
}

// Быстрый круг ГОНКИ из протокола jolpica: у каждого пилота свой лучший круг
// с рангом, ранг 1 — быстрейший в гонке. Считаем по рангу, а не минимумом по
// времени: ранг проставляет источник, и он же решает спорные случаи (круг,
// не засчитанный из-за нарушения лимитов трассы, ранга не получает).
export function computeRaceFastestLap(raceResults: any): FastestLap | null {
  const rows = raceResults?.MRData?.RaceTable?.Races?.[0]?.Results;
  if (!Array.isArray(rows)) return null;
  const best = rows.find((r: any) => String(r?.FastestLap?.rank) === "1");
  const time = best?.FastestLap?.Time?.time;
  if (typeof time !== "string") return null;
  const secs = lapSeconds(time);
  if (secs == null) return null;
  return {
    time,
    seconds: secs,
    driver: shortDriver(best.Driver?.givenName, best.Driver?.familyName, best.Driver?.code),
    tag: "R",
  };
}

// «Race» → R, «Sprint» → SPR; квалы/прочее — null (питстопы значимы в гонках).
export function raceTag(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes("qual") || n.includes("shootout")) return null;
  if (n.includes("sprint")) return "SPR";
  if (n.includes("race")) return "R";
  return null;
}

/// Стопы уик-энда из pit-фактов OpenF1 — ФОЛБЭК канала. Живой до 2025-го
/// включительно и для двух спринтов 2025, где статика FOM отдаёт 403; с
/// Канады-2026 источник ломается вразнобой и `stop_duration` приходит null у
/// всех строк сессии (10 сессий сезона), поэтому основным он быть перестал.
export function openf1Stops(
  sessions: { session_key: number; session_name: string }[],
  pitBySession: Map<number, any[]>,
): WeekendStop[] {
  const out: WeekendStop[] = [];
  for (const s of sessions) {
    const tag = raceTag(s.session_name);
    if (!tag) continue;
    for (const row of pitBySession.get(s.session_key) ?? []) {
      const sec = row?.stop_duration;
      // Строка без времени в этом источнике не факт визита, а пустая ячейка:
      // круга и пит-лейна у неё тоже нет, знать о ней нечего.
      if (typeof sec !== "number" || sec <= 0) continue;
      out.push({ car: Number(row?.driver_number), seconds: sec, tag });
    }
  }
  return out;
}

/// Стопы уик-энда из НАШЕГО факта f1/pitstops — первый приоритет. Визиты без
/// стационарного времени едут сюда с `seconds: null`: «быстрейший» их
/// игнорирует, медиана считает по ним свою полноту.
export function pitstopsFactStops(doc: EventPitstops | null): WeekendStop[] {
  if (!doc) return [];
  return doc.sessions.flatMap((s) =>
    s.stops.map((x) => ({ car: x.car, seconds: x.stationarySec, tag: s.tag })));
}

/// Строки С ИЗМЕРЕНИЕМ. Каскад источников гейтуется по ним, а не по длине
/// списка: факт, где ВСЕ визиты пришли только из PitLaneTimeCollection
/// (stationarySec:null у каждого), непуст — но бесполезен, и фолбэк openf1
/// обязан включиться. Это не гипотеза, а состояние архива: PitStopSeries
/// родился на US GP 2024, до него 403 при живом PitLaneTimeCollection.
const measuredStops = (rows: WeekendStop[]): WeekendStop[] =>
  rows.filter((r) => typeof r.seconds === "number" && r.seconds > 0);

/// Быстрейший питстоп уик-энда: минимум стационарного времени по гоночным
/// сессиям. `preferred` непуст — считаем по нему, иначе по фолбэку openf1:
/// порядок источников живёт ЗДЕСЬ, одной строкой, а не размазан по вызовам.
export function computeFastestPitStop(
  sessions: { session_key: number; session_name: string }[],
  pitBySession: Map<number, any[]>,
  drivers: any[],
  preferred: WeekendStop[] = [],
): FastestPitStop | null {
  const rows = measuredStops(preferred).length
    ? preferred : openf1Stops(sessions, pitBySession);
  const byNumber = new Map<number, any>(drivers.map((d) => [d.driver_number, d]));
  let best: FastestPitStop | null = null;
  for (const row of rows) {
    const sec = row.seconds;
    if (typeof sec !== "number" || sec <= 0 || (best && sec >= best.seconds)) continue;
    const d = byNumber.get(row.car);
    best = {
      time: String(sec),
      seconds: sec,
      driver: shortDriver(d?.first_name, d?.last_name, d?.broadcast_name),
      tag: row.tag,
    };
  }
  return best;
}

/// Медиана всех стационарных стопов ГЛАВНОЙ гонки (не спринта): один
/// быстрый стоп бывает удачей, медиана — качество работы бригад уик-энда.
///
/// Источники в том же порядке, что у быстрейшего. Отличие одно и оно важное:
/// медиана обязана НЕСТИ СВОЮ ПОЛНОТУ. Из нашего факта известно, сколько
/// стопов гонки источник потерял (визит есть, стационарного нет), и молчать об
/// этом нельзя — на Монако измерено 29 стопов из 70, и «медиана гонки» по ним
/// это медиана удачно записанной трети.
export function computeMedianPitStop(
  sessions: { session_key: number; session_name: string }[],
  pitBySession: Map<number, any[]>,
  preferred: WeekendStop[] = [],
): MedianPitStop | null {
  // Гейт — по измеренным стопам ГОНКИ (тот же принцип, что у быстрейшего, но
  // фильтр по tag обязан идти ПЕРВЫМ: измерения спринта про полноту гонки
  // ничего не говорят).
  let rows: WeekendStop[];
  const preferredRace = preferred.filter((r) => r.tag === "R");
  if (measuredStops(preferredRace).length) {
    rows = preferredRace;
  } else {
    const race = sessions.find((s) => raceTag(s.session_name) === "R");
    if (!race) return null;
    rows = openf1Stops([race], pitBySession);
  }
  const secs = rows
    .map((r) => r.seconds)
    .filter((x): x is number => typeof x === "number" && x > 0)
    .sort((a, b) => a - b);
  if (!secs.length) return null;
  const mid = secs.length % 2
    ? secs[(secs.length - 1) / 2]
    : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2;
  const rounded = Math.round(mid * 10) / 10;
  return { time: rounded.toFixed(1), seconds: rounded, covered: secs.length, total: rows.length };
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
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, scheduleMirrorFile(YEAR)), "utf8"));
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
  // Питстопы: ПЕРВЫЙ приоритет — наш факт f1/pitstops (статика FOM, задача
  // 3a), openf1 остаётся фолбэком. Карта строится один раз на прогон: внутри
  // резолв «раунд → eventKey» по витрине календаря, и повторять его на каждом
  // раунде значило бы перечитывать календарь два десятка раз.
  const factByRound = readSeasonPitstops(join(process.cwd(), "data"), YEAR);
  if (factByRound.size) console.log(`  факт питстопов: раундов ${factByRound.size}`);

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
    // Протокол гонки — из зеркала jolpica; нет его (гонка ещё не
    // классифицирована) — поля просто не будет.
    let raceResults: any = null;
    try {
      raceResults = JSON.parse(
        readFileSync(join(JOLPICA_DIR, `${YEAR}_${round}_results.json`), "utf8"));
    } catch { /* протокола нет — не беда */ }
    const raceLap = raceResults ? computeRaceFastestLap(raceResults) : null;
    const preferred = pitstopsFactStops(factByRound.get(round) ?? null);
    const stop = computeFastestPitStop(sessions, pits, drivers, preferred);
    const median = computeMedianPitStop(sessions, pits, preferred);
    const out: RoundHighlights = {
      season: YEAR,
      round,
      ...(lap ? { fastestLap: lap } : {}),
      ...(raceLap ? { fastestLapRace: raceLap } : {}),
      ...(stop ? { fastestPitStop: stop } : {}),
      ...(median ? { medianPitStop: median } : {}),
    };
    const changed = writeJSONWithEnvelope(path, out);
    console.log(
      `  R${round}: ${lap ? `${lap.time} ${lap.driver} (${lap.tag})` : "нет круга"}` +
      `${raceLap ? `, гонка ${raceLap.time} ${raceLap.driver}` : ""}` +
      `${stop ? `, пит ${stop.time} ${stop.driver} [${preferred.length ? "f1/pitstops" : "openf1"}]` : ""}` +
      `${median ? `, медиана ${median.time} (${median.covered}/${median.total})` : ""}` +
      ` → ${changed ? "записано" : "без изменений"}`,
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
