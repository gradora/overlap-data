// Продьюсер «SPORT MILESTONES» — all-time рекорды F1 для одноимённого блока
// поиска. Источник — карьерная статистика активных пилотов из Jolpica (дешёвые
// MRData.total, без пагинации): старты (Grands Prix), победы, подиумы
// (P1+P2+P3), поулы. Держатели all-time рекордов курируются (реальные факты,
// меняются редко); их значение берём ЖИВЫМ из Jolpica (Alonso/Hamilton активны
// и держат рекорды — цифра всегда точная, совпадает с макетом: Hamilton
// podiums = 207). Карточки: «new record» (держатель) и «to beat» (ближайший
// активный преследователь с прогрессом). Пишет data/f1/records/<season>.json.
//
// Юбилейные «legacy»-вехи (350 GP for Alonso) в блоке — из уже существующего
// data/f1/milestones (продьюсер f1milestones.ts), приложение их доклеивает.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./mirror.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT = join(process.cwd(), "data", "f1", "records", `${YEAR}.json`);
const STANDINGS = join(process.cwd(), "data", "f1", "jolpica", "current_driverStandings.json");
const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

/// Отслеживаемые all-time рекорды: держатель курируется (driverId Jolpica),
/// значение рекорда — его живой тотал (держатели активны). Порядок — приоритет
/// показа.
export const TRACKED: { stat: string; holder: string; holderName: string }[] = [
  { stat: "Grands Prix", holder: "alonso",   holderName: "Fernando Alonso" },
  { stat: "wins",        holder: "hamilton", holderName: "Lewis Hamilton" },
  { stat: "podiums",     holder: "hamilton", holderName: "Lewis Hamilton" },
  { stat: "poles",       holder: "hamilton", holderName: "Lewis Hamilton" },
];

/// «to beat» показываем только у реального преследования — прогресс ≥ порога
/// (иначе «11 из 106» рядом с рекордом выглядит бессмысленно).
export const CHASE_MIN_PROGRESS = 0.5;

export interface DriverTotals {
  driverId: string;
  code: string;        // «HAM»
  driver: string;      // «L. Hamilton»
  number: string | null;
  teamId: string;      // «mercedes» — цвет полоски
  "Grands Prix": number;
  wins: number;
  podiums: number;
  poles: number;
}

export interface RecordCard {
  kind: "new record" | "to beat";
  stat: string;
  value: number;       // крупная цифра карточки
  record: number;      // значение all-time рекорда
  driver: string;      // «L. Hamilton»
  code: string;        // «HAM»
  number: string | null;
  teamId: string;
  holder: string;      // имя держателя рекорда (для сабтайтла)
  progress: number;    // value/record (0..1)
}

export interface SeasonRecords {
  season: number;
  records: RecordCard[];
}

/// Чистая сборка карточек: для каждого рекорда — держатель (new record) и
/// ближайший активный преследователь (to beat, если прогресс ≥ порога).
export function buildCards(
  totals: DriverTotals[],
  tracked = TRACKED,
  minProgress = CHASE_MIN_PROGRESS,
): RecordCard[] {
  const byId = new Map(totals.map((t) => [t.driverId, t]));
  const cards: RecordCard[] = [];
  for (const rec of tracked) {
    const key = rec.stat as "Grands Prix" | "wins" | "podiums" | "poles";
    const holder = byId.get(rec.holder);
    if (!holder || holder[key] <= 0) continue; // держатель не активен — пропуск
    const record = holder[key];

    cards.push({
      kind: "new record", stat: rec.stat, value: record, record,
      driver: holder.driver, code: holder.code, number: holder.number,
      teamId: holder.teamId, holder: rec.holderName, progress: 1,
    });

    // Ближайший активный преследователь (не держатель) с максимумом по метрике.
    const chaser = totals
      .filter((t) => t.driverId !== rec.holder)
      .sort((a, b) => b[key] - a[key])[0];
    if (chaser && chaser[key] > 0) {
      const progress = chaser[key] / record;
      if (progress >= minProgress) {
        cards.push({
          kind: "to beat", stat: rec.stat, value: chaser[key], record,
          driver: chaser.driver, code: chaser.code, number: chaser.number,
          teamId: chaser.teamId, holder: rec.holderName, progress,
        });
      }
    }
  }
  return cards;
}

// ── Сеть ────────────────────────────────────────────────────────────────────

async function fetchJSON(url: string, attempt = 0): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (res.status === 429 && attempt < 3) {
      clearTimeout(t);
      await new Promise((r) => setTimeout(r, 8000 * (attempt + 1)));
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

/// MRData.total ручки-агрегата (limit=1) — карьерный счётчик без пагинации.
async function total(path: string): Promise<number | null> {
  const d = await fetchJSON(`${JOLPICA}/${path}.json?limit=1`);
  const n = Number(d?.MRData?.total);
  return Number.isFinite(n) ? n : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`F1 records, season ${YEAR}`);

  const driversResp = await fetchJSON(`${JOLPICA}/${YEAR}/drivers.json?limit=40`);
  const drivers = driversResp?.MRData?.DriverTable?.Drivers ?? [];
  if (!drivers.length) {
    console.warn("records: пилоты сезона недоступны — пропускаем");
    return;
  }

  // Команда пилота — из зеркала driverStandings (для цвета полоски).
  const teamOf = new Map<string, string>();
  try {
    const st = JSON.parse(readFileSync(STANDINGS, "utf8"));
    const rows = st?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings ?? [];
    for (const row of rows) {
      const id = row?.Driver?.driverId, tid = row?.Constructors?.[0]?.constructorId;
      if (id && tid) teamOf.set(id, tid);
    }
  } catch { /* нет зеркала — teamId пустой, цвет фолбэкнется в приложении */ }

  const totals: DriverTotals[] = [];
  for (const d of drivers) {
    const id = d.driverId;
    // Последовательно с паузой — Jolpica жёстко rate-лимитит параллельные залпы.
    const entries = await total(`drivers/${id}/results`); await sleep(500);
    const wins = await total(`drivers/${id}/results/1`); await sleep(500);
    const p2 = await total(`drivers/${id}/results/2`); await sleep(500);
    const p3 = await total(`drivers/${id}/results/3`); await sleep(500);
    const poles = await total(`drivers/${id}/qualifying/1`); await sleep(500);
    // Сетевой пропуск любой метрики — пилота не учитываем (не портим сравнение).
    if ([entries, wins, p2, p3, poles].some((x) => x == null)) {
      console.warn(`  ${id}: неполные данные — пропуск`);
      continue;
    }
    const code = d.code ?? d.familyName.slice(0, 3).toUpperCase();
    totals.push({
      driverId: id, code,
      driver: `${d.givenName[0]}. ${d.familyName}`,
      number: d.permanentNumber ?? null,
      teamId: teamOf.get(id) ?? "",
      "Grands Prix": entries!, wins: wins!, podiums: wins! + p2! + p3!, poles: poles!,
    });
    await sleep(300);
  }

  if (!totals.length) {
    console.warn("records: карьерные тоталы недоступны — пропускаем");
    return;
  }

  const records = buildCards(totals);
  const payload: SeasonRecords = { season: YEAR, records };
  const changed = writeIfChanged(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `  ${records.length} карточек: ${records.map((r) => `${r.kind === "to beat" ? "→" : "★"}${r.value} ${r.stat} (${r.code})`).join(", ")} → ${changed ? "записано" : "без изменений"}`,
  );
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
