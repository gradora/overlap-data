// Синтез R1-строк race_control (этап 3 плана docs/f1-kitchen-plan.md §1).
//
// ЗАЧЕМ. Зеркало race_control хранило вербатим рейс-контрола FIA — то же
// охраняемое выражение, что вычищенный текст решений стюардов. Форма R1
// (решение владельца, вопрос №1): файл остаётся JSON-МАССИВОМ строк, потому
// что клиентский каскад архива 2023–24 декодит [RaceControlEvent] и жив;
// каждая строка несёт факт-ключи (выход classifyRaceControl) + legacy-ключи
// для старых сборок (category, lap_number, driver_number) + message — НАШ
// СИНТЕЗ из фактов, порт клиентского RaceControlSource.event(from:): старые
// сборки парсят из строки те же ключевые слова (VIRTUAL / SAFETY CAR /
// DEPLOYED / NO FURTHER / SERVED / PENALTY / INVESTIGAT / DELETED), что
// парсили из текста FIA, — иконки и заголовки пилюль Weekend Recap не гаснут.
//
// ЗАМКНУТОЕ МНОЖЕСТВО ШАБЛОНОВ. Каждый синтезированный message обязан
// матчиться РОВНО ОДНИМ шаблоном из RACECONTROL_MESSAGE_TEMPLATES — это
// сторож «вербатим не пролезает»: свободный текст FIA не матчится ни одним.
// Проверяют одно и то же три места: писатель перед записью (throw), разовый
// конвертер (гейт) и walk-тест CI — все через factTextError (openf1facts.ts).
//
// РАЗДЕЛЕНИЕ: здесь — чистый синтез без диска и без импорта openf1facts
// (тот импортирует нас для оракула; обратное ребро дало бы цикл).
// Классификация — в racecontrol.ts, её таблица тестов теперь охраняет ЗАПИСЬ.

import {
  RACECONTROL_PARSER_VERSION, classifyRaceControl,
  type RaceControlFact, type RaceControlKind,
} from "./racecontrol.js";

/// Kind строки-маркера пустой сессии (амендмент 11): пустых фактов не бывает —
/// сессия без классифицированных событий пишется массивом из ОДНОЙ такой
/// строки, иначе пустой массив нечем версионировать пер-строчно и бамп
/// парсера не доехал бы до него никогда. Старые сборки декодят маркер в
/// RaceControlEvent со сплошными nil — одна серая info-строка, не крэш;
/// сборка витрины (r1RowToFact) маркер отбрасывает.
export const R1_EMPTY_KIND = "empty";

export function r1EmptyMarker(): Record<string, unknown> {
  return { parser: RACECONTROL_PARSER_VERSION, kind: R1_EMPTY_KIND };
}

/// Legacy-ключ category по kind — Record даёт компайл-тайм полноту: новый
/// kind в racecontrol.ts не соберётся без решения, какой категорией его
/// видят старые сборки. Значения — словарь источника (RaceControl.swift
/// разбирает только "SafetyCar", остальные информационные).
///
/// ИЗВЕСТНЫЕ ОТКЛОНЕНИЯ ЛЕГАСИ (ревью этапа 3, принято 10.09.2026 — легаси
/// приведён к семантике НОВОГО пути, план §1 амендмент 15):
///  - medical_car → "SafetyCar": в сырье шёл информационной строкой, теперь
///    легаси рисует SC-бейдж и считает выезды медцины в Recap — ровно как
///    новый путь (28 строк корпуса);
///  - «NOTED - FAILING TO SERVE PENALTY»: заголовок легаси-пилюли стал
///    «PENALTY» вместо «INVESTIGATION» (иконка та же, 17 строк) — порядок
///    якорей синтеза совпадает с классификатором, не с headline легаси;
///  - подписи штрафов легаси-Recap теряют аббревиатуры пилотов «(LEC)» из
///    вербатима (номер машины доезжает через driver_number).
const R1_CATEGORY: Record<RaceControlKind, string> = {
  flag: "Flag",
  safety_car: "SafetyCar",
  medical_car: "SafetyCar",
  drs: "Drs",
  session_status: "SessionStatus",
  car_event: "CarEvent",
  lap_deleted: "Other",
  lap_reinstated: "Other",
  penalty: "Other",
  penalty_served: "Other",
  investigation: "Other",
  no_further_action: "Other",
  finish: "Other",
  pit_status: "Other",
  track_condition: "Other",
  weighbridge: "Other",
};

