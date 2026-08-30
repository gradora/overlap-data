// Продьюсер заявки сезона с разрезолвленными личностями (D4 фазы 6).
// ЧИСТАЯ деривация из уже снятых зеркал — ноль сетевых запросов.
// Пишет data/f1/entrylist/<season>.json.
//
// Обоснование формы, ключа и того, почему слой выводится, а не курируется —
// в шапке lib/entrylist.ts.
//
// Пересобирает сезон целиком каждый прогон: деривация дешёвая, а
// writeJSONWithEnvelope держит git чистым.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mirrorSlug, writeJSONWithEnvelope } from "../lib/mirror.js";
import { loadRefs } from "../lib/refs.js";
import {
  ENTRYLIST_SCHEMA_VERSION, type JolpicaDriver, type OpenF1DriverRow,
  buildEntryList,
} from "../lib/entrylist.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const DATA_DIR = join(process.cwd(), "data");
const JOLPICA_DIR = join(DATA_DIR, "f1", "jolpica");
const OPENF1_DIR = join(DATA_DIR, "f1", "openf1");
const OUT_PATH = join(DATA_DIR, "f1", "entrylist", `${YEAR}.json`);

function readJSON(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/// Заявка сезона из зеркала. Год-именованный файл, а не `current_`: продьюсер
/// гоняют и по архивным сезонам.
export function readEntry(year: number, dir = JOLPICA_DIR): JolpicaDriver[] {
  const path = join(dir, mirrorSlug(`${year}/drivers.json?limit=100`));
  const doc = readJSON(path);
  return doc?.MRData?.DriverTable?.Drivers ?? [];
}

/// Строки пилотов по митингам сезона из зеркала OpenF1.
export function readMeetingRows(year: number, dir = OPENF1_DIR): Map<number, OpenF1DriverRow[]> {
  const out = new Map<number, OpenF1DriverRow[]>();
  const meetings = readJSON(join(dir, mirrorSlug(`meetings?year=${year}`)));
  if (!Array.isArray(meetings)) return out;
  for (const m of meetings) {
    const key = m?.meeting_key;
    if (typeof key !== "number") continue;
    const path = join(dir, mirrorSlug(`drivers?meeting_key=${key}`));
    if (!existsSync(path)) continue;
    const rows = readJSON(path);
    if (Array.isArray(rows)) out.set(key, rows);
  }
  return out;
}

/// `meetingKey` → (`driverId` → `constructorId`) по протоколам гонок.
///
/// Митинг сопоставляется раунду через витрину календаря: она единственная
/// знает эту связь и уже держит её в `sourceIds.openf1.meetingKey`. Спринт
/// читаем тоже — пилот мог проехать спринт и сойти в гонке.
export function constructorsByMeeting(year: number, dataDir = DATA_DIR): Map<number, Map<string, string>> {
  const out = new Map<number, Map<string, string>>();
  const cal = readJSON(join(dataDir, "f1", "calendar", `${year}.json`));
  const events = cal?.payload?.events ?? cal?.events;
  if (!Array.isArray(events)) return out;

  for (const e of events) {
    const mk = e?.sourceIds?.openf1?.meetingKey;
    const round = e?.sourceIds?.jolpica?.round;
    if (typeof mk !== "number" || typeof round !== "number") continue;
    const byDriver = new Map<string, string>();
    for (const kind of ["results", "sprint"]) {
      const doc = readJSON(join(dataDir, "f1", "jolpica", `${year}_${round}_${kind}.json`));
      const races = doc?.MRData?.RaceTable?.Races;
      if (!Array.isArray(races)) continue;
      for (const race of races) {
        for (const r of race?.Results ?? race?.SprintResults ?? []) {
          const did = r?.Driver?.driverId;
          const cid = r?.Constructor?.constructorId;
          // Гоночный протокол приоритетнее спринтового: он читается вторым
          // только если гонки ещё нет.
          if (did && cid && !byDriver.has(did)) byDriver.set(did, cid);
        }
      }
    }
    if (byDriver.size) out.set(mk, byDriver);
  }
  return out;
}

export async function main(): Promise<void> {
  console.log(`F1 entrylist, season ${YEAR}`);
  const entry = readEntry(YEAR);
  if (!entry.length) {
    console.warn("entrylist: зеркала заявки сезона нет — пропускаем прогон");
    return;
  }
  const rowsByMeeting = readMeetingRows(YEAR);
  if (!rowsByMeeting.size) {
    console.warn("entrylist: зеркал митингов нет — пропускаем прогон");
    return;
  }

  const list = buildEntryList({
    season: YEAR,
    entry,
    rowsByMeeting,
    exceptions: loadRefs()?.f1DriverAcronyms ?? [],
    constructorsByMeeting: constructorsByMeeting(YEAR),
  });

  const changed = writeJSONWithEnvelope(OUT_PATH, {
    season: list.season, drivers: list.drivers, unresolved: list.unresolved,
  }, ENTRYLIST_SCHEMA_VERSION);

  console.log(`  заявка ${entry.length}, в протоколах ${list.drivers.length}, ` +
              `не связано ${list.unresolved.length} → ${changed ? "записано" : "без изменений"}`);

  // Молчаливая дыра — худшее, что может сделать слой личностей: пилот просто
  // исчезает с экрана без следа. Поэтому нерезолв всегда виден в логе крона.
  if (list.unresolved.length) {
    const what = [...new Set(list.unresolved.map((u) => `${u.acronym}${u.lastName ? ` (${u.lastName})` : ""}`))];
    console.warn(`::warning::f1 entrylist ${YEAR}: не связаны с человеком — ${what.join(", ")}; ` +
      `если это настоящий пилот, добавь исключение в data/refs/matching.json → f1DriverAcronyms`);
  }
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
