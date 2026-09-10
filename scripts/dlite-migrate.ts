// Одноразовая миграция D-лайт (10.09.2026): из ВИТРИНЫ уходят текстовые
// имена источников. Запуск: `npx tsx scripts/dlite-migrate.ts`.
//
// Что делает (согласованно с уже перерезанными писателями):
//  F1:
//   1. Пересобирает f1/calendar/<год>.json НОВЫМ билдером из зеркал на диске
//      (v3: sourceIds → mk, чеканные id/eventKey) — мимо сторожа дрейфа: это
//      тот самый «осознанный один раз», ради которого сторож и существует.
//   2. Переименовывает id-ключуемые файлы витрины (forecast/weather/
//      racecontrol: `f1-meeting-<mk>` → чеканный id) и правит id внутри.
//   3. Переименовывает f1/events/<eventKey>.json под чеканные ключи и правит
//      eventKey/eventId внутри.
//  WEC:
//   4. wec/<год>/index.json: события теряют sourceIds.fiawec, получают
//      hasResults (v2).
//   5. wec/<год>/NN_*.json, test_*.json: документ теряет sourceIds, сессии —
//      sourceIds.sessionId → seq (ранг id внутри события, v3).
//
// После прогона бессетевые продьюсеры (f1overrides/f1events/f1weather,
// сборка WEC из фактов) обязаны сойтись в unchanged/frozen — это и есть
// приёмка «диф ровно по спеке».

import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  buildF1CalendarDoc, coveredSeasons, readJolpicaSeason, readMeetings, readOverrides,
  readPrev, F1_CALENDAR_SCHEMA_VERSION, type F1CalendarDoc,
} from "../src/lib/f1calendar.js";
import { writeJSONWithEnvelope } from "../src/lib/mirror.js";
import {
  WEC_INDEX_SCHEMA_VERSION, type WecIndexEvent,
} from "../src/lib/wecsnapshot.js";
import { WEC_EVENT_SCHEMA_VERSION } from "../src/lib/wecevents.js";

const DATA = join(process.cwd(), "data");
const NOW = Date.now();

const readJSON = (p: string): any | null => {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
};

/// Тело файла без конверта (writeJSONWithEnvelope соберёт его заново).
const payloadOf = (doc: any): any => {
  const { schemaVersion: _v, generatedAt: _g, ...payload } = doc;
  return payload;
};

// MARK: - F1: календарь v3 + карта переименований

interface OldEvent {
  id: string; eventKey?: string;
  sourceIds?: { openf1?: { meetingKey?: number } | null } | null;
}

const idMap = new Map<string, string>();    // старый id → новый id
const keyMap = new Map<string, string>();   // старый eventKey → новый eventKey

const currentYear = new Date(NOW).getUTCFullYear();
for (const season of coveredSeasons(DATA, currentYear)) {
  const path = join(DATA, "f1", "calendar", `${season}.json`);
  const oldDoc = readJSON(path);
  const oldEvents: OldEvent[] = oldDoc?.payload?.events ?? oldDoc?.events ?? [];

  const jolpica = readJolpicaSeason(DATA, season);
  if (!jolpica) { console.log(`f1 ${season}: нет расписания — пропуск`); continue; }
  const meetings = readMeetings(DATA, season);
  // prevEvents НЕ передаём: свежая чеканка по возрастанию mk — это и есть
  // целевая раскладка миграции; дальше её замораживает наследование.
  const doc: F1CalendarDoc = buildF1CalendarDoc({
    season,
    schedule: jolpica.schedule,
    results: jolpica.results,
    sprints: jolpica.sprints,
    meetings,
    overrides: readOverrides(DATA, season, currentYear),
    now: NOW,
  });

  // Карта старое → новое: по mk (митинг не перенумеровывается), затем по id.
  const newByMk = new Map(doc.events.flatMap((e) => (e.mk != null ? [[e.mk, e] as const] : [])));
  const newById = new Map(doc.events.map((e) => [e.id, e]));
  for (const old of oldEvents) {
    const mk = old.sourceIds?.openf1?.meetingKey;
    const next = (mk != null ? newByMk.get(mk) : undefined) ?? newById.get(old.id);
    if (!next) { console.warn(`  ${season}: событию ${old.id} не нашлось пары в новой витрине`); continue; }
    if (old.id !== next.id) idMap.set(old.id, next.id);
    if (old.eventKey && old.eventKey !== next.eventKey) keyMap.set(old.eventKey, next.eventKey);
  }

  const { series, season: y, frozen, events } = doc;
  writeJSONWithEnvelope(path, { series, season: y, frozen, events }, F1_CALENDAR_SCHEMA_VERSION);
  console.log(`f1 ${season}: календарь v${F1_CALENDAR_SCHEMA_VERSION}, событий ${events.length}`);
}

