// Слой извлечённых ФАКТОВ вместо зеркала HTML fiawec.
//
// ЗАЧЕМ. Раньше продьюсеры WEC сохраняли страницы fiawec.com целиком — 24 МБ
// чужого выражения в открытом репозитории. Это редистрибуция, и перед
// публикацией приложения её надо снять. Из трёх рассмотренных вариантов
// (перенести кухню в приватный репозиторий; дать публичному воркфлоу ключ от
// приватного; перестать хранить HTML) выбран третий: он единственный убирает
// предмет спора, а не перепрятывает его, и не заводит ни одного нового узла,
// способного протухнуть незаметно — ни ключа, ни второго репозитория, ни
// второго крона.
//
// ЧТО ИЗМЕНИЛОСЬ. Продьюсер по-прежнему качает ту же страницу, но разбирает её
// В ПАМЯТИ в том же проходе и кладёт на диск не страницу, а извлечённое:
// слаги, даты, id сессий, строки протокола. Ключ файла — тот же
// `mirrorSlug(path)`, что был у зеркала, поэтому адресация не поменялась.
// Замерено на прототипе: 24.03 МБ / 154 файла → 0.37 МБ / 153, витрина на
// выходе побайтово та же.
//
// ГДЕ ГРАНИЦА. Позиция, номер машины, команда, круги, время, дата, id сессии —
// факты, они не охраняются. Страница целиком — выражение. Проект уже проводил
// эту границу однажды, когда убирал вербатим решений FIA; здесь тот же приём.
// Механический сторож границы — `MAX_FACT_STRING`: во всём корпусе медиана
// строки 8 символов, максимум 58 (состав экипажа), а абзац прозы — 200+.
//
// ЧЕМ ПЛАТИМ, ЧЕСТНО. Парсер становится несущим в момент ЗАПИСИ, а не чтения:
// раньше баг чинился правкой функции и перечитыванием архива с диска, теперь
// лечение — перекачка с чужого сервера. Отсюда `WEC_FACTS_SCHEMA_VERSION` и
// правило `isCurrent`: факты старой версии считаются отсутствующими, и архив
// сам подтягивается прогонами после правки парсера.
//
// РАЗДЕЛЕНИЕ. Здесь — адреса, ввод-вывод и форма имени, БЕЗ единого импорта
// парсеров: извлечение живёт в `wecextract.ts`. Иначе получается цикл
// (wecsnapshot → wecfacts → wecsnapshot), а вместе с ним — порядок
// инициализации, на который никто не смотрит.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mirrorSlug, writeIfChanged } from "./mirror.js";
import type {
  WecRacePageInfo, WecRaceTeamRow, WecSessionRef, WecStandingTableParsed,
} from "./wecsnapshot.js";
import type { WecEventResultRow } from "./wecevents.js";

/// Версия схемы фактов. ПОДНИМАТЬ при любой правке парсера, меняющей то, что
/// извлекается: старые факты после этого считаются отсутствующими, и
/// замороженные этапы перечитываются заново. Без этого правка парсера не
/// доезжала бы до архива никогда — то, что при хранении HTML получалось само.
export const WEC_FACTS_SCHEMA_VERSION = 1;

/// Каталог фактов. Имя НЕ `fiawec`: смена имени — часть защиты. Запись
/// `wec/fiawec` убрана из карты границы, поэтому если продьюсер когда-нибудь
/// снова начнёт писать страницы в старый каталог, сторож охвата уронит тесты
/// как «новое семейство без зоны».
export const WEC_FACTS_DIRNAME = "facts";

/// Предел длины строкового поля факта. Не эстетика, а механическая граница
/// «факт против выражения»: замерено на всём корпусе — медиана 8, p99 25,
/// максимум 58. Абзац стюардского вердикта или анонс — 200+, и такой не
/// пролезет обратно при будущей правке парсера.
export const MAX_FACT_STRING = 120;

// MARK: - Адреса страниц источника
//
// Единственное место, где они пишутся. Раньше те же строки собирались
// независимо в семи модулях, а два продьюсера дублировали ещё и сам
// `mirrorSlug` регуляркой «без импорта» — правка канонической функции туда
// просто не дошла бы.

export const wecSeasonPath = (year: number) => `/en/season/${year}`;
export const wecRacePath = (slug: string) => `/en/race/${slug}`;
export const wecIndexPath = () => `/en/page/resultats-1`;
export const wecSessionsPath = (raceId: number) => `/en/page/resultats-1?raceId=${raceId}`;
export const wecResultsPath = (raceId: number, sessionId: number) =>
  `/en/page/resultats-1?raceId=${raceId}&sessionId=${sessionId}`;
export const wecStandingsPath = () => `/en/page/manufacturers-classification`;

// MARK: - Форма факта

export type WecFacts =
  /// Страница сезона: порядок слагов = порядок раундов.
  | { kind: "season"; races: string[]; tests: string[] }
  /// Страница события: расписание уик-энда, даты, страна, id в системе
  /// результатов.
  | {
    kind: "race"; page: WecRacePageInfo | null;
    info: { startMs: number | null; endMs: number | null; iso2: string | null };
    raceId: number | null;
  }
  /// Дропдаун сессий события.
  | { kind: "sessions"; sessions: WecSessionRef[] }
  /// Протокол одной сессии.
  | { kind: "results"; rows: Omit<WecEventResultRow, "drivers">[]; teamRows: WecRaceTeamRow[] }
  /// Зачёт производителей.
  | { kind: "standings"; season: number | null; tables: WecStandingTableParsed[] };

