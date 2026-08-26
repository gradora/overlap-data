// Курируемое расписание сезона IMSA WeatherTech (даты + трассы). Al Kamel создаёт
// папки раундов только по мере приближения, поэтому БУДУЩИЕ этапы (для «ближайшего
// события» в приложении) берём отсюда, а прошедшие/текущие обогащаем скрейпом.
// Обновляется раз в сезон; сверено по imsa.com + Wikipedia + honda.racing.
// venue — официальная длинная форма (токен-матч со скрейпом Al Kamel).

import { loadRefs, pinFor, trackByAlias, type RefsMap } from "./refs.js";
import { slugifyImsaTrack } from "./alkamelimsa.js";

export interface ScheduleEntry {
  round: number; // championship round (1..11)
  name: string;
  venue: string;
  startDate: string; // ISO date YYYY-MM-DD (первый день уикенда)
  endDate: string; // день гонки (последний день этапа)
}

export const SCHEDULE: Record<number, ScheduleEntry[]> = {
  // 2025 — закрытый сезон (бэкфилл под переключатель сезонов в приложении).
  // Даты уикендов сняты с таймстампов папок Al Kamel (Results/25_2025/…),
  // имена этапов — по вики сезона. У Дайтоны endDate — день ФИНИША 24-часовой
  // гонки (старт 25-го), как и в 2026.
  2025: [
    { round: 1, name: "Rolex 24 At Daytona", venue: "Daytona International Speedway", startDate: "2025-01-23", endDate: "2025-01-26" },
    { round: 2, name: "Mobil 1 Twelve Hours of Sebring", venue: "Sebring International Raceway", startDate: "2025-03-13", endDate: "2025-03-15" },
    { round: 3, name: "Acura Grand Prix of Long Beach", venue: "Streets of Long Beach", startDate: "2025-04-11", endDate: "2025-04-12" },
    { round: 4, name: "TireRack.com Monterey SportsCar Championship", venue: "WeatherTech Raceway Laguna Seca", startDate: "2025-05-09", endDate: "2025-05-11" },
    { round: 5, name: "Chevrolet Detroit Sports Car Classic", venue: "Detroit Street Circuit", startDate: "2025-05-30", endDate: "2025-05-31" },
    { round: 6, name: "Sahlen's Six Hours of The Glen", venue: "Watkins Glen International", startDate: "2025-06-20", endDate: "2025-06-22" },
    { round: 7, name: "Chevrolet Grand Prix", venue: "Canadian Tire Motorsport Park", startDate: "2025-07-11", endDate: "2025-07-13" },
    { round: 8, name: "Motul SportsCar Grand Prix", venue: "Road America", startDate: "2025-08-01", endDate: "2025-08-03" },
    { round: 9, name: "Michelin GT Challenge at VIR", venue: "VIRginia International Raceway", startDate: "2025-08-22", endDate: "2025-08-24" },
    { round: 10, name: "TireRack.com Battle on the Bricks", venue: "Indianapolis Motor Speedway", startDate: "2025-09-19", endDate: "2025-09-21" },
    { round: 11, name: "Motul Petit Le Mans", venue: "Michelin Raceway Road Atlanta", startDate: "2025-10-09", endDate: "2025-10-11" },
  ],
  2026: [
    { round: 1, name: "Rolex 24 At Daytona", venue: "Daytona International Speedway", startDate: "2026-01-21", endDate: "2026-01-25" },
    { round: 2, name: "Mobil 1 Twelve Hours of Sebring", venue: "Sebring International Raceway", startDate: "2026-03-18", endDate: "2026-03-21" },
    { round: 3, name: "Acura Grand Prix of Long Beach", venue: "Streets of Long Beach", startDate: "2026-04-17", endDate: "2026-04-18" },
    { round: 4, name: "Monterey SportsCar Championship", venue: "WeatherTech Raceway Laguna Seca", startDate: "2026-05-01", endDate: "2026-05-03" },
    { round: 5, name: "Chevrolet Detroit Sports Car Classic", venue: "Detroit Street Circuit", startDate: "2026-05-29", endDate: "2026-05-30" },
    { round: 6, name: "Sahlen's Six Hours of The Glen", venue: "Watkins Glen International", startDate: "2026-06-25", endDate: "2026-06-28" },
    { round: 7, name: "Chevrolet Grand Prix", venue: "Canadian Tire Motorsport Park", startDate: "2026-07-10", endDate: "2026-07-12" },
    { round: 8, name: "Motul SportsCar Endurance Grand Prix", venue: "Road America", startDate: "2026-07-30", endDate: "2026-08-02" },
    { round: 9, name: "Michelin GT Challenge at VIR", venue: "VIRginia International Raceway", startDate: "2026-08-20", endDate: "2026-08-23" },
    { round: 10, name: "Battle on the Bricks", venue: "Indianapolis Motor Speedway", startDate: "2026-09-18", endDate: "2026-09-20" },
    { round: 11, name: "Motul Petit Le Mans", venue: "Michelin Raceway Road Atlanta", startDate: "2026-10-01", endDate: "2026-10-03" },
  ],
  // 2027 — сверено с imsa.com/weathertech/2027-schedule (снято 02.08.2026).
  // ROAR Before the Rolex 24 (22–24 янв) в SCHEDULE не входит: тестовые
  // уик-энды идут отдельным каналом discovery (testRounds → tests.json).
  // У Laguna Seca imsa.com пока не назвал событие (тайтл = площадка) — имя
  // перекроется eventName из Al Kamel при первом скрейпе.
  2027: [
    { round: 1, name: "Rolex 24 At Daytona", venue: "Daytona International Speedway", startDate: "2027-01-28", endDate: "2027-01-31" },
    { round: 2, name: "Mobil 1 Twelve Hours of Sebring", venue: "Sebring International Raceway", startDate: "2027-03-17", endDate: "2027-03-20" },
    { round: 3, name: "Acura Grand Prix of Long Beach", venue: "Streets of Long Beach", startDate: "2027-04-16", endDate: "2027-04-17" },
    { round: 4, name: "WeatherTech Raceway Laguna Seca", venue: "WeatherTech Raceway Laguna Seca", startDate: "2027-04-30", endDate: "2027-05-02" },
    { round: 5, name: "Chevrolet Detroit Grand Prix", venue: "Detroit Street Circuit", startDate: "2027-06-04", endDate: "2027-06-05" },
    { round: 6, name: "Sahlen's Six Hours of The Glen", venue: "Watkins Glen International", startDate: "2027-06-24", endDate: "2027-06-27" },
    { round: 7, name: "Chevrolet Grand Prix", venue: "Canadian Tire Motorsport Park", startDate: "2027-07-09", endDate: "2027-07-11" },
    { round: 8, name: "Motul SportsCar Endurance Grand Prix", venue: "Road America", startDate: "2027-07-29", endDate: "2027-08-01" },
    { round: 9, name: "Michelin GT Challenge at VIR", venue: "VIRginia International Raceway", startDate: "2027-08-20", endDate: "2027-08-22" },
    { round: 10, name: "TireRack.com Battle on the Bricks", venue: "Indianapolis Motor Speedway", startDate: "2027-09-17", endDate: "2027-09-19" },
    { round: 11, name: "Motul Petit Le Mans", venue: "Michelin Raceway Road Atlanta", startDate: "2027-10-06", endDate: "2027-10-09" },
  ],
};

