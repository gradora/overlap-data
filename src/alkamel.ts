// Порт скрейпера/парсера Al Kamel (IMSAAlKamelService/-Parser/-CalendarParser/
// -PointsParser из приложения) на Node. Портал отдаёт Apache-листинги («Index
// of …») и JSON по каждой сессии. Цепочка:
//   сезон → раунды → WeatherTech-папка → сессии (время из таймстампа папки) →
//   лучший 03_Results_*.JSON → классификация по классам; плюс POINTS DATA.

import type { Driver, PointsEntry, RaceClass, ResultRow } from "./types.js";

const BASE = "https://imsa.results.alkamelcloud.com/Results";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

// MARK: HTTP

function buildURL(segments: string[]): string {
  let s = BASE;
  for (const seg of segments) s += "/" + encodeURIComponent(seg);
  // листинги требуют завершающий «/», файлы — нет
  if (!segments[segments.length - 1]?.includes(".")) s += "/";
  return s;
}

async function get(segments: string[]): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(buildURL(segments), {
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
    });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchHTML(segments: string[]): Promise<string | null> {
  const res = await get(segments);
  return res ? await res.text() : null;
}

export async function fetchJSON(segments: string[]): Promise<any | null> {
  const res = await get(segments);
  if (!res) return null;
  // JSON с UTF-8 BOM — .text()+strip надёжнее, чем .json()
  const text = (await res.text()).replace(/^﻿/, "");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// MARK: Apache-листинг

function hrefs(html: string): string[] {
  const out: string[] = [];
  const re = /href="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (
      href.startsWith("/") ||
      href.startsWith("?") ||
      href.startsWith("#") ||
      href === "../"
    )
      continue;
    out.push(href);
  }
  return out;
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export const folders = (html: string): string[] =>
  hrefs(html)
    .filter((h) => h.endsWith("/"))
    .map((h) => decode(h.slice(0, -1)));

export const files = (html: string): string[] =>
  hrefs(html)
    .filter((h) => !h.endsWith("/"))
    .map(decode);

// MARK: Сезон / раунды

export interface Round {
  folder: string; // «15_Canadian Tire Motorsport Park»
  track: string; // «Canadian Tire Motorsport Park»
  ordinal: number; // 15 — порядковый в листинге
}

export function rounds(seasonHTML: string): Round[] {
  return folders(seasonHTML).flatMap((folder) => {
    const us = folder.indexOf("_");
    if (us < 0) return [];
    const ordinal = Number(folder.slice(0, us));
    if (!Number.isInteger(ordinal)) return [];
    const track = folder.slice(us + 1);
    const lower = track.toLowerCase();
    const isSupport = ["(aec)", "(vprc)", "(mx-5)", "(imsa vp"].some((x) =>
      lower.includes(x),
    );
    const isNonRace = lower.includes("test") || lower.includes("roar");
    if (isSupport || isNonRace) return [];
    return [{ folder, track, ordinal }];
  });
}

// Папка WeatherTech-чемпионата в листинге раунда (истина, не имя раунда).
export const weatherTechFolder = (roundHTML: string): string | undefined =>
  folders(roundHTML).find((f) =>
    f.toLowerCase().includes("weathertech sportscar championship"),
  );

export const pointsDataFolder = (wtHTML: string): string | undefined =>
  folders(wtHTML).find((f) => f.toLowerCase().includes("points data"));

// Лучший 03_Results_*.JSON: Official > без суффикса > Provisional > Unofficial.
export function resultsFile(sessionHTML: string): string | undefined {
  const candidates = files(sessionHTML).filter(
    (f) => f.startsWith("03_Results_") && f.toUpperCase().endsWith(".JSON"),
  );
  const rank = (name: string): number => {
    const n = name.toLowerCase();
    if (n.includes("unofficial")) return 1; // до official-проверки: подстрока!
    if (n.includes("official")) return 4;
    if (n.includes("provisional")) return 2;
    return 3;
  };
  return candidates.sort((a, b) => rank(b) - rank(a))[0];
}

