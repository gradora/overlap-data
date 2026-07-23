// Продьюсер «BEASTS OF THE SEASON» — сезонные лидерборды F1 для полки поиска:
//  • biggest comeback — прирост позиций (grid − финиш) по всем гонкам и
//    спринтам сезона, топ-3;
//  • fastest pit stop — минимум стационарного пита по data/f1/highlights, топ-3.
// Comeback тянет результаты по раундам из Jolpica (grid лежит прямо в Results),
// pit берёт из уже-зеркалированных highlights и доклеивает команду/код по
// фамилии из тех же результатов. Пишет data/f1/beasts/<season>.json.
// Freeze: сезон отстоялся (все раунды заморожены, файл на месте) — сеть не
// трогаем; переходное окно сезонов пропускаем.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "./freeze.js";
import { writeIfChanged } from "./mirror.js";
import { scheduleSeasonMismatch } from "./season.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const HIGHLIGHTS_DIR = join(process.cwd(), "data", "f1", "highlights");
const OUT_DIR = join(process.cwd(), "data", "f1", "beasts");
const NOW = Date.now();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

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

async function fetchJSON(url: string, attempt = 0): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (res.status === 429 && attempt < 3) {
      clearTimeout(t);
      await new Promise((r) => setTimeout(r, 30000 * (attempt + 1)));
      return fetchJSON(url, attempt + 1);
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function readHighlights(round: number): any | null {
  try {
    return JSON.parse(readFileSync(join(HIGHLIGHTS_DIR, `${YEAR}_${round}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  console.log(`F1 beasts, season ${YEAR}`);
  let races: { round: string; date: string; raceName: string; hasSprint: boolean }[] = [];
  let scheduleSeason: string | null = null;
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
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
  // история, сетевая фаза не нужна.
  const settled =
    races.length > 0 &&
    races.every((r) => isFrozen(Date.parse(`${r.date}T23:59:59Z`), NOW)) &&
    existsSync(out);
  if (settled) {
    console.log("beasts: сезон отстоялся — без сетевой фазы");
    return;
  }

  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const comebacks: (BeastRow & { gain: number })[] = [];
  const drivers = new Map<string, DriverInfo>();

  for (const r of done) {
    const round = Number(r.round);
    const race = await fetchJSON(`${JOLPICA}/${YEAR}/${round}/results.json`);
    const results = race?.MRData?.RaceTable?.Races?.[0]?.Results;
    if (Array.isArray(results)) {
      for (const [family, info] of driverMap(results)) drivers.set(family, info);
      for (const res of results) {
        const row = comebackRow(res, r.raceName);
        if (row) comebacks.push(row);
      }
    }
    await sleep(400);

    // Спринт — отдельный «тип» гонки: приросты позиций тоже считаем.
    if (r.hasSprint) {
      const sprint = await fetchJSON(`${JOLPICA}/${YEAR}/${round}/sprint.json`);
      const sResults = sprint?.MRData?.RaceTable?.Races?.[0]?.SprintResults;
      if (Array.isArray(sResults)) {
        for (const res of sResults) {
          const row = comebackRow(res, `${r.raceName} Sprint`);
          if (row) comebacks.push(row);
        }
      }
      await sleep(400);
    }
  }

  // Питы из локальных highlights, команда/код — по фамилии из результатов.
  const roundName = new Map(races.map((r) => [Number(r.round), r.raceName]));
  const pits: (BeastRow & { seconds: number })[] = [];
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
    });
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
  const changed = writeIfChanged(out, JSON.stringify(payload, null, 2) + "\n");
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
