// Файл события — ПРОЕКЦИЯ round-keyed семейств, а не новое хранилище.
//
// Что это. `data/f1/events/<eventKey>.json` собирает в один документ то, что
// уже лежит в `f1/{fia,winners,highlights,milestones}`. Экран события делал по
// одному GET на каждое семейство — четыре запроса ради 7.3 КБ; теперь один.
//
// ПОЧЕМУ ИМЕННО ПРОЕКЦИЯ, А НЕ НАКОПИТЕЛЬ. Накапливающий композит пришлось бы
// защищать теми же предохранителями, что и семейства (окна заморозки, слияние
// без удалений, fail-closed сторожа), и каждый прогон был бы шансом испортить
// собранное — ровно та беда, которую в июле чинили в штрафах. У проекции этой
// проблемы нет по построению: правда живёт в семействах, здесь только её
// отражение, и порченый прогон чинится следующим. Сети проекция не требует
// вовсе (читает локальные файлы), поэтому пересобирать её можно хоть каждый
// прогон бесплатно.
//
// СЛЕДСТВИЕ: файл не может быть свежее своих входов. Семейства обновляются со
// своим темпом (штрафы — каждые 15 минут по уик-эндам, highlights/winners —
// дважды на этап), и проекция наследует его как есть.
//
// ЧЕГО ЗДЕСЬ НЕТ. Погода — отдельным файлом (решение владельца): она весит
// 70 КБ в среднем против 7.3 КБ всех блоков вместе и грузится условно.
// Протоколы сессий — поставка D4, им нужен курируемый слой личностей.
//
// У WEC И IMSA — ТОЛЬКО DERIVED, БЕЗ СЕССИЙ. У них файл события уже есть
// (`<серия>/<год>/NN_<слаг>.json`, путь публикует сам индекс), и дублировать
// в проекцию 26 МБ сессий было бы бессмысленно. Вставить блоки ВНУТРЬ того
// файла тоже нельзя: его пишет продьюсер зеркала, который в снапшоте идёт
// РАНЬШЕ derived-семейств, и он пересобирает файл по белому списку — блоки
// либо отставали бы на прогон, либо стирались бы каждый раз. Поэтому у этих
// серий проекция несёт только штрафы, победителей и хайлайты: экран качает
// два файла вместо четырёх.
//
// ВАЖНО ПРО generatedAt. Из блоков он вырезается вместе с остальным конвертом.
// Иначе композит менялся бы каждый прогон источника, `writeJSONWithEnvelope`
// видел бы отличие и git пух бы на пустом месте.

export const EVENT_FILE_SCHEMA_VERSION = 1;

/// Поля конверта источника, которые в блок не переносятся.
///
/// `generatedAt` — ВРЕДЕН: он меняется каждый прогон источника, и композит
/// коммитился бы вхолостую. `schemaVersion` — избыточен: у композита своя
/// версия, а блочная вводила бы в заблуждение (клиент сверяет контракт файла
/// целиком).
///
/// А вот `season` и `round` ОСТАЮТСЯ, хотя и дублируют верхний уровень:
/// клиентские модели (`FIAEventPenalties`, `F1PastWinners`,
/// `F1EventMilestones`, `F1EventHighlights`) объявляют их обязательными, и без
/// них блок просто не декодируется. Дублирование тут — цена того, что ОДИН И
/// ТОТ ЖЕ декодер читает и отдельный файл семейства, и блок внутри композита.
const ENVELOPE_KEYS = ["schemaVersion", "generatedAt"];

