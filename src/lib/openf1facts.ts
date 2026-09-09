// Слой фактов для заготовки OpenF1 — этап 0: реестр полей, манифест
// конвертации, оракул полноты, сторожа формы и предполётная тревога. По
// плейбуку WEC-фактов (`wecfacts.ts`), адаптировано с HTML на JSON.
//
// ЗАЧЕМ. Зеркало `data/f1/openf1` хранит ответы API как есть — 30.4 МБ чужой
// схемы, включая вербатим рейс-контрола FIA. План (docs/f1-kitchen-plan.md §1)
// режет ФОРМУ: класс А (шесть семейств) станет тем же массивом строк, но только
// с keep-полями реестра; класс Б (weather, race_control) — извлечённым фактом.
// Этот модуль — предохранители ДО конвертации: на этапе 0 данные не трогаются,
// но появляются оракул «файл — полноценный факт?», матрица ожидаемых файлов
// замороженного митинга и храповик дыр, чинящий известную ловушку заморозки
// «по наличию листинга» (пропавшие тесты 1304/1305).
//
// ПЕРЕХОДНАЯ СЕМАНТИКА (амендмент 3). Конвертация едет посемейно, и смешанное
// состояние каталога легально. Гейт — манифест `_extractor`: семейство БЕЗ
// записи в нём считается неконвертированным, и его оракул — простой existsSync
// (сырьё валидно). Семейство С записью проверяется формой. Поэтому walk-тест
// зелёный на сегодняшнем сырье и краснеет, только если конвертированное
// семейство откатилось в сырьё — «возврат сырья ловится формой, а не именем».
//
// РАЗДЕЛЕНИЕ, как у wecfacts: здесь адреса, реестр, ввод-вывод и оракулы —
// БЕЗ импорта продьюсеров (иначе цикл producers/openf1 → lib → producers).
// `isRaceLike`/`pitNeedsHeal` переехали сюда из producers/openf1.ts именно
// поэтому: матрица полноты и гейт заморозки обязаны считать race-like и
// здоровье пита ОДНОЙ функцией с писателем, а лежать при этом в lib.

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "./freeze.js";
import { mirrorSlug, writeIfChanged } from "./mirror.js";
import {
  WEATHER_PARSER_VERSION, normalizeOpenF1,
  type OpenF1WeatherRow, type WeatherSamples,
} from "./weather.js";
import { RACECONTROL_PARSER_VERSION } from "./racecontrol.js";
import {
  R1_ALLOWED_KEYS, R1_EMPTY_KIND, R1_KINDS, matchedTemplates, r1EmptyMarker,
  toR1Row,
} from "./racecontrolsynth.js";

/// Версия экстракции класса А. Поднимать при любой правке реестра keep-полей.
///
/// ПРОЦЕДУРА БАМПА — ручная, одним PR (у класса А версия живёт в манифесте
/// СЕМЕЙСТВА, и кроновый писатель её не продвигает — механика isCurrent WEC
/// здесь НЕ работает: после бампа без конвертера каждый прогон пережигал бы
/// кап добора на одни и те же «вечно устаревшие» файлы без прогресса):
///   1. гашение кронов коммитом (if: false на job, как окно этапов 1–3);
///   2. BACKFILL=late без капа — перекачка сырья по расширенному реестру
///      (источник жив; поля сверх прежнего keep берутся из живого API,
///      страховка на его смерть — raw-зеркало в приватном репо);
///   3. src/convert-openf1-a.ts — конвертация + новая версия в манифесте;
///   4. данные + код одним коммитом, расгашение кронов.
/// Забытый шаг 3 ловит тест «версия кода == parser манифеста» на первом же
/// пуше (openf1facts.test.ts) — PR с бампом без конвертации не пройдёт CI.
export const OPENF1_FACTS_SCHEMA_VERSION = 1;

/// Версия конверта weather (этап 2). `v` — версия ФОРМЫ конверта; версия
/// ПАРСЕРА живёт в weather.ts — оракул сверяет обе. У race_control (вариант R1) конверта НЕТ:
/// файл остаётся массивом ради Swift-декода каскада 2023–24, его версия — в
/// манифесте семейства и пер-строчным ключом `parser`; конвертная константа
/// понадобилась бы только при переходе на R2.
///
/// БАМП ЛЮБОЙ ИЗ ВЕРСИЙ КЛАССА Б (v конверта или WEATHER_PARSER_VERSION) —
/// та же ручная 4-шаговая процедура, что у OPENF1_FACTS_SCHEMA_VERSION выше:
/// samples нормализованы С ПОТЕРЯМИ, пересчитать их из факта нельзя — пересъём
/// только из живого API (BACKFILL=late) или из raw-зеркала приватного репо;
/// кроновый путь НЕ сходится (манифест продвигает только конвертер, а оракул
/// сверяет entry.parser раньше пер-файлового) — доказано симуляцией в ревью
/// этапа 2. Забытый конвертер ловит тот же пин-тест манифеста.
export const OPENF1_WEATHER_FACT_VERSION = 1;

// MARK: - Реестр полей (класс А)

/// Семейства зеркала. Класс А — «подмножество as-is», класс Б — «извлечённый
/// факт», у обоих классов имена файлов не меняются (mirrorSlug — сшивка
/// sourceIds, клиентская адресация и GC живут на этой форме).
export type Openf1Family =
  | "meetings" | "sessions" | "drivers" | "session_result" | "stints" | "pit"
  | "race_control" | "weather";

export type Openf1ClassAFamily = Exclude<Openf1Family, "race_control" | "weather">;

export interface Openf1FieldSpec {
  /// Что остаётся в заготовке. Правило сериализации (амендмент 2): писатель
  /// кладёт ВСЕ keep-ключи всегда, отсутствующие у источника — явным null.
  /// Тогда оракул может требовать ТОЧНОЕ равенство множеств ключей, и пропажа
  /// поля у источника не порождает вечную перекачку «файл неполон → добор».
  keep: readonly string[];
  /// Подмножество keep, обязательное Swift-декодерам клиента
  /// (OpenF1Models.swift, non-optional поля) — каскад архива 2023–24 жив и
  /// читает эти семейства mirror-first. Парный тест с декодерами — на этапе 1.
  clientRequired: readonly string[];
  /// Что выбрасывается — ОСОЗНАННО, по карте потребления (нет читателей ни в
  /// сборке, ни в клиенте). Union keep+drop обязан покрывать каждый ключ
  /// боевого корпуса — это держит тест реестра: новое поле источника не
  /// проскочит неклассифицированным.
  drop: readonly string[];
}

