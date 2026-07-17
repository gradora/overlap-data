// Курируемое расписание сезона IMSA WeatherTech (даты + трассы). Al Kamel создаёт
// папки раундов только по мере приближения, поэтому БУДУЩИЕ этапы (для «ближайшего
// события» в приложении) берём отсюда, а прошедшие/текущие обогащаем скрейпом.
// Обновляется раз в сезон; сверено по imsa.com + Wikipedia + honda.racing.
// venue — официальная длинная форма (токен-матч со скрейпом Al Kamel).

export interface ScheduleEntry {
  round: number; // championship round (1..11)
  name: string;
  venue: string;
  startDate: string; // ISO date YYYY-MM-DD (первый день уикенда)
  endDate: string; // день гонки (последний день этапа)
}

export const SCHEDULE: Record<number, ScheduleEntry[]> = {
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

export function matchTrack(scheduleVenue: string, tracks: string[]): string | undefined {
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
  return best?.track;
}
