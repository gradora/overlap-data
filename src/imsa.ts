// Оркестратор снапшотов IMSA. Расписание-driven: индекс строится из курируемого
// расписания сезона (все 11 раундов, включая БУДУЩИЕ), а прошедшие/текущие
// обогащаются скрейпом Al Kamel. На каждый прогон:
//   1) курируемое расписание сезона (schedule.ts) — каркас индекса;
//   2) сезон-индекс Al Kamel → раунды; матч к расписанию по трассе;
//   3) сматченный раунд: finished — заморожен; иначе тянем уикенд, пишем файл;
//   4) будущий раунд (нет данных) — только запись в index (status upcoming);
//   5) POINTS DATA последнего сыгранного раунда → points.json.
// Пишем только изменившиеся файлы — git лёгкий, финалы вечны.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  fetchHTML, fetchJSON, files, lastHourFolder, mergeGTD, parsePointsTable,
  parseSession, pointsDataFolder, pointsFile, resultsFile, Round, rounds,
  sessionInstant, sessions, wallClockISO, weatherTechFolder,
} from "./alkamel.js";
import { isFrozen } from "./freeze.js";
import { matchTrack, SCHEDULE, ScheduleEntry } from "./schedule.js";
import {
  EventSnapshot, EventStatus, IndexEvent, OfficialPoints, PointsEntry,
  RaceClass, SCHEMA_VERSION, SeasonIndex, Session,
} from "./types.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const DATA_ROOT = join(process.cwd(), "data");
const OUT_DIR = join(DATA_ROOT, "imsa", String(YEAR));
const NOW = Date.now();
const FINISH_AFTER_MS = 30 * 3600 * 1000; // окно «уикенд ещё live», потом freeze

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const fileNameFor = (entry: ScheduleEntry): string =>
  `${String(entry.round).padStart(2, "0")}_${slugify(entry.venue)}.json`;

function readJSON<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// Пишем только если ИЗМЕНИЛИСЬ ДАННЫЕ (generatedAt игнорируем — иначе файл
// дёргался бы каждый прогон из-за таймстампа и плодил бы пустые коммиты).
// Итог: generatedAt = «когда данные реально обновились», не «когда бегал джоб».
const withoutTimestamp = (s: string): string =>
  s.replace(/"generatedAt": "[^"]*"/g, '"generatedAt": ""');

function writeIfChanged(path: string, obj: unknown): boolean {
  const next = JSON.stringify(obj, null, 1) + "\n";
  if (existsSync(path)) {
    const prev = readFileSync(path, "utf8");
    if (withoutTimestamp(prev) === withoutTimestamp(next)) return false;
  }
  writeFileSync(path, next);
  return true;
}

// MARK: Уикенд одного раунда

interface WeekendMeta {
  eventName: string;
  circuitName: string | null;
  circuitLengthM: number | null;
}

async function fetchWeekendSessions(
  seasonDir: string,
  r: Round,
): Promise<{ sessions: Session[]; meta: WeekendMeta } | null> {
  const roundHTML = await fetchHTML([seasonDir, r.folder]);
  if (!roundHTML) return null;
  const wt = weatherTechFolder(roundHTML);
  if (!wt) return null; // раунд-суппорт без WeatherTech
  const wtHTML = await fetchHTML([seasonDir, r.folder, wt]);
  if (!wtHTML) return null;
  const refs = sessions(wtHTML);
  const meta: WeekendMeta = { eventName: "", circuitName: null, circuitLengthM: null };
  if (refs.length === 0) return { sessions: [], meta };

  const out: Session[] = [];
  for (const ref of refs) {
    const basePath = [seasonDir, r.folder, wt, ref.folder];
    const html = await fetchHTML(basePath);
    let parsed = null;
    if (html) {
      const file = resultsFile(html);
      let path = file ? [...basePath, file] : null;
      if (!file) {
        // Эндуранс: результаты в последней часовой подпапке.
        const hour = lastHourFolder(html);
        if (hour) {
          const hourHTML = await fetchHTML([...basePath, hour]);
          const hourFile = hourHTML ? resultsFile(hourHTML) : undefined;
          if (hourFile) path = [...basePath, hour, hourFile];
        }
      }
      if (path) {
        const json = await fetchJSON(path);
        if (json) parsed = parseSession(json);
      }
    }
    if (parsed) {
      // Метаданные уикенда — из первой сессии, что их отдала.
      if (!meta.eventName && parsed.eventName) meta.eventName = parsed.eventName;
      if (!meta.circuitName && parsed.circuitName) meta.circuitName = parsed.circuitName;
      if (meta.circuitLengthM === null && parsed.circuitLengthM !== null)
        meta.circuitLengthM = parsed.circuitLengthM;
    }
    out.push({
      name: ref.name,
      type: parsed?.sessionType ?? "",
      start: sessionInstant(ref.wallClock, r.track).toISOString(),
      wallClock: wallClockISO(ref.wallClock),
      hasResults: parsed !== null,
      rows: parsed?.rows ?? [],
    });
  }
  return { sessions: out, meta };
}

