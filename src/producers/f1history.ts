// Продьюсер «Day in history» — индекс всех гонок F1 1950..прошлый год по дням
// года (MM-DD) для полки лендинга поиска. Источник: Jolpica — расписание
// сезона ({year}.json) + победители ({year}/results/1.json, фильтр «finished
// 1st» отдаёт P1 всех раундов одним запросом). Текущий сезон не включаем —
// он живёт в календаре приложения; прошлый год доезжает январским прогоном.
// Выход: data/f1/history/index.json — один файл, приложение ищет свой день.
// Write-once по сезонам: скачанные годы не перекачиваются.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {writeJSONWithEnvelope } from "../lib/mirror.js";
import { fetchJSON as httpJSON } from "../lib/http.js";
import { JOLPICA } from "../lib/sources.js";

const fetchJSON = (relative: string) => httpJSON(`${JOLPICA}/${relative}`, { backoffMs: 60000 });

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
  given?: string;      // имя победителя — для подписи без дубля фамилии
  team?: string;       // конструктор победителя
  // Сырьё для вычисления фактов (переживает инкрементальные прогоны):
  driverId?: string;   // ключ карьерного счёта побед
  grid?: number;       // стартовая позиция победителя (0 = пит-лейн)
  nat?: string;        // nationality победителя — для «домашней победы»
  // Готовый текст карточки (приоритет над шаблоном приложения):
  fact?: string;       // ≤112 симв., англ., полное имя пилота внутри
  tag?: string;        // ярлык-заголовок ≤18 симв. («MAIDEN WIN»); нет — фолбэк
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
  winnersByRound: Map<number, WinnerInfo>,
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
      ...(win ? {
        winner: win.winner, ...(win.given ? { given: win.given } : {}), team: win.team,
        ...(win.driverId ? { driverId: win.driverId } : {}),
        ...(win.grid !== undefined ? { grid: win.grid } : {}),
        ...(win.nat ? { nat: win.nat } : {}),
      } : {}),
    };
    const list = index.days[day] ?? [];
    list.push(entry);
    list.sort((a, b) => b.year - a.year);
    index.days[day] = list;
  }
  if (!index.seasons.includes(year)) index.seasons.push(year);
  index.seasons.sort((a, b) => a - b);
}

export interface WinnerInfo {
  winner: string;
  given: string;
  team: string;
  driverId: string;
  grid?: number;
  nat?: string;
}

/// P1-результаты сезона → карта раунд → данные победителя.
export function winnersMap(races: any[]): Map<number, WinnerInfo> {
  const map = new Map<number, WinnerInfo>();
  for (const race of races) {
    const result = race?.Results?.[0];
    const family = result?.Driver?.familyName;
    if (!family) continue;
    const grid = Number(result?.grid);
    map.set(Number(race.round), {
      winner: String(family),
      given: String(result?.Driver?.givenName ?? ""),
      team: String(result?.Constructor?.name ?? ""),
      driverId: String(result?.Driver?.driverId ?? ""),
      ...(Number.isFinite(grid) ? { grid } : {}),
      ...(result?.Driver?.nationality ? { nat: String(result.Driver.nationality) } : {}),
    });
  }
  return map;
}


// MARK: Факты

// Демоним → страны jolpica (для «домашней победы»). Только реально
// встречающиеся у победителей национальности.
const HOME: Record<string, string[]> = {
  British: ["UK", "United Kingdom", "Great Britain", "England"],
  German: ["Germany"], Italian: ["Italy"], French: ["France"],
  Dutch: ["Netherlands"], Spanish: ["Spain"], Brazilian: ["Brazil"],
  Argentine: ["Argentina"], Argentinian: ["Argentina"],
  Austrian: ["Austria"], Australian: ["Australia"],
  American: ["USA", "United States"], Mexican: ["Mexico"],
  Canadian: ["Canada"], Finnish: ["Finland"], Japanese: ["Japan"],
  Monegasque: ["Monaco"], Belgian: ["Belgium"], Swiss: ["Switzerland"],
  Swedish: ["Sweden"], "New Zealander": ["New Zealand"],
  "South African": ["South Africa"], Polish: ["Poland"],
  Colombian: ["Colombia"], Venezuelan: ["Venezuela"], Thai: ["Thailand"],
  Danish: ["Denmark"], Portuguese: ["Portugal"],
};