export const OPENF1_FIELDS: Record<Openf1ClassAFamily, Openf1FieldSpec> = {
  meetings: {
    keep: ["meeting_key", "meeting_name", "date_start", "date_end", "year",
      "is_cancelled", "circuit_short_name", "country_name", "location"],
    clientRequired: ["meeting_key", "meeting_name", "date_start", "date_end"],
    drop: ["meeting_official_name", "gmt_offset", "circuit_key", "circuit_type",
      "circuit_image", "circuit_info_url", "country_code", "country_flag",
      "country_key"],
  },
  sessions: {
    // session_type сборкой не потребляется, но обязателен клиенту (OpenF1Session
    // non-optional) — карта потребления его резала, дизайн вернул.
    // is_cancelled — тоже возврат, но уже НА ЭТАПЕ 1: карта потребления
    // снималась 07.09, а 08.09 появился Б1-блок schedule (f1protocols.
    // buildScheduleBlock читает s.is_cancelled — пилюля «Cancelled» у сессий
    // отменённых Бахрейна/Джидды-2026). Дроп по таблице дизайна ронял эталон
    // витрины: flag cancelled пропадал из файлов событий.
    keep: ["session_key", "session_name", "session_type", "meeting_key",
      "date_start", "date_end", "is_cancelled"],
    clientRequired: ["session_key", "session_name", "session_type", "meeting_key"],
    drop: ["circuit_key", "circuit_short_name", "country_code", "country_key",
      "country_name", "location", "gmt_offset", "year"],
  },
  drivers: {
    keep: ["driver_number", "name_acronym", "first_name", "last_name",
      "broadcast_name", "team_name", "team_colour"],
    clientRequired: ["driver_number", "name_acronym", "team_name", "team_colour"],
    drop: ["headshot_url", "country_code", "full_name", "meeting_key", "session_key"],
  },
  session_result: {
    // session_key сборкой не потребляется, но required у OpenF1SessionResult.
    keep: ["driver_number", "session_key", "position", "number_of_laps",
      "dnf", "dns", "dsq", "duration", "gap_to_leader"],
    clientRequired: ["driver_number", "session_key"],
    // points есть в боевом корпусе, но не в карте потребления: f1protocols
    // переносит только перечисленные поля, очки F1 едут из Jolpica-зачёта,
    // клиентский декодер их не требует — выбрасываем осознанно.
    drop: ["meeting_key", "points"],
  },
  stints: {
    keep: ["driver_number", "stint_number", "compound"],
    clientRequired: ["driver_number", "stint_number"],
    drop: ["lap_start", "lap_end", "tyre_age_at_start", "meeting_key", "session_key"],
  },
  pit: {
    // Клиент pit не читает вовсе (в OpenF1Service ручки нет) — clientRequired
    // пуст. stop_duration обязателен и самолечению (pitNeedsHeal).
    keep: ["driver_number", "stop_duration"],
    clientRequired: [],
    drop: ["date", "lane_duration", "pit_duration", "lap_number",
      "meeting_key", "session_key"],
  },
};

// MARK: - Экстракция класса А (этап 1)

/// Строки источника → канонический текст факта. Правила: лишние ключи источника
/// молча отбрасываются (осознанный drop держит тест реестра «union покрыт
/// keep ∪ drop»), ВСЕ keep-ключи кладутся КАЖДОЙ строке — отсутствующие явным
/// null (амендмент 2: иначе пропажа поля у источника означала бы вечную
/// перекачку «неполон → добор»); порядок ключей — порядок реестра keep;
/// сериализация компактная, завершающий \n. «Ответ API как есть» перестаёт
/// существовать: и набор полей, и байтовая форма — наши.
///
/// Сторож — throw, не тихий пропуск: результат прогоняется через оракул формы
/// (factTextError), и строка, не прошедшая его ПОСЛЕ экстракции (вербатим-длина
/// в keep-значении, не-объект в массиве, разлив сверх потолка семейства), не
/// записывается вовсе. Писатель и разовый конвертер зовут ОДНУ эту функцию —
/// «как пишем» и «как проверяем» не могут разъехаться.
export function extractClassA(family: Openf1ClassAFamily, rows: unknown): string {
  if (!Array.isArray(rows)) {
    throw new Error(`extractClassA ${family}: источник — не массив строк (${typeof rows})`);
  }
  const keep = OPENF1_FIELDS[family].keep;
  const extracted = rows.map((row, i) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`extractClassA ${family}: строка ${i} — не объект`);
    }
    const fact: Record<string, unknown> = {};
    // undefined → null явно: JSON.stringify выбросил бы undefined-ключ, и
    // оракул точного равенства множеств счёл бы файл битым.
    for (const k of keep) fact[k] = (row as any)[k] === undefined ? null : (row as any)[k];
    return fact;
  });
  const text = JSON.stringify(extracted) + "\n";
  const err = factTextError(family, { parser: OPENF1_FACTS_SCHEMA_VERSION }, text);
  if (err) throw new Error(`extractClassA: ${err}`);
  return text;
}

// MARK: - Экстракция weather (класс Б, этап 2)

/// Сырые строки ручки weather → канонический текст факта-конверта (дизайн §1):
///   { "v": 1, "kind": "weather", "parser": N, "samples": WeatherSamples }
/// где samples — РОВНО выход normalizeOpenF1 (колоночная форма, unix-секунды,
/// км/ч, дедуп таймстампов): нормализация переезжает с чтения на запись.
/// Пустой/непригодный источник → reject-маркер { …, "reject": "<причина>" } —
/// это ВАЛИДНЫЙ факт («нет отсчётов» — знание), им живёт счёт holes у
/// f1weather: «первый seal требует полного зеркала» продолжает работать.
///
/// Не-массив коэрсится в [] ровно как делал читатель до переезда
/// (normalizeOpenF1(Array.isArray ? rows : []) в f1weather) — причина reject
/// байт-в-байт совпадает с прежним варнингом витрины.
///
/// НЕ идемпотентна над собственным выходом (конверт — не массив строк →
/// reject): писатель зовёт её только на 200-ответ API, а конвертер обязан
/// отличать уже-конверт от сырья (см. convert-openf1-weather.ts).
///
/// Выход прогоняется через оракул формы — писатель, конвертер и walk-тест
/// смотрят одной проверкой; клиент weather-файлы не читает вовсе (К4),
/// лок-степ с приложением не нужен.
export function extractWeatherFact(rows: unknown): string {
  const { samples, reject } = normalizeOpenF1(
    Array.isArray(rows) ? (rows as OpenF1WeatherRow[]) : []);
  const fact = reject === null
    ? { v: OPENF1_WEATHER_FACT_VERSION, kind: "weather",
        parser: WEATHER_PARSER_VERSION, samples }
    : { v: OPENF1_WEATHER_FACT_VERSION, kind: "weather",
        parser: WEATHER_PARSER_VERSION, reject };
  const text = JSON.stringify(fact) + "\n";
  const err = factTextError("weather", { parser: WEATHER_PARSER_VERSION }, text);
  if (err) throw new Error(`extractWeatherFact: ${err}`);
  return text;
}

/// Разбор факта погоды читателем (f1weather):
/// - { samples } — пригодная сессия;
/// - { reject } — валидный reject-маркер (дыра С прежним варнингом);
/// - null — НЕ факт текущих версий: битый текст, сырьё, чужой конверт,
///   устаревший parser. Для читателя это дыра БЕЗ варнинга, как «файла нет» —
///   ровно прежний счёт holes; устаревший факт как дыра держит правило
///   «первый seal требует полного зеркала», а добор писателя перечитает файл.
export function parseWeatherFact(
  text: string,
): { samples: WeatherSamples } | { reject: string } | null {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc?.v !== OPENF1_WEATHER_FACT_VERSION || doc?.kind !== "weather" ||
      doc?.parser !== WEATHER_PARSER_VERSION) return null;
  if (typeof doc.reject === "string") return { reject: doc.reject };
  if (!Array.isArray(doc.samples?.t)) return null;   // конверт без samples и без reject
  return { samples: doc.samples as WeatherSamples };
}

