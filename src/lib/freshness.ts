// Свежесть продьюсеров: чистая арифметика поверх реестра. Ввод — прошлый
// health.json и результаты текущего прогона, вывод — новые отметки и список
// просроченных. Ни чтения диска, ни времени «сейчас» внутри: `today` приходит
// аргументом, поэтому границы бюджета проверяются тестом, а не наблюдением.
//
// ДНЕВНАЯ ГРАНУЛЯРНОСТЬ — не деталь оформления, а требование. health.json
// пишется через writeIfChanged (побайтовое сравнение всего файла), и каждое
// изменение любого поля — это коммит. Крон часовой; метка с точностью выше
// суток переписывала бы файл 24 раза в день на каждого из 21 продьюсера.
// Поэтому здесь ходят только строки "YYYY-MM-DD", и здесь НЕЛЬЗЯ заводить
// производные от «сейчас» (сколько часов назад, checkedAt, «осталось N») —
// они меняются каждый прогон по построению.
//
// Почему возраст файла тут ни при чём: writeJSONWithEnvelope исключает
// generatedAt из сравнения, файлы меняются только при реальном изменении
// содержимого, и «артефакт не менялся 20 дней» — законное состояние. Считаем
// не изменения данных, а УСПЕШНЫЕ ПРОГОНЫ.

import { PRODUCERS, type ProducerSpec } from "./producers.js";

/// Статус шага GitHub, нормализованный: незаданное (локальный прогон) →
/// "unknown".
export type Outcome = "success" | "failure" | "cancelled" | "skipped" | "unknown";

/// Отметки «продьюсер → дата последнего успеха», день UTC.
export type Stamps = Record<string, string>;

/// Приведение исхода шага к «успеху» для продьюсеров, которые штатно
/// пропускаются (шаг под `if:`). Живёт здесь, а не в health.ts, потому что это
/// предохранитель, а не оформление: не считать skipped успехом для суточного
/// шага — значит переворачивать его отметку в 03:37, тогда как `date`
/// переворачивается в первом прогоне после полуночи. Это гарантированный ВТОРОЙ
/// коммит health.json каждые сутки, то есть регресс дневной гранулярности.
export const normalizeOutcome = (spec: ProducerSpec, raw: Outcome): Outcome =>
  spec.skippedIsSuccess && raw === "skipped" ? "success" : raw;

export interface StaleEntry {
  producer: string;
  /// Суток молчания на момент прогона.
  days: number;
  budgetDays: number;
  /// От чего считаем: дата последнего успеха либо (если успеха не было ни
  /// разу) дата появления продьюсера в реестре.
  since: string;
  /// false — продьюсер не отрабатывал успешно НИ РАЗУ с момента появления
  /// в реестре. Ровно кейс «объявлен, но не подключён к воркфлоу».
  everRan: boolean;
  workflow: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/// День UTC в формате YYYY-MM-DD.
export const utcDay = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/// Разница в сутках между двумя днями UTC. Обе даты — полночь UTC, поэтому
/// деление точное и переходы на летнее время ни при чём.
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/// День UTC через n суток (n может быть отрицательным).
export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/// Мусор в накопленном файле не должен ни ронять прогон, ни притворяться
/// свежей отметкой: всё, что не «YYYY-MM-DD», выбрасываем.
const validDay = (v: unknown): v is string => typeof v === "string" && ISO_DAY.test(v);

/// Читаем карту отметок из произвольного (возможно битого) JSON.
export function readStamps(raw: unknown): Stamps {
  const out: Stamps = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (validDay(v)) out[k] = v;
  }
  return out;
}

/// Позднейшая из двух дат; undefined-и игнорируются. Лексикографическое
/// сравнение ISO-дней совпадает с хронологическим.
const later = (a?: string, b?: string): string | undefined =>
  a === undefined ? b : b === undefined ? a : (a > b ? a : b);

/// Новые отметки последнего успеха.
///
/// Правила, каждое из которых закрывает конкретный способ соврать:
///  1. success в этом прогоне → сегодня;
///  2. маркер чужого воркфлоу (tracks) → дата из маркера;
///  3. ЛЮБОЙ другой outcome, включая "unknown" локального прогона, отметку не
///     трогает — переносим прежнюю байт-в-байт. Это ограничение «локальный
///     `npm run health` не портит накопленное и не поднимает тревогу»;
///  4. берём ПОЗДНЕЙШУЮ из кандидата и прежней — отметка не может поехать
///     назад, даже если маркер удалили, часы раннера уехали или файл починили
///     руками;
///  5. ключи вне реестра выпадают — переименование продьюсера честно
///     обнуляет его историю, а не тащит мёртвую запись вечно.
export function mergeLastSuccess(
  previous: Stamps,
  outcomes: Record<string, Outcome>,
  markers: Stamps,
  today: string,
  registry: ProducerSpec[] = PRODUCERS,
): Stamps {
  const out: Stamps = {};
  for (const spec of registry) {
    const fresh = outcomes[spec.key] === "success" ? today : undefined;
    const best = later(later(previous[spec.key], fresh), markers[spec.key]);
    if (best !== undefined) out[spec.key] = best;
  }
  return out;
}

