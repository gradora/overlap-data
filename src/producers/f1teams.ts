// Продьюсер экрана команды (макет «team page final» 1424:95036). Собирает то,
// чего нет ни в одном зачёте: разбивку сезона на Гран-при и спринты, форму
// пилотов по этапам, домашнюю трассу и всевременные итоги.
//
// Почему не из зачёта: constructorStandings знает только место и сумму очков.
// Поулы, подиумы, быстрые круги и спринтовая часть считаются построчно из
// результатов сезона — по одному запросу на выборку, а не на гонку.
//
// Ловушки Jolpica, на которые уже наступали:
//  • qualifying/1 отдаёт МУСОР — у Феррари-2026 приезжают позиции 4, 4, 4, 2.
//    Поулы считаем фильтром position === "1" по полной выборке квалификаций.
//  • история команды разрезана по constructorId (mclaren / mclaren-ford):
//    всевременные победы суммируем по всем историческим id, как в f1records.
//  • титулов одним запросом не отдают (constructorStandings/1 требует season).
//    Берём чемпиона каждого сезона по одному запросу на год и кэшируем
//    НАВСЕГДА: прошлый чемпион не меняется, за год добавляется одна строка.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged, writeJSONWithEnvelope } from "../lib/mirror.js";
import { scheduleSeasonMismatch } from "../lib/season.js";
import { fetchJSON as httpJSON } from "../lib/http.js";
import { JOLPICA } from "../lib/sources.js";
import { groupById } from "./f1records.js";