// Токен-матч трассы расписания ↔ скрейпа Al Kamel (дженерик-слова не считаются,
// многословный venue требует ≥2 общих токенов; алиас Mosport). Мини-версия
// логики приложения, чтобы обогащать расписание живыми результатами.
const GENERIC = new Set(["international", "raceway", "speedway", "circuit", "street",
  "course", "streets", "park", "the", "grand", "prix", "motorsport", "motorsports", "at", "of"]);

const ALIASES: [string, string][] = [
  ["mosport", "canadian tire motorsport park"],
  ["canadian tire", "canadian tire motorsport park"],
];

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t)),
  );
}

// ---- Карта сущностей (фаза 2 DATA-PLAN): подключение потребителя ----
// Карта — СОВЕТНИК на обкатке: её мнение (pins → алиасы) сверяется со
// встроенным матчем, при расхождении печатается warning и побеждает
// ВСТРОЕННАЯ таблица (перещёлкивание приоритета — отдельным решением позже).
// Карта недоступна/бита → мнения нет, поведение в точности прежнее (fail-open).

let refsLoaded = false;
let refsOnce: RefsMap | undefined;
function defaultRefs(): RefsMap | undefined {
  if (!refsLoaded) {
    refsLoaded = true;   // читаем один раз на прогон (как akSeasonPage-кэш)
    refsOnce = loadRefs();
  }
  return refsOnce;
}