// MARK: - Экстракция race_control (класс Б, вариант R1, этап 3)

/// Сырые строки ручки race_control → канонический текст R1-факта: JSON-МАССИВ
/// строк (конверта нет — Swift-декод [RaceControlEvent] клиентского каскада
/// 2023–24 жив), построчно classifyRaceControl + синтез message из фактов
/// (racecontrolsynth.ts). Шум (null классификатора) не сохраняется — витрина
/// его и так отбрасывает; вербатим FIA не переживает запись по построению.
/// Пустых фактов не бывает (амендмент 11): ноль классифицированных строк →
/// массив из одной строки-маркера с parser.
///
/// Сторож шаблонов — В ПРЕДПОЛЁТЕ писателя (амендмент 6): выход прогоняется
/// через оракул формы (message ⇒ ровно один шаблон синтезатора), не прошёл —
/// throw ДО записи: вербатим не может закоммититься даже одним прогоном.
///
/// НЕ идемпотентна над собственным выходом (classifyRaceControl над синтезом
/// дал бы вторичную разметку): писатель зовёт её только на 200-ответ API, а
/// конвертер опознаёт уже-факт оракулом (см. convert-openf1-racecontrol.ts).
export function extractRaceControlFact(rows: unknown): string {
  if (!Array.isArray(rows)) {
    throw new Error(`extractRaceControlFact: источник — не массив строк (${typeof rows})`);
  }
  const out: Record<string, unknown>[] = [];
  rows.forEach((row, i) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`extractRaceControlFact: строка ${i} — не объект`);
    }
    const r1 = toR1Row(row);
    if (r1 !== null) out.push(r1);
  });
  const text = JSON.stringify(out.length > 0 ? out : [r1EmptyMarker()]) + "\n";
  const err = factTextError("race_control", { parser: RACECONTROL_PARSER_VERSION }, text);
  if (err) throw new Error(`extractRaceControlFact: ${err}`);
  return text;
}

// MARK: - Сторожа формы (дизайн §2.2/§2.4)

/// Потолок длины СТРОКОВОГО значения в конвертированном файле — JSON-аналог
/// сторожа «нет HTML» у WEC: любой вербатим-абзац FIA или URL длиннее, а
/// легитимные значения короче с запасом. Замер боевого корпуса 07.09.2026:
/// максимум среди keep-строк класса А — 25 символов (ISO-дата с офсетом);
/// длиннейшие содержательные — meeting_name 25, country_name 20,
/// circuit_short_name 18. Плюс будущий синтез рекапа race_control ~45 —
/// итого 64 с запасом. Экспортируется писателю этапа 1: превышение = throw
/// ДО записи, а walk-тест ловит то же самое пост-фактум.
export const OPENF1_MAX_STRING = 64;

/// Потолок байтов файла по семейству — боевой максимум ×4 (замер по сырому
/// корпусу 07.09.2026, имя файла-рекордсмена в комментарии). Конвертированные
/// файлы — ПОДМНОЖЕСТВА сырья, так что даже полный возврат сырья остаётся под
/// потолком по белому списку ключей; потолок ловит другой класс поломки —
/// патологический разлив (вербатим, задублированные строки, чужое семейство
/// под нашим именем). Применяется только к конвертированным семействам.
export const OPENF1_MAX_FILE_BYTES: Record<Openf1Family, number> = {
  meetings: 4 * 20_544,        // meetings_year_2026
  sessions: 4 * 1_948,         // sessions_meeting_key_1302
  drivers: 4 * 45_826,         // drivers_meeting_key_1279
  session_result: 4 * 4_356,   // session_result_session_key_11330
  stints: 4 * 42_801,          // stints_session_key_11468
  pit: 4 * 18_118,             // pit_session_key_9149
  race_control: 4 * 84_980,    // race_control_session_key_11353
  weather: 4 * 133_039,        // weather_session_key_9683
};

/// Первая строка глубже лимита в любом углу структуры (ключи не проверяются:
/// у класса А они под белым списком, у класса Б — фиксированы конвертом).
function findLongString(value: unknown): string | null {
  if (typeof value === "string") return value.length > OPENF1_MAX_STRING ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findLongString(v);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) {
      const hit = findLongString(v);
      if (hit !== null) return hit;
    }
  }
  return null;
}

// MARK: - Имя файла ↔ семейство

/// «Как пишем» и «как опознаём» — в одном модуле, урок WEC: предикат имени в
/// другом файле разъезжается с записью молча. Порядок префиксов важен:
/// session_result_* длиннее и проверяется ДО sessions_* — иначе протокол
/// опознался бы как листинг.
const MEETINGS_PREFIX = "meetings_year_";
const SESSIONS_PREFIX = "sessions_meeting_key_";
const DRIVERS_PREFIX = "drivers_meeting_key_";
const FAMILY_PREFIXES: ReadonlyArray<readonly [Openf1Family, string]> = [
  ["session_result", "session_result_session_key_"],
  ["sessions", SESSIONS_PREFIX],
  ["meetings", MEETINGS_PREFIX],
  ["drivers", DRIVERS_PREFIX],
  ["stints", "stints_session_key_"],
  ["pit", "pit_session_key_"],
  ["race_control", "race_control_session_key_"],
  ["weather", "weather_session_key_"],
];

/// Семейства, адресуемые session_key, — их файлы GC сносит вслед за сессией.
const SESSION_KEY_PREFIXES = FAMILY_PREFIXES
  .filter(([, prefix]) => prefix.includes("_session_key_"))
  .map(([, prefix]) => prefix);

/// Семейство по имени файла зеркала, или null для чужака. Чужак в каталоге —
/// повод уронить walk-тест: имён вне восьми семейств (плюс манифест) там быть
/// не должно.
export function familyOfFile(name: string): Openf1Family | null {
  for (const [family, prefix] of FAMILY_PREFIXES) {
    if (name.startsWith(prefix)) return family;
  }
  return null;
}

/// Семейство по API-относительному пути писателя (`pit?session_key=9`).
export function familyOfRelative(relative: string): Openf1Family | null {
  const head = relative.split("?")[0];
  return FAMILY_PREFIXES.some(([f]) => f === head) ? (head as Openf1Family) : null;
}

// MARK: - Манифест _extractor

/// Имя манифеста. Ведущее подчёркивание недостижимо для mirrorSlug (крайние
/// не-алфанумы отбрасываются) — коллизий с ключами зеркала нет по построению.
export const OPENF1_MANIFEST_NAME = "_extractor";

export const OPENF1_MANIFEST_V = 1;

export interface Openf1FamilyEntry {
  /// Версия экстракции семейства: для класса А — OPENF1_FACTS_SCHEMA_VERSION,
  /// для класса Б — версия его парсера. Отстала от текущей — семейство
  /// «устарело», оракул отвечает «не полон», добор перечитывает.
  parser: number;
}

