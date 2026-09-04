// Продьюсер «BEASTS OF THE SEASON» — сезонные лидерборды F1 для полки поиска:
//  • biggest comeback — прирост позиций (grid − финиш) по всем гонкам и
//    спринтам сезона, топ-3;
//  • fastest pit stop — минимум стационарного пита по data/f1/highlights,
//    топ-3; раунды, где openf1 не отдал stop_duration, закрывает фолбэк
//    наград DHL (data/f1/pitawards, ручной продьюсер f1pitawards).
// Comeback считается из ЗЕРКАЛА Jolpica, которое тем же прогоном пишет f1.ts:
// пер-раундовые слайсы <y>/<r>/results.json (writeRoundResultSlices) и
// пагинация <y>/sprint.json (год-именованные копии current-алиасов) — grid
// лежит прямо в Results. Сеть — только честный фолбэк при дыре в зеркале.
// Pit берёт из уже-зеркалированных highlights и доклеивает команду/код по
// фамилии из тех же результатов. Пишет data/f1/beasts/<season>.json.
// Freeze: сезон отстоялся (все раунды заморожены, файл на месте) — файл не
// пересобираем; переходное окно сезонов пропускаем.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "../lib/freeze.js";
import { mirrorSlug, writeJSONWithEnvelope } from "../lib/mirror.js";
import {
  matchAwardRound, awardTeamId, readPitAwards,
  type AwardCalendarEvent, type PitAwardRow,
} from "../lib/pitawards.js";
import { scheduleSeasonMismatch } from "../lib/season.js";
import { fetchJSON as httpJSON } from "../lib/http.js";
import { JOLPICA } from "../lib/sources.js";

const fetchJSON = (url: string) => httpJSON(url, { backoffMs: 30000 });

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const HIGHLIGHTS_DIR = join(process.cwd(), "data", "f1", "highlights");
const OUT_DIR = join(process.cwd(), "data", "f1", "beasts");
const NOW = Date.now();

export interface BeastRow {
  value: string;    // «P21 → P6» | «2.3»
  detail?: string;  // «15» — прирост позиций (только comeback)
  event: string;    // «Belgian Grand Prix»
  code: string;     // «HAD»
  team: string;     // «Red Bull»
  teamId: string;   // «red_bull» — цвет полоски в приложении
}

export interface SeasonBeasts {
  season: number;
  comebacks: BeastRow[];
  pits: BeastRow[];
}

interface DriverInfo {
  code: string;
  team: string;
  teamId: string;
}

/// Один результат гонки → строка камбэка, если пилот стартовал (grid ≥ 1) и
/// доехал до классифицированной позиции (числовой финиш) с приростом позиций.
export function comebackRow(result: any, event: string): (BeastRow & { gain: number }) | null {
  const grid = Number(result?.grid);
  const finish = Number(result?.position);
  if (!Number.isFinite(grid) || grid < 1) return null;
  if (!Number.isFinite(finish) || finish < 1) return null;
  const gain = grid - finish;
  if (gain <= 0) return null;   // назад или на месте — не камбэк
  return {
    value: `P${grid} → P${finish}`,
    detail: String(gain),
    event,
    code: driverCode(result?.Driver),
    team: result?.Constructor?.name ?? "",
    teamId: result?.Constructor?.constructorId ?? "",
    gain,
  };
}

/// «VER» из code, иначе первые три буквы фамилии капсом.
export function driverCode(driver: any): string {
  const code = driver?.code;
  if (typeof code === "string" && code.length >= 2) return code.toUpperCase();
  const family = String(driver?.familyName ?? "");
  return family.slice(0, 3).toUpperCase();
}

