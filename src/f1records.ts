// Продьюсер «SPORT MILESTONES» — вехи и рекорды F1 для одноимённого блока
// поиска. Источник — карьерная статистика из Jolpica (дешёвые MRData.total).
// Карточки собираются С ГОТОВЫМ ТЕКСТОМ (header/title/note/подписи полоски) —
// формулировки и «вау-углы» живут в бэкенде, приложение только рисует.
//
// Углы (не просто «держит рекорд», а горячая динамика):
//  • milestone — держатель идёт к красивой круглой цифре: «12 more for a
//    landmark 450» (Alonso, Grands Prix). Полоска — прогресс к цели.
//  • firstPast — уникальность: «The only driver ever past 100 wins» (Hamilton).
//  • rate — частота: «On the podium in more than half his races» (Hamilton,
//    207 подиумов из 390 — полоска = доля подиумных гонок).
//  • chase — погоня за ЗАФИКСИРОВАННОЙ цифрой ушедшей легенды (держатель больше
//    не гоняет → цель стоит → догнать реально): Verstappen → 91 победа / 155
//    подиумов Шумахера. Полоска — прогресс к цели.
//
// Только results-based метрики (GP, без спринтов); qualifying/1 у Jolpica
// завышает поулы (лумпит sprint-shootout) — поулы не берём.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./mirror.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT = join(process.cwd(), "data", "f1", "records", `${YEAR}.json`);
const STANDINGS = join(process.cwd(), "data", "f1", "jolpica", "current_driverStandings.json");
const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

type Metric = "entries" | "wins" | "podiums";

type Hook =
  | { kind: "milestone"; step: number }        // к следующей круглой цифре
  | { kind: "firstPast"; threshold: number }   // единственный за порогом
  | { kind: "rate"; over: Metric };            // доля (подиумов от гонок)

/// Активные держатели all-time рекордов + «вау-угол».
export const HELD: { stat: string; holder: string; metric: Metric; hook: Hook }[] = [
  { stat: "Grands Prix", holder: "alonso",   metric: "entries", hook: { kind: "milestone", step: 50 } },
  { stat: "wins",        holder: "hamilton", metric: "wins",    hook: { kind: "firstPast", threshold: 100 } },
  { stat: "podiums",     holder: "hamilton", metric: "podiums", hook: { kind: "rate", over: "entries" } },
];

/// Погони за ЗАФИКСИРОВАННОЙ цифрой ушедшей легенды. record — реальный факт.
export const CHASES: {
  stat: string; metric: Metric; record: number; holder: string; chaser: string;
}[] = [
  { stat: "wins",    metric: "wins",    record: 91,  holder: "Michael Schumacher", chaser: "max_verstappen" },
  { stat: "podiums", metric: "podiums", record: 155, holder: "Michael Schumacher", chaser: "max_verstappen" },
];

export interface Subject {
  code: string;         // «VER»
  driver: string;       // «M. Verstappen»
  number: string | null;
  teamId: string;       // «red_bull» — цвет полоски
}

/// Готовая карточка блока — приложение рисует как есть.
export interface RecordCard {
  id: string;
  header: string;       // «MILESTONE» | «RECORD» | «CHASING»
  title: string;        // «438 GRANDS PRIX»
  note: string;         // сабтайтл
  progress: number;     // заполнение полоски 0…1
  teamId: string;       // цвет полоски
  barLeft: string;      // «#14 F. Alonso» | «WINS»
  barRight: string;     // «438/450» | «106»
}

export interface SeasonRecords {
  season: number;
  records: RecordCard[];
}

const UP = (s: string) => s.toUpperCase();

/// Карточка держателя рекорда по «вау-углу».
function heldCard(
  h: (typeof HELD)[number],
  V: Record<string, number | null>,
  S: Record<string, Subject | null>,
): RecordCard | null {
  const info = S[h.holder];
  const value = V[`${h.holder}:${h.metric}`];
  if (!info || value == null || value <= 0) return null;
  const title = UP(`${value} ${h.stat}`);

  switch (h.hook.kind) {
    case "milestone": {
      const target = Math.ceil((value + 1) / h.hook.step) * h.hook.step;
      const gap = target - value;
      return {
        id: `held-${h.stat}`, header: "MILESTONE", title,
        note: `${gap} more for a landmark ${target} — extending his own all-time record.`,
        progress: value / target, teamId: info.teamId,
        barLeft: `#${info.number ?? "?"} ${info.driver}`, barRight: `${value}/${target}`,
      };
    }
    case "firstPast":
      return {
        id: `held-${h.stat}`, header: "RECORD", title,
        note: `The only driver in F1 history to pass ${h.hook.threshold} ${h.stat}.`,
        progress: 1, teamId: info.teamId, barLeft: UP(h.stat), barRight: `${value}`,
      };
    case "rate": {
      const races = V[`${h.holder}:${h.hook.over}`] ?? 0;
      const ratio = races > 0 ? value / races : 1;
      const noun = h.stat.replace(/s$/, "");
      const note = ratio >= 0.5
        ? `On the podium in more than half of his ${races} Grands Prix.`
        : `A ${noun} roughly every ${(1 / ratio).toFixed(1)} races.`;
      return {
        id: `held-${h.stat}`, header: "RECORD", title, note,
        progress: ratio, teamId: info.teamId, barLeft: UP(h.stat),
        barRight: races > 0 ? `${value}/${races}` : `${value}`,
      };
    }
  }
}