/// Закрытое множество kind R1-файла: все виды классификатора плюс маркер.
export const R1_KINDS: ReadonlySet<string> =
  new Set([...Object.keys(R1_CATEGORY), R1_EMPTY_KIND]);

/// Факт-ключи строки — выход classifyRaceControl. flag/scope/sector несут
/// двойную службу (факт И legacy-поле старых сборок) — писатель кладёт их
/// только когда они есть в факте (kind "flag"), поэтому фильтр по этому
/// множеству восстанавливает факт без примесей.
export const R1_FACT_KEYS: ReadonlySet<string> = new Set([
  "kind", "lap", "car", "flag", "scope", "sector", "time", "reason",
  "virtual", "deployed", "enabled",
]);

/// Полный белый список ключей R1-строки — для оракула формы: сырьё OpenF1
/// несёт date/session_key/meeting_key/qualifying_phase, ни один из них сюда
/// не входит, «сырьё вернулось» краснеет на первом же ключе.
export const R1_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  ...R1_FACT_KEYS, "parser", "category", "lap_number", "driver_number", "message",
]);

/// Имена флагов для синтеза — закрытый словарь значений источника (тот же
/// список, что switch иконки клиента). Неизвестный флаг = message нет:
/// пилюля старых сборок живёт на поле flag, строка ей не обязательна.
const FLAG_NAMES: Record<string, string> = {
  GREEN: "Green flag",
  YELLOW: "Yellow flag",
  "DOUBLE YELLOW": "Double yellow flag",
  RED: "Red flag",
  BLUE: "Blue flag",
  BLACK: "Black flag",
  "BLACK AND WHITE": "Black and white flag",
  CHEQUERED: "Chequered flag",
  CLEAR: "Clear",
};

/// Порт RaceControlSource.compose(_:car:reason:) клиента — до символа: тот же
/// формат хвостов у обеих синтезаций, бэкендной (архив 2023–24) и клиентской
/// (витрина racecontrol).
function compose(head: string, car?: number, reason?: string): string {
  const parts = [head];
  if (car != null) parts.push(`— car ${car}`);
  if (reason != null) parts.push(`(${reason.replace(/_/g, " ")})`);
  return parts.join(" ");
}

/// message из факта, или null — строка без синтеза легальна (нет слов — нет
/// вербатима). Семантика — порт RaceControlSource.event(from:); сверх порта
/// синтезируются информационные виды (flag/drs/статусы), которые новый путь
/// клиента отбрасывает, а старые сборки показывают текстом: без синтеза их
/// пилюли остались бы немыми. Худший случай длины — lap_deleted с временем,
/// трёхзначной машиной и причиной causing_a_collision: 57 символов, под
/// потолком OPENF1_MAX_STRING=64 (пин в racecontrolsynth.test.ts).
export function synthesizeRaceControlMessage(f: RaceControlFact): string | null {
  switch (f.kind) {
    case "flag": {
      const name = f.flag != null ? FLAG_NAMES[f.flag] : undefined;
      if (name === undefined) return null;
      if (f.sector != null) return `${name} in sector ${f.sector}`;
      if (f.car != null) return `${name} for car ${f.car}`;
      return name;
    }
    case "safety_car":
      // DEPLOYED/ENDING — слова, по которым иконка старых сборок различает
      // выезд (жёлтый бейдж) и уход (серый): active = contains("DEPLOYED").
      return (f.virtual === true ? "Virtual safety car" : "Safety car") +
        (f.deployed === true ? " deployed" : " ending");
    case "medical_car":
      return "Medical car deployed";
    case "penalty":
      return compose("Penalty", f.car, f.reason);
    case "penalty_served":
      return compose("Penalty served", f.car);
    case "investigation":
      return compose("Under investigation", f.car, f.reason);
    case "no_further_action":
      return compose("No further action", f.car);
    case "lap_deleted":
      return compose(f.time != null ? `Lap time ${f.time} deleted` : "Lap time deleted",
        f.car, f.reason);
    case "lap_reinstated":
      return f.time != null ? `Lap time ${f.time} reinstated` : "Lap time reinstated";
    case "finish":
      return f.car != null ? `Car ${f.car} takes the flag` : null;
    case "drs":
      return f.enabled === true ? "DRS enabled" : "DRS disabled";
    case "session_status":
      return "Session status update";
    case "pit_status":
      return "Pit lane status update";
    case "track_condition":
      return "Track condition update";
    case "car_event":
      return f.car != null ? `Incident involving car ${f.car}` : "On-track incident";
    case "weighbridge":
      return f.car != null ? `Car ${f.car} called to weighbridge` : "Weighbridge call";
    default: {
      const exhaustive: never = f.kind;
      return exhaustive;
    }
  }
}

