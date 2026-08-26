// Продьюсер «New achievement» (юбилейные GP пилотов, кратные 50) для баннера
// THIS WEEKEND — источник карьерная статистика Jolpica: полные хронологии
// стартов пилотов (карьерная и за текущую команду) с фильтром DNS/DNQ/W.
// Прогноз стартов на раунд R: total − прошедшие_раунды + R (полное участие —
// как и анонсируют юбилеи). Файлы по раундам:
// data/f1/milestones/<season>_<round>.json. Замороженные раунды с файлом не
// перезаписываем (история).
//
// Сетевая фаза (~150 запросов: список пилотов + две хронологии на каждого)
// гейтится отпечатком зачёта (механика f1records/f1teams, lib/fingerprint):
// хронологии меняются ровно тогда, когда приезжают новые результаты, то есть
// вместе с вектором зачёта. Отпечаток совпал — полный набор хронологий
// поднимается из _state_<season>.json, запросов ноль. Осечка сети не портит
// накопленное: неполный набор хронологий не публикуется и не кэшируется,
// отпечаток не штампуется — следующий прогон дотянет.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "../lib/freeze.js";
import { scheduleMirrorFile, writeIfChanged, writeJSONWithEnvelope } from "../lib/mirror.js";
import { scheduleSeasonMismatch } from "../lib/season.js";
import { standingsFingerprint } from "../lib/fingerprint.js";
import { fetchJSON as httpJSON } from "../lib/http.js";
import { isStart } from "../lib/starts.js";
import { JOLPICA } from "../lib/sources.js";

const fetchJSON = (url: string) => httpJSON(url, { backoffMs: 30000 });

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const OUT_DIR = join(process.cwd(), "data", "f1", "milestones");
const STATE = join(OUT_DIR, `_state_${YEAR}.json`);
const NOW = Date.now();

const STATE_VERSION = 1;

export interface Achievement {
  driver: string;   // «F. Alonso»
  given?: string;   // «Fernando» — для подписи без дубля фамилии из заголовка
  count: number;    // 350
  team?: string;    // «Williams» — юбилей стартов ЗА КОМАНДУ (нет — карьерный)
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

/// Прогноз стартов пилота на раунд R сезона: старты сейчас + будущие гонки
/// до R включительно (прошлые пропуски пилота формулу не ломают — их нет ни
/// в startsNow, ни в добавке).
export function startsAtRound(totalNow: number, completedRounds: number, round: number): number {
  return totalNow - completedRounds + round;
}

/// Что считается стартом — общее правило для юбилеев и рекордов (они делят
/// один блок в приложении и обязаны считать одинаково).
export { isStart };

/// Фактические юбилеи прошедших этапов сезона: k-й старт хронологии (k кратен
/// 50), выпавший на сезон year → раунд → count. В отличие от прогнозной
/// startsAtRound не ломается пропусками пилота ВНУТРИ сезона (DNS Албона в
/// Китае-26 сдвигает его юбилей, прогнозная формула этого не видит назад).
export function seasonMilestones(
  log: { season: number; round: number }[],
  year: number,
): Map<number, number> {
  const map = new Map<number, number>();
  log.forEach((start, i) => {
    const count = milestoneCount(i + 1);
    if (count != null && start.season === year) map.set(start.round, count);
  });
  return map;
}

// ── Кэш хронологий ──────────────────────────────────────────────────────────

type StartLog = { season: number; round: number }[];

/// В состоянии хронология лежит парами [season, round]: у ветеранов по 400+
/// стартов и хронологий две на пилота — объекты раздули бы файл вчетверо.
export function packLog(log: StartLog): [number, number][] {
  return log.map((s) => [s.season, s.round]);
}

/// Обратная распаковка с проверкой формы. null — кэш битый: для вызывающего
/// это «кэша нет» (fail-open чтения), а не повод падать или верить мусору.
export function unpackLog(raw: unknown): StartLog | null {
  if (!Array.isArray(raw)) return null;
  const log: StartLog = [];
  for (const pair of raw) {
    const season = Number(pair?.[0]);
    const round = Number(pair?.[1]);
    if (!Array.isArray(pair) || !Number.isFinite(season) || !Number.isFinite(round)) return null;
    log.push({ season, round });
  }
  return log;
}

interface StateDriver {
  driverId: string;
  givenName: string;
  familyName: string;
}

interface State {
  version: number;
  season: number;
  fingerprint: string;
  drivers: StateDriver[];
  careerLogs: Record<string, [number, number][]>;
  teamLogs: Record<string, { team: string; log: [number, number][] }>;
}

function loadState(): State {
  const empty: State = {
    version: STATE_VERSION, season: YEAR, fingerprint: "",
    drivers: [], careerLogs: {}, teamLogs: {},
  };
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8"));
    if (s?.version === STATE_VERSION && s?.season === YEAR && Array.isArray(s?.drivers)) {
      return {
        version: STATE_VERSION, season: YEAR, fingerprint: String(s.fingerprint ?? ""),
        drivers: s.drivers, careerLogs: s.careerLogs ?? {}, teamLogs: s.teamLogs ?? {},
      };
    }
  } catch { /* нет файла — соберём с нуля */ }
  return empty;
}