// Эндуранс: финальная классификация в последней часовой подпапке («24_Hour 24»).
export function lastHourFolder(sessionHTML: string): string | undefined {
  return folders(sessionHTML)
    .flatMap((folder) => {
      const us = folder.indexOf("_");
      const n = Number(folder.slice(0, us));
      if (us < 0 || !Number.isInteger(n) || !folder.toLowerCase().includes("hour"))
        return [];
      return [{ folder, n }];
    })
    .sort((a, b) => b.n - a.n)[0]?.folder;
}

export interface SessionRef {
  name: string; // «Race» / «Qualifying» / «Practice 1»
  wallClock: WallClock; // цифры таймстампа папки (пояс трассы применяется позже)
  folder: string; // «202607121405_Race»
}

export interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

export function parseTimestamp(s: string): WallClock | undefined {
  if (s.length !== 12 || !/^\d{12}$/.test(s)) return undefined;
  return {
    y: +s.slice(0, 4),
    mo: +s.slice(4, 6),
    d: +s.slice(6, 8),
    h: +s.slice(8, 10),
    mi: +s.slice(10, 12),
  };
}

export function sessions(wtHTML: string): SessionRef[] {
  return folders(wtHTML)
    .flatMap((folder) => {
      const us = folder.indexOf("_");
      if (us < 0) return [];
      const wall = parseTimestamp(folder.slice(0, us));
      if (!wall) return []; // не сессия (напр. POINTS DATA)
      return [{ name: folder.slice(us + 1), wallClock: wall, folder }];
    })
    .sort((a, b) => cmpWall(a.wallClock, b.wallClock));
}

const cmpWall = (a: WallClock, b: WallClock): number =>
  wallToUTCms(a, "UTC") - wallToUTCms(b, "UTC");

// MARK: Таймзоны трасс (10 площадок WeatherTech, все — Северная Америка)

const TZ_MAP: { tokens: string[]; tz: string }[] = [
  { tokens: ["long beach", "laguna", "seca"], tz: "America/Los_Angeles" },
  {
    tokens: ["road america", "elkhart", "americas", "austin", "cota"],
    tz: "America/Chicago",
  },
  {
    tokens: [
      "daytona", "sebring", "watkins", "atlanta", "virginia", "mid-ohio",
      "mid ohio", "detroit", "canadian tire", "mosport", "indianapolis",
      "lime rock",
    ],
    tz: "America/New_York",
  },
];

export function trackTimeZone(venue: string): string | undefined {
  const v = venue.toLowerCase();
  return TZ_MAP.find((e) => e.tokens.some((t) => v.includes(t)))?.tz;
}

// Оффсет зоны (мс) в конкретный UTC-инстант через Intl.
function zoneOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(date))
    if (part.type !== "literal") p[part.type] = +part.value;
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUTC - date.getTime();
}

// Wall-clock трассы → реальный UTC-инстант. Без зоны — как есть (±оффсет).
// IMSA гоняется март–октябрь, DST-края редки → одного прохода достаточно.
function wallToUTCms(w: WallClock, tz: string | "UTC"): number {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  if (tz === "UTC") return guess;
  return guess - zoneOffsetMs(new Date(guess), tz);
}

export function sessionInstant(w: WallClock, venue: string): Date {
  const tz = trackTimeZone(venue);
  return new Date(wallToUTCms(w, tz ?? "UTC"));
}

// Wall-clock трассы, помещённый в UTC БЕЗ сдвига (цифры сохранены). Приложение
// кладёт его в ref.date; его builder сам конвертит поясом трассы.
export function wallClockISO(w: WallClock): string {
  return new Date(wallToUTCms(w, "UTC")).toISOString();
}

// MARK: Классы

export function raceClass(className: string): RaceClass {
  switch (className.trim().toUpperCase()) {
    case "GTP":
      return "GTP";
    case "LMP2":
      return "LMP2";
    default:
      return "GTD"; // GTD / GTDPRO / GTD PRO / прочие GT3
  }
}

// MARK: Толерантное чтение

const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const intOrNull = (v: unknown): number | null => {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") {
    const n = parseInt(v.trim(), 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
};
const dblOrNull = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.trim());
    return Number.isNaN(n) ? null : n;
  }
  return null;
};