/// Полезная часть документа семейства. null — файла нет или он не разобран:
/// блок просто не появится, и это честное «в семействе этого нет».
export function stripEnvelope(doc: unknown): Record<string, unknown> | null {
  if (doc == null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const src = doc as Record<string, unknown>;
  // Продьюсеры пишут payload плоско рядом с конвертом; вложенный payload
  // встречается у части семейств — поддерживаем обе формы.
  const body = (src.payload && typeof src.payload === "object" && !Array.isArray(src.payload))
    ? src.payload as Record<string, unknown>
    : src;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ENVELOPE_KEYS.includes(k)) continue;
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/// Пилот, реально вышедший на трассу в ЭТОМ событии, с разрезолвленной
/// личностью. Срез заявки сезона по митингу (см. lib/entrylist.ts).
///
/// Зачем внутри файла события: клиент резолвил акроним сам, по составу сезона
/// из ЗАЧЁТА, а для архивного события ради этого качал `<год>/driverStandings`
/// целиком. Заодно уходит целый класс молчаливых подмен — угадывание по
/// первым трём буквам фамилии (братья Леклеры).
import type { ProtocolsBlock } from "./f1protocols.js";

export interface EventEntryDriver {
  driverId: string;
  /// Акроним, под которым пилот идёт в протоколах этого события.
  acronym: string;
  givenName: string;
  familyName: string;
  /// Только у зачётных: заявка не отдаёт национальность резервистам, и
  /// выдумывать её нечем — клиент рисует нейтральный флаг.
  nationality?: string;
  car: number;
  team?: string;
  teamColour?: string;
  /// Конструктор jolpica ЭТОГО этапа — не сезона: у мидсезонной пересадки
  /// (Лоусон-2025: red_bull → rb) сезонный список дал бы первую команду на
  /// весь год. Нет — пилот не стартовал в гонке этапа.
  constructorId?: string;
}

export type EventSeries = "f1" | "wec" | "imsa";

export interface EventFile {
  schemaVersion: number;
  series: EventSeries;
  season: number;
  /// Ключ файла — он же имя. Дублируется внутрь, чтобы файл, попавший не по
  /// тому адресу (сбой деплоя, ручное копирование), был отличим от своего.
  eventKey: string;
  /// Идентичность события в витрине — по ней клиент сверяет, что открыл файл
  /// СВОЕГО события, а не соседа.
  eventId: string;
  round: number;
  /// Заявка ЭТОГО события. Пусто/отсутствует — срез не собрался (нет ключа
  /// митинга или заявки сезона), и клиент резолвит прежним путём.
  entry?: EventEntryDriver[];
  protocols?: ProtocolsBlock;
  fia?: Record<string, unknown>;
  winners?: Record<string, unknown>;
  highlights?: Record<string, unknown>;
  milestones?: Record<string, unknown>;
}

export interface EventFileInput {
  /// Протоколы сессий (D4): позиции, гэпы, компаунды — джойн с `entry` по
  /// номеру машины делает клиент.
  protocols?: ProtocolsBlock | null;
  /// F1 по умолчанию — у него проекция появилась первой.
  series?: EventSeries;
  season: number;
  eventKey: string;
  eventId: string;
  round: number;
  entry?: EventEntryDriver[];
  fia?: unknown;
  winners?: unknown;
  highlights?: unknown;
  milestones?: unknown;
}

/// Сборка проекции. Возвращает null, если собирать нечего: у события нет ни
/// одного блока (так выглядят оверлейные этапы — тесты и отмены, у которых
/// раунда в источнике нет вовсе). Пустой файл писать нельзя: он неотличим от
/// «данные есть, но пустые» и заставил бы клиента доверять пустоте.
export function buildEventFile(input: EventFileInput): EventFile | null {
  const protocols = input.protocols ?? null;
  const blocks = {
    fia: stripEnvelope(input.fia),
    winners: stripEnvelope(input.winners),
    highlights: stripEnvelope(input.highlights),
    milestones: stripEnvelope(input.milestones),
  };
  const entry = input.entry ?? [];
  // Пусто во ВСЕХ блоках, в заявке И в протоколах — собирать нечего.
  if (Object.values(blocks).every((b) => b === null) && !entry.length && !protocols) return null;

  return {
    schemaVersion: EVENT_FILE_SCHEMA_VERSION,
    series: input.series ?? "f1",
    season: input.season,
    eventKey: input.eventKey,
    eventId: input.eventId,
    round: input.round,
    ...(entry.length ? { entry } : {}),
    ...(protocols ? { protocols } : {}),
    ...(blocks.fia ? { fia: blocks.fia } : {}),
    ...(blocks.winners ? { winners: blocks.winners } : {}),
    ...(blocks.highlights ? { highlights: blocks.highlights } : {}),
    ...(blocks.milestones ? { milestones: blocks.milestones } : {}),
  };
}

/// Имя файла события. Отдельной функцией, потому что его знают трое:
/// продьюсер (куда писать), сторож охвата (что проверять) и клиент (что
/// запрашивать) — расхождение здесь было бы молчаливым 404.
export function eventFilePath(eventKey: string): string {
  return `${eventKey}.json`;
}