function computeStatus(sessionsList: Session[]): EventStatus {
  if (sessionsList.length === 0) return "upcoming";
  const last = sessionsList[sessionsList.length - 1];
  const lastStart = last.start ? Date.parse(last.start) : NaN;
  if (last.hasResults && !Number.isNaN(lastStart) && NOW - lastStart > FINISH_AFTER_MS)
    return "finished";
  const anyPast = sessionsList.some(
    (s) => s.start && Date.parse(s.start) <= NOW,
  );
  const anyResults = sessionsList.some((s) => s.hasResults);
  return anyPast || anyResults ? "live" : "upcoming";
}

function buildSnapshot(entry: ScheduleEntry, wtSessions: Session[], meta: WeekendMeta): EventSnapshot {
  // venue/round/name — из расписания (стабильны и совпадают с календарём
  // приложения); circuit* и сессии — из скрейпа.
  return {
    schemaVersion: SCHEMA_VERSION,
    series: "imsa",
    season: YEAR,
    round: entry.round,
    slug: slugify(entry.venue),
    name: meta.eventName || entry.name,
    venue: entry.venue,
    circuitName: meta.circuitName,
    circuitLengthM: meta.circuitLengthM,
    status: computeStatus(wtSessions),
    start: wtSessions[0]?.start ?? null,
    end: wtSessions[wtSessions.length - 1]?.start ?? null,
    sessions: wtSessions,
    generatedAt: new Date(NOW).toISOString(),
  };
}

// MARK: POINTS DATA (последний сыгранный раунд)

async function fetchPoints(
  seasonDir: string,
  latestFirst: Round[],
): Promise<OfficialPoints | null> {
  for (const r of latestFirst) {
    const roundHTML = await fetchHTML([seasonDir, r.folder]);
    const wt = roundHTML ? weatherTechFolder(roundHTML) : undefined;
    if (!wt) continue;
    const wtHTML = await fetchHTML([seasonDir, r.folder, wt]);
    const pd = wtHTML ? pointsDataFolder(wtHTML) : undefined;
    if (!pd) continue;
    const pdHTML = await fetchHTML([seasonDir, r.folder, wt, pd]);
    if (!pdHTML) continue;
    const fileList = files(pdHTML);
    const points = await assemblePoints([seasonDir, r.folder, wt, pd], fileList);
    if (points) return points;
  }
  return null;
}

async function assemblePoints(
  path: string[],
  fileList: string[],
): Promise<OfficialPoints | null> {
  const CLASSES = ["GTP", "LMP2", "GTDPRO", "GTD"] as const;
  const tables: Record<string, PointsEntry[]> = {};
  for (const cls of CLASSES) {
    for (const table of ["Drivers", "Teams"] as const) {
      const file = pointsFile(fileList, cls, table);
      if (!file) continue;
      const json = await fetchJSON([...path, file]);
      const entries = json ? parsePointsTable(json) : null;
      if (entries) tables[`${cls}|${table}`] = entries;
    }
  }
  const assemble = (table: string): Partial<Record<RaceClass, PointsEntry[]>> => {
    const out: Partial<Record<RaceClass, PointsEntry[]>> = {};
    if (tables[`GTP|${table}`]) out.GTP = tables[`GTP|${table}`];
    if (tables[`LMP2|${table}`]) out.LMP2 = tables[`LMP2|${table}`];
    const pro = tables[`GTDPRO|${table}`] ?? [];
    const gtd = tables[`GTD|${table}`] ?? [];
    if (pro.length || gtd.length) out.GTD = mergeGTD(pro, gtd);
    return out;
  };
  const result: OfficialPoints = {
    drivers: assemble("Drivers"),
    teams: assemble("Teams"),
  };
  const empty =
    Object.keys(result.drivers).length === 0 &&
    Object.keys(result.teams).length === 0;
  return empty ? null : result;
}

// MARK: main

