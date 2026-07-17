// Нормализованная схема снапшотов IMSA, которую читает приложение вместо
// прямого скрейпа Al Kamel. Поля отражают IMSAResultRow / IMSAAlKamelSession
// из приложения, чтобы клиент просто декодил JSON, а не парсил HTML/сырьё.

export const SCHEMA_VERSION = 1;

export type Series = "imsa";
export type RaceClass = "GTP" | "LMP2" | "GTD";
export type EventStatus = "upcoming" | "live" | "finished";

export interface Driver {
  name: string; // «F. Surname»
  nationality: string;
}

export interface ResultRow {
  position: number; // абсолютная позиция в классификации
  classPosition: number; // позиция внутри своего класса (вычисляется)
  carNumber: string;
  chassis: string;
  raceClass: RaceClass;
  team: string;
  drivers: Driver[];
  laps: number | null;
  leaderTime: string; // лидер класса — полный результат; остальные — «+gap»
  totalTime: string; // абсолютное время / «DNF»
  interval: string;
  pitstops: number | null;
}

export interface Session {
  name: string; // из имени папки: «Race» / «Qualifying» / «Practice 1»
  type: string; // session_type из JSON
  start: string | null; // ISO реального инстанта (wall-clock + таймзона трассы)
  wallClock: string | null; // ISO с цифрами wall-clock трассы В UTC (без сдвига);
  // приложение кладёт его в ref.date, а builder сам применяет пояс — так
  // клиентский путь идентичен прямому скрейпу и не конвертит пояс дважды.
  hasResults: boolean;
  rows: ResultRow[];
}

export interface PointsEntry {
  key: string; // Teams: номер машины «31»; Drivers: полное имя
  points: number;
  position: number;
}

// Очки по классам (GTDPRO+GTD склеены в GTD), отдельно пилоты и машины.
export interface OfficialPoints {
  drivers: Partial<Record<RaceClass, PointsEntry[]>>;
  teams: Partial<Record<RaceClass, PointsEntry[]>>;
}

export interface EventSnapshot {
  schemaVersion: number;
  series: Series;
  season: number;
  round: number; // порядковый в листинге Al Kamel (НЕ номер этапа чемпионата)
  slug: string;
  name: string; // event_name из сессии, иначе имя трассы
  venue: string; // имя трассы из папки раунда
  circuitName: string | null;
  circuitLengthM: number | null;
  status: EventStatus;
  start: string | null; // инстант первой сессии
  end: string | null; // инстант последней сессии
  sessions: Session[];
  generatedAt: string;
}

export interface IndexEvent {
  round: number;
  slug: string;
  name: string;
  venue: string;
  status: EventStatus;
  start: string | null;
  end: string | null;
  resultsPath: string; // «imsa/2026/08_road-america.json»
}

export interface SeasonIndex {
  schemaVersion: number;
  series: Series;
  season: number;
  generatedAt: string;
  events: IndexEvent[];
}