/// Персистентный бейслайн дыр — храповик предполёта. НЕ скаляр: симуляция
/// показала отравление скалярного счёта пропажей листинга (матрица митинга
/// схлопывается до [листинг, drivers], суммарные дыры ПАДАЮТ, храповик молча
/// опускается — а вернувшийся листинг даёт «новые» дыры поверх заниженного
/// бейслайна). Поэтому карта по-митингово плюс счёт замороженных по годам:
/// пропажу целого митинга или усохший год видно как таковые.
export interface Openf1HolesBaseline {
  /// meetingKey → число дыр; только митинги с дырами (полные не пишем).
  perMeeting: Record<string, number>;
  /// год (из имени meetings_year_*) → число замороженных митингов матрицы.
  /// Отменённые не считаются — они вне матрицы.
  frozenPerYear: Record<string, number>;
}

export interface Openf1Manifest {
  v: number;
  /// Семейство отсутствует в карте = НЕ конвертировано (переходная семантика,
  /// амендмент 3): его файлы — сырьё, оракул для них — existsSync.
  families: Partial<Record<Openf1Family, Openf1FamilyEntry>>;
  holesBaseline?: Openf1HolesBaseline;
}

/// Манифест каталога, или null (нет файла / бит / чужая версия). Чужая версия
/// читается как отсутствие — правило isCurrent WEC: молча использовать
/// манифест будущей схемы опаснее, чем переинициализировать бейслайн.
export function readOpenf1Manifest(dir: string): Openf1Manifest | null {
  try {
    const doc = JSON.parse(readFileSync(join(dir, OPENF1_MANIFEST_NAME), "utf8"));
    if (doc?.v !== OPENF1_MANIFEST_V || typeof doc.families !== "object") return null;
    return doc as Openf1Manifest;
  } catch {
    return null;
  }
}

export function writeOpenf1Manifest(dir: string, manifest: Openf1Manifest): boolean {
  return writeIfChanged(join(dir, OPENF1_MANIFEST_NAME),
    JSON.stringify(manifest, null, 2) + "\n");
}

/// Бейслайн из манифеста, если он нужной формы; иное (в т.ч. скаляр прежней
/// схемы) — как отсутствие: переинициализация безопаснее молчаливой
/// интерпретации чужой структуры.
function baselineOf(manifest: Openf1Manifest): Openf1HolesBaseline | null {
  const b = manifest.holesBaseline as unknown;
  if (typeof b !== "object" || b === null) return null;
  const { perMeeting, frozenPerYear } = b as Openf1HolesBaseline;
  if (typeof perMeeting !== "object" || perMeeting === null) return null;
  if (typeof frozenPerYear !== "object" || frozenPerYear === null) return null;
  return { perMeeting, frozenPerYear };
}

// MARK: - Оракул полноты/свежести факта

/// Ошибка формы содержимого файла, или null (форма в порядке). Чистая функция
/// над текстом — её гоняет и оракул полноты, и walk-тест CI, и писатель
/// этапа 1 перед записью: «сырьё вернулось» ловится всюду одной проверкой.
///
/// Для НЕконвертированного семейства (`entry` нет в манифесте) любой контент
/// валиден — сырьё живёт по existsSync до своего этапа конвертации.
export function factTextError(
  family: Openf1Family, entry: Openf1FamilyEntry | undefined, text: string,
): string | null {
  if (!entry) return null;
  // Сторожа формы (§2.2/§2.4) — до посемейных проверок: потолок байтов по
  // семейству и потолок строкового значения общие для всех конвертированных.
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > OPENF1_MAX_FILE_BYTES[family]) {
    return `${family}: ${bytes} байт против потолка ${OPENF1_MAX_FILE_BYTES[family]} — патологический разлив`;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return `${family}: не JSON`;
  }
  const long = findLongString(doc);
  if (long !== null) {
    return `${family}: строка длиннее ${OPENF1_MAX_STRING} символов ` +
      `(«${long.slice(0, 40)}…») — вербатим/URL в заготовку не пролезает`;
  }
  if (family === "weather") {
    // Конверт класса Б: версия семейства в манифесте, версия формы конверта и
    // версия парсера — все текущие (та же тройка, что у race_control ниже);
    // reject-маркер («нет отсчётов») — валидный факт, им живёт учёт дыр погоды.
    if (entry.parser !== WEATHER_PARSER_VERSION) {
      return "weather: устаревшая версия семейства в манифесте";
    }
    const d = doc as any;
    if (d?.v !== OPENF1_WEATHER_FACT_VERSION) return "weather: чужая версия конверта";
    if (d?.parser !== WEATHER_PARSER_VERSION) return "weather: устаревший парсер";
    if (d?.kind !== "weather") return "weather: чужой вид факта";
    // Конверт обязан нести либо samples (колоночная ось t), либо reject-маркер:
    // сырьё (массив строк) и пустой объект не притворяются фактом.
    if (typeof d.reject !== "string" && !Array.isArray(d.samples?.t)) {
      return "weather: конверт без samples и без reject";
    }
    return null;
  }
  if (family === "race_control") {
    // Вариант R1: файл остаётся МАССИВОМ (клиентский каскад 2023–24 декодит
    // [RaceControlEvent]), версия парсера — ПЕР-СТРОЧНЫМ ключом (амендмент 1:
    // Swift лишние ключи игнорирует, а частичная миграция после бампа иначе
    // непредставима — в семейном манифесте одна версия на все файлы).
    if (entry.parser !== RACECONTROL_PARSER_VERSION) {
      return "race_control: устаревшая версия семейства в манифесте";
    }
    if (!Array.isArray(doc)) return "race_control: не массив (R1)";
    // Пустых фактов не бывает (решение этапа 3): сессия без классифицированных
    // событий пишется строкой-маркером с parser — иначе пустой массив нечем
    // версионировать пер-строчно, и бамп парсера не доехал бы до него никогда.
    if (doc.length === 0) {
      return "race_control: пустой массив — писатель обязан класть строку-маркер с parser";
    }
    for (let i = 0; i < doc.length; i++) {
      const row = doc[i];
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        return `race_control: строка ${i} — не объект`;
      }
      const r = row as Record<string, unknown>;
      if (r.parser !== RACECONTROL_PARSER_VERSION) {
        return `race_control: строка ${i} — устаревший/отсутствующий parser`;
      }
      // Сторожа R1 (§2.4 п.3): kind — из закрытого множества классификатора;
      // ключи — по белому списку (сырьё несёт date/session_key/meeting_key —
      // краснеет на первом же); message — только из шаблонов синтезатора,
      // причём ровно одного: вербатим FIA не матчится ни одним по построению.
      if (typeof r.kind !== "string" || !R1_KINDS.has(r.kind)) {
        return `race_control: строка ${i} — kind вне закрытого множества`;
      }
      if (r.kind === R1_EMPTY_KIND && doc.length !== 1) {
        return `race_control: строка ${i} — маркер пустой сессии не единственная строка файла`;
      }
      const extra = Object.keys(r).filter((k) => !R1_ALLOWED_KEYS.has(k));
      if (extra.length) {
        return `race_control: строка ${i} — ключи вне реестра (${extra.join(", ")}): сырьё вернулось`;
      }
      if (r.message !== undefined) {
        if (typeof r.message !== "string" || matchedTemplates(r.message) !== 1) {
          return `race_control: строка ${i} — message не из шаблонов синтезатора ` +
            `(«${String(r.message).slice(0, 40)}…»)`;
        }
      }
    }
    return null;
  }
  // Класс А: тот же массив строк, но множество ключей каждой строки РАВНО
  // keep-набору реестра (амендмент 2). Надмножество — сырьё вернулось,
  // подмножество — устаревшая/битая экстракция; проверяются ВСЕ строки, не
  // row[0]: сырьё, дописанное в хвост, иначе бы проскочило. Пустой массив —
  // валидный факт (спринт без питстопов), не дыра.
  if (entry.parser !== OPENF1_FACTS_SCHEMA_VERSION) {
    return `${family}: устаревшая версия экстракции в манифесте`;
  }
  if (!Array.isArray(doc)) return `${family}: не массив строк`;
  const keep = OPENF1_FIELDS[family].keep;
  for (let i = 0; i < doc.length; i++) {
    const row = doc[i];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return `${family}: строка ${i} — не объект`;
    }
    const keys = Object.keys(row);
    const extra = keys.filter((k) => !keep.includes(k));
    if (extra.length) return `${family}: строка ${i} — ключи вне реестра (${extra.join(", ")}): сырьё вернулось`;
    const missing = keep.filter((k) => !keys.includes(k));
    if (missing.length) return `${family}: строка ${i} — нет keep-ключей (${missing.join(", ")}): писатель обязан класть все keep (отсутствующие — null)`;
  }
  return null;
}

