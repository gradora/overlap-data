// Документ зачётов сезона F1 — `f1/<год>/standings.json`, по образцу WEC/IMSA:
// оба зачёта одним файлом плюс раундовая раскладка очков.
//
// ЗАЧЕМ. Экран зачёта собирал раундовые колонки на КЛИЕНТЕ из 7–9 GET к
// кухне jolpica (два standings-файла + все страницы results и sprint сезона,
// 227–356 КБ). Замер: реально потребляемое подмножество — меньше половины, а
// аналогичный документ WEC — 40 КБ одним GET. Вместе с f1/calendar это
// снимает с кухни jolpica самый тяжёлый клиентский трафик — шаг к сплиту.
//
// Сборка БЕССЕТЕВАЯ, из год-именованных файлов зеркала этого же прогона.
// Живёт на шаге f1overrides по прецеденту витрины календаря: он единственный
// стоит после всех входов, и нового шага воркфлоу не появляется.

import { join } from "node:path";
import { mirrorSlug, writeJSONWithEnvelope } from "./mirror.js";
import { readJolpicaSeason, readPrev, type JolpicaRace } from "./f1calendar.js";

export const F1_STANDINGS_SCHEMA_VERSION = 1;

/// Очки этапа одной строки зачёта. `classified` false — дэш DNF/DNS/DSQ в
/// колонке (клиент рисовал его по positionText).
export interface F1StagePoints {
  round: number;
  race?: { points: number; classified: boolean };
  sprint?: { points: number; classified: boolean };
}

export interface F1DriverRow {
  position: number;
  driverId: string;
  givenName: string;
  familyName: string;
  code?: string;
  permanentNumber?: number;
  nationality?: string;
  /// Первый конструктор строки — как берёт клиент (.first).
  constructorId?: string;
  constructorName?: string;
  points: number;
  wins: number;
  stages: F1StagePoints[];
}

export interface F1ConstructorRow {
  position: number;
  constructorId: string;
  name: string;
  nationality?: string;
  points: number;
  wins: number;
  stages: F1StagePoints[];
}

/// Этап сезона — колонка таблицы. `locality` — город из расписания: заголовок
/// колонки клиент делает из него сам (тот же acronym, что и раньше).
export interface F1StandingsRound {
  round: number;
  locality?: string;
  sprint?: boolean;
  /// Победитель спринта — для дуэлей поиска (прежний fetchSprintWins).
  sprintWinner?: { driverId?: string; constructorId?: string };
}

export interface F1StandingsDoc {
  series: "f1";
  season: number;
  /// Сезон завершён и отстоялся — файл больше не изменится.
  frozen: boolean;
  rounds: F1StandingsRound[];
  drivers: F1DriverRow[];
  constructors: F1ConstructorRow[];
}

interface StandingsList {
  season?: string | number;
  DriverStandings?: any[];
  ConstructorStandings?: any[];
}

