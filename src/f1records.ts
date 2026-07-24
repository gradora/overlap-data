// Продьюсер «SPORT MILESTONES» — вехи и рекорды F1 для одноимённого блока
// поиска. Источник — карьерная статистика из Jolpica (дешёвые MRData.total).
// Два типа карточек:
//   • «new record» — активный держатель all-time рекорда, который он продолжает
//     двигать (Alonso — Grands Prix; Hamilton — wins/podiums). Цифра живая.
//   • «to beat» — активный пилот догоняет ЗАФИКСИРОВАННУЮ цифру ушедшей легенды
//     (держатель больше не гоняет → рекорд стоит → погоня осмысленна). Сейчас:
//     Verstappen → 91 победа Шумахера, → 68 поулов Шумахера. Цель курируется
//     (реальный факт), прогресс пилота — живой из Jolpica.
// НЕ гоняем «активный за активным» по накопительной метрике — рекорд движется у
// обоих, догнать нельзя, график бессмыслен.
// Юбилейные «legacy»-вехи (350 GP for Alonso) в блоке — из data/f1/milestones
// (продьюсер f1milestones.ts), приложение их доклеивает.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./mirror.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT = join(process.cwd(), "data", "f1", "records", `${YEAR}.json`);
const STANDINGS = join(process.cwd(), "data", "f1", "jolpica", "current_driverStandings.json");
const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

type Metric = "entries" | "wins" | "podiums" | "poles";

/// Активные держатели all-time рекордов (продолжают двигать) → «new record».
export const HELD: { stat: string; holder: string; holderName: string; metric: Metric }[] = [
  { stat: "Grands Prix", holder: "alonso",   holderName: "Fernando Alonso", metric: "entries" },
  { stat: "wins",        holder: "hamilton", holderName: "Lewis Hamilton",  metric: "wins" },
  { stat: "podiums",     holder: "hamilton", holderName: "Lewis Hamilton",  metric: "podiums" },
];

/// Погони за ЗАФИКСИРОВАННОЙ цифрой ушедшей легенды → «to beat». record — реальный
/// факт (курируется, меняется редко), прогресс пилота считаем живым.
export const CHASES: {
  stat: string; metric: Metric; record: number; holder: string; chaser: string;
}[] = [
  { stat: "wins",  metric: "wins",  record: 91, holder: "Michael Schumacher", chaser: "max_verstappen" },
  { stat: "poles", metric: "poles", record: 68, holder: "Michael Schumacher", chaser: "max_verstappen" },
];

export interface Subject {
  code: string;         // «VER»
  driver: string;       // «M. Verstappen»
  number: string | null;
  teamId: string;       // «red_bull» — цвет полоски
}

export interface RecordCard {
  kind: "new record" | "to beat";
  stat: string;
  value: number;        // крупная цифра карточки (живой тотал субъекта)
  record: number;       // цель/рекорд
  driver: string;
  code: string;
  number: string | null;
  teamId: string;
  holder: string;       // имя держателя рекорда (для сабтайтла)
  progress: number;     // value/record (0…1)
}

export interface SeasonRecords {
  season: number;
  records: RecordCard[];
}

/// Чистая сборка: held → «new record» (субъект = держатель), chases → «to beat»
/// (субъект = преследователь, если ещё не догнал). value/info резолвит вызывающий.
export function buildCards(
  held: { stat: string; holderName: string; value: number | null; info: Subject | null }[],
  chases: { stat: string; record: number; holder: string; value: number | null; info: Subject | null }[],
): RecordCard[] {
  const cards: RecordCard[] = [];
  for (const h of held) {
    if (h.value == null || h.value <= 0 || !h.info) continue;
    cards.push({
      kind: "new record", stat: h.stat, value: h.value, record: h.value,
      driver: h.info.driver, code: h.info.code, number: h.info.number,
      teamId: h.info.teamId, holder: h.holderName, progress: 1,
    });
  }
  for (const c of chases) {
    // Показываем, только пока цифра НЕ достигнута (иначе это уже не погоня).
    if (c.value == null || c.value <= 0 || c.value >= c.record || !c.info) continue;
    cards.push({
      kind: "to beat", stat: c.stat, value: c.value, record: c.record,
      driver: c.info.driver, code: c.info.code, number: c.info.number,
      teamId: c.info.teamId, holder: c.holder, progress: c.value / c.record,
    });
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

async function total(path: string): Promise<number | null> {
  const d = await fetchJSON(`${JOLPICA}/${path}.json?limit=1`);
  const n = Number(d?.MRData?.total);
  return Number.isFinite(n) ? n : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Карьерный тотал метрики: podiums = P1+P2+P3 (три ручки), остальное — одна.
async function metricTotal(id: string, metric: Metric): Promise<number | null> {
  switch (metric) {
    case "entries": return total(`drivers/${id}/results`);
    case "wins":    return total(`drivers/${id}/results/1`);
    case "poles":   return total(`drivers/${id}/qualifying/1`);
    case "podiums": {
      const w = await total(`drivers/${id}/results/1`); await sleep(500);
      const p2 = await total(`drivers/${id}/results/2`); await sleep(500);
      const p3 = await total(`drivers/${id}/results/3`);
      return w != null && p2 != null && p3 != null ? w + p2 + p3 : null;
    }
  }
}

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

  const info = (id: string): Subject | null => {
    const d = drivers.find((x: any) => x.driverId === id);
    if (!d) return null; // субъект не в этом сезоне (ушёл) — карточку пропустим
    return {
      code: d.code ?? d.familyName.slice(0, 3).toUpperCase(),
      driver: `${d.givenName[0]}. ${d.familyName}`,
      number: d.permanentNumber ?? null,
      teamId: teamOf.get(id) ?? "",
    };
  };

  // Резолвим только нужных субъектов (держатели + преследователи) — 3-4 пилота.
  const subjects = new Map<string, Subject | null>();
  const metrics = new Map<string, Metric[]>();
  for (const h of HELD) {
    subjects.set(h.holder, info(h.holder));
    metrics.set(h.holder, [...(metrics.get(h.holder) ?? []), h.metric]);
  }
  for (const c of CHASES) {
    subjects.set(c.chaser, info(c.chaser));
    metrics.set(c.chaser, [...(metrics.get(c.chaser) ?? []), c.metric]);
  }

  const value = new Map<string, number | null>();
  for (const [id, ms] of metrics) {
    if (!subjects.get(id)) continue; // ушедший субъект — не тратим запросы
    for (const m of [...new Set(ms)]) {
      value.set(`${id}:${m}`, await metricTotal(id, m));
      await sleep(500);
    }
  }

  const held = HELD.map((h) => ({
    stat: h.stat, holderName: h.holderName,
    value: value.get(`${h.holder}:${h.metric}`) ?? null, info: subjects.get(h.holder) ?? null,
  }));
  const chases = CHASES.map((c) => ({
    stat: c.stat, record: c.record, holder: c.holder,
    value: value.get(`${c.chaser}:${c.metric}`) ?? null, info: subjects.get(c.chaser) ?? null,
  }));

  const records = buildCards(held, chases);
  if (!records.length) {
    console.warn("records: нет карточек (данные недоступны) — пропускаем");
    return;
  }
  const payload: SeasonRecords = { season: YEAR, records };
  const changed = writeIfChanged(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `  ${records.length} карточек: ${records.map((r) => `${r.kind === "to beat" ? "→" : "★"}${r.value}/${r.record} ${r.stat} (${r.code})`).join(", ")} → ${changed ? "записано" : "без изменений"}`,
  );
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