/// Даты первого появления продьюсеров, которые ещё НИ РАЗУ не отработали
/// успешно.
///
/// Это ответ на «первый прогон, когда истории нет». Пустая отметка не может
/// значить «свежо» — тогда продьюсер, которого забыли подключить, прятался бы
/// вечно, то есть исходный инцидент прошёл бы мимо. Не может она значить и
/// «протухло» — иначе выкатка реестра даёт залп тревог по всем 21 продьюсеру
/// сразу, на пустом месте.
///
/// Поэтому у отсутствующей отметки заводится точка отсчёта — день, когда
/// продьюсера впервые увидели. В день выкатки возраст 0 (залпа нет), дальше он
/// растёт наравне с настоящими отметками, и через бюджет «ни разу не
/// запускался» прорывается наружу.
///
/// Запись живёт ровно до первого успеха: как только появилась lastSuccess,
/// firstSeen вычёркивается. Непустой firstSeen в health.json читается прямо —
/// «эти продьюсеры с момента объявления не отработали ни разу».
export function mergeFirstSeen(
  previous: Stamps,
  lastSuccess: Stamps,
  today: string,
  registry: ProducerSpec[] = PRODUCERS,
): Stamps {
  const out: Stamps = {};
  for (const spec of registry) {
    if (lastSuccess[spec.key] !== undefined) continue; // успех был — точка отсчёта не нужна
    out[spec.key] = previous[spec.key] ?? today;
  }
  return out;
}

/// Просроченные продьюсеры. Просрочка — строгое «больше бюджета»: ровно
/// budgetDays суток молчания ещё норма, budgetDays+1 — тревога.
///
/// Порядок — как в реестре (детерминированный): сортировка по возрасту гоняла
/// бы строки местами при равных значениях и лишний раз дёргала бы файл.
export function staleProducers(
  lastSuccess: Stamps,
  firstSeen: Stamps,
  today: string,
  registry: ProducerSpec[] = PRODUCERS,
): StaleEntry[] {
  const out: StaleEntry[] = [];
  for (const spec of registry) {
    // Ручной продьюсер (см. ProducerSpec.manual) в расчёт не входит: ему никто
    // не обещал регулярности, и вечная тревога по нему обесценила бы сигнал.
    if (spec.manual) continue;
    const success = lastSuccess[spec.key];
    const since = success ?? firstSeen[spec.key];
    if (since === undefined) continue; // ни отметки, ни точки отсчёта — судить не о чем
    const days = daysBetween(since, today);
    if (days <= spec.budgetDays) continue;
    out.push({
      producer: spec.key,
      days,
      budgetDays: spec.budgetDays,
      since,
      everRan: success !== undefined,
      workflow: spec.workflow,
    });
  }
  return out;
}

export interface Freshness {
  lastSuccess: Stamps;
  firstSeen: Stamps;
  stale: StaleEntry[];
}

/// Весь цикл свежести за один прогон: перенести накопленное, проставить
/// сегодняшние успехи, посчитать просрочку. Отдельная функция, а не три вызова
/// в health.ts, — чтобы тесты гоняли ровно ту цепочку, которая бежит в кроне,
/// а не её копию с возможным другим порядком шагов.
///
/// `previous` берётся из прошлого health.json КАК ЕСТЬ (undefined, битый JSON,
/// чужие типы) — свежесть не имеет права падать из-за испорченного файла.
export function computeFreshness(
  previous: { lastSuccess?: unknown; firstSeen?: unknown } | undefined,
  outcomes: Record<string, Outcome>,
  markers: Stamps,
  today: string,
  registry: ProducerSpec[] = PRODUCERS,
): Freshness {
  // Ручные продьюсеры (ProducerSpec.manual) выпадают из свежести ЦЕЛИКОМ, а не
  // только из просрочки: иначе им проставлялся бы firstSeen — точка отсчёта для
  // того, кто «ещё не отработал», — и health.json вечно показывал бы ожидание
  // прогона, которого никто не обещал.
  const tracked = registry.filter((spec) => !spec.manual);
  const lastSuccess = mergeLastSuccess(
    readStamps(previous?.lastSuccess), outcomes, markers, today, tracked,
  );
  const firstSeen = mergeFirstSeen(readStamps(previous?.firstSeen), lastSuccess, today, tracked);
  return { lastSuccess, firstSeen, stale: staleProducers(lastSuccess, firstSeen, today, tracked) };
}