export type WecFactsKind = WecFacts["kind"];

interface Envelope { schemaVersion: number; payload: WecFacts; }

// MARK: - Ввод-вывод

/// Каталог фактов внутри корня данных. `root` — это всегда каталог `data`,
/// а не корень репозитория: так уже устроены библиотеки WEC.
export const wecFactsDir = (root: string) => join(root, "wec", WEC_FACTS_DIRNAME);

/// Файл факта. Имя — РОВНО `mirrorSlug(path)`, без расширения.
///
/// Расширение здесь не косметика: GC осиротевших опознаёт файлы выбывших
/// этапов предикатом «год в КОНЦЕ имени» (`isRaceFileOfSeason`). Добавь
/// `.json` — и GC молча перестанет работать, файлы уехавших этапов замёрзнут
/// навечно, а прогон останется зелёным. Прототип этого слоя такую форму имени
/// как раз и содержал.
export const wecFactsFile = (root: string, path: string) =>
  join(wecFactsDir(root), mirrorSlug(path));

/// Прочитанный факт нужного вида, или null. Факт ЧУЖОЙ ВЕРСИИ схемы — тоже
/// null: он должен быть перечитан, а не молча использован.
export function readFacts<K extends WecFactsKind>(
  root: string, path: string, kind: K,
): Extract<WecFacts, { kind: K }> | null {
  try {
    const doc = JSON.parse(readFileSync(wecFactsFile(root, path), "utf8")) as Envelope;
    if (doc?.schemaVersion !== WEC_FACTS_SCHEMA_VERSION) return null;
    const payload = doc.payload;
    return payload?.kind === kind ? (payload as Extract<WecFacts, { kind: K }>) : null;
  } catch {
    return null;
  }
}

/// Есть ли пригодный факт этого вида. Существование файла НЕ спрашивается
/// нигде отдельно: оракулы заморозки обязаны спрашивать полноту, иначе
/// частично разобранная страница метит этап замороженным навсегда.
export const hasFacts = (root: string, path: string, kind: WecFactsKind): boolean =>
  readFacts(root, path, kind) !== null;

/// Записать факт. Возвращает true, если файл изменился.
///
/// Отказ вместо записи — на две вещи, и обе про правовую границу:
/// строку длиннее `MAX_FACT_STRING` (значит в факты заехало выражение) и
/// разметку внутри строки. Тихо пропустить такое нельзя: один раз пропущенное
/// уезжает в публичный репозиторий и остаётся в его истории.
export function writeFacts(root: string, path: string, facts: WecFacts): boolean {
  const offender = longStringIn(facts);
  if (offender) {
    throw new Error(`wecfacts: факт для ${path} содержит строку длиной ` +
      `${offender.length} (предел ${MAX_FACT_STRING}) — это уже не факт, ` +
      `а выражение: ${JSON.stringify(offender.slice(0, 80))}`);
  }
  const body: Envelope = { schemaVersion: WEC_FACTS_SCHEMA_VERSION, payload: facts };
  return writeIfChanged(wecFactsFile(root, path), JSON.stringify(body) + "\n");
}

/// Первая строка, нарушающая границу факта, или null. Обходит структуру
/// целиком: длинная строка может прятаться в любом вложенном поле.
export function longStringIn(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > MAX_FACT_STRING || /<[a-zA-Z/!]/.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) { const bad = longStringIn(v); if (bad) return bad; }
    return null;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) { const bad = longStringIn(v); if (bad) return bad; }
    return null;
  }
  return null;
}

// MARK: - Форма имени и GC осиротевших
//
// «Как пишем» и «как ищем, чтобы удалить» держатся в ОДНОМ модуле намеренно.
// Раньше они жили в разных файлах (запись в producers/wec.ts, предикат в
// fiawecsite.ts) и разъехаться могли молча — GC переставал удалять, файлы
// выбывших этапов копились, прогон был зелёный.

/// Ожидаемые файлы страниц событий сезона.
export const expectedRaceFiles = (slugs: string[]): Set<string> =>
  new Set(slugs.map((s) => mirrorSlug(wecRacePath(s))));

/// Файл страницы события принадлежит сезону: «en_race_<…>_<год>» с
/// необязательным коротким числовым хвостом (Ле-Ман-2025 опубликован как
/// `24-hours-of-le-mans-2025-1`).
export const isRaceFileOfSeason = (file: string, year: number): boolean =>
  file.startsWith("en_race_") && new RegExp(`_${year}(_\\d{1,2})?$`).test(file);

/// Осиротевшие файлы событий сезона: fiawec перекраивает календарь задним
/// числом (Катар и Бахрейн-2026 уехали в 2027), и без уборки файлы выбывших
/// этапов остаются в репозитории навсегда.
export function orphanRaceFiles(root: string, year: number, slugs: string[]): string[] {
  const dir = wecFactsDir(root);
  if (!existsSync(dir)) return [];
  const expected = expectedRaceFiles(slugs);
  return readdirSync(dir).filter((f) => isRaceFileOfSeason(f, year) && !expected.has(f));
}
