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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "./freeze.js";
import { mirrorSlug, writeIfChanged } from "./mirror.js";
import { WEATHER_PARSER_VERSION } from "./weather.js";
import { RACECONTROL_PARSER_VERSION } from "./racecontrol.js";

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

/// Версия конверта weather — на будущее (этап 2), в этапе 0 семейство не
/// конвертировано. `v` — версия ФОРМЫ конверта; версия ПАРСЕРА живёт в
/// weather.ts — оракул сверяет обе. У race_control (вариант R1) конверта НЕТ:
/// файл остаётся массивом ради Swift-декода каскада 2023–24, его версия — в
/// манифесте семейства и пер-строчным ключом `parser`; конвертная константа
/// понадобилась бы только при переходе на R2.
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
const FAMILY_PREFIXES: ReadonlyArray<readonly [Openf1Family, string]> = [
  ["session_result", "session_result_session_key_"],
  ["sessions", "sessions_meeting_key_"],
  ["meetings", MEETINGS_PREFIX],
  ["drivers", "drivers_meeting_key_"],
  ["stints", "stints_session_key_"],
  ["pit", "pit_session_key_"],
  ["race_control", "race_control_session_key_"],
  ["weather", "weather_session_key_"],
];

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
      if ((doc[i] as any)?.parser !== RACECONTROL_PARSER_VERSION) {
        return `race_control: строка ${i} — устаревший/отсутствующий parser`;
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
