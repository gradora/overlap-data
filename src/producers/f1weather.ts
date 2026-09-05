// Историческая погода событий F1 (шаг 5.3 DATA-PLAN). Форма файла, единицы и
// предохранители — в шапке lib/weather.ts.
//
// Продьюсер БЕССЕТЕВОЙ, как витрина календаря: всё, что нужно, уже лежит на
// диске после прогона openf1 — листинг сессий митинга и погода каждой сессии.
// Сшивка идёт через `sourceIds.openf1.meetingKey` витрины календаря, то есть
// нового пространства идентичности не заводится: имя файла — это `id` события
// витрины, тот самый, на котором у клиента висит вечный кэш погоды.
//
// Ключ — id, а не «сезон_раунд»: round = 0 это сентинел и он НЕ уникален
// (в 2026-м четыре события с нулём — два теста и две отмены), такой ключ
// схлопнул бы их в один файл.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mirrorSlug, writeJSONWithEnvelope } from "../lib/mirror.js";
import { isFrozen } from "../lib/freeze.js";
import { envFlag } from "../lib/env.js";
import {
  normalizeOpenF1, summarize, summarizeEvent, mergeWeatherEvent, weatherRegression,
  WEATHER_SCHEMA_VERSION, WEATHER_PARSER_VERSION,
  type WeatherDoc, type WeatherSession,
} from "../lib/weather.js";

const DATA_DIR = join(process.cwd(), "data");
const NOW = Date.now();

function readJSON<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

interface CalendarEvent {
  id: string;
  round: number;
  name: string;
  dates: { start: string | null; race: string | null; raceTime: string | null };
  sourceIds: { openf1: { meetingKey: number } | null };
}

interface CalendarDoc { schemaVersion?: number; season?: number; events?: CalendarEvent[] }

/// Конец события — конец дня гонки. Точнее не нужно: окно freeze недельное.
function eventEndMs(event: CalendarEvent): number | null {
  const day = event.dates.race;
  if (!day) return null;
  const ms = Date.parse(`${day}T23:59:59Z`);
  return Number.isFinite(ms) ? ms : null;
}

export interface BuildOutcome {
  outcome: "written" | "unchanged" | "skipped" | "kept-previous";
  reason?: string;
}

/// Сборка погоды одного события из уже снятого зеркала.
function buildEvent(
  dataDir: string, season: number, event: CalendarEvent, meetingKey: number, now: number,
  log: (m: string) => void,
): BuildOutcome {
  const mirrorDir = join(dataDir, "f1", "openf1");
  const path = join(dataDir, "f1", "weather", `${event.id}.json`);
  const prev = readJSON<WeatherDoc>(path);

  const endMs = eventEndMs(event);
  // Событие ещё идёт или не начиналось — писать нечего: обрезанный ряд
  // запечатался бы как полный.
  if (endMs === null || endMs > now) return { outcome: "skipped", reason: "окно ещё не закрылось" };

  const settled = isFrozen(endMs, now);
  // Запечатанное событие пересобираем ТОЛЬКО если устарела версия разбора —
  // образец пер-документной версии у решений стюардов.
  if (prev?.final && prev.parserVersion === WEATHER_PARSER_VERSION && !envFlag("F1_WEATHER_FORCE")) {
    return { outcome: "unchanged", reason: "запечатано" };
  }

  const listing = readJSON<any[]>(join(mirrorDir, mirrorSlug(`sessions?meeting_key=${meetingKey}`)));
  if (!Array.isArray(listing) || listing.length === 0) {
    return { outcome: "skipped", reason: "листинга сессий нет в зеркале" };
  }

  const sessions: WeatherSession[] = [];
  let holes = 0;
  for (const s of listing) {
    const key = String(s?.session_key ?? "");
    if (key === "") continue;
    const file = join(mirrorDir, mirrorSlug(`weather?session_key=${key}`));
    if (!existsSync(file)) { holes++; continue; }
    const rows = readJSON<any[]>(file);
    const { samples, reject } = normalizeOpenF1(Array.isArray(rows) ? rows : []);
    if (reject) {
      holes++;
      log(`::warning::f1 weather ${event.id}: сессия ${key} отброшена — ${reject}`);
      continue;
    }
    sessions.push({
      key,
      name: String(s?.session_name ?? "?"),
      startedAt: samples.t[0] ?? null,
      endedAt: samples.t[samples.t.length - 1] ?? null,
      samples,
      summary: summarize(samples),
    });
  }
  if (sessions.length === 0) return { outcome: "skipped", reason: "ни одной пригодной сессии" };

  // ПЕРВАЯ запись по уже отстоявшемуся событию требует ПОЛНОГО зеркала.
  // Иначе она запечатает урезанный ряд навсегда: предохранителю регрессии
  // сравнивать не с чем (prev == null), а гейт «запечатано» сработает уже на
  // следующем прогоне. Ровно этот класс стоил нам решений стюардов R11-2026.
  if (!prev && settled && holes > 0) {
    return { outcome: "skipped", reason: `зеркало неполное (${holes} сессий без погоды), ` +
      `запечатывать урезанным нельзя` };
  }

  const next: WeatherDoc = {
    schemaVersion: WEATHER_SCHEMA_VERSION,
    series: "f1",
    season,
    eventId: event.id,
    parserVersion: WEATHER_PARSER_VERSION,
    // Печать final — только после границы freeze И при полном зеркале:
    // дыра означает, что архив ещё можно дозаполнить.
    final: settled && holes === 0,
    timeAnchor: { method: "native", confidenceSec: 0 },
    sessions,
    summary: summarizeEvent(sessions),
  };

  const merged = mergeWeatherEvent(prev, next);
  const regression = weatherRegression(prev, merged);
  if (regression) {
    log(`::warning::f1 weather ${event.id}: ${regression} — прежний файл не тронут`);
    return { outcome: "kept-previous", reason: regression };
  }

  const { series, season: y, eventId, parserVersion, final, timeAnchor,
          sessions: out, summary } = merged;
  const changed = writeJSONWithEnvelope(
    path, { series, season: y, eventId, parserVersion, final, timeAnchor,
            sessions: out, summary },
    WEATHER_SCHEMA_VERSION);
  return { outcome: changed ? "written" : "unchanged" };
}

/// Все сезоны, у которых есть витрина календаря.
export function buildF1Weather(
  dataDir: string = DATA_DIR, now: number = NOW, log: (m: string) => void = console.log,
): string {
  const dir = join(dataDir, "f1", "calendar");
  if (!existsSync(dir)) return "f1 weather: витрины календаря нет — пропуск";
  const files = readdirSync(dir).filter((f) => /^\d{4}\.json$/.test(f)).sort();

  const parts: string[] = [];
  for (const file of files) {
    const year = Number(file.slice(0, 4));
    const doc = readJSON<CalendarDoc>(join(dir, file));
    // Январское отравление: файл сезона, несущий ЧУЖОЙ season, не разбираем —
    // иначе погода уехала бы под чужие id.
    if (!doc || doc.season !== year) {
      parts.push(`${year}: витрина непригодна`);
      continue;
    }
    const tally: Record<string, number> = {};
    for (const event of doc.events ?? []) {
      const meetingKey = event.sourceIds?.openf1?.meetingKey;
      if (meetingKey == null) { tally.noKey = (tally.noKey ?? 0) + 1; continue; }
      const r = buildEvent(dataDir, year, event, meetingKey, now, log);
      tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
    }
    parts.push(`${year}: ` + Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", "));
  }
  return `f1 weather — ${parts.join("; ")}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(buildF1Weather());
}