// MARK: - F1: переименование id-ключуемых файлов витрины

/// Переименовать файл и поправить внутри поля с прежним идентификатором.
function migrateFile(dir: string, oldName: string, newName: string,
                     patch: (payload: any) => void): void {
  const oldPath = join(DATA, dir, oldName);
  const newPath = join(DATA, dir, newName);
  if (!existsSync(oldPath)) return;
  renameSync(oldPath, newPath);
  const doc = readJSON(newPath);
  if (!doc) { console.warn(`  ${dir}/${newName}: файл не прочитался после переноса`); return; }
  const version = doc.schemaVersion ?? 1;
  const payload = payloadOf(doc);
  patch(payload);
  writeJSONWithEnvelope(newPath, payload, version);
  console.log(`  ${dir}: ${oldName} → ${newName}`);
}

for (const [oldId, newId] of idMap) {
  for (const dir of ["f1/forecast", "f1/weather"]) {
    migrateFile(dir, `${oldId}.json`, `${newId}.json`, (p) => { p.eventId = newId; });
  }
  migrateFile("f1/racecontrol", `${oldId}.json`, `${newId}.json`, (p) => { p.id = newId; });
}

for (const [oldKey, newKey] of keyMap) {
  migrateFile("f1/events", `${oldKey}.json`, `${newKey}.json`, (p) => {
    p.eventKey = newKey;
    if (typeof p.eventId === "string" && idMap.has(p.eventId)) p.eventId = idMap.get(p.eventId)!;
  });
}

// MARK: - WEC: index v2 + файлы событий v3

const wecRoot = join(DATA, "wec");
for (const name of readdirSync(wecRoot)) {
  if (!/^\d{4}$/.test(name)) continue;
  const seasonDir = join(wecRoot, name);

  const indexPath = join(seasonDir, "index.json");
  const indexDoc = readJSON(indexPath);
  // Идемпотентность: уже мигрированный файл (событий с sourceIds нет) не
  // трогаем — повторный прогон не должен затирать hasResults ложью.
  const indexEvents: any[] = indexDoc ? payloadOf(indexDoc).events ?? [] : [];
  if (indexDoc && indexEvents.some((e: any) => e.sourceIds)) {
    const payload = payloadOf(indexDoc);
    payload.events = indexEvents.map((e: any) => {
      const { sourceIds, ...rest } = e;
      return { ...rest, hasResults: (sourceIds?.fiawec?.raceId ?? null) !== null };
    });
    writeJSONWithEnvelope(indexPath, payload, WEC_INDEX_SCHEMA_VERSION);
    console.log(`wec ${name}: index v${WEC_INDEX_SCHEMA_VERSION}`);
  }

  for (const file of readdirSync(seasonDir)) {
    if (!/^(\d{2}_|test_).+\.json$/.test(file)) continue;
    const path = join(seasonDir, file);
    const doc = readJSON(path);
    if (!doc) continue;
    const payload = payloadOf(doc);
    const touched = payload.sourceIds !== undefined
      || (payload.sessions ?? []).some((s: any) => s?.sourceIds !== undefined);
    if (!touched) continue;   // уже мигрирован — seq не перечёркиваем
    delete payload.sourceIds;
    const ids = (payload.sessions ?? [])
      .map((s: any) => s?.sourceIds?.sessionId)
      .filter((v: any): v is number => typeof v === "number")
      .sort((a: number, b: number) => a - b);
    const rank = new Map(ids.map((id: number, i: number) => [id, i]));
    payload.sessions = (payload.sessions ?? []).map((s: any) => {
      const { sourceIds, ...rest } = s;
      const sid = sourceIds?.sessionId ?? null;
      // seq — на месте прежнего sourceIds (после status, перед rows).
      const { rows, ...head } = rest;
      return { ...head, seq: sid !== null ? rank.get(sid) ?? null : null, rows };
    });
    writeJSONWithEnvelope(path, payload, WEC_EVENT_SCHEMA_VERSION);
    console.log(`wec ${name}: ${file} v${WEC_EVENT_SCHEMA_VERSION}`);
  }
}

console.log("Миграция D-лайт завершена.");