/// Оракул полноты/свежести — замена existsSync у гейтов писателя. true =
/// «файл есть и это полноценный факт текущей версии»; для неконвертированного
/// семейства = «файл есть». false для конвертированного, но устаревшего/
/// сырого файла — так бамп версии сам ставит архив в очередь добора.
export function factComplete(
  dir: string, manifest: Openf1Manifest | null, relative: string,
): boolean {
  const family = familyOfRelative(relative);
  const file = join(dir, mirrorSlug(relative));
  const entry = family ? manifest?.families?.[family] : undefined;
  if (!entry) return existsSync(file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return factTextError(family!, entry, text) === null;
}

// MARK: - Race-like и здоровье пита (переехали из producers/openf1.ts)

// «Race»/«Sprint» (но не Sprint Qualifying/Shootout).
export function isRaceLike(name: unknown): boolean {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("qual") || n.includes("shootout")) return false;
  return n.includes("race") || n.includes("sprint");
}

/// Пит-файл требует пересъёма: строки есть, а стационарного времени нет НИ У
/// ОДНОЙ. Это сигнатура регрессии источника (с Венгрии-2026 stop_duration
/// перестал считаться; поле дозаполняется задним числом) — а зеркало снимало
/// pit один раз в день гонки, и дозаполнение иначе не долетело бы никогда.
/// Пустой файл НЕ лечится: спринт без остановок — валидное состояние.
/// Оба признака (rows.length, stop_duration) входят в keep пита — предикат
/// переживёт конвертацию класса А без правок.
export function pitNeedsHeal(rows: unknown): boolean {
  return Array.isArray(rows) && rows.length > 0 &&
    !rows.some((r: any) => typeof r?.stop_duration === "number");
}

/// Лечению подлежат только питы сезонов ≥2026: регрессия stop_duration у
/// источника началась с Венгрии-2026, а архив 2023–25 OpenF1 не дозаполняет —
/// замер 07.09.2026: из 49 больных питов замороженных митингов 40 приходятся
/// на 2023–25 и больны «вечно» (месяцы без дозаполнения), 9 — на 2026.
/// Без гейта лечение жгло бы кап (6/прогон) на архиве, до живых 2026-х
/// очередь в BACKFILL=late не доходила бы.
export const PIT_HEAL_SINCE_SEASON = 2026;

// MARK: - Карта митингов по листингам годов

