// Оркестратор снапшотов IMSA. На каждый прогон:
//   1) сезон-индекс → раунды (только с WeatherTech-папкой);
//   2) для раунда: если снапшот уже finished — НЕ трогаем (заморожен), иначе
//      тянем уикенд, считаем статус, пишем файл;
//   3) POINTS DATA последнего сыгранного раунда → points.json;
//   4) собираем index.json из всех снапшотов.
// Пишем только изменившиеся файлы — git остаётся лёгким, а финалы вечны.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  fetchHTML, fetchJSON, files, lastHourFolder, mergeGTD, parsePointsTable,
  parseSession, pointsDataFolder, pointsFile, resultsFile, Round, rounds,
  sessionInstant, sessions, weatherTechFolder,
} from "./alkamel.js";
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

const fileNameFor = (r: Round): string =>
  `${String(r.ordinal).padStart(2, "0")}_${slugify(r.track)}.json`;

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

function buildSnapshot(r: Round, wtSessions: Session[], meta: WeekendMeta): EventSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    series: "imsa",
    season: YEAR,
    round: r.ordinal,
    slug: slugify(r.track),
    name: meta.eventName || r.track,
    venue: r.track,
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

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const seasonDir = `${YEAR % 100}_${YEAR}`;
  const seasonHTML = await fetchHTML([seasonDir]);
  if (!seasonHTML) {
    console.error(`Season index unavailable: ${seasonDir}`);
    process.exit(1);
  }
  const allRounds = rounds(seasonHTML);
  console.log(`Rounds in season ${YEAR}: ${allRounds.length}`);

  const indexEvents: IndexEvent[] = [];
  let wrote = 0;

  for (const r of allRounds) {
    const fname = fileNameFor(r);
    const outPath = join(OUT_DIR, fname);
    const existing = readJSON<EventSnapshot>(outPath);

    let snap: EventSnapshot;
    if (existing?.status === "finished") {
      snap = existing; // заморожен — не рескрейпим
      console.log(`  frozen  ${fname}`);
    } else {
      const weekend = await fetchWeekendSessions(seasonDir, r);
      if (!weekend) {
        console.log(`  skip    ${fname} (no WeatherTech yet)`);
        continue;
      }
      snap = buildSnapshot(r, weekend.sessions, weekend.meta);
      if (writeIfChanged(outPath, snap)) {
        wrote++;
        console.log(`  ${snap.status.padEnd(8)}${fname} (${snap.sessions.length} sessions)`);
      } else {
        console.log(`  same    ${fname}`);
      }
    }

    indexEvents.push({
      round: snap.round,
      slug: snap.slug,
      name: snap.name,
      venue: snap.venue,
      status: snap.status,
      start: snap.start,
      end: snap.end,
      resultsPath: `imsa/${YEAR}/${fname}`,
    });
  }

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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