// Warning на каждый вызов заливал бы лог: матчеры зовутся в циклах по всем
// раундам сезона. Дедуп по конкретной паре входов — расхождение видно ровно
// один раз за прогон.
const warnedKeys = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(msg);
}

/// Резолв произвольного имени трассы (venue расписания ИЛИ имя папки архива
/// Al Kamel) в запись карты: alkamelImsa-пространство по слагу, затем
/// curated-venue как есть (лукапы карты case-insensitive).
function refTrackByLabel(m: RefsMap, label: string) {
  return trackByAlias(m, "alkamelImsa", slugifyImsaTrack(label)) ??
    trackByAlias(m, "imsaVenue", label);
}

export function matchTrack(
  scheduleVenue: string, tracks: string[], refs?: RefsMap | null,
): string | undefined {
  let effective = scheduleVenue;
  const lower = scheduleVenue.toLowerCase();
  for (const [needle, canonical] of ALIASES) if (lower.includes(needle)) effective = canonical;
  const target = tokens(effective);
  if (target.size === 0) return undefined;
  const required = Math.min(2, target.size);
  let best: { track: string; score: number } | undefined;
  for (const track of tracks) {
    const score = [...tokens(track)].filter((t) => target.has(t)).length;
    if (score >= required && (!best || score > best.score)) best = { track, score };
  }
  const builtin = best?.track;

  // Мнение карты. refs === null — явное «без карты» (тесты fail-open);
  // undefined — карта по умолчанию. try/catch — битый ОБЪЕКТ карты (не файл,
  // это ловит loadRefs) не имеет права ронять матчер: fail-open сквозной.
  const m = refs === null ? undefined : refs ?? defaultRefs();
  if (m) {
    try {
      const pin = pinFor(m, "schedule", scheduleVenue);
      const targetTrack = pin?.slug !== undefined
        ? m.tracks.find((t) => t.slug === pin.slug)
        : trackByAlias(m, "imsaVenue", scheduleVenue);
      if (targetTrack) {
        // Warning ТОЛЬКО на положительное противоречие: имя, которое карта
        // знает, но относит к другой трассе, либо матч есть ровно у одной
        // стороны. Кандидат, которого карта не знает вовсе, — молча (обкатка:
        // карта заведомо покрывает не все суффиксные варианты архива).
        const builtinTrack = builtin !== undefined ? refTrackByLabel(m, builtin) : undefined;
        if (builtin !== undefined && builtinTrack && builtinTrack.slug !== targetTrack.slug) {
          warnOnce(`matchTrack:${scheduleVenue}|${builtin}`,
            `  refs: matchTrack «${scheduleVenue}» → «${builtin}», а карта считает это трассой ` +
            `«${builtinTrack.slug}» (venue → «${targetTrack.slug}») — побеждает встроенная таблица`);
        } else if (builtin === undefined) {
          const mapPick = tracks.find((cand) => refTrackByLabel(m, cand)?.slug === targetTrack.slug);
          if (mapPick !== undefined) {
            warnOnce(`matchTrack:${scheduleVenue}|∅`,
              `  refs: matchTrack «${scheduleVenue}» не сматчился встроенно, а карта находит ` +
              `«${mapPick}» (${targetTrack.slug}) — побеждает встроенная таблица (нет матча)`);
          }
        }
      }
    } catch {
      // fail-open: мнение карты — только совет
    }
  }
  return builtin;
}