/// «meeting_key → год и отменённость» по всем meetings_year_* каталога.
/// Нужна доборам, идущим ОТ ФАЙЛОВ на диске, а не от календаря
/// (BACKFILL=late): отменённые — вне целей добора, лечение пита гейтится
/// сезоном. Год — из имени файла: это тот же ключ, которым живёт матрица.
export function openf1MeetingIndex(
  dir: string,
): Map<number, { year: number; cancelled: boolean }> {
  const index = new Map<number, { year: number; cancelled: boolean }>();
  if (!existsSync(dir)) return index;
  for (const name of readdirSync(dir)) {
    if (familyOfFile(name) !== "meetings") continue;
    const year = Number(name.slice(MEETINGS_PREFIX.length));
    let meetings: unknown;
    try {
      meetings = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    for (const m of Array.isArray(meetings) ? meetings : []) {
      const key = Number((m as any)?.meeting_key);
      if (!Number.isFinite(key)) continue;
      index.set(key, { year, cancelled: (m as any)?.is_cancelled === true });
    }
  }
  return index;
}

// MARK: - GC осиротевших (этап 4)
//
// У зеркала OpenF1 уборки не было ВОВСЕ: файл митинга, выпавшего из
// meetings_year_* (перенос в другой год, фантом источника), никто больше не
// обновит и не прочитает — он лежал бы навсегда. «Как пишем» и «как ищем,
// чтобы удалить» держатся в одном модуле намеренно — урок WEC (pruneOrphans
// в wecfacts.ts): предикат имени в другом файле разъезжается с записью молча.
//
// ГРАНИЦА СИРОТСТВА (амендмент 9): сиротство меряется по meetings_year_* и
// листингам, НЕ по матрице добора. Файлы ОТМЕНЁННЫХ митингов — не сироты: их
// митинг жив в meetings_year_* (is_cancelled — свойство строки, не отсутствие),
// их сессии живы в листинге. Манифест `_extractor` — вне восьми семейств
// (familyOfFile → null), GC его не видит по построению.

/// Кап уборки — «единиц» за прогон. Единица — осиротевший МИТИНГ (листинг +
/// drivers + сессионные файлы из листинга сносятся вместе) ЛИБО осиротевший
/// session_key россыпью (сессия выпала из живого листинга). Обрезанный, но
/// читаемый meetings_year_* осиротил бы десятки митингов, обрезанный листинг —
/// хвост своих сессий; свыше капа GC не удаляет НИЧЕГО и возвращает отказ —
/// вызывающий обязан прокричать (образец — fail-closed pruneOrphans WEC).
/// Реальная перекройка календаря — один-два митинга, больше — порча.
export const OPENF1_MAX_PRUNE_PER_RUN = 2;

export interface Openf1OrphanScan {
  /// meeting_key с файлами на диске (листинг/drivers), которых нет ни в одном
  /// meetings_year_*.
  meetings: string[];
  /// session_key россыпью: сессионные файлы, чьего ключа нет ни в одном
  /// листинге (живом или осиротевшем).
  sessions: string[];
  /// session_key из листингов осиротевших митингов — сносятся вслед за своим
  /// митингом, в кап единиц не входят (это части единицы-митинга).
  listedByOrphans: string[];
}

/// Разведка сирот БЕЗ удаления — ей же живёт CI-тест «боевой каталог сирот не
/// содержит». Отказ вместо скана — на любую порчу входов сиротства: битый
/// meetings_year_* «осиротил» бы целый год, битый листинг — сессии своего
/// митинга россыпью; GC обязан не верить такому диску целиком, а не удалять
/// то, что успел понять (форму вообще-то держит walk-тест, но уборка со
/// сносом файлов не имеет права полагаться на чужой зелёный).
export function openf1Orphans(dir: string): Openf1OrphanScan | { refused: string } {
  const empty: Openf1OrphanScan = { meetings: [], sessions: [], listedByOrphans: [] };
  if (!existsSync(dir)) return empty;
  const names = readdirSync(dir);

  const meetingFiles = names.filter((n) => familyOfFile(n) === "meetings");
  if (meetingFiles.length === 0) {
    return { refused: "ни одного meetings_year_* — состав митингов неизвестен, мерить сиротство нечем" };
  }
  // Валидный ПУСТОЙ год (глитч «[]» или массив без meeting_key) — порча тише
  // битого JSON: он «осиротил» бы все митинги своего года разом, и в раннем
  // сезоне (1–2 митинга) кап единиц такое пропустил бы. Но пустой год И
  // ЛЕГИТИМЕН в межсезонье (январский meetings?year=N+1 честно пуст), поэтому
  // отказ — только по СОЧЕТАНИЮ «пустой год + найдены кандидаты в сироты»
  // (см. конец функции): без кандидатов пустому году верить безопасно.
  const emptyYears: string[] = [];
  const knownMeetings = new Set<string>();
  for (const name of meetingFiles) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      doc = null;
    }
    if (!Array.isArray(doc)) {
      return { refused: `${name} бит — одна порча «осиротила» бы весь год, GC отменён целиком` };
    }
    const before = knownMeetings.size;
    for (const m of doc) {
      const key = (m as any)?.meeting_key;
      if (key != null) knownMeetings.add(String(key));
    }
    if (knownMeetings.size === before) emptyYears.push(name);
  }

  // Два прохода по листингам: сперва живые (их сессии — «известные»), потом
  // осиротевшие. Сессия, числящаяся И в живом листинге, останется жить —
  // защита от теоретического дубля session_key между митингами.
  const orphanMeetings = new Set<string>();
  const knownSessions = new Set<string>();
  const orphanListed = new Set<string>();
  const listings: Array<{ meetingKey: string; sessionKeys: string[] }> = [];
  for (const name of names) {
    const family = familyOfFile(name);
    if (family === "drivers" && !knownMeetings.has(name.slice(DRIVERS_PREFIX.length))) {
      orphanMeetings.add(name.slice(DRIVERS_PREFIX.length));
    }
    if (family !== "sessions") continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      doc = null;
    }
    if (!Array.isArray(doc)) {
      return { refused: `${name} бит — сессии митинга неперечислимы, GC отменён целиком` };
    }
    listings.push({
      meetingKey: name.slice(SESSIONS_PREFIX.length),
      sessionKeys: doc.map((s) => (s as any)?.session_key)
        .filter((sk) => sk != null).map(String),
    });
  }
  for (const l of listings) {
    if (knownMeetings.has(l.meetingKey)) {
      for (const sk of l.sessionKeys) knownSessions.add(sk);
    } else {
      orphanMeetings.add(l.meetingKey);
    }
  }
  for (const l of listings) {
    if (knownMeetings.has(l.meetingKey)) continue;
    for (const sk of l.sessionKeys) {
      if (!knownSessions.has(sk)) orphanListed.add(sk);
    }
  }

  const looseSessions = new Set<string>();
  for (const name of names) {
    const prefix = SESSION_KEY_PREFIXES.find((p) => name.startsWith(p));
    if (!prefix) continue;
    const sk = name.slice(prefix.length);
    if (!knownSessions.has(sk) && !orphanListed.has(sk)) looseSessions.add(sk);
  }

  // Сочетание «пустой год + кандидаты в сироты» — не верим ни тому, ни
  // другому: вероятнее глитч «[]» источника, чем массовый легитимный выбыв.
  if (emptyYears.length > 0 &&
      (orphanMeetings.size > 0 || looseSessions.size > 0 || orphanListed.size > 0)) {
    return { refused: `${emptyYears.join(", ")} не назвал ни одного meeting_key ` +
      `при найденных кандидатах в сироты — пустому году не верим, GC отменён` };
  }

  return {
    meetings: [...orphanMeetings].sort(),
    sessions: [...looseSessions].sort(),
    listedByOrphans: [...orphanListed].sort(),
  };
}

/// Убрать сирот: файлы выбывшего митинга (листинг, drivers и его сессии — как
/// WEC подметает E5/E6 по raceId) и сессионные файлы россыпью. Возвращает
/// список удалённых; при отказе разведки или превышении капа не удаляет
/// НИЧЕГО — вызывающий обязан прокричать тревогу-предупреждение.
export function pruneOpenf1Orphans(dir: string): { removed: string[] } | { refused: string } {
  const scan = openf1Orphans(dir);
  if ("refused" in scan) return scan;
  const units = scan.meetings.length + scan.sessions.length;
  if (units > OPENF1_MAX_PRUNE_PER_RUN) {
    return { refused: `сирот ${units} единиц при капе ${OPENF1_MAX_PRUNE_PER_RUN} ` +
      `(митинги: ${scan.meetings.join(", ") || "—"}; сессии: ` +
      `${scan.sessions.join(", ") || "—"}) — похоже на обрезанный листинг, ` +
      "не перекройку календаря; ничего не удалено" };
  }
  const removed: string[] = [];
  const rmIfExists = (name: string) => {
    if (!existsSync(join(dir, name))) return;
    rmSync(join(dir, name));
    removed.push(name);
  };
  for (const key of scan.meetings) {
    rmIfExists(`${SESSIONS_PREFIX}${key}`);
    rmIfExists(`${DRIVERS_PREFIX}${key}`);
  }
  for (const sk of [...scan.listedByOrphans, ...scan.sessions]) {
    for (const prefix of SESSION_KEY_PREFIXES) rmIfExists(`${prefix}${sk}`);
  }
  return { removed };
}

// MARK: - Матрица ожидаемых файлов замороженного митинга

/// API-пути всех файлов, которые обязаны существовать у собранного митинга:
/// листинг сессий, drivers, на каждую сессию session_result/stints/
/// race_control/weather, pit — только race-like.
///
/// drivers ВКЛЮЧЁН в матрицу осознанно: у него есть читатель (entrylist —
/// заявка сезона), дыра там настоящая. Замер 07.09.2026: у замороженных
/// НЕотменённых митингов drivers-дыр нет вовсе (единственная была у
/// отменённой Эмилии-Романьи-2023 (1209) — та теперь вне матрицы целиком);
/// листинги без drivers — незамороженные будущие этапы 2026, их снимет
/// основной цикл в их уик-энд.
///
/// Отменённость здесь НЕ проверяется — исключение отменённых митингов из
/// матрицы делают вызывающие (countOpenf1Holes и писатель): у них есть строка
/// митинга с is_cancelled, а у этой функции — только ключ.
export function expectedMeetingHandles(dir: string, meetingKey: number | string): string[] {
  const listing = `sessions?meeting_key=${meetingKey}`;
  const handles = [listing, `drivers?meeting_key=${meetingKey}`];
  let sessions: unknown;
  try {
    sessions = JSON.parse(readFileSync(join(dir, mirrorSlug(listing)), "utf8"));
  } catch {
    // Листинга нет/бит — состав сессий неизвестен; ожидаемы хотя бы листинг и
    // drivers, остальное досчитается, когда листинг появится.
    return handles;
  }
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const sk = (s as any)?.session_key;
    if (sk == null) continue;
    handles.push(`session_result?session_key=${sk}`);
    handles.push(`stints?session_key=${sk}`);
    handles.push(`race_control?session_key=${sk}`);
    handles.push(`weather?session_key=${sk}`);
    if (isRaceLike((s as any)?.session_name)) handles.push(`pit?session_key=${sk}`);
  }
  return handles;
}