/// Карточка погони за зафиксированной цифрой легенды.
function chaseCard(
  c: (typeof CHASES)[number],
  V: Record<string, number | null>,
  S: Record<string, Subject | null>,
): RecordCard | null {
  const info = S[c.chaser];
  const value = V[`${c.chaser}:${c.metric}`];
  if (!info || value == null || value <= 0 || value >= c.record) return null;
  const gap = c.record - value;
  return {
    id: `chase-${c.stat}`, header: "CHASING", title: UP(`${value} ${c.stat}`),
    note: `${gap} ${c.stat} from passing ${c.holder}’s ${c.record}.`,
    progress: value / c.record, teamId: info.teamId,
    barLeft: `#${info.number ?? "?"} ${info.driver}`, barRight: `${value}/${c.record}`,
  };
}

/// Чистая сборка блока — держатели (вау-углы) + погони.
export function buildCards(
  V: Record<string, number | null>,
  S: Record<string, Subject | null>,
): RecordCard[] {
  const cards: RecordCard[] = [];
  for (const h of HELD) { const c = heldCard(h, V, S); if (c) cards.push(c); }
  for (const c of CHASES) { const card = chaseCard(c, V, S); if (card) cards.push(card); }
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

async function main() {
  console.log(`F1 records, season ${YEAR}`);

  const driversResp = await fetchJSON(`${JOLPICA}/${YEAR}/drivers.json?limit=40`);
  const drivers = driversResp?.MRData?.DriverTable?.Drivers ?? [];
  if (!drivers.length) {
    console.warn("records: пилоты сезона недоступны — пропускаем");
    return;
  }

  const teamOf = new Map<string, string>();
  try {
    const st = JSON.parse(readFileSync(STANDINGS, "utf8"));
    const rows = st?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings ?? [];
    for (const row of rows) {
      const id = row?.Driver?.driverId, tid = row?.Constructors?.[0]?.constructorId;
      if (id && tid) teamOf.set(id, tid);
    }
  } catch { /* нет зеркала — цвет фолбэкнется в приложении */ }

  const S: Record<string, Subject | null> = {};
  const subjectOf = (id: string): Subject | null => {
    const d = drivers.find((x: any) => x.driverId === id);
    if (!d) return null;
    return {
      code: d.code ?? d.familyName.slice(0, 3).toUpperCase(),
      driver: `${d.givenName[0]}. ${d.familyName}`,
      number: d.permanentNumber ?? null,
      teamId: teamOf.get(id) ?? "",
    };
  };

  // Кто и что нужно (держатели + преследователи, 3-4 пилота).
  const need = new Map<string, Set<Metric>>();
  const add = (id: string, m: Metric) => need.set(id, (need.get(id) ?? new Set()).add(m));
  for (const h of HELD) { add(h.holder, h.metric); if (h.hook.kind === "rate") add(h.holder, h.hook.over); }
  for (const c of CHASES) add(c.chaser, c.metric);

  const V: Record<string, number | null> = {};
  for (const [id, metrics] of need) {
    S[id] = subjectOf(id);
    if (!S[id]) continue; // субъект не в сезоне (ушёл) — карточку пропустим
    // podiums и wins делят results/1 — считаем P1/P2/P3 один раз при надобности.
    const wantPodiums = metrics.has("podiums");
    const wantWins = metrics.has("wins");
    if (metrics.has("entries")) { V[`${id}:entries`] = await total(`drivers/${id}/results`); await sleep(500); }
    if (wantWins || wantPodiums) {
      const p1 = await total(`drivers/${id}/results/1`); await sleep(500);
      if (wantWins) V[`${id}:wins`] = p1;
      if (wantPodiums) {
        const p2 = await total(`drivers/${id}/results/2`); await sleep(500);
        const p3 = await total(`drivers/${id}/results/3`); await sleep(500);
        V[`${id}:podiums`] = p1 != null && p2 != null && p3 != null ? p1 + p2 + p3 : null;
      }
    }
  }

  const records = buildCards(V, S);
  if (!records.length) {
    console.warn("records: нет карточек (данные недоступны) — пропускаем");
    return;
  }
  const payload: SeasonRecords = { season: YEAR, records };
  const changed = writeIfChanged(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `  ${records.length} карточек: ${records.map((r) => `${r.header[0]}:${r.title}`).join(", ")} → ${changed ? "записано" : "без изменений"}`,
  );
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
