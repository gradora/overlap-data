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
import { scheduleSeasonMismatch } from "./season.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const OUT_DIR = join(process.cwd(), "data", "f1", "milestones");
const NOW = Date.now();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

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

/// Запись результатов считается СТАРТОМ (юбилеи и спецшлемы считают старты):
/// DNS/DNQ/Withdrew/Excluded — участие без старта, не в счёт. Пример: у
/// Албона за Williams 101 запись, но 99 стартов (DNS Сан-Паулу-24, Китай-26).
export function isStart(status: string, positionText: string): boolean {
  if (positionText === "W") return false;
  return !/^(did not start|withdr|did not qualify|did not prequalify|excluded)/i.test(status);
}

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

async function fetchJSON(url: string, attempt = 0): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    // Rate limit на длинных выгрузках: пауза и повтор, иначе гвард полноты
    // (completeLogs) отменяет пересчёт прошедших раундов целыми прогонами.
    if (res.status === 429 && attempt < 3) {
      clearTimeout(t);
      await new Promise((r) => setTimeout(r, 30000 * (attempt + 1)));
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

async function main() {
  console.log(`F1 milestones, season ${YEAR}`);
  let races: { round: string; date: string }[] = [];
  let scheduleSeason: string | null = null;
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
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

  const driversResp = await fetchJSON(`${JOLPICA}/${YEAR}/drivers.json?limit=40`);
  const drivers = driversResp?.MRData?.DriverTable?.Drivers ?? [];
  if (!drivers.length) {
    console.warn("milestones: пилоты сезона недоступны — пропускаем");
    return;
  }

  // Текущая команда пилота — из зеркала driverStandings (без сети).
  const teamOf = new Map<string, { id: string; name: string }>();
  try {
    const st = JSON.parse(readFileSync(join(JOLPICA_DIR, "current_driverStandings.json"), "utf8"));
    const rows = st?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings ?? [];
    for (const row of rows) {
      const c = row?.Constructors?.[0];
      if (row?.Driver?.driverId && c?.constructorId) {
        teamOf.set(row.Driver.driverId, { id: c.constructorId, name: c.name });
      }
    }
  } catch { /* нет зеркала стендингов — командные юбилеи пропустим */ }

  // Хронология реальных СТАРТОВ (карьерная и за текущую команду) — полная
  // выгрузка результатов с фильтром DNS/DNQ/W: MRData.total считает и
  // невыезды. Длина хронологии — прогноз будущих юбилеев; сама хронология —
  // фактические юбилеи прошедших раундов сезона (обратная сторона карусели).
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  async function startLog(pathBase: string): Promise<{ season: number; round: number }[] | null> {
    const log: { season: number; round: number }[] = [];
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

  const careerLogs = new Map<string, { season: number; round: number }[]>();
  const teamLogs = new Map<string, { log: { season: number; round: number }[]; team: string }>();
  for (const d of drivers) {
    const career = await startLog(`drivers/${d.driverId}/results`);
    if (career != null) careerLogs.set(d.driverId, career);
    await sleep(400);

    const team = teamOf.get(d.driverId);
    if (team) {
      const forTeam = await startLog(`drivers/${d.driverId}/constructors/${team.id}/results`);
      if (forTeam != null) teamLogs.set(d.driverId, { log: forTeam, team: team.name });
      await sleep(400);
    }
  }
  console.log(`  starts: ${careerLogs.size}/${drivers.length} пилотов (команда: ${teamLogs.size}), прошедших раундов: ${completedRounds}`);

  // Прошедшие раунды переписываем только при полном сборе хронологий: сетевой
  // пропуск пилота иначе стёр бы его уже записанный фактический юбилей.
  const completeLogs = careerLogs.size === drivers.length;

  for (const r of races) {
    const round = Number(r.round);
    const path = join(OUT_DIR, `${YEAR}_${round}.json`);
    const done = Date.parse(`${r.date}T23:59:59Z`) < NOW;
    if (done && !completeLogs) continue;

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
