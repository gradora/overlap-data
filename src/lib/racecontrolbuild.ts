// Сборка файла рейс-контрола из зеркала openf1. С этапа 3 кухни зеркало
// хранит ГОТОВЫЕ R1-факты (классификация переехала с чтения на запись —
// extractRaceControlFact в openf1facts.ts), поэтому здесь только чтение:
// строка файла → факт через r1RowToFact (фильтр факт-ключей с сохранением
// порядка записи), маркер пустой сессии и устаревшие строки отбрасываются.
// Классификатор (racecontrol.ts) и его таблица тестов не меняются — они
// теперь охраняют ЗАПИСЬ зеркала, а витрина получается побайтово той же:
// classifyRaceControl чиста, вход тот же, выход разложен по тем же ключам.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mirrorSlug, writeJSONWithEnvelope } from "./mirror.js";
import {
  RACECONTROL_PARSER_VERSION, RACECONTROL_SCHEMA_VERSION,
  type RaceControlDoc, type RaceControlSession,
} from "./racecontrol.js";
import { r1RowToFact } from "./racecontrolsynth.js";

function readMirror<T>(dataDir: string, path: string): T | null {
  try {
    return JSON.parse(readFileSync(
      join(dataDir, "f1", "openf1", mirrorSlug(path)), "utf8")) as T;
  } catch {
    return null;
  }
}

/// Документ рейс-контрола события, или null — когда нет ни одной сессии с
/// событиями. Пустой файл не пишется: лента Recap без записей и честный 404
/// для клиента неотличимы, а файл-пустышка занял бы место в витрине навсегда.
export function buildRaceControlDoc(
  dataDir: string, season: number, eventId: string, meetingKey: number,
): RaceControlDoc | null {
  const sessions = readMirror<{ session_key: number; session_name: string }[]>(
    dataDir, `sessions?meeting_key=${meetingKey}`);
  if (!Array.isArray(sessions) || sessions.length === 0) return null;

  const out: RaceControlSession[] = [];
  for (const s of sessions) {
    const rows = readMirror<unknown[]>(
      dataDir, `race_control?session_key=${s.session_key}`);
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const events = rows.map(r1RowToFact)
      .filter((f): f is NonNullable<typeof f> => f !== null);
    if (events.length > 0) out.push({ key: s.session_key, name: s.session_name, events });
  }
  if (out.length === 0) return null;
  return {
    id: eventId, season, parserVersion: RACECONTROL_PARSER_VERSION, sessions: out,
  };
}

/// Запись с конвертом; true — файл изменился.
export function writeRaceControl(dataDir: string, doc: RaceControlDoc): boolean {
  return writeJSONWithEnvelope(
    join(dataDir, "f1", "racecontrol", `${doc.id}.json`), doc, RACECONTROL_SCHEMA_VERSION);
}