// Снапшоты раундов сезона уже существуют (NN_*.json)? Отличает пред-сезонье
// (папки сезона на Al Kamel ещё нет — штатно, индекс собираем из расписания)
// от аутэйджа источника посреди сезона (валимся, чтобы не деградировать
// живые данные в upcoming).
export function hasSeasonSnapshots(fileNames: string[]): boolean {
  return fileNames.some((f) => /^\d{2}_.+\.json$/.test(f));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const schedule = SCHEDULE[YEAR] ?? [];
  if (schedule.length === 0) {
    console.error(`No curated schedule for ${YEAR} — add it to src/schedule.ts`);
    process.exit(1);
  }
  const seasonDir = `${YEAR % 100}_${YEAR}`;
  const seasonHTML = await fetchHTML([seasonDir]);
  let allRounds: Round[] = [];
  if (seasonHTML) {
    allRounds = rounds(seasonHTML);
  } else {
    // Папку сезона Al Kamel создаёт ближе к первому этапу (Дайтона — конец
    // января). Пока снапшотов сезона нет — это пред-сезонье: календарь в
    // приложении нужен уже 1 января, поэтому пишем индекс из курируемого
    // расписания (все upcoming), результаты подтянутся с появлением папки.
    // А вот при живых снапшотах отсутствие индекса — аутэйдж: fail-loud.
    let existing: string[] = [];
    try {
      existing = readdirSync(OUT_DIR);
    } catch {
      /* директории нет — снапшотов точно нет */
    }
    if (hasSeasonSnapshots(existing)) {
      console.error(`Season index unavailable: ${seasonDir}`);
      process.exit(1);
    }
    console.warn(`Season index unavailable: ${seasonDir} — пред-сезонье, индекс из курируемого расписания`);
  }
  console.log(`Season ${YEAR}: ${schedule.length} scheduled rounds, ${allRounds.length} Al Kamel rounds`);

  const indexEvents: IndexEvent[] = [];
  const trackNames = allRounds.map((r) => r.track);
  let wrote = 0;
  // Staleness-guard курируемого расписания: этап, чей endDate прошёл (+grace),
  // но так и не сматчился/не скрейпнулся (остался upcoming) — самая опасная тихая
  // поломка (venue-переименование → matchTrack промахнулся → результаты зависли
  // в upcoming навсегда). Собираем и печатаем ::warning:: (не валим прогон).
  const SCHEDULE_GRACE_MS = 48 * 3600 * 1000;
  const scheduleDrift: string[] = [];

  for (const entry of schedule) {
    const fname = fileNameFor(entry);
    const outPath = join(OUT_DIR, fname);
    const existing = readJSON<EventSnapshot>(outPath);
    const matchedTrack = matchTrack(entry.venue, trackNames);
    const matched = matchedTrack ? allRounds.find((r) => r.track === matchedTrack) : undefined;

    let snap: EventSnapshot | null = null;
    // Freeze по возрасту финиша (7д), а НЕ сразу при status=finished: результат
    // ещё может измениться штрафом/апелляцией в первые ~72ч. existing.end —
    // старт последней сессии (окно 7д с запасом перекрывает длину гонки).
    const frozen = existing?.status === "finished" &&
      isFrozen(existing.end ? Date.parse(existing.end) : null, NOW);
    if (frozen) {
      snap = existing!; // оседание завершилось — не рескрейпим
      console.log(`  frozen  R${entry.round} ${fname}`);
    } else if (matched) {
      const weekend = await fetchWeekendSessions(seasonDir, matched);
      if (weekend && weekend.sessions.length > 0) {
        snap = buildSnapshot(entry, weekend.sessions, weekend.meta);
        if (writeIfChanged(outPath, snap)) {
          wrote++;
          console.log(`  ${snap.status.padEnd(8)}R${entry.round} ${fname} (${snap.sessions.length} sessions)`);
        } else {
          console.log(`  same    R${entry.round} ${fname}`);
        }
      }
    }

    if (snap) {
      indexEvents.push({
        round: entry.round, slug: snap.slug, name: snap.name, venue: entry.venue,
        status: snap.status, start: snap.start, end: snap.end,
        resultsPath: `imsa/${YEAR}/${fname}`,
      });
    } else {
      // Будущий раунд (Al Kamel ещё не создал папку) — только в индекс, даты из
      // расписания, без файла результатов.
      console.log(`  upcoming R${entry.round} ${slugify(entry.venue)}`);
      // Drift: endDate прошёл (+grace), а результатов так и нет → этап навсегда
      // завис в upcoming. Причина обычно — рассинхрон venue↔track (matchTrack).
      if (Date.parse(`${entry.endDate}T23:59:59Z`) + SCHEDULE_GRACE_MS < NOW) {
        scheduleDrift.push(
          `R${entry.round} «${entry.venue}» (${entry.endDate}) прошёл, но не сматчился с Al Kamel — результаты зависли в upcoming (проверь venue↔track в src/schedule.ts)`,
        );
      }
      indexEvents.push({
        round: entry.round, slug: slugify(entry.venue), name: entry.name, venue: entry.venue,
        status: "upcoming",
        start: `${entry.startDate}T00:00:00.000Z`,
        end: `${entry.endDate}T00:00:00.000Z`,
        resultsPath: null,
      });
    }
  }

  // Сигнал протухания курируемого расписания (не валит прогон — только лог).
  for (const d of scheduleDrift) console.warn(`::warning::IMSA schedule drift: ${d}`);

  // POINTS DATA (последний сыгранный раунд).
  const latestFirst = [...allRounds].sort((a, b) => b.ordinal - a.ordinal);
  const points = await fetchPoints(seasonDir, latestFirst);
  if (points) {
    const pPath = join(OUT_DIR, "points.json");
    if (writeIfChanged(pPath, { schemaVersion: SCHEMA_VERSION, series: "imsa", season: YEAR, generatedAt: new Date(NOW).toISOString(), points })) {
      wrote++;
      console.log("  points.json updated");
    }
  }

  const index: SeasonIndex = {
    schemaVersion: SCHEMA_VERSION,
    series: "imsa",
    season: YEAR,
    generatedAt: new Date(NOW).toISOString(),
    events: indexEvents.sort((a, b) => a.round - b.round),
  };
  if (writeIfChanged(join(OUT_DIR, "index.json"), index)) wrote++;

  console.log(`Done. ${indexEvents.length} events, ${wrote} files changed.`);
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
