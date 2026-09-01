// Продьюсер файла события F1 — ЧИСТАЯ проекция уже собранных семейств и
// зеркала openf1, ноль сетевых запросов. Пишет data/f1/events/<eventKey>.json
// и — с поставкой D4 — классифицированный рейс-контрол
// data/f1/racecontrol/<id события>.json (отдельным файлом, как погода: он
// нужен только ленте Recap прошедшего уик-энда, а вербатима в нём нет по
// построению — см. lib/racecontrol.ts).
//
// Обоснование формы (проекция, а не накопитель), состава блоков и того, чего
// здесь намеренно нет — в lib/eventfile.ts. Ключ файла и его стабильность —
// в lib/eventkey.ts.
//
// Пересобирает ВСЕ события витрины каждый прогон: деривация дешёвая, а
// writeJSONWithEnvelope держит git чистым, поэтому обновление формата само
// доезжает до архива без ручных прогонов.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJSONWithEnvelope } from "../lib/mirror.js";
import {
  EVENT_FILE_SCHEMA_VERSION, type EventEntryDriver, buildEventFile, eventFilePath,
} from "../lib/eventfile.js";
import { buildProtocolsBlock } from "../lib/f1protocols.js";
import { buildRaceControlDoc, writeRaceControl } from "../lib/racecontrolbuild.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const DATA_DIR = join(process.cwd(), "data");
const OUT_DIR = join(DATA_DIR, "f1", "events");

function readJSON(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;   // файла нет или он бит — блока просто не будет
  }
}

/// Событие витрины в том минимуме, который нужен проекции.
interface ShowcaseEvent {
  id: string;
  eventKey?: string;
  round: number;
  sourceIds?: { openf1?: { meetingKey?: number } | null };
}

export function readShowcase(season: number, dataDir = DATA_DIR): ShowcaseEvent[] {
  const doc = readJSON(join(dataDir, "f1", "calendar", `${season}.json`)) as
    { payload?: { events?: ShowcaseEvent[] }; events?: ShowcaseEvent[] } | null;
  return doc?.payload?.events ?? doc?.events ?? [];
}

/// Срез заявки сезона по одному митингу: у каждого пилота ровно одно место.
/// Пилот, проехавший митинг за две команды (такое бывает у резервистов между
/// РАЗНЫМИ митингами, внутри одного — нет), взял бы первое по номеру.
export function entryForMeeting(list: any, meetingKey: number): EventEntryDriver[] {
  const drivers = list?.payload?.drivers ?? list?.drivers;
  if (!Array.isArray(drivers)) return [];
  const out: EventEntryDriver[] = [];
  for (const d of drivers) {
    const seat = (d.seats ?? []).find((s: any) => s.meetingKey === meetingKey);
    if (!seat) continue;
    out.push({
      driverId: d.driverId,
      acronym: seat.acronym,
      givenName: d.givenName,
      familyName: d.familyName,
      ...(d.nationality ? { nationality: d.nationality } : {}),
      car: seat.car,
      ...(seat.team ? { team: seat.team } : {}),
      ...(seat.teamColour ? { teamColour: seat.teamColour } : {}),
      ...(seat.constructorId ? { constructorId: seat.constructorId } : {}),
    });
  }
  return out.sort((a, b) => a.car - b.car);
}

export async function main(): Promise<void> {
  console.log(`F1 events, season ${YEAR}`);
  const events = readShowcase(YEAR);
  const entryList = readJSON(join(DATA_DIR, "f1", "entrylist", `${YEAR}.json`));
  if (!events.length) {
    console.warn("events: витрины календаря нет — пропускаем прогон");
    return;
  }

  let written = 0, unchanged = 0, empty = 0, noKey = 0, rcWritten = 0;
  for (const e of events) {
    if (!e.eventKey) {
      // Витрина прошлой версии: ключа ещё нет. Молча пропустить нельзя —
      // иначе «файлов нет» будет неотличимо от «событий нет».
      noKey++;
      continue;
    }
    const round = e.round;
    const family = (name: string) =>
      round >= 1 ? readJSON(join(DATA_DIR, "f1", name, `${YEAR}_${round}.json`)) : null;

    const meetingKey = e.sourceIds?.openf1?.meetingKey;
    if (meetingKey != null) {
      const rc = buildRaceControlDoc(DATA_DIR, YEAR, e.id, meetingKey);
      if (rc && writeRaceControl(DATA_DIR, rc)) rcWritten++;
    }
    const file = buildEventFile({
      season: YEAR,
      eventKey: e.eventKey,
      eventId: e.id,
      round,
      entry: meetingKey != null ? entryForMeeting(entryList, meetingKey) : [],
      protocols: meetingKey != null ? buildProtocolsBlock(DATA_DIR, meetingKey) : null,
      fia: family("fia"),
      winners: family("winners"),
      highlights: family("highlights"),
      milestones: family("milestones"),
    });
    if (!file) {
      // Оверлейные этапы (тесты, отмены) round-keyed семейств не имеют вовсе —
      // собирать нечего. Пустой файл не пишем: см. buildEventFile.
      empty++;
      continue;
    }
    const changed = writeJSONWithEnvelope(
      join(OUT_DIR, eventFilePath(e.eventKey)), file, EVENT_FILE_SCHEMA_VERSION);
    if (changed) written++; else unchanged++;
  }

  console.log(`  событий ${events.length}: записано ${written}, без изменений ${unchanged}, ` +
              `без блоков ${empty}, рейс-контрол обновлён у ${rcWritten}` +
              (noKey ? `, БЕЗ КЛЮЧА ${noKey}` : ""));
  if (noKey) {
    console.warn(`::warning::f1 events: у ${noKey} событий витрины нет eventKey — ` +
      `календарь собран прошлой версией, файлы событий для них не построены`);
  }
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