const REASON_RE =
  "(track limits|causing a collision|impeding|speeding|unsafe release|false start)";

/// Замкнутое множество шаблонов синтеза. Якоря ^…$ и взаимоисключающие головы
/// («Penalty served» не матчится шаблоном «Penalty…»: после головы допустимы
/// только « — car N», « (причина)» или конец строки) — каждый синтез матчится
/// РОВНО одним, любой вербатим FIA — нулём.
export const RACECONTROL_MESSAGE_TEMPLATES: readonly RegExp[] = [
  /^(Green|Yellow|Double yellow|Red|Blue|Black|Black and white|Chequered) flag( in sector \d{1,2}| for car \d{1,3})?$/,
  /^Clear( in sector \d{1,2}| for car \d{1,3})?$/,
  /^(Virtual safety car|Safety car) (deployed|ending)$/,
  /^Medical car deployed$/,
  new RegExp(`^Penalty( — car \\d{1,3})?( \\(${REASON_RE}\\))?$`),
  /^Penalty served( — car \d{1,3})?$/,
  new RegExp(`^Under investigation( — car \\d{1,3})?( \\(${REASON_RE}\\))?$`),
  /^No further action( — car \d{1,3})?$/,
  new RegExp(`^Lap time( \\d:\\d\\d\\.\\d{3})? deleted( — car \\d{1,3})?( \\(${REASON_RE}\\))?$`),
  /^Lap time( \d:\d\d\.\d{3})? reinstated$/,
  /^Car \d{1,3} takes the flag$/,
  /^DRS (enabled|disabled)$/,
  /^Session status update$/,
  /^Pit lane status update$/,
  /^Track condition update$/,
  /^Incident involving car \d{1,3}$/,
  /^On-track incident$/,
  /^Car \d{1,3} called to weighbridge$/,
  /^Weighbridge call$/,
];

/// Сколькими шаблонами матчится строка. Контракт: синтез → 1, вербатим → 0;
/// «ровно один» проверяется тестом и оракулом (factTextError).
export function matchedTemplates(message: string): number {
  return RACECONTROL_MESSAGE_TEMPLATES.filter((re) => re.test(message)).length;
}

/// Сырая строка источника → R1-строка, или null (шум — объявление без
/// структурной ценности, витрина его и так отбрасывает; в заготовке не
/// сохраняется вовсе). Порядок ключей несущий: parser, затем факт-ключи В
/// ПОРЯДКЕ classifyRaceControl, затем legacy — сборка витрины восстанавливает
/// факт фильтром по R1_FACT_KEYS с сохранением порядка, и витринный документ
/// получается побайтово тем же, что при классификации на чтении.
export function toR1Row(
  raw: Parameters<typeof classifyRaceControl>[0],
): Record<string, unknown> | null {
  const fact = classifyRaceControl(raw);
  if (fact === null) return null;
  const row: Record<string, unknown> = { parser: RACECONTROL_PARSER_VERSION, ...fact };
  row.category = R1_CATEGORY[fact.kind];
  if (fact.lap != null) row.lap_number = fact.lap;
  if (fact.car != null) row.driver_number = fact.car;
  const message = synthesizeRaceControlMessage(fact);
  if (message !== null) row.message = message;
  return row;
}

/// R1-строка файла → факт для сборки витрины (racecontrolbuild), или null:
/// маркер пустой сессии, чужая/устаревшая строка (не текущий parser — её
/// перечитает добор писателя, до тех пор она как шум) и не-объект
/// отбрасываются. Фильтр по R1_FACT_KEYS сохраняет порядок ключей записи.
export function r1RowToFact(row: unknown): RaceControlFact | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (r.parser !== RACECONTROL_PARSER_VERSION) return null;
  if (typeof r.kind !== "string" || r.kind === R1_EMPTY_KIND) return null;
  const fact: Record<string, unknown> = {};
  for (const k of Object.keys(r)) {
    if (R1_FACT_KEYS.has(k)) fact[k] = r[k];
  }
  return fact as unknown as RaceControlFact;
}
