// Продьюсер «победители прошлых лет» для блока Stats & Highlights — источник
// история побед на трассе из Jolpica (/circuits/<id>/results/1). Для каждого
// раунда текущего сезона пишет data/f1/winners/<season>_<round>.json: последние
// 5 победителей ДО текущего сезона + кумулятивные победы пилота на этой трассе
// («×N Overall»). История неизменна в течение сезона → файл пишется один раз
// (существует — пропускаем), крон-прогоны после бэкфилла бесплатны.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./mirror.js";
import { scheduleSeasonMismatch } from "./season.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const OUT_DIR = join(process.cwd(), "data", "f1", "winners");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

export interface PastWinner {
  year: number;
  code?: string;        // «PIA» (у старых сезонов может отсутствовать)
  name: string;         // «Oscar Piastri»
  constructor: string;  // «McLaren»
  winsHere: number;     // побед на этой трассе К ЭТОМУ году включительно
}

export interface RoundWinners {
  season: number;
  round: number;
  circuitId: string;
  winners: PastWinner[]; // свежие первыми, до 5, все годы < season
}

interface WinnerRow {
  season: number;
  driverId: string;
  code?: string;
  name: string;
  constructor: string;
}

// Полная история победителей трассы → последние 5 до `beforeYear` с
// кумулятивным счётом побед пилота на трассе.
export function buildWinners(rows: WinnerRow[], beforeYear: number): PastWinner[] {
  const sorted = [...rows].sort((a, b) => a.season - b.season);
  const tally = new Map<string, number>();
  const all: PastWinner[] = [];
  for (const r of sorted) {
    const n = (tally.get(r.driverId) ?? 0) + 1;
    tally.set(r.driverId, n);
    all.push({
      year: r.season,
      ...(r.code ? { code: r.code } : {}),
      name: r.name,
      constructor: r.constructor,
      winsHere: n,
    });
  }
  return all.filter((w) => w.year < beforeYear).slice(-5).reverse();
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

// Вся история побед на трассе (пагинация limit=100 — у самых старых трасс
// ~75 гонок, но на всякий случай докручиваем offset до total).
async function circuitWinners(circuitId: string): Promise<WinnerRow[] | null> {
  const rows: WinnerRow[] = [];
  let offset = 0;
  for (let page = 0; page < 5; page++) {
    const d = await fetchJSON(`${JOLPICA}/circuits/${circuitId}/results/1.json?limit=100&offset=${offset}`);
    const table = d?.MRData?.RaceTable;
    if (!table) return page === 0 ? null : rows;
    for (const race of table.Races ?? []) {
      const res = race.Results?.[0];
      if (!res) continue;
      rows.push({
        season: Number(race.season),
        driverId: res.Driver?.driverId ?? `${res.Driver?.givenName} ${res.Driver?.familyName}`,
        code: res.Driver?.code,
        name: `${res.Driver?.givenName ?? ""} ${res.Driver?.familyName ?? ""}`.trim(),
        constructor: res.Constructor?.name ?? "",
      });
    }
    offset += 100;
    if (offset >= Number(d.MRData.total ?? 0)) break;
  }
  return rows;
}

async function main() {
  console.log(`F1 past winners, season ${YEAR}`);
  let races: { round: string; raceName: string; Circuit?: { circuitId?: string } }[] = [];
  let scheduleSeason: string | null = null;
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
    const table = d?.MRData?.RaceTable;
    races = table?.Races ?? [];
    scheduleSeason = table?.season ?? null;
  } catch {
    console.warn("winners: нет зеркала расписания — пропускаем");
    return;
  }
  // Гонка флипов + write-once: файлы `${YEAR}_R` по календарю ЧУЖОГО сезона
  // никогда бы не пересобрались (existsSync-скип) — маппинг раунд→трасса
  // остался бы прошлогодним на весь сезон. Пропускаем до синхронизации.
  if (scheduleSeasonMismatch(scheduleSeason, YEAR)) {
    console.warn(
      `winners: зеркало расписания за сезон ${scheduleSeason}, YEAR=${YEAR} — переходное окно, пропускаем`,
    );
    return;
  }
  for (const r of races) {
    const round = Number(r.round);
    const circuitId = r.Circuit?.circuitId;
    if (!circuitId) continue;
    const path = join(OUT_DIR, `${YEAR}_${round}.json`);
    if (existsSync(path)) continue;   // история сезона неизменна — пишем один раз
    const rows = await circuitWinners(circuitId);
    if (!rows) {
      console.warn(`  R${round} (${circuitId}): Jolpica недоступна — пропускаем`);
      continue;
    }
    const out: RoundWinners = {
      season: YEAR,
      round,
      circuitId,
      winners: buildWinners(rows, YEAR),
    };
    writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
    console.log(`  R${round} (${circuitId}): ${out.winners.length} победителей`);
    await new Promise((res) => setTimeout(res, 300));   // вежливая пауза
  }
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