const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? "TH" : ["TH", "ST", "ND", "RD"][n % 10 <= 3 ? n % 10 : 0]}`;

const shortRace = (name: string) => name.replace("Grand Prix", "GP");

/// Вычисляет fact/tag для КАЖДОЙ записи с победителем. Работает по всему
/// индексу (карьерный номер победы требует всех сезонов), идемпотентен —
/// зовётся на каждом прогоне, инкрементальный сезон меняет только хвост
/// нумерации. Приоритет: пит-лейн > первая победа > камбэк > юбилейная >
/// домашняя > дефолт с номером победы (без tag — заголовок остаётся за
/// прозвищем/фамилией, это сохраняет разнообразие карточек).
export function computeFacts(index: HistoryIndex): void {
  // Карьерная нумерация: все победы по дате.
  const wins: { key: string; driverId: string; date: string }[] = [];
  for (const [day, races] of Object.entries(index.days)) {
    for (const r of races) {
      if (!r.driverId) continue;
      wins.push({ key: `${r.year}|${day}|${r.round}`, driverId: r.driverId,
                  date: `${r.year}-${day}` });
    }
  }
  wins.sort((a, b) => a.date.localeCompare(b.date));
  const winNo = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const w of wins) {
    const n = (totals.get(w.driverId) ?? 0) + 1;
    totals.set(w.driverId, n);
    winNo.set(w.key, n);
  }

  for (const [day, races] of Object.entries(index.days)) {
    for (const r of races) {
      if (!r.driverId || !r.winner) continue;
      const k = winNo.get(`${r.year}|${day}|${r.round}`);
      if (!k) continue;
      const name = r.given ? `${r.given} ${r.winner}` : r.winner;
      const total = totals.get(r.driverId) ?? k;
      const gp = shortRace(r.name);
      let fact: string; let tag: string | undefined;

      if (r.grid === 0) {
        tag = "PIT LANE START";
        fact = `${name} wins the ${gp} from the pit lane — career victory No. ${k}`;
      } else if (k === 1) {
        tag = "MAIDEN WIN";
        const tail = total > 1 ? ` — the first of ${total} career victories` : "";
        fact = `A maiden F1 win for ${name}${tail}`;
      } else if (r.grid !== undefined && r.grid >= 10) {
        tag = `FROM P${r.grid}`;
        fact = `${name} charges from P${r.grid} to win the ${gp}`;
      } else if ([10, 25, 50, 75, 100].includes(k)) {
        tag = `${ordinal(k)} WIN`;
        fact = `Career win No. ${k} for ${name}, at the wheel of a ${r.team}`;
      } else if (r.nat && (HOME[r.nat] ?? []).includes(r.country)) {
        tag = "HOME WIN";
        fact = `A home Grand Prix victory for ${name} and ${r.team}`;
      } else {
        tag = undefined;
        const variants = [
          `Career win No. ${k} for ${name}` +
            (r.grid !== undefined && r.grid > 1 ? `, from P${r.grid} on the grid` : ""),
          `${name} takes career win No. ${k} for ${r.team}`,
          `Win No. ${k} of ${total} career victories for ${name}`,
        ];
        fact = variants[(r.year + r.round) % variants.length];
      }

      if (fact.length > 112) fact = `Career win No. ${k} for ${name}`;
      r.fact = fact;
      if (tag) r.tag = tag; else delete r.tag;
    }
  }
}

// MARK: Курируемые моменты

export interface Moment {
  day: string;    // «MM-DD»
  year: number;
  race: string;   // точное raceName — защита от попадания не в ту гонку
  tag: string;
  fact: string;
  sourceUrl?: string;
}

/// Накладывает курируемые факты ПОВЕРХ вычисленных. Матч строгий — по дню,
/// году и названию гонки: момент, не нашедший свою гонку, не применяется и
/// попадает в отчёт (опечатка в moments.json не должна молча пропасть).
export function applyMoments(index: HistoryIndex, moments: Moment[]): string[] {
  const misses: string[] = [];
  for (const m of moments) {
    const races = index.days[m.day] ?? [];
    const race = races.find((r) => r.year === m.year && r.name === m.race);
    if (!race) { misses.push(`${m.day} ${m.year} «${m.race}»`); continue; }
    if (m.fact.length > 112 || m.tag.length > 18) {
      misses.push(`${m.day} ${m.year} «${m.race}» (длина fact/tag)`); continue;
    }
    race.fact = m.fact;
    race.tag = m.tag;
  }
  return misses;
}

function readMoments(): Moment[] {
  try {
    const parsed = JSON.parse(
      readFileSync(join(process.cwd(), "data", "f1", "history", "moments.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
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
  // Сезоны без имён победителей (миграция given) и без сырья для фактов
  // (миграция driverId/grid, v2 карточек) тоже перекачиваем.
  const withGiven = new Set<number>();
  const withDriverId = new Set<number>();
  for (const races of Object.values(index.days)) {
    for (const r of races) {
      if (r.given) withGiven.add(r.year);
      if (r.driverId) withDriverId.add(r.year);
    }
  }
  const broken = [...raced].filter(
    (y) => !withWinner.has(y) || !withGiven.has(y) || !withDriverId.has(y));
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
  if (missing.length) console.log(`  недостающих сезонов: ${missing.length}`);

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

  // Факты — каждый прогон (карьерная нумерация зависит от всего корпуса,
  // курируемые моменты могли обновиться); writeJSONWithEnvelope не тронет
  // файл, если байты не изменились.
  computeFacts(index);
  const misses = applyMoments(index, readMoments());
  for (const miss of misses) console.warn(`  ::warning::момент не нашёл гонку: ${miss}`);

  writeJSONWithEnvelope(OUT_PATH, index);
  console.log(`Done: +${added} сезонов, дней в индексе ${Object.keys(index.days).length}`);
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