/// «Заморожен И ПОЛОН» — новый смысл гейта заморозки (амендмент 5): каждый
/// ожидаемый файл проходит оракул полноты. Больной пит неполнотой НЕ считается
/// (полнота = только дыры/устарелость файлов): лечение — ОТДЕЛЬНЫЙ канал
/// писателя (healMeetingPits, свой кап 6, сезоны ≥ PIT_HEAL_SINCE_SEASON).
/// Иначе 40 вечно больных архивных питов 2023–25 держали бы свои митинги в
/// «не полон» навсегда: с питом в полноте замер 07.09.2026 давал 36/90
/// полных замороженных митингов, без него — 73/87: «заморожен и полон →
/// пропуск» снова покрывает подавляющее большинство архива.
export function frozenMeetingComplete(
  dir: string, manifest: Openf1Manifest | null, meetingKey: number | string,
): boolean {
  // Битый (существующий, но не парсящийся в массив) листинг — митинг НЕ полон:
  // матрица по нему схлопнута, и existsSync-оракул один дал бы «полон» на
  // перманентно испорченном зеркале — писатель обязан переснять листинг.
  if (!listingReadable(dir, meetingKey)) return false;
  for (const rel of expectedMeetingHandles(dir, meetingKey)) {
    if (!factComplete(dir, manifest, rel)) return false;
  }
  return true;
}

/// Листинг сессий существует и читается массивом. Отдельный предикат, потому
/// что от него зависят сразу три места (полнота, счёт дыр, тревога предполёта),
/// и семантика «бит = отсутствует» обязана быть одной на всех.
export function listingReadable(dir: string, meetingKey: number | string): boolean {
  try {
    return Array.isArray(JSON.parse(readFileSync(
      join(dir, mirrorSlug(`sessions?meeting_key=${meetingKey}`)), "utf8")));
  } catch {
    return false;
  }
}

// MARK: - Счёт дыр и предполётная тревога

export interface Openf1HoleReport {
  /// Имена ОТСУТСТВУЮЩИХ файлов (плюс битые листинги сессий — существующий,
  /// но не читающийся массивом листинг считается дырой, иначе порча листинга
  /// полного митинга занижала бы счёт молча). Устаревший факт (staleness) —
  /// НЕ дыра, а очередь добора с капом GET (амендмент 4); иначе массовый бамп
  /// парсера красил бы предполёт до конца перекачки.
  holes: string[];
  /// ВСЕ замороженные митинги матрицы: meetingKey → число дыр (0 у полных).
  /// Полный список нужен предполёту: «митинг из карты пропал из матрицы» —
  /// отдельная тревога, отличимая от «дыры закрылись».
  perMeeting: Record<string, number>;
  /// год → число замороженных митингов (отменённые не считаются).
  frozenPerYear: Record<string, number>;
  /// Замороженные митинги, чей листинг сессий отсутствует или бит: их матрица
  /// схлопнута до [листинг, drivers], и счёт дыр ЗАНИЖЕН — предполёт обязан
  /// тревожиться, а не радоваться «закрытым» дырам (симуляция отравления).
  listingMissing: string[];
  frozenMeetings: number;
  unfrozenMeetings: number;
  /// Отменённые митинги — вне матрицы целиком (см. countOpenf1Holes).
  cancelledMeetings: number;
}

/// Дыры по диску: для каждого ЗАМОРОЖЕННОГО митинга каждого сезона из
/// meetings_year_* — все файлы матрицы. Незамороженные пропускаются: у идущего
/// уик-энда файлов законно ещё нет; митинг без дат тоже не морозится (заморозка
/// требует известного финиша — правило isFrozen).
///
/// ОТМЕНЁННЫЕ (is_cancelled=true) исключаются из матрицы ЦЕЛИКОМ: источник
/// данных их сессий не отдаёт никогда, и 64 «вечные» дыры (Эмилия-Романья-2023,
/// Бахрейн и Саудовская Аравия-2026) жили бы в счёте вечно, а добор жёг бы кап
/// перпетуальными MISS-GET. Уже снятые файлы отменённых ОСТАЮТСЯ лежать —
/// этап 4 (GC осиротевших) не должен опознать их сиротами: их митинг жив в
/// meetings_year_*, сиротство меряется по нему, не по матрице. Оговорка:
/// этап, отменённый ПОСЛЕ отгонявшихся сессий, теряет только хвосты добора —
/// снятое живым путём остаётся, новых запросов по нему не будет.
export function countOpenf1Holes(dir: string, now: number = Date.now()): Openf1HoleReport {
  const report: Openf1HoleReport = {
    holes: [], perMeeting: {}, frozenPerYear: {}, listingMissing: [],
    frozenMeetings: 0, unfrozenMeetings: 0, cancelledMeetings: 0,
  };
  if (!existsSync(dir)) return report;
  const years = readdirSync(dir).filter((f) => familyOfFile(f) === "meetings");
  for (const yearFile of years) {
    const year = yearFile.slice(MEETINGS_PREFIX.length);
    let meetings: unknown;
    try {
      meetings = JSON.parse(readFileSync(join(dir, yearFile), "utf8"));
    } catch {
      continue;
    }
    for (const m of Array.isArray(meetings) ? meetings : []) {
      const key = (m as any)?.meeting_key;
      if (key == null) continue;
      if ((m as any)?.is_cancelled === true) {
        report.cancelledMeetings++;
        continue;
      }
      const finish = Date.parse((m as any)?.date_end ?? (m as any)?.date_start ?? "");
      if (!isFrozen(Number.isNaN(finish) ? null : finish, now)) {
        report.unfrozenMeetings++;
        continue;
      }
      report.frozenMeetings++;
      report.frozenPerYear[year] = (report.frozenPerYear[year] ?? 0) + 1;
      let meetingHoles = 0;
      if (!listingReadable(dir, key)) {
        report.listingMissing.push(String(key));
        // Битый-но-существующий листинг — тоже дыра: existsSync ниже его
        // «видит», и без этой ветки порча листинга ПОЛНОГО митинга давала бы
        // 0 дыр при схлопнутой матрице — молчаливое отравление зеркала
        // (симуляция в тесте). Отсутствующий листинг ловится и циклом ниже.
        const listingFile = mirrorSlug(`sessions?meeting_key=${key}`);
        if (existsSync(join(dir, listingFile))) {
          meetingHoles++;
          report.holes.push(listingFile);
        }
      }
      for (const rel of expectedMeetingHandles(dir, key)) {
        const file = mirrorSlug(rel);
        if (!existsSync(join(dir, file))) {
          meetingHoles++;
          report.holes.push(file);
        }
      }
      report.perMeeting[String(key)] = meetingHoles;
    }
  }
  return report;
}