/// Карта «leclerc» → {code, team, teamId} из результатов гонки (для доклейки
/// команды к питу, где источник знает только «C. Leclerc»).
export function driverMap(results: any[]): Map<string, DriverInfo> {
  const map = new Map<string, DriverInfo>();
  for (const r of results) {
    const family = String(r?.Driver?.familyName ?? "").toLowerCase();
    if (!family || map.has(family)) continue;
    map.set(family, {
      code: driverCode(r?.Driver),
      team: r?.Constructor?.name ?? "",
      teamId: r?.Constructor?.constructorId ?? "",
    });
  }
  return map;
}

/// «C. Leclerc» → «leclerc» (фамилия последним словом), для матчинга по карте.
export function familyKey(shortName: string): string {
  const parts = shortName.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}


/// Спринт-результаты по раундам из страниц зеркальной пагинации sprint.
/// Строки одного раунда могут быть разрезаны лимитом посреди гонки (та же
/// причина, по которой f1.ts клеит writeRoundResultSlices) — поэтому
/// SprintResults склеиваются по round, а не берутся с первой попавшейся
/// страницы.
export function sprintResultsByRound(pages: any[]): Map<number, any[]> {
  const byRound = new Map<number, any[]>();
  for (const page of pages) {
    for (const race of page?.MRData?.RaceTable?.Races ?? []) {
      const round = Number(race?.round);
      if (!Number.isFinite(round)) continue;
      const bucket = byRound.get(round) ?? [];
      bucket.push(...(race?.SprintResults ?? []));
      byRound.set(round, bucket);
    }
  }
  return byRound;
}

/// Строки pit-фолбэка из наград DHL: только сыгранные раунды и только НЕ
/// закрытые openf1. Награда командная — пилота нет, code пустой (клиент
/// показывает команду на его месте). Несматченный ярлык — предупреждение и
/// пропуск: неверный раунд молча задвоил бы этап в лидерборде.
export function awardPitRows(
  awards: PitAwardRow[],
  events: AwardCalendarEvent[],
  doneRounds: Set<number>,
  coveredRounds: Set<number>,
  roundName: Map<number, string>,
  constructors: { name: string; id: string }[],
): (BeastRow & { seconds: number; round: number })[] {
  const out: (BeastRow & { seconds: number; round: number })[] = [];
  for (const a of awards) {
    if (typeof a?.seconds !== "number") continue;
    const round = matchAwardRound(a.event, events);
    if (round == null) {
      console.warn(`::warning::beasts: этап награды «${a.event}» не сматчился с календарём — пропуск`);
      continue;
    }
    if (!doneRounds.has(round) || coveredRounds.has(round)) continue;
    out.push({
      value: a.seconds.toFixed(3),
      event: roundName.get(round) ?? a.event,
      code: "",
      team: a.team,
      teamId: awardTeamId(a.team, constructors),
      seconds: a.seconds,
      round,
    });
  }
  return out;
}

function readHighlights(round: number): any | null {
  try {
    return JSON.parse(readFileSync(join(HIGHLIGHTS_DIR, `${YEAR}_${round}.json`), "utf8"));
  } catch {
    return null;
  }
}

/// Файл зеркала Jolpica по относительному пути (тот же слаг, что у f1.ts).
function readMirror(relative: string): any | null {
  try {
    return JSON.parse(readFileSync(join(JOLPICA_DIR, mirrorSlug(relative)), "utf8"));
  } catch {
    return null;
  }
}

/// Все страницы зеркальной пагинации <base>?limit=100&offset=N. null — дыра
/// в пагинации (нет и нулевой страницы либо оборвана середина): неполный
/// список молча терял бы камбэки, поэтому вызывающий уходит в сетевой фолбэк.
function readMirrorPages(base: string): any[] | null {
  const pages: any[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = readMirror(`${base}?limit=100&offset=${offset}`);
    if (page == null) return null;
    pages.push(page);
    const total = Number(page?.MRData?.total ?? 0);
    if (offset + 100 >= total) return pages;
  }
}