function drivers(raw: unknown): Driver[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d: any) => {
    const first = str(d.firstname);
    const surname = str(d.surname);
    const initial = first ? `${first[0]}. ` : "";
    return {
      name: `${initial}${surname}`.trim(),
      nationality: str(d.country),
    };
  });
}

export interface ParsedSession {
  sessionName: string;
  sessionType: string;
  eventName: string;
  circuitName: string;
  circuitLengthM: number | null;
  rows: ResultRow[];
}

// Семантика полей (сверено на живой гонке): time=быстрый круг машины,
// elapsed_time=общее время гонки, gap_first=гэп к абсолютному лидеру.
export function parseSession(json: any): ParsedSession | null {
  const session = json?.session ?? {};
  const circuit = session.circuit ?? {};
  const entries: any[] = Array.isArray(json?.classification)
    ? json.classification
    : [];
  if (entries.length === 0) return null;

  const perClass: Partial<Record<RaceClass, number>> = {};
  const rows: ResultRow[] = entries.map((e) => {
    const cls = raceClass(str(e.class));
    perClass[cls] = (perClass[cls] ?? 0) + 1;
    const classPos = perClass[cls]!;
    const best = str(e.time);
    const elapsed = str(e.elapsed_time);
    const dnf = e.not_finished === true;
    const total = dnf ? "DNF" : elapsed === "" ? best : elapsed;
    const gap = str(e.gap_first);
    let leaderTime: string;
    if (dnf) leaderTime = "DNF";
    else if (classPos === 1) leaderTime = total;
    else leaderTime = gap === "-" || gap === "" ? "" : gap;
    return {
      position: intOrNull(e.position) ?? 0,
      classPosition: classPos,
      carNumber: str(e.number),
      chassis: str(e.vehicle),
      raceClass: cls,
      team: str(e.team),
      drivers: drivers(e.drivers),
      laps: intOrNull(e.laps),
      leaderTime,
      totalTime: total,
      interval: str(e.gap_previous),
      pitstops: intOrNull(e.pit_stops),
    };
  });

  return {
    sessionName: str(session.session_name),
    sessionType: str(session.session_type),
    eventName: str(session.event_name),
    circuitName: str(circuit.name),
    circuitLengthM: dblOrNull(circuit.length),
    rows,
  };
}

// MARK: POINTS DATA

// Имя файла таблицы: «IWSC 01 GTP Drivers.json». Класс — точным словом
// (у GTD/GTDPRO общий префикс).
export function pointsFile(
  fileList: string[],
  className: string,
  table: "Drivers" | "Teams",
): string | undefined {
  return fileList.find((file) => {
    if (!file.toLowerCase().endsWith(".json")) return false;
    const stem = file.slice(0, -5);
    const words = stem.split(" ");
    return (
      words.includes(className) &&
      stem.toLowerCase().includes(table.toLowerCase()) &&
      stem.toUpperCase().startsWith("IWSC")
    );
  });
}

export function parsePointsTable(json: any): PointsEntry[] | null {
  const rowsRaw: any[] = Array.isArray(json?.classification)
    ? json.classification
    : [];
  if (rowsRaw.length === 0) return null;
  const entries = rowsRaw.flatMap((row): PointsEntry[] => {
    const key = typeof row.key === "string" ? row.key : "";
    if (!key) return [];
    const points =
      dblOrNull(row.total_points) ?? dblOrNull(row.total_net_points) ?? 0;
    const position = dblOrNull(row.net_position) ?? dblOrNull(row.position);
    if (position === null) return [];
    return [{ key, points: Math.round(points), position: Math.round(position) }];
  });
  return entries.length ? entries.sort((a, b) => a.position - b.position) : null;
}

// GTDPRO+GTD → GTD: пересортировка по очкам и перенумерация.
export function mergeGTD(a: PointsEntry[], b: PointsEntry[]): PointsEntry[] {
  return [...a, ...b]
    .sort((x, y) => y.points - x.points)
    .map((e, i) => ({ key: e.key, points: e.points, position: i + 1 }));
}