/// Warning-канал амендмента 2: keep-поле, сплошь null по ВСЕМУ семейству, —
/// сигнатура «источник перестал отдавать поле» (писатель класса А кладёт
/// отсутствующие как null, оракул этого не различает по построению — иначе
/// пропажа поля означала бы вечную перекачку). Это ПРЕДУПРЕЖДЕНИЕ в выводе
/// предполёта, не тревога: сплошной null может быть и легитимным (источник
/// дозаполняет задним числом). Смотрит только конвертированные семейства —
/// на этапе 0 всегда пусто, цена появится вместе с конвертацией.
export function openf1NullFieldWarnings(
  dir: string, manifest: Openf1Manifest | null,
): string[] {
  const warnings: string[] = [];
  if (!manifest || !existsSync(dir)) return warnings;
  const names = readdirSync(dir);
  for (const family of Object.keys(OPENF1_FIELDS) as Openf1ClassAFamily[]) {
    if (!manifest.families?.[family]) continue;
    const keep = OPENF1_FIELDS[family].keep;
    const nonNullSeen = new Set<string>();
    let rows = 0;
    for (const name of names) {
      if (familyOfFile(name) !== family) continue;
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        continue;   // форму держат оракул и walk-тест, здесь только счёт null
      }
      for (const row of Array.isArray(doc) ? doc : []) {
        rows++;
        for (const k of keep) {
          if ((row as any)?.[k] != null) nonNullSeen.add(k);
        }
      }
    }
    if (rows === 0) continue;
    for (const k of keep) {
      if (!nonNullSeen.has(k)) {
        warnings.push(`${family}: keep-поле «${k}» сплошь null по семейству ` +
          `(${rows} строк) — источник перестал его отдавать?`);
      }
    }
  }
  return warnings;
}

export interface Openf1PreflightReport {
  holes: string[];
  baseline: Openf1HolesBaseline;
  initialized: boolean;
  /// Warning-канал (сплошной null и т.п.) — печатается писателем, job не валит.
  warnings: string[];
}

/// Предполёт писателя — ТРЕВОГА, не гейт коммита. throw отсюда красит шаг
/// openf1 (в snapshot.yml и f1live.yml он стоит с continue-on-error), гейт
/// продьюсеров в конце воркфлоу валит job → GitHub шлёт письмо владельцу, а
/// данные прогона ПУБЛИКУЮТСЯ — шаг коммита идёт с if: always(). Это
/// осознанно: формула «exit 1 → коммита нет» в CI была ложью (коммит всё
/// равно случался), а честная тревога ценнее иллюзии гейта. Жёсткие гейты
/// «дальше нельзя» появятся в конвертерах этапов 1–3 — те гоняются локально
/// при гашёных кронах, где exit 1 реально останавливает работу.
///
/// Храповик — по-митингово (см. Openf1HolesBaseline: скаляр отравлялся
/// пропажей листинга). Тревоги: (1) дыры митинга сверх его записи в карте —
/// включая дырявый митинг вне карты («замёрз недособранным» или архив
/// потерял файл); (2) митинг из карты пропал из матрицы либо потерял листинг
/// сессий — счёт его дыр занижен, «улучшению» верить нельзя; (3) год усох по
/// числу замороженных митингов — битый/обрезанный meetings_year_*.
/// Автоснижение — только по-митингово при реальном закрытии дыр добором;
/// рост числа замороженных по годам легален (новые этапы замерзают) и
/// подхватывается молча.
///
/// OPENF1_ACCEPT_HOLES=1 — явный путь принятия нового состояния картой
/// целиком. Когда применять: источник навсегда потерял файлы отгонявшегося
/// этапа; митинг легально ушёл из матрицы (помечен отменённым задним числом).
/// Осознанный разовый ЛОКАЛЬНЫЙ прогон — не переменная крона: постоянно
/// включённая, она выключила бы храповик совсем.
///
/// Замер по диску 07.09.2026 (отменённые уже вне матрицы) — 21 дыра:
/// 7 живых у Японии-2026 (session_result 11248/11249/11253 + stints
/// 11247/11248/11249/11253 — до расширения wanted их никто не добирал) и
/// 14 одиночных по сезонам 2023–25: 13 pit + 1 session_result квалификации
/// Бельгии-2023 (сессия 9135); race_control-дыр — 0. Замороженных митингов
/// 87 (2023: 23, 2024: 25, 2025: 25, 2026: 14), полных из них 73.
export function preflightOpenf1Holes(
  dir: string, now: number = Date.now(),
): Openf1PreflightReport {
  const report = countOpenf1Holes(dir, now);
  const manifest = readOpenf1Manifest(dir) ?? { v: OPENF1_MANIFEST_V, families: {} };
  const warnings = openf1NullFieldWarnings(dir, manifest);
  const current: Openf1HolesBaseline = {
    perMeeting: Object.fromEntries(
      Object.entries(report.perMeeting).filter(([, n]) => n > 0)),
    frozenPerYear: report.frozenPerYear,
  };
  const prior = baselineOf(manifest);
  if (prior === null || process.env.OPENF1_ACCEPT_HOLES === "1") {
    writeOpenf1Manifest(dir, { ...manifest, holesBaseline: current });
    return { holes: report.holes, baseline: current, initialized: prior === null, warnings };
  }
  const alarms: string[] = [];
  for (const [key, n] of Object.entries(report.perMeeting)) {
    const allowed = prior.perMeeting[key] ?? 0;
    if (n > allowed) alarms.push(`митинг ${key}: ${n} дыр при карте ${allowed}`);
  }
  for (const key of Object.keys(prior.perMeeting)) {
    if (!(key in report.perMeeting)) {
      alarms.push(`митинг ${key} из карты дыр пропал из матрицы — ` +
        `строка митинга исчезла из meetings_year_* (или он «отменился»)`);
    }
  }
  // По КАЖДОМУ митингу отчёта, не только известным карте: у полного митинга
  // (запись в карте отсутствует — 0 дыр) порча листинга иначе проходила бы
  // молча, а у дырявого — выглядела бы «улучшением» и опускала храповик.
  for (const key of report.listingMissing) {
    alarms.push(`митинг ${key}: листинг сессий пропал/бит — счёт его дыр занижен`);
  }
  for (const [year, n] of Object.entries(prior.frozenPerYear)) {
    const cur = report.frozenPerYear[year] ?? 0;
    if (cur < n) {
      alarms.push(`год ${year}: ${cur} замороженных митингов при бейслайне ${n} — ` +
        `meetings_year_${year} бит или усох`);
    }
  }
  if (alarms.length) {
    throw new Error(`openf1 предполёт — тревога (данные прогона публикуются, ` +
      `письмо уйдёт через гейт продьюсеров): ${alarms.join("; ")}. ` +
      `Если состояние легитимно — принять его локальным прогоном с OPENF1_ACCEPT_HOLES=1`);
  }
  // Тревог нет ⇒ current поэлементно не хуже prior: perMeeting только
  // опустился (закрытые добором дыры), frozenPerYear только вырос (новые
  // замёрзшие митинги). Записываем как новый бейслайн — это и есть храповик.
  writeOpenf1Manifest(dir, { ...manifest, holesBaseline: current });
  return { holes: report.holes, baseline: current, initialized: false, warnings };
}
