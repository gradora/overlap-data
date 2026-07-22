// Общий слой продьюсеров IMSA-карточек (winners / highlights / safetycar /
// penalties) поверх Apache-дерева imsa.results.alkamelcloud.com.
// Особенности дерева (разведка 22.07.2026):
//  - NN-префиксы раундов НЕ уникальны в сезоне (2024: три папки «19_…») —
//    матчить только по имени трассы;
//  - на одну трассу в сезоне бывает 2-3 папки (тесты, младшие серии, второе
//    событие ковидного 2020) — валидный раунд определяется наличием внутри
//    папки «IMSA WeatherTech SportsCar Championship» с сессией «…_Race»;
//  - подпапки Hour N в гонке бывают с дырами (WGI-2024 без 05_Hour 5) —
//    финальная = максимальный номер;
//  - имена файлов исторически нестабильны («23_Time Cards_Race.CSV» vs
//    «23_Time Cards.JSON») — искать по подстроке, Official предпочтительнее.

import { fetchHTML, files, folders } from "./alkamel.js";

export const IMSA_SEASONS_FIRST = 2016; // глубже архива нет (и 2016 обрезан)

// MARK: Матчинг трассы

/// Слаг ядра имени: нижний регистр, только [a-z0-9], без общих слов.
export function slugifyImsaTrack(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/// Алиасы архивных имён папок → каноническое ядро текущего venue.
/// Ключи и значения — слаги slugifyImsaTrack.
const IMSA_TRACK_ALIASES: Record<string, string> = {
  // Rolex 24 (2020) и нотис-борд «Rolex 24 - Daytona …»
  "rolex-24-at-daytona": "daytona-international-speedway",
  "rolex-24-daytona-international-speedway": "daytona-international-speedway",
  // Long Beach: curated venue «Streets of Long Beach», архив «Long Beach Street Circuit»
  "long-beach-street-circuit": "streets-of-long-beach",
  // Laguna Seca: Mazda Raceway (2016) и разница регистров схлопывается слагом
  "mazda-raceway-laguna-seca": "weathertech-raceway-laguna-seca",
  // Detroit: с 2023 даунтаун «Detroit Street Course» (Belle Isle — другая трасса)
  "detroit-street-course": "detroit-street-circuit",
  // Indianapolis: WT-раунд 2024 лежал в папке-событии
  "tire-rack-com-battle-on-the-bricks": "indianapolis-motor-speedway",
  "indianapolis-motor-speedway-rc": "indianapolis-motor-speedway",
  // Road Atlanta: curated venue «Michelin Raceway Road Atlanta», архив короче
  "road-atlanta": "michelin-raceway-road-atlanta",
  "motul-petit-le-mans": "michelin-raceway-road-atlanta",
  // WGI-2021: второе событие уикенда с аббревиатурой в имени
  "weathertech-240-wgi": "watkins-glen-international",
};

/// Папка раунда соответствует трассе venue? Сравнение по каноническим слагам
/// (алиасы применяются к обеим сторонам), плюс вхождение ядра для суффиксных
/// вариантов нотис-борда («Sebring International Raceway - AEC»).
export function matchImsaTrack(folderName: string, venue: string): boolean {
  const clean = folderName.replace(/^\d+_/, "");
  const f = slugifyImsaTrack(clean);
  const v = slugifyImsaTrack(venue);
  const fc = IMSA_TRACK_ALIASES[f] ?? f;
  const vc = IMSA_TRACK_ALIASES[v] ?? v;
  if (fc === vc) return true;
  // Суффиксные варианты: ядро совпадает, папка длиннее («…-aec», «…-vprc»).
  if (fc.startsWith(vc + "-") || vc.startsWith(fc + "-")) return true;
  // Префиксные события: «6H - Watkins Glen International», «Rolex 24 - …» —
  // имя трассы в конце. Ложные срабатывания (MX-5 Cup Road America и т.п.)
  // отсеивает признак WeatherTech-папки у вызывающего.
  return fc.endsWith("-" + vc);
}

// MARK: Навигация по дереву

const WT_MARKER = "weathertech sportscar";

/// Папка WeatherTech-серии в раунде (или null — раунд без старшей серии).
export function wtFolderName(roundFolders: string[]): string | null {
  return roundFolders.find((f) => f.toLowerCase().includes(WT_MARKER)) ?? null;
}

/// Папки сессий вида «202606281210_Race» с распарсенным именем.
export interface ImsaSessionFolder {
  folder: string;
  stamp: string; // «202606281210»
  name: string;  // «Race»
}

export function imsaSessionFolders(wtFolders: string[]): ImsaSessionFolder[] {
  const out: ImsaSessionFolder[] = [];
  for (const f of wtFolders) {
    const m = f.match(/^(\d{12})_(.+)$/);
    if (m) out.push({ folder: f, stamp: m[1], name: m[2] });
  }
  return out;
}

/// Гоночная сессия уикенда (имя «Race», не «Race Replay» и т.п.).
export function raceSession(sessions: ImsaSessionFolder[]): ImsaSessionFolder | null {
  return sessions.find((s) => /^race\b/i.test(s.name)) ?? null;
}

/// Финальная стадия гонки: «NN_Hour N» с максимальным N; null — файлы в корне
/// (короткие гонки без почасовых промежутков).
export function finalHourFolder(raceFolders: string[]): string | null {
  let best: { n: number; folder: string } | null = null;
  for (const f of raceFolders) {
    const m = f.match(/Hour\s+(\d+)/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (!best || n > best.n) best = { n, folder: f };
  }
  return best?.folder ?? null;
}

/// Число Hour-папок — эвристика «главного» события при двух WT-событиях на
/// трассе за сезон (Себринг-2020: 12h против июльского спринта).
export function hourCount(raceFolders: string[]): number {
  return raceFolders.filter((f) => /Hour\s+\d+/i.test(f)).length;
}

/// Файл по подстроке с приоритетом статуса: Official → Provisional →
/// Unofficial → без суффикса. ext — «.JSON» | «.CSV» (регистр не важен).
export function pickImsaFile(all: string[], sub: string, ext: string): string | null {
  const cand = all.filter(
    (f) => f.toLowerCase().includes(sub.toLowerCase()) && f.toLowerCase().endsWith(ext.toLowerCase()),
  );
  if (!cand.length) return null;
  // «Unofficial» содержит подстроку «official» — official матчим строго.
  for (const status of [/(?:^|[^n])official/, /provisional/, /unofficial/]) {
    const hit = cand.find((f) => status.test(f.toLowerCase()));
    if (hit) return hit;
  }
  return cand[0];
}

// MARK: Разбор данных

export interface ImsaDriverRef {
  firstname?: string;
  surname?: string;
}

/// «Dane Cameron / Felipe Nasr» → «CAMERON / NASR» — фамилии капсом, как WEC.
export function imsaCrewSurnames(drivers: ImsaDriverRef[]): string {
  return drivers
    .map((d) => (d.surname ?? "").trim().toUpperCase())
    .filter(Boolean)
    .join(" / ");
}

/// «D. Cameron» из firstname/surname (для карточки THIS WEEKEND).
export function imsaShortDriver(first: string | undefined, sur: string | undefined): string {
  const s = (sur ?? "").trim();
  const f = (first ?? "").trim();
  if (!s) return f;
  return f ? `${f[0]}. ${s}` : s;
}

/// «6:01:10.521» / «29.409» / «2:29:13.516» → секунды. null — не время.
export function imsaTimeSeconds(raw: string): number | null {
  const parts = raw.trim().split(":");
  if (!parts.length || parts.some((p) => p === "" || Number.isNaN(Number(p)))) return null;
  let s = 0;
  for (const p of parts) s = s * 60 + Number(p);
  return s;
}

// MARK: Обход события

export interface ImsaRaceStage {
  /// Сегменты пути до папки с финальными файлами гонки.
  segments: string[];
  /// Имена файлов в ней.
  files: string[];
  /// Число Hour-папок в гонке (0 — файлы в корне сессии).
  hours: number;
  /// Штамп сессии «202606281210» (для выбора позднего события).
  stamp: string;
}

/// Финальная стадия гонки WT-серии внутри папки раунда. null — не WT-раунд
/// или гонки нет (тест/младшие серии).
export async function imsaRaceStage(season: string, round: string): Promise<ImsaRaceStage | null> {
  const roundHTML = await fetchHTML([season, round]);
  if (!roundHTML) return null;
  const wt = wtFolderName(folders(roundHTML));
  if (!wt) return null;
  const wtHTML = await fetchHTML([season, round, wt]);
  if (!wtHTML) return null;
  const race = raceSession(imsaSessionFolders(folders(wtHTML)));
  if (!race) return null;
  const raceHTML = await fetchHTML([season, round, wt, race.folder]);
  if (!raceHTML) return null;
  const raceDirs = folders(raceHTML);
  const hour = finalHourFolder(raceDirs);
  if (!hour) {
    return {
      segments: [season, round, wt, race.folder],
      files: files(raceHTML),
      hours: 0,
      stamp: race.stamp,
    };
  }
  const hourHTML = await fetchHTML([season, round, wt, race.folder, hour]);
  if (!hourHTML) return null;
  return {
    segments: [season, round, wt, race.folder, hour],
    files: files(hourHTML),
    hours: hourCount(raceDirs),
    stamp: race.stamp,
  };
}

/// Все папки-кандидаты трассы в сезоне (имя матчится) — вызывающий выбирает
/// главное событие по imsaRaceStage (hours/stamp).
export function trackCandidates(seasonFolders: string[], venue: string): string[] {
  return seasonFolders.filter((f) => matchImsaTrack(f, venue));
}
