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
// ВАЖНО ПРО generatedAt. Из блоков он вырезается вместе с остальным конвертом.
// Иначе композит менялся бы каждый прогон источника, `writeJSONWithEnvelope`
// видел бы отличие и git пух бы на пустом месте.

export const EVENT_FILE_SCHEMA_VERSION = 1;

/// Поля конверта источника: в проекции они либо избыточны (season/round уже
/// сверху), либо вредны (generatedAt).
const ENVELOPE_KEYS = ["schemaVersion", "generatedAt", "season", "round"];

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

export interface EventFile {
  schemaVersion: number;
  series: "f1";
  season: number;
  /// Ключ файла — он же имя. Дублируется внутрь, чтобы файл, попавший не по
  /// тому адресу (сбой деплоя, ручное копирование), был отличим от своего.
  eventKey: string;
  /// Идентичность события в витрине — по ней клиент сверяет, что открыл файл
  /// СВОЕГО события, а не соседа.
  eventId: string;
  round: number;
  fia?: Record<string, unknown>;
  winners?: Record<string, unknown>;
  highlights?: Record<string, unknown>;
  milestones?: Record<string, unknown>;
}

export interface EventFileInput {
  season: number;
  eventKey: string;
  eventId: string;
  round: number;
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
  const blocks = {
    fia: stripEnvelope(input.fia),
    winners: stripEnvelope(input.winners),
    highlights: stripEnvelope(input.highlights),
    milestones: stripEnvelope(input.milestones),
  };
  if (Object.values(blocks).every((b) => b === null)) return null;

  return {
    schemaVersion: EVENT_FILE_SCHEMA_VERSION,
    series: "f1",
    season: input.season,
    eventKey: input.eventKey,
    eventId: input.eventId,
    round: input.round,
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
