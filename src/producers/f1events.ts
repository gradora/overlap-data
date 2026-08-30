// Продьюсер файла события F1 — ЧИСТАЯ проекция уже собранных семейств, ноль
// сетевых запросов. Пишет data/f1/events/<eventKey>.json.
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
  EVENT_FILE_SCHEMA_VERSION, buildEventFile, eventFilePath,
} from "../lib/eventfile.js";

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
}

export function readShowcase(season: number, dataDir = DATA_DIR): ShowcaseEvent[] {
  const doc = readJSON(join(dataDir, "f1", "calendar", `${season}.json`)) as
    { payload?: { events?: ShowcaseEvent[] }; events?: ShowcaseEvent[] } | null;
  return doc?.payload?.events ?? doc?.events ?? [];
}

export async function main(): Promise<void> {
  console.log(`F1 events, season ${YEAR}`);
  const events = readShowcase(YEAR);
  if (!events.length) {
    console.warn("events: витрины календаря нет — пропускаем прогон");
    return;
  }

  let written = 0, unchanged = 0, empty = 0, noKey = 0;
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

    const file = buildEventFile({
      season: YEAR,
      eventKey: e.eventKey,
      eventId: e.id,
      round,
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
              `без блоков ${empty}` + (noKey ? `, БЕЗ КЛЮЧА ${noKey}` : ""));
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