async function main() {
  console.log(`F1 beasts, season ${YEAR}`);
  let races: { round: string; date: string; raceName: string; hasSprint: boolean }[] = [];
  let scheduleSeason: string | null = null;
  try {
    // Исторический сезон лежит под своим именем: current.json — алиас ТЕКУЩЕГО
    // (у f1.ts та же развилка, historicSeason). Без неё SEASON=<прошлый год>
    // читал расписание текущего и глох на scheduleSeasonMismatch.
    const scheduleFile = YEAR < new Date().getUTCFullYear() ? `${YEAR}.json` : "current.json";
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, scheduleFile), "utf8"));
    const table = d?.MRData?.RaceTable;
    scheduleSeason = table?.season ?? null;
    races = (table?.Races ?? []).map((r: any) => ({
      round: r.round,
      date: r.date,
      raceName: r.raceName,
      hasSprint: r.Sprint != null,
    }));
  } catch {
    console.warn("beasts: нет зеркала расписания — пропускаем");
    return;
  }
  if (scheduleSeasonMismatch(scheduleSeason, YEAR)) {
    console.warn(`beasts: расписание за ${scheduleSeason}, YEAR=${YEAR} — переходное окно, пропускаем`);
    return;
  }

  const out = join(OUT_DIR, `${YEAR}.json`);
  const done = races.filter((r) => Date.parse(`${r.date}T23:59:59Z`) < NOW);
  if (!done.length) {
    console.log("beasts: сезон ещё не начался — пропускаем");
    return;
  }
  // Сезон отстоялся (все раунды заморожены, файл на месте) — камбэки/питы уже
  // история, пересборка не нужна.
  const settled =
    races.length > 0 &&
    races.every((r) => isFrozen(Date.parse(`${r.date}T23:59:59Z`), NOW)) &&
    existsSync(out);
  if (settled) {
    console.log("beasts: сезон отстоялся — пересборка не нужна");
    return;
  }

  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const comebacks: (BeastRow & { gain: number })[] = [];
  const drivers = new Map<string, DriverInfo>();

  // Спринты сезона — из зеркальной пагинации одним чтением на весь прогон.
  // Дыра в пагинации = зеркало не писалось (бэкфилл не гонялся) — уходим в
  // сетевой фолбэк по раундам ниже.
  const sprintPages = readMirrorPages(`${YEAR}/sprint.json`);
  const sprintByRound = sprintPages ? sprintResultsByRound(sprintPages) : null;
  if (!sprintPages) {
    console.log("::warning::beasts: в зеркале нет пагинации спринтов — живые запросы по раундам");
  }
  let liveFetches = 0;

  for (const r of done) {
    const round = Number(r.round);
    // Пер-раундовый слайс зеркала. Промах — раунд ещё не долетел до зеркала
    // либо сезон не бэкфилился: честный фолбэк в сеть, чтобы не потерять
    // камбэки раунда до следующего прогона.
    let race = readMirror(`${YEAR}/${round}/results.json`);
    if (race == null) {
      console.log(`::warning::beasts: в зеркале нет results R${round} — живой запрос`);
      race = await fetchJSON(`${JOLPICA}/${YEAR}/${round}/results.json`);
      liveFetches++;
      await sleep(400);
    }
    const results = race?.MRData?.RaceTable?.Races?.[0]?.Results;
    if (Array.isArray(results)) {
      for (const [family, info] of driverMap(results)) drivers.set(family, info);
      for (const res of results) {
        const row = comebackRow(res, r.raceName);
        if (row) comebacks.push(row);
      }
    }

    // Спринт — отдельный «тип» гонки: приросты позиций тоже считаем. Раунда
    // нет в живой пагинации зеркала = jolpica ещё не опубликовал спринт, живой
    // запрос отдал бы ту же пустоту — не тратим.
    if (r.hasSprint) {
      let sResults = sprintByRound?.get(round);
      if (!sprintByRound) {
        const sprint = await fetchJSON(`${JOLPICA}/${YEAR}/${round}/sprint.json`);
        liveFetches++;
        await sleep(400);
        sResults = sprint?.MRData?.RaceTable?.Races?.[0]?.SprintResults;
      }
      if (Array.isArray(sResults)) {
        for (const res of sResults) {
          const row = comebackRow(res, `${r.raceName} Sprint`);
          if (row) comebacks.push(row);
        }
      }
    }
  }
  console.log(`  источник: зеркало, живых запросов ${liveFetches}`);

  // Питы из локальных highlights, команда/код — по фамилии из результатов.
  const roundName = new Map(races.map((r) => [Number(r.round), r.raceName]));
  const pits: (BeastRow & { seconds: number; round: number })[] = [];
  for (const r of done) {
    const round = Number(r.round);
    const pit = readHighlights(round)?.fastestPitStop;
    if (!pit || typeof pit.seconds !== "number") continue;
    const info = drivers.get(familyKey(String(pit.driver ?? "")));
    pits.push({
      // Формат до тысячных как в макете; stop_duration OpenF1 приходит до
      // десятых — недостающие разряды добиваются нулями.
      value: Number(pit.seconds).toFixed(3),
      event: roundName.get(round) ?? "",
      code: info?.code ?? familyKey(String(pit.driver ?? "")).slice(0, 3).toUpperCase(),
      team: info?.team ?? "",
      teamId: info?.teamId ?? "",
      seconds: pit.seconds,
      round,
    });
  }

  // Фолбэк: награды DHL (data/f1/pitawards, ручной продьюсер f1pitawards) —
  // для раундов, где openf1 не дал стационарного времени (с Венгрии-2026 их
  // пайплайн перестал его считать). Строго дырозакрыватель: раунды, закрытые
  // openf1, награды не трогают — при выздоровлении источника фолбэк сам
  // вытесняется его строками.
  const awards = readPitAwards(join(process.cwd(), "data"), YEAR)?.rows ?? [];
  if (awards.length) {
    let events: AwardCalendarEvent[] = [];
    try {
      const cal = JSON.parse(readFileSync(
        join(process.cwd(), "data", "f1", "calendar", `${YEAR}.json`), "utf8"));
      events = (cal?.events ?? []).filter((e: any) => e.kind === "race");
    } catch { /* витрины календаря нет — матчить не с чем, фолбэк молчит */ }
    const teams = [...new Map([...drivers.values()]
      .map((d) => [d.teamId, { name: d.team, id: d.teamId }] as const)).values()]
      .filter((t) => t.id);
    const fallback = awardPitRows(awards, events,
      new Set(done.map((r) => Number(r.round))),
      new Set(pits.map((p) => p.round)), roundName, teams);
    if (fallback.length) {
      console.log(`  pit-фолбэк DHL: ${fallback.map((p) => `${p.event} ${p.value}`).join(", ")}`);
    }
    pits.push(...fallback);
  }

  const strip = (r: BeastRow): BeastRow =>
    r.detail != null
      ? { value: r.value, detail: r.detail, event: r.event, code: r.code, team: r.team, teamId: r.teamId }
      : { value: r.value, event: r.event, code: r.code, team: r.team, teamId: r.teamId };

  const topComebacks = comebacks
    .sort((a, b) => b.gain - a.gain || a.event.localeCompare(b.event))
    .slice(0, 3)
    .map(strip);
  const topPits = pits
    .sort((a, b) => a.seconds - b.seconds || a.event.localeCompare(b.event))
    .slice(0, 3)
    .map(strip);

  const payload: SeasonBeasts = { season: YEAR, comebacks: topComebacks, pits: topPits };
  const changed = writeJSONWithEnvelope(out, payload);
  console.log(
    `  comeback: ${topComebacks.map((c) => `${c.code} ${c.value}`).join(", ") || "нет"}`,
  );
  console.log(`  pit: ${topPits.map((p) => `${p.code} ${p.value}`).join(", ") || "нет"} → ${changed ? "записано" : "без изменений"}`);
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