const fetchJSON = (url: string) => httpJSON(url, { backoffMs: 8000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const DATA = join(process.cwd(), "data", "f1");
const TEAMS_DIR = join(DATA, "teams");
const OUT = join(TEAMS_DIR, `${YEAR}.json`);
const STATE = join(TEAMS_DIR, `_state_${YEAR}.json`);
const JOLPICA_DIR = join(DATA, "jolpica");

/// Первый сезон чемпионата конструкторов — раньше титулов не существовало.
const FIRST_CONSTRUCTOR_SEASON = 1958;
const STATE_VERSION = 1;

// ── Форма выдачи ────────────────────────────────────────────────────────────

export interface TeamTally {
  starts: number;      // выходов на старт (машино-стартов)
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  points: number;
}

/// Результат пилота на этапе для полоски формы. `position` — nil у сходов;
/// `status` оставляем как есть («Finished», «Accident», «+1 Lap»).
export interface FormResult {
  round: number;
  race: string;
  position: number | null;
  status: string;
}

export interface TeamDriverForm {
  driverId: string;
  code: string;
  number: string | null;
  name: string;        // «C. Leclerc»
  results: FormResult[];
  /// Победы в спринтах и число квалификаций, выигранных у напарника, — строки
  /// расширенной карточки дуэли. Считаются из тех же выборок, что и всё
  /// остальное, своих запросов не стоят.
  sprintWins: number;
  qualiWins: number;
}

export interface TeamPage {
  constructorId: string;
  name: string;
  base?: { country: string; city: string };
  /// Место и очки в зачёте конструкторов; null — зачёт ещё не открыт.
  position: number | null;
  points: number;
  gp: TeamTally;
  sprint: TeamTally;
  form: TeamDriverForm[];
  /// Домашняя трасса и всевременные итоги команды НА НЕЙ.
  home?: { circuitId: string; name: string; wins: number; poles: number };
  /// Другие серии бренда: наши (wec, imsa) и внешние (formulae, indycar).
  alsoIn: string[];
  /// Первый сезон команды в чемпионате — подпись «From 1950» в рекордах.
  firstSeason: number | null;
  allTime: { wins: number; titles: number };
  /// Рекорды нынешних пилотов В ЭТОЙ команде — вторая половина блока RECORDS.
  driverRecords: { driverId: string; name: string; wins: number }[];
}

/// Раунд календаря с трёхбуквенным кодом — подпись пустой ячейки полоски
/// формы («ABU», «QAT»). Своего кода Jolpica не отдаёт, ведём картой.
export interface SeasonRound {
  round: number;
  code: string;
  race: string;
}

export interface SeasonTeams {
  season: number;
  rounds: SeasonRound[];
  teams: TeamPage[];
}

/// Коды этапов — по конвенции самой Формулы-1 (венесуэльский «ABU» — город,
/// «QAT» — страна). Незнакомая трасса деградирует в первые три буквы слага.
const ROUND_CODES: Record<string, string> = {
  albert_park: "AUS", shanghai: "CHN", suzuka: "JPN", miami: "MIA",
  villeneuve: "CAN", monaco: "MON", catalunya: "ESP", red_bull_ring: "AUT",
  silverstone: "GBR", spa: "BEL", hungaroring: "HUN", zandvoort: "NED",
  monza: "ITA", madring: "MAD", baku: "AZE", sepang: "MAL", marina_bay: "SIN",
  americas: "USA", rodriguez: "MEX", interlagos: "SAO", vegas: "LVG",
  losail: "QAT", yas_marina: "ABU", imola: "EMI", jeddah: "SAU", bahrain: "BHR",
  ricard: "FRA", portimao: "POR", istanbul: "TUR", nurburgring: "NUR",
  mugello: "MUG", sochi: "RUS",
};

const roundCode = (circuitId: string): string =>
  ROUND_CODES[circuitId] ?? circuitId.replace(/[^a-z]/g, "").slice(0, 3).toUpperCase();

const emptyTally = (): TeamTally =>
  ({ starts: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, points: 0 });

// ── Чистый разбор ───────────────────────────────────────────────────────────

/// Свод по строкам результатов (гонки или спринты). Строка = одна машина на
/// одном этапе, поэтому starts считает машино-старты: у двухмашинной команды
/// за уик-энд их два — так же, как очки начисляются обеим машинам.
export function tallyResults(races: any[], key: "Results" | "SprintResults"): TeamTally {
  const out = emptyTally();
  for (const race of races) {
    for (const row of race?.[key] ?? []) {
      const pos = Number(row?.position);
      out.starts += 1;
      out.points += Number(row?.points ?? 0);
      if (pos === 1) out.wins += 1;
      if (pos >= 1 && pos <= 3) out.podiums += 1;
      if (row?.FastestLap?.rank === "1") out.fastestLaps += 1;
      // Поул спринта отдельной выборкой не отдают: старт с первой позиции в
      // спринте и есть результат спринт-квалификации.
      if (key === "SprintResults" && Number(row?.grid) === 1) out.poles += 1;
    }
  }
  return out;
}

/// Поулы сезона: qualifying/1 у Jolpica подмешивает чужие строки, поэтому
/// берём полную выборку квалификаций и считаем настоящие первые места.
export function countPoles(races: any[]): number {
  let n = 0;
  for (const race of races) {
    for (const row of race?.QualifyingResults ?? []) {
      if (row?.position === "1") n += 1;
    }
  }
  return n;
}

/// Полоска формы: по пилоту — его результат на каждом этапе в порядке раундов.
export function buildForm(races: any[]): TeamDriverForm[] {
  const byDriver = new Map<string, TeamDriverForm>();
  for (const race of races) {
    for (const row of race?.Results ?? []) {
      const d = row?.Driver;
      if (!d?.driverId) continue;
      if (!byDriver.has(d.driverId)) {
        byDriver.set(d.driverId, {
          driverId: d.driverId,
          code: d.code ?? String(d.familyName ?? "").slice(0, 3).toUpperCase(),
          number: d.permanentNumber ?? null,
          name: `${String(d.givenName ?? "").slice(0, 1)}. ${d.familyName ?? ""}`.trim(),
          results: [],
          sprintWins: 0,
          qualiWins: 0,
        });
      }
      const pos = Number(row?.position);
      byDriver.get(d.driverId)!.results.push({
        round: Number(race.round),
        race: String(race.raceName ?? ""),
        position: Number.isFinite(pos) && pos > 0 ? pos : null,
        status: String(row?.status ?? ""),
      });
    }
  }
  for (const form of byDriver.values()) form.results.sort((a, b) => a.round - b.round);
  // Порядок пилотов — по числу этапов: основной состав раньше подменных.
  return [...byDriver.values()].sort((a, b) => b.results.length - a.results.length);
}

/// Победы в спринтах — по тем же строкам, что и свод спринтов.
export function applySprintWins(form: TeamDriverForm[], sprints: any[]): void {
  const byId = new Map(form.map((f) => [f.driverId, f]));
  for (const race of sprints) {
    for (const row of race?.SprintResults ?? []) {
      if (Number(row?.position) === 1) {
        const f = byId.get(row?.Driver?.driverId);
        if (f) f.sprintWins += 1;
      }
    }
  }
}

/// Квали-дуэль: на каждом этапе сравниваем позиции напарников и засчитываем
/// победу тому, кто впереди. Этапы, где выехал только один, не считаем — это
/// не дуэль, а отсутствие соперника.
export function applyQualiDuel(form: TeamDriverForm[], quali: any[]): void {
  const byId = new Map(form.map((f) => [f.driverId, f]));
  for (const race of quali) {
    const rows = (race?.QualifyingResults ?? [])
      .map((r: any) => ({ id: r?.Driver?.driverId, pos: Number(r?.position) }))
      .filter((r: any) => r.id && Number.isFinite(r.pos));
    if (rows.length < 2) continue;
    const best = rows.reduce((a: any, b: any) => (b.pos < a.pos ? b : a));
    const f = byId.get(best.id);
    if (f) f.qualiWins += 1;
  }
}

// ── Сеть ────────────────────────────────────────────────────────────────────

/// Все страницы выборки (у команды за сезон это одна-две сотни строк).
async function allRaces(path: string): Promise<any[] | null> {
  const out: any[] = [];
  for (let offset = 0; ; offset += 100) {
    const d = await fetchJSON(`${JOLPICA}/${path}.json?limit=100&offset=${offset}`);
    const races = d?.MRData?.RaceTable?.Races;
    if (!Array.isArray(races)) return null;
    out.push(...races);
    if (offset + 100 >= Number(d?.MRData?.total ?? 0)) return out;
    await sleep(400);
  }
}

async function total(path: string): Promise<number | null> {
  const d = await fetchJSON(`${JOLPICA}/${path}.json?limit=1`);
  const n = Number(d?.MRData?.total);
  return Number.isFinite(n) ? n : null;
}

interface Catalog {
  teams: Record<string, {
    base?: { country: string; city: string };
    home?: string;
    alsoIn?: string[];
  }>;
}

function loadCatalog(): Catalog {
  try {
    const raw = JSON.parse(readFileSync(join(TEAMS_DIR, "catalog.json"), "utf8"));
    if (raw?.teams) return { teams: raw.teams };
  } catch { /* fallthrough */ }
  console.log("::warning::teams/catalog.json не прочитался — база и домашняя трасса не попадут в выдачу");
  return { teams: {} };
}

interface State {
  version: number;
  fingerprint: string;
  /// Чемпион каждого сезона — прошлые не меняются, кэш вечный.
  champions: Record<string, string>;
  /// Всевременные победы и домашняя статистика: пересчитываются только после
  /// гонки, между прогонами живут здесь.
  raw: Record<string, number>;
}

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8"));
    if (s?.version === STATE_VERSION) {
      return {
        version: STATE_VERSION, fingerprint: String(s.fingerprint ?? ""),
        champions: s.champions ?? {}, raw: s.raw ?? {},
      };
    }
  } catch { /* нет файла — соберём с нуля */ }
  return { version: STATE_VERSION, fingerprint: "", champions: {}, raw: {} };
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

async function main() {
  console.log(`F1 teams, season ${YEAR}`);

  // Season guard — как у остальных продьюсеров: в переходном окне зеркало
  // расписания ещё про прошлый сезон, и писать нечего. Оттуда же берём имена
  // трасс: у домашней трассы этап может быть ещё не проехан, и в результатах
  // команды её просто нет.
  const circuitNames = new Map<string, string>();
  const rounds: SeasonRound[] = [];
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
    const table = d?.MRData?.RaceTable;
    const season = table?.season ?? null;
    if (season && scheduleSeasonMismatch(season, YEAR)) {
      console.warn(`teams: зеркало расписания за сезон ${season}, YEAR=${YEAR} — переходное окно, пропускаем`);
      return;
    }
    for (const race of table?.Races ?? []) {
      const c = race?.Circuit;
      if (c?.circuitId && c?.circuitName) circuitNames.set(String(c.circuitId), String(c.circuitName));
      const round = Number(race?.round);
      if (c?.circuitId && Number.isFinite(round)) {
        rounds.push({ round, code: roundCode(String(c.circuitId)), race: String(race?.raceName ?? "") });
      }
    }
    rounds.sort((a, b) => a.round - b.round);
  } catch { /* нет зеркала — идём дальше, гард не обязателен */ }

  // Зачёт конструкторов даёт и состав, и место с очками, и отпечаток для кэша.
  let rows: any[] = [];
  let fingerprint = "";
  try {
    const st = JSON.parse(readFileSync(join(JOLPICA_DIR, "current_constructorStandings.json"), "utf8"));
    const list = st?.MRData?.StandingsTable?.StandingsLists?.[0];
    rows = list?.ConstructorStandings ?? [];
    if (rows.length) {
      const vector = rows.map((r: any) => `${r?.Constructor?.constructorId}:${r?.points}:${r?.wins}`);
      fingerprint = `${list?.season}-${list?.round}-${hash(vector.sort().join("|"))}`;
    }
  } catch { /* нет зеркала — соберём состав из API ниже */ }
  if (!rows.length) {
    const d = await fetchJSON(`${JOLPICA}/${YEAR}/constructors.json?limit=40`);
    const list = d?.MRData?.ConstructorTable?.Constructors ?? [];
    if (!list.length) {
      console.warn("teams: состав сезона недоступен — пропускаем");
      return;
    }
    rows = list.map((c: any) => ({ Constructor: c, position: null, points: "0" }));
    console.log("::warning::teams: нет зеркала зачёта — место и очки будут пустыми");
  }

  const state = loadState();
  const fresh = fingerprint !== "" && state.fingerprint === fingerprint;
  const raw: Record<string, number> = fresh ? { ...state.raw } : {};
  const catalog = loadCatalog();
  const groups = groupById(await allConstructorIds());
  let fetched = 0;
  let failed = 0;
  const live = new Set<string>();
  const cached = async (key: string, get: () => Promise<number | null>): Promise<number> => {
    live.add(key);
    if (raw[key] != null) return raw[key];
    const n = await get();
    if (n == null) {
      failed++;
      return state.raw[key] ?? 0;
    }
    raw[key] = n;
    fetched++;
    return n;
  };

  // Чемпионы по сезонам — вечный кэш, добираем только недостающие годы.
  for (let season = FIRST_CONSTRUCTOR_SEASON; season <= YEAR; season++) {
    if (state.champions[season] != null) continue;
    const d = await fetchJSON(`${JOLPICA}/${season}/constructorStandings/1.json`);
    const champ = d?.MRData?.StandingsTable?.StandingsLists?.[0]
      ?.ConstructorStandings?.[0]?.Constructor?.constructorId;
    await sleep(400);
    // Текущий сезон не дописываем: чемпион ещё не определён.
    if (champ && season < YEAR) state.champions[season] = String(champ);
    else if (champ) console.log(`  сезон ${season} идёт — лидер ${champ}, титул не засчитан`);
  }

  const teams: TeamPage[] = [];
  for (const row of rows) {
    const c = row?.Constructor;
    const id = String(c?.constructorId ?? "");
    if (!id) continue;
    const facts = catalog.teams[id];
    const ids = groups[id] ?? [id];

    const seasonRaces = await allRaces(`${YEAR}/constructors/${id}/results`);
    await sleep(400);
    const sprints = await allRaces(`${YEAR}/constructors/${id}/sprint`);
    await sleep(400);
    const quali = await allRaces(`${YEAR}/constructors/${id}/qualifying`);
    await sleep(400);

    const gp = tallyResults(seasonRaces ?? [], "Results");
    gp.poles = countPoles(quali ?? []);
    const sprint = tallyResults(sprints ?? [], "SprintResults");

    // Всевременные победы — по всем историческим id команды.
    let allWins = 0;
    for (const historic of ids) {
      allWins += await cached(`${historic}:wins`, async () => {
        const n = await total(`constructors/${historic}/results/1`);
        await sleep(400);
        return n;
      });
    }
    const titles = Object.values(state.champions).filter((x) => ids.includes(x)).length;

    let home: TeamPage["home"];
    if (facts?.home) {
      const circuit = facts.home;
      const wins = await cached(`${id}:home:${circuit}:wins`, async () => {
        const n = await total(`constructors/${id}/circuits/${circuit}/results/1`);
        await sleep(400);
        return n;
      });
      const poles = await cached(`${id}:home:${circuit}:poles`, async () => {
        const races = await allRaces(`constructors/${id}/circuits/${circuit}/qualifying`);
        await sleep(400);
        return races == null ? null : countPoles(races);
      });
      // Имя — из расписания сезона: этап домашней трассы может быть впереди,
      // и в результатах команды его ещё нет.
      const name = circuitNames.get(circuit)
        ?? seasonRaces?.find((r: any) => r?.Circuit?.circuitId === circuit)?.Circuit?.circuitName;
      home = { circuitId: circuit, name: String(name ?? circuit), wins, poles };
    }

    // Первый сезон — вечный факт, спрашиваем один раз.
    const firstSeason = await cached(`${id}:firstSeason`, async () => {
      const d = await fetchJSON(`${JOLPICA}/constructors/${id}/seasons.json?limit=1`);
      await sleep(400);
      const y = Number(d?.MRData?.SeasonTable?.Seasons?.[0]?.season);
      return Number.isFinite(y) ? y : null;
    });

    const form = buildForm(seasonRaces ?? []);
    applySprintWins(form, sprints ?? []);
    applyQualiDuel(form, quali ?? []);
    const driverRecords: TeamPage["driverRecords"] = [];
    for (const d of form) {
      const wins = await cached(`${id}:driver:${d.driverId}:wins`, async () => {
        const n = await total(`drivers/${d.driverId}/constructors/${id}/results/1`);
        await sleep(400);
        return n;
      });
      driverRecords.push({ driverId: d.driverId, name: d.name, wins });
    }

    teams.push({
      constructorId: id,
      name: String(c?.name ?? id),
      base: facts?.base,
      position: Number(row?.position) || null,
      points: Number(row?.points ?? 0),
      gp, sprint,
      form,
      home,
      alsoIn: facts?.alsoIn ?? [],
      firstSeason: firstSeason || null,
      allTime: { wins: allWins, titles },
      driverRecords,
    });
  }

  if (!teams.length) {
    console.warn("teams: нечего писать — пропускаем");
    return;
  }

  const stamped = failed === 0 ? fingerprint : state.fingerprint;
  const kept = Object.fromEntries(Object.entries(raw).filter(([k]) => live.has(k)));
  writeIfChanged(STATE, JSON.stringify(
    { version: STATE_VERSION, fingerprint: stamped, champions: state.champions, raw: kept },
    null, 2) + "\n");
  if (failed) console.log(`::warning::teams: ${failed} запросов не ответили — часть цифр могла остаться прошлой`);

  const changed = writeJSONWithEnvelope(OUT, { season: YEAR, rounds, teams } satisfies SeasonTeams);
  console.log(
    `  ${teams.length} команд, запросов ${fetched} (кэш ${fresh ? "свежий" : "сброшен"}), титулов в базе ${Object.keys(state.champions).length} → ${changed ? "записано" : "без изменений"}`,
  );
  console.log("Done.");
}

/// Полный список конструкторов — для склейки исторических id (mclaren-ford).
async function allConstructorIds(): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const d = await fetchJSON(`${JOLPICA}/constructors.json?limit=100&offset=${offset}`);
    const list = d?.MRData?.ConstructorTable?.Constructors;
    if (!Array.isArray(list)) return ids;
    ids.push(...list.map((c: any) => String(c.constructorId)));
    if (offset + 100 >= Number(d?.MRData?.total ?? 0)) return ids;
    await sleep(400);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