/// Хронологии из состояния. null — кэш неполный или битый (нет пилота, не
/// распаковалась пара): пользоваться им нельзя, идём в сеть.
export function unpackState(state: {
  drivers: StateDriver[];
  careerLogs: Record<string, [number, number][]>;
  teamLogs: Record<string, { team: string; log: [number, number][] }>;
}): {
  careerLogs: Map<string, StartLog>;
  teamLogs: Map<string, { log: StartLog; team: string }>;
} | null {
  if (!state.drivers.length) return null;
  const careerLogs = new Map<string, StartLog>();
  const teamLogs = new Map<string, { log: StartLog; team: string }>();
  for (const d of state.drivers) {
    const career = unpackLog(state.careerLogs[d.driverId]);
    if (career == null) return null;   // кэш обязан крыть ВСЕХ пилотов
    careerLogs.set(d.driverId, career);
    const t = state.teamLogs[d.driverId];
    if (t != null) {
      const log = unpackLog(t.log);
      if (log == null || typeof t.team !== "string") return null;
      teamLogs.set(d.driverId, { log, team: t.team });
    }
  }
  return { careerLogs, teamLogs };
}


async function main() {
  console.log(`F1 milestones, season ${YEAR}`);
  let races: { round: string; date: string }[] = [];
  let scheduleSeason: string | null = null;
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, scheduleMirrorFile(YEAR)), "utf8"));
    const table = d?.MRData?.RaceTable;
    races = table?.Races ?? [];
    scheduleSeason = table?.season ?? null;
  } catch {
    console.warn("milestones: нет зеркала расписания — пропускаем");
    return;
  }
  // Гонка флипов: расписание чужого сезона даёт бессмысленный completedRounds
  // (все даты нового сезона «в будущем») — startsAtRound перезаписал бы
  // корректный архив прошлого года мусором. Пропускаем до синхронизации.
  if (scheduleSeasonMismatch(scheduleSeason, YEAR)) {
    console.warn(
      `milestones: зеркало расписания за сезон ${scheduleSeason}, YEAR=${YEAR} — переходное окно, пропускаем`,
    );
    return;
  }
  const completedRounds = races.filter((r) => Date.parse(`${r.date}T23:59:59Z`) < NOW).length;

  // Сезон целиком отстоялся (все раунды заморожены и файлы на месте) — юбилеи
  // уже история, сетевой фазе (список пилотов + ~20 карьерных totals) делать
  // нечего. Без раннего выхода декабрьские прогоны жгли бы ~20 тыс. пустых
  // запросов к Jolpica за межсезонье.
  const settled =
    races.length > 0 &&
    races.every(
      (r) =>
        isFrozen(Date.parse(`${r.date}T23:59:59Z`), NOW) &&
        existsSync(join(OUT_DIR, `${YEAR}_${Number(r.round)}.json`)),
    );
  if (settled) {
    console.log("milestones: сезон отстоялся — без сетевой фазы");
    return;
  }

  // Команда пилота и отпечаток зачёта — из одного зеркала driverStandings
  // (без сети). Очки меняются ровно тогда, когда приезжают новые результаты, —
  // значит и хронологии стартов имеет смысл перечитывать только тогда.
  const teamOf = new Map<string, { id: string; name: string }>();
  let fingerprint = "";
  try {
    const st = JSON.parse(readFileSync(join(JOLPICA_DIR, "current_driverStandings.json"), "utf8"));
    const list = st?.MRData?.StandingsTable?.StandingsLists?.[0];
    fingerprint = standingsFingerprint(list);
    for (const row of list?.DriverStandings ?? []) {
      const c = row?.Constructors?.[0];
      if (row?.Driver?.driverId && c?.constructorId) {
        teamOf.set(row.Driver.driverId, { id: c.constructorId, name: c.name });
      }
    }
  } catch { /* нет зеркала стендингов — командные юбилеи пропустим, кэш ниже отключён */ }
  if (!fingerprint) {
    console.log("::warning::milestones: нет зеркала зачёта — кэш хронологий отключён, прогон полный");
  }

  const state = loadState();
  const cache = fingerprint !== "" && state.fingerprint === fingerprint
    ? unpackState(state) : null;

  let drivers: StateDriver[];
  let careerLogs: Map<string, StartLog>;
  let teamLogs: Map<string, { log: StartLog; team: string }>;

  if (cache) {
    // Зачёт не менялся с последнего полного сбора — хронологии целиком из
    // кэша, сетевой фазы нет вовсе.
    drivers = state.drivers;
    ({ careerLogs, teamLogs } = cache);
    console.log(`  зачёт не менялся — хронологии из кэша (${drivers.length} пилотов), запросов 0`);
  } else {
    const driversResp = await fetchJSON(`${JOLPICA}/${YEAR}/drivers.json?limit=40`);
    const roster = driversResp?.MRData?.DriverTable?.Drivers ?? [];
    if (!roster.length) {
      console.warn("milestones: пилоты сезона недоступны — пропускаем");
      return;
    }
    drivers = roster.map((d: any) => ({
      driverId: String(d.driverId),
      givenName: String(d.givenName ?? ""),
      familyName: String(d.familyName ?? ""),
    }));

    // Хронология реальных СТАРТОВ (карьерная и за текущую команду) — полная
    // выгрузка результатов с фильтром DNS/DNQ/W: MRData.total считает и
    // невыезды. Длина хронологии — прогноз будущих юбилеев; сама хронология —
    // фактические юбилеи прошедших раундов сезона (обратная сторона карусели).
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

    async function startLog(pathBase: string): Promise<StartLog | null> {
      const log: StartLog = [];
      let offset = 0;
      while (true) {
        const resp = await fetchJSON(`${JOLPICA}/${pathBase}.json?limit=100&offset=${offset}`);
        const races = resp?.MRData?.RaceTable?.Races;
        if (!Array.isArray(races)) return null;   // сеть/лимит — не портим цифру
        for (const r of races) {
          const res = r?.Results?.[0];
          if (isStart(String(res?.status ?? ""), String(res?.positionText ?? ""))) {
            log.push({ season: Number(r.season), round: Number(r.round) });
          }
        }
        const total = Number(resp?.MRData?.total ?? 0);
        offset += 100;
        if (offset >= total) return log;
        await sleep(400);
      }
    }

    careerLogs = new Map();
    teamLogs = new Map();
    let misses = 0;
    for (const d of drivers) {
      const career = await startLog(`drivers/${d.driverId}/results`);
      if (career != null) careerLogs.set(d.driverId, career);
      else misses++;
      await sleep(400);

      const team = teamOf.get(d.driverId);
      if (team) {
        const forTeam = await startLog(`drivers/${d.driverId}/constructors/${team.id}/results`);
        if (forTeam != null) teamLogs.set(d.driverId, { log: forTeam, team: team.name });
        else misses++;
        await sleep(400);
      }
    }
    console.log(`  starts: ${careerLogs.size}/${drivers.length} пилотов (команда: ${teamLogs.size})`);

    // Осечка сети не портит накопленное: неполный набор хронологий не
    // публикуем вовсе (частичный прогон стирал бы из будущих файлов юбилеи
    // не ответивших пилотов, а из прошедших — записанные факты), не кэшируем
    // и отпечаток не штампуем. Прежние файлы остаются, следующий прогон дотянет.
    if (misses > 0) {
      console.log(`::warning::milestones: ${misses} хронологий не собрались — файлы не трогаем, отпечаток не штампуем`);
      return;
    }

    // Полный сбор — кэшируем под свежим отпечатком. Пустой отпечаток (нет
    // зеркала зачёта) кэш не оживит: проверка выше требует непустого совпадения.
    writeIfChanged(STATE, JSON.stringify({
      version: STATE_VERSION, season: YEAR, fingerprint, drivers,
      careerLogs: Object.fromEntries([...careerLogs].map(([id, log]) => [id, packLog(log)])),
      teamLogs: Object.fromEntries([...teamLogs].map(([id, t]) => [id, { team: t.team, log: packLog(t.log) }])),
    }, null, 2) + "\n");
  }
  console.log(`  прошедших раундов: ${completedRounds}`);

  for (const r of races) {
    const round = Number(r.round);
    const path = join(OUT_DIR, `${YEAR}_${round}.json`);
    const done = Date.parse(`${r.date}T23:59:59Z`) < NOW;

    const achievements: Achievement[] = [];
    for (const d of drivers) {
      const career = careerLogs.get(d.driverId);
      if (career == null) continue;
      const t = teamLogs.get(d.driverId);

      if (done) {
        // Фактические юбилеи из хронологии — что реально случилось в раунде.
        const count = seasonMilestones(career, YEAR).get(round);
        if (count != null) {
          achievements.push({ driver: shortName(d.givenName, d.familyName), given: d.givenName, count });
        }
        const teamCount = t ? seasonMilestones(t.log, YEAR).get(round) : undefined;
        if (teamCount != null) {
          achievements.push({
            driver: shortName(d.givenName, d.familyName), given: d.givenName,
            count: teamCount, team: t!.team,
          });
        }
        continue;
      }

      const starts = startsAtRound(career.length, completedRounds, round);
      const count = milestoneCount(starts);
      if (count != null) {
        achievements.push({ driver: shortName(d.givenName, d.familyName), given: d.givenName, count });
      }

      // Командный юбилей: кратный 50 старт за текущую команду.
      if (t) {
        const teamStarts = startsAtRound(t.log.length, completedRounds, round);
        const teamCount = milestoneCount(teamStarts);
        if (teamCount != null) {
          achievements.push({
            driver: shortName(d.givenName, d.familyName), given: d.givenName,
            count: teamCount, team: t.team,
          });
        }
      }
    }
    const out: RoundMilestones = { season: YEAR, round, achievements };
    const changed = writeJSONWithEnvelope(path, out);
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