function standingsList(root: string, year: number, file: string): StandingsList | null {
  const doc = readPrev<any>(join(root, "f1", "jolpica", mirrorSlug(`${year}_${file}.json`)));
  const list = doc?.MRData?.StandingsTable?.StandingsLists?.[0];
  if (!list) return null;
  // Season-guard: год-именованный файл обязан нести свой сезон.
  if (String(doc?.MRData?.StandingsTable?.season ?? list.season ?? "") !== String(year)) {
    console.warn(`::warning::f1 standings ${year}: файл ${file} за чужой сезон — пропуск`);
    return null;
  }
  return list;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/// Очки по раундам из строк протоколов. Ключ — driverId либо constructorId;
/// у конструктора очки этапа — СУММА обеих машин (клиент считал так же).
function stagePointsBy(
  races: JolpicaRace[], key: (row: any) => string | undefined, resultsField: string,
): Map<string, Map<number, { points: number; classified: boolean }>> {
  const out = new Map<string, Map<number, { points: number; classified: boolean }>>();
  for (const race of races) {
    const round = num(race.round);
    for (const row of (race as any)[resultsField] ?? []) {
      const id = key(row);
      if (!id) continue;
      const byRound = out.get(id) ?? new Map();
      const prev = byRound.get(round) ?? { points: 0, classified: false };
      // positionText не-числовой — DNF/DNS/DSQ; классифицирован хотя бы один
      // результат раунда (для конструктора — хотя бы одна машина).
      const classified = /^\d+$/.test(String(row.positionText ?? ""));
      byRound.set(round, {
        points: prev.points + num(row.points),
        classified: prev.classified || classified,
      });
      out.set(id, byRound);
    }
  }
  return out;
}

function stagesFor(
  id: string, rounds: number[],
  race: Map<string, Map<number, { points: number; classified: boolean }>>,
  sprint: Map<string, Map<number, { points: number; classified: boolean }>>,
): F1StagePoints[] {
  const out: F1StagePoints[] = [];
  for (const round of rounds) {
    const r = race.get(id)?.get(round);
    const s = sprint.get(id)?.get(round);
    if (!r && !s) continue;   // этап ещё не сыгран — колонки просто нет
    out.push({ round, ...(r ? { race: r } : {}), ...(s ? { sprint: s } : {}) });
  }
  return out;
}

/// Документ зачётов сезона, или null — когда в зеркале нет зачётов (сезон не
/// начался: jolpica отдаёт пустой список, и файл-пустышка врал бы клиенту).
export function buildF1StandingsDoc(root: string, year: number): F1StandingsDoc | null {
  const season = readJolpicaSeason(root, year);
  const driverList = standingsList(root, year, "driverStandings");
  const constructorList = standingsList(root, year, "constructorStandings");
  const driverRows: any[] = driverList?.DriverStandings ?? [];
  const constructorRows: any[] = constructorList?.ConstructorStandings ?? [];
  if (!driverRows.length && !constructorRows.length) return null;

  const results = season?.results ?? [];
  const sprints = season?.sprints ?? [];
  const raceByDriver = stagePointsBy(results, (r) => r.Driver?.driverId, "Results");
  const sprintByDriver = stagePointsBy(sprints, (r) => r.Driver?.driverId, "SprintResults");
  const raceByTeam = stagePointsBy(results, (r) => r.Constructor?.constructorId, "Results");
  const sprintByTeam = stagePointsBy(sprints, (r) => r.Constructor?.constructorId, "SprintResults");

  // Этапы — сыгранные раунды из результатов; локality — из расписания.
  const played = [...new Set([...results, ...sprints].map((r) => num(r.round)))]
    .sort((a, b) => a - b);
  const localityByRound = new Map(
    (season?.schedule ?? []).map((r) => [num(r.round), r.Circuit?.Location?.locality]));
  const sprintRounds = new Set(sprints.map((r) => num(r.round)));
  const rounds: F1StandingsRound[] = played.map((round) => {
    const winner = sprints.find((r) => num(r.round) === round)
      ?.SprintResults?.find((row: any) => String(row.position) === "1") as any;
    return {
      round,
      ...(localityByRound.get(round) ? { locality: localityByRound.get(round) } : {}),
      ...(sprintRounds.has(round) ? { sprint: true } : {}),
      ...(winner ? {
        sprintWinner: {
          ...(winner.Driver?.driverId ? { driverId: winner.Driver.driverId } : {}),
          ...(winner.Constructor?.constructorId
            ? { constructorId: winner.Constructor.constructorId } : {}),
        },
      } : {}),
    };
  });
  const playedList = played;

  const drivers: F1DriverRow[] = driverRows.map((r) => {
    const d = r.Driver ?? {};
    const c = (r.Constructors ?? [])[0] ?? {};
    return {
      position: num(r.position),
      driverId: String(d.driverId ?? ""),
      givenName: String(d.givenName ?? ""),
      familyName: String(d.familyName ?? ""),
      ...(d.code ? { code: String(d.code) } : {}),
      ...(d.permanentNumber ? { permanentNumber: num(d.permanentNumber) } : {}),
      ...(d.nationality ? { nationality: String(d.nationality) } : {}),
      ...(c.constructorId ? { constructorId: String(c.constructorId) } : {}),
      ...(c.name ? { constructorName: String(c.name) } : {}),
      points: num(r.points),
      wins: num(r.wins),
      stages: stagesFor(String(d.driverId ?? ""), playedList, raceByDriver, sprintByDriver),
    };
  });

  const constructors: F1ConstructorRow[] = constructorRows.map((r) => {
    const c = r.Constructor ?? {};
    return {
      position: num(r.position),
      constructorId: String(c.constructorId ?? ""),
      name: String(c.name ?? ""),
      ...(c.nationality ? { nationality: String(c.nationality) } : {}),
      points: num(r.points),
      wins: num(r.wins),
      stages: stagesFor(String(c.constructorId ?? ""), playedList, raceByTeam, sprintByTeam),
    };
  });

  // Заморозка — по витрине календаря: сезон завершён и отстоялся.
  const cal = readPrev<any>(join(root, "f1", "calendar", `${year}.json`));
  const frozen = Boolean(cal?.payload?.frozen ?? cal?.frozen ?? false);

  return { series: "f1", season: year, frozen, rounds, drivers, constructors };
}

/// Пишет документ; вернёт исход для лога.
export function writeF1StandingsFile(root: string, year: number): string {
  const doc = buildF1StandingsDoc(root, year);
  if (!doc) return `standings ${year}: зачётов в зеркале нет — пропуск`;
  const changed = writeJSONWithEnvelope(
    join(root, "f1", String(year), "standings.json"), doc, F1_STANDINGS_SCHEMA_VERSION);
  return `standings ${year}: ${changed ? "written" : "unchanged"} ` +
    `(${doc.drivers.length} пилотов, ${doc.constructors.length} команд, ${doc.rounds.length} этапов)`;
}
