// Продьюсер «Day in history» — индекс всех гонок F1 1950..прошлый год по дням
// года (MM-DD) для полки лендинга поиска. Источник: Jolpica — расписание
// сезона ({year}.json) + победители ({year}/results/1.json, фильтр «finished
// 1st» отдаёт P1 всех раундов одним запросом). Текущий сезон не включаем —
// он живёт в календаре приложения; прошлый год доезжает январским прогоном.
// Выход: data/f1/history/index.json — один файл, приложение ищет свой день.
// Write-once по сезонам: скачанные годы не перекачиваются.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchText, writeIfChanged } from "./mirror.js";

const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const OUT_PATH = join(process.cwd(), "data", "f1", "history", "index.json");
const FIRST_SEASON = 1950;
const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const PAUSE_MS = 1200; // jolpica rate limit — бэкфилл неспешный, но однократный

export interface HistoryRace {
  year: number;
  round: number;
  name: string;        // «British Grand Prix»
  circuit: string;     // circuitName
  country: string;
  winner?: string;     // фамилия победителя; нет данных — поля нет
  team?: string;       // конструктор победителя
}

export interface HistoryIndex {
  seasons: number[];                       // какие сезоны уже в индексе
  days: Record<string, HistoryRace[]>;     // «MM-DD» → гонки, свежие первыми
}

/// Вливает сезон в индекс: гонки раскладываются по MM-DD даты, победители
/// подтягиваются по номеру раунда. Внутри дня — сортировка год-убыванием.
export function mergeSeason(
  index: HistoryIndex,
  year: number,
  races: any[],
  winnersByRound: Map<number, { winner: string; team: string }>,
): void {
  for (const race of races) {
    const date = String(race?.date ?? "");
    const m = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
    if (!m) continue;
    const day = `${m[1]}-${m[2]}`;
    const round = Number(race.round);
    const win = winnersByRound.get(round);
    const entry: HistoryRace = {
      year,
      round,
      name: String(race.raceName ?? ""),
      circuit: String(race.Circuit?.circuitName ?? ""),
      country: String(race.Circuit?.Location?.country ?? ""),
      ...(win ? { winner: win.winner, team: win.team } : {}),
    };
    const list = index.days[day] ?? [];
    list.push(entry);
    list.sort((a, b) => b.year - a.year);
    index.days[day] = list;
  }
  if (!index.seasons.includes(year)) index.seasons.push(year);
  index.seasons.sort((a, b) => a - b);
}

/// P1-результаты сезона → карта раунд → {winner, team}.
export function winnersMap(races: any[]): Map<number, { winner: string; team: string }> {
  const map = new Map<number, { winner: string; team: string }>();
  for (const race of races) {
    const result = race?.Results?.[0];
    const family = result?.Driver?.familyName;
    if (!family) continue;
    map.set(Number(race.round), {
      winner: String(family),
      team: String(result?.Constructor?.name ?? ""),
    });
  }
  return map;
}

function readIndex(): HistoryIndex {
  try {
    const parsed = JSON.parse(readFileSync(OUT_PATH, "utf8")) as HistoryIndex;
    if (parsed?.days && Array.isArray(parsed.seasons)) return parsed;
  } catch { /* нет индекса — начинаем с нуля */ }
  return { seasons: [], days: {} };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/// 429 (rate limit Jolpica) — ждём минуту и пробуем ещё, до трёх раз.
async function fetchJSON(relative: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchText(`${JOLPICA}/${relative}`);
    if (res?.status === 429) {
      console.log(`  429 ${relative} — пауза 60с (попытка ${attempt + 1}/3)`);
      await sleep(60_000);
      continue;
    }
    if (!res || res.status !== 200) {
      console.log(`  MISS ${relative} (${res?.status ?? "net"})`);
      return null;
    }
    try {
      return JSON.parse(res.text);
    } catch {
      return null;
    }
  }
  console.log(`  MISS ${relative} (429 после ретраев)`);
  return null;
}

/// Санация после прогона, упёршегося в rate limit: сезоны, попавшие в индекс
/// без единого победителя, выкидываем целиком (write-once иначе не даст их
/// дозаполнить; у Jolpica победители есть у всех исторических сезонов).
export function evictWinnerlessSeasons(index: HistoryIndex): number[] {
  const withWinner = new Set<number>();
  const raced = new Set<number>();
  for (const races of Object.values(index.days)) {
    for (const r of races) {
      raced.add(r.year);
      if (r.winner) withWinner.add(r.year);
    }
  }
  const broken = [...raced].filter((y) => !withWinner.has(y));
  if (!broken.length) return [];
  const brokenSet = new Set(broken);
  for (const [day, races] of Object.entries(index.days)) {
    const kept = races.filter((r) => !brokenSet.has(r.year));
    if (kept.length) index.days[day] = kept;
    else delete index.days[day];
  }
  index.seasons = index.seasons.filter((y) => !brokenSet.has(y));
  return broken.sort((a, b) => a - b);
}

async function main(): Promise<void> {
  console.log(`F1 day-in-history index, seasons ${FIRST_SEASON}..${YEAR - 1}`);
  mkdirSync(join(process.cwd(), "data", "f1", "history"), { recursive: true });

  const index = readIndex();
  const evicted = evictWinnerlessSeasons(index);
  if (evicted.length) console.log(`  санация: перекачаем сезоны без победителей ${evicted.join(", ")}`);
  const missing: number[] = [];
  for (let y = FIRST_SEASON; y < YEAR; y++) {
    if (!index.seasons.includes(y)) missing.push(y);
  }
  if (!missing.length) {
    console.log("  все сезоны уже в индексе — выходим");
    return;
  }
  console.log(`  недостающих сезонов: ${missing.length}`);

  let added = 0;
  for (const year of missing) {
    const schedule = await fetchJSON(`${year}.json?limit=100`);
    await sleep(PAUSE_MS);
    const races = schedule?.MRData?.RaceTable?.Races;
    if (!Array.isArray(races) || !races.length) {
      console.log(`  ${year}: расписания нет — скип (сезон не помечаем)`);
      continue;
    }
    const winners = await fetchJSON(`${year}/results/1.json?limit=100`);
    await sleep(PAUSE_MS);
    const winnerRaces = winners?.MRData?.RaceTable?.Races ?? [];
    if (!winnerRaces.length) {
      // Победители есть у всех исторических сезонов — пусто значит rate
      // limit; сезон не помечаем, дозаполнится следующим прогоном.
      console.log(`  ${year}: победителей нет — скип (сезон не помечаем)`);
      continue;
    }
    mergeSeason(index, year, races, winnersMap(winnerRaces));
    added++;
    console.log(`  ${year}: ${races.length} гонок, победителей ${winnerRaces.length}`);
  }

  if (added) {
    writeIfChanged(OUT_PATH, JSON.stringify(index, null, 1) + "\n");
    console.log(`Done: +${added} сезонов, дней в индексе ${Object.keys(index.days).length}`);
  } else {
    console.log("Done: ничего не добавлено");
  }
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
