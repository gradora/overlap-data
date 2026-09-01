// Классифицированный рейс-контрол F1 — файл `f1/racecontrol/<id события>.json`.
//
// ВЕРБАТИМ СЮДА НЕ ПОПАДАЕТ. Поле `message` источника — текст рейс-контрола
// FIA, то же охраняемое выражение, что вычищенный текст решений стюардов.
// В кухне (зеркало openf1) он лежит как известный риск; перенести его в
// витрину значило бы опубликовать выражение в собственном контракте. Поэтому
// здесь тот же приём, что у штрафов: сообщение классифицируется в `kind` +
// структурные поля (машина, круг, сектор, время, причина), а строку собирает
// клиент сам.
//
// Замер корпуса (23 069 записей, сезоны 2023+): правила ниже классифицируют
// ~97 %; остаток — служебные объявления без структурной ценности («PINK HEAD
// PADDING MATERIAL MUST BE USED»), они в файл не входят и считаются в
// статистике продьюсера.
//
// Ключ файла — `id` события витрины, как у погоды: round=0 — сентинел и не
// уникален, «сезон_раунд» схлопнул бы тесты в один файл.

export const RACECONTROL_SCHEMA_VERSION = 1;
/// Версия ПРАВИЛ классификации. Поднимать при любом изменении taxonomy или
/// регулярок: перечитка зеркала дешёвая (продьюсер бессетевой), но без версии
/// старые файлы никогда не узнали бы о новой разметке.
export const RACECONTROL_PARSER_VERSION = 1;

export type RaceControlKind =
  | "flag"              // флаг: цвет в `flag`, охват в `scope`/`sector`
  | "lap_deleted"       // круг удалён: car, time, reason
  | "lap_reinstated"    // круг возвращён
  | "penalty"           // штраф наложен: car, reason
  | "penalty_served"    // штраф отбыт
  | "investigation"     // расследование/noted: car, reason
  | "no_further_action" // без последствий
  | "safety_car"        // SC/VSC: virtual, deployed
  | "medical_car"
  | "finish"            // клетчатый флаг первому: car
  | "drs"               // enabled/disabled (+зона в reason нет — в enabled)
  | "session_status"    // старт/стоп/резюме сессии
  | "pit_status"        // пит-лейн открыт/закрыт
  | "track_condition"   // дождь/скользко/мусор/низкий грип
  | "car_event"         // машина остановилась/вылетела/эвакуация
  | "weighbridge";      // вызов на весы

/// Причины — закрытый список: свободный текст сюда не попадает по построению.
export type RaceControlReason =
  | "track_limits" | "causing_a_collision" | "impeding" | "speeding"
  | "unsafe_release" | "false_start";

export interface RaceControlFact {
  kind: RaceControlKind;
  lap?: number;
  /// Номер машины из текста или поля источника.
  car?: number;
  flag?: string;
  scope?: string;
  sector?: number;
  /// Время круга «1:23.456» — только у lap_deleted/lap_reinstated.
  time?: string;
  reason?: RaceControlReason;
  /// safety_car: виртуальная ли и выезд/уход. drs: включён/выключен.
  virtual?: boolean;
  deployed?: boolean;
  enabled?: boolean;
}

interface RawRow {
  lap_number?: number | null;
  category?: string | null;
  flag?: string | null;
  scope?: string | null;
  sector?: number | null;
  driver_number?: number | null;
  message?: string | null;
}

const REASONS: [RegExp, RaceControlReason][] = [
  [/TRACK LIMITS/, "track_limits"],
  [/CAUSING A COLLISION/, "causing_a_collision"],
  [/IMPEDING/, "impeding"],
  [/SPEEDING/, "speeding"],
  [/UNSAFE RELEASE/, "unsafe_release"],
  [/FALSE START/, "false_start"],
];

/// Классифицированный факт, или null — запись без структурной ценности
/// (объявление, не событие) в витрину не попадает.
export function classifyRaceControl(row: RawRow): RaceControlFact | null {
  const msg = (row.message ?? "").toUpperCase();
  const base: RaceControlFact = { kind: "flag" };
  if (row.lap_number != null) base.lap = row.lap_number;
  const carFromMsg = /CAR \d{1,2}\b/.exec(msg.replace(/CARS?/, "CAR"));
  const car = row.driver_number ?? (carFromMsg ? Number(/\d+/.exec(carFromMsg[0])![0]) : null);
  if (car != null) base.car = car;
  const reason = REASONS.find(([re]) => re.test(msg))?.[1];
  if (reason) base.reason = reason;
  const time = /\d:\d\d\.\d{3}/.exec(msg)?.[0];

  if (row.category === "SafetyCar" || msg.includes("MEDICAL CAR")) {
    if (msg.includes("MEDICAL CAR")) return { ...base, kind: "medical_car" };
    return {
      ...base, kind: "safety_car",
      virtual: msg.includes("VIRTUAL") || msg.includes("VSC"),
      deployed: msg.includes("DEPLOYED"),
    };
  }
  // Порядок как у клиента: NO FURTHER раньше INVESTIGATION — текст содержит оба.
  if (msg.includes("NO FURTHER")) return { ...base, kind: "no_further_action" };
  if (msg.includes("SERVED") && msg.includes("PENALTY")) return { ...base, kind: "penalty_served" };
  if (msg.includes("PENALTY")) return { ...base, kind: "penalty" };
  if (msg.includes("INVESTIGAT") || msg.includes("NOTED")) return { ...base, kind: "investigation" };
  if (msg.includes("REINSTATED")) return { ...base, kind: "lap_reinstated", ...(time ? { time } : {}) };
  if (msg.includes("DELETED")) return { ...base, kind: "lap_deleted", ...(time ? { time } : {}) };
  if (msg.includes("FIRST CAR TO TAKE THE FLAG")) return { ...base, kind: "finish" };
  if (row.category === "Drs" || msg.startsWith("DRS ") || msg.includes("OVERTAKE ENABLED")) {
    return { ...base, kind: "drs", enabled: msg.includes("ENABLED") };
  }
  if (row.category === "Flag" || row.flag) {
    if (row.flag) base.flag = row.flag;
    if (row.scope) base.scope = row.scope;
    if (row.sector != null) base.sector = row.sector;
    return base;
  }
  if (row.category === "SessionStatus" || /GREEN LIGHT|SESSION (WILL|RESUME|START|STOP)/.test(msg)) {
    return { ...base, kind: "session_status" };
  }
  if (/PIT (LANE|ENTRY|EXIT)/.test(msg) && /OPEN|CLOSED/.test(msg)) {
    return { ...base, kind: "pit_status" };
  }
  if (/TRACK SURFACE|SLIPPERY|RISK OF RAIN|CHANCE OF RAIN|DEBRIS|LOW GRIP|WET/.test(msg)) {
    return { ...base, kind: "track_condition" };
  }
  if (row.category === "CarEvent" || /RECOVERY|STOPPED|OFF TRACK|SPUN/.test(msg)) {
    return { ...base, kind: "car_event" };
  }
  if (/WEIGH/.test(msg)) return { ...base, kind: "weighbridge" };
  return null;
}

export interface RaceControlSession {
  key: number;
  name: string;
  events: RaceControlFact[];
}

export interface RaceControlDoc {
  id: string;
  season: number;
  parserVersion: number;
  /// Порядок сессий и событий — хронология источника.
  sessions: RaceControlSession[];
  /// Запечатан после отстоя события — как у погоды.
  final?: boolean;
}
