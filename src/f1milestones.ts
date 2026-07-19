// Продьюсер «New achievement» (юбилейные GP пилотов, кратные 50) для баннера
// THIS WEEKEND — источник карьерная статистика Jolpica: total записей пилота
// (/drivers/<id>/results?limit=1 → MRData.total, включает прошедшие гонки
// текущего сезона). Прогноз стартов на раунд R: total − прошедшие_раунды + R
// (полное участие — как и анонсируют юбилеи). Файлы по раундам:
// data/f1/milestones/<season>_<round>.json. Замороженные раунды с файлом не
// перезаписываем (история).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "./freeze.js";
import { writeIfChanged } from "./mirror.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const OUT_DIR = join(process.cwd(), "data", "f1", "milestones");
const NOW = Date.now();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

export interface Achievement {
  driver: string;   // «F. Alonso»
  count: number;    // 350
}

export interface RoundMilestones {
  season: number;
  round: number;
  achievements: Achievement[];
}

/// Юбилей — каждый кратный 50 старт (50, 100, …, 350…).
export function milestoneCount(starts: number): number | null {
  return starts > 0 && starts % 50 === 0 ? starts : null;
}

/// «Fernando» + «Alonso» → «F. Alonso».
export function shortName(given: string, family: string): string {
  return given ? `${given[0]}. ${family}` : family;
}

/// Прогноз стартов пилота на раунд R сезона.
export function startsAtRound(totalNow: number, completedRounds: number, round: number): number {
  return totalNow - completedRounds + round;
}

async function fetchJSON(url: string): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  console.log(`F1 milestones, season ${YEAR}`);
  let races: { round: string; date: string }[] = [];
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
    races = d?.MRData?.RaceTable?.Races ?? [];
  } catch {
    console.warn("milestones: нет зеркала расписания — пропускаем");
    return;
  }
  const completedRounds = races.filter((r) => Date.parse(`${r.date}T23:59:59Z`) < NOW).length;

  const driversResp = await fetchJSON(`${JOLPICA}/${YEAR}/drivers.json?limit=40`);
  const drivers = driversResp?.MRData?.DriverTable?.Drivers ?? [];
  if (!drivers.length) {
    console.warn("milestones: пилоты сезона недоступны — пропускаем");
    return;
  }

  // Карьерные totals — по одному дешёвому запросу на пилота (limit=1).
  const totals = new Map<string, number>();
  for (const d of drivers) {
    const resp = await fetchJSON(`${JOLPICA}/drivers/${d.driverId}/results.json?limit=1`);
    const total = Number(resp?.MRData?.total ?? NaN);
    if (!Number.isNaN(total)) totals.set(d.driverId, total);
    await new Promise((res) => setTimeout(res, 300));   // вежливая пауза
  }
  console.log(`  totals: ${totals.size}/${drivers.length} пилотов, прошедших раундов: ${completedRounds}`);

  for (const r of races) {
    const round = Number(r.round);
    const path = join(OUT_DIR, `${YEAR}_${round}.json`);
    // Историю юбилеев прошедших этапов не переписываем.
    if (isFrozen(Date.parse(`${r.date}T23:59:59Z`), NOW) && existsSync(path)) continue;

    const achievements: Achievement[] = [];
    for (const d of drivers) {
      const total = totals.get(d.driverId);
      if (total == null) continue;
      const starts = startsAtRound(total, completedRounds, round);
      const count = milestoneCount(starts);
      if (count != null) achievements.push({ driver: shortName(d.givenName, d.familyName), count });
    }
    const out: RoundMilestones = { season: YEAR, round, achievements };
    const changed = writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
    if (achievements.length || changed) {
      console.log(`  R${round}: ${achievements.map((a) => `${a.count} GP ${a.driver}`).join(", ") || "нет"} → ${changed ? "записано" : "без изменений"}`);
    }
  }
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
