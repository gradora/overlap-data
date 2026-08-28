// Стабильный ключ события — имя файла семейства `<series>/events/`.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ КЛЮЧ. Файл события — новое семейство, и класть его на
// существующие идентификаторы нельзя: они дрейфуют. Раунд едет при отмене
// этапа, дата — при переносе, слаг трассы совпадает (в 2026 два события
// `bahrain-testing` — предсезонки 11–13 и 18–20 февраля, имя у обеих
// буквально «Pre-Season Testing»), порядковый номер внутри группы едет при
// вставке более раннего события. Стабильно только то, что присвоил ИСТОЧНИК:
// `meeting_key` OpenF1 не перенумеровывается, а слаги WEC/IMSA — это пути их
// собственных URL, то есть тоже ключи источника.
//
// ФОРМАТ: `<серия>-<сезон>-<читаемая часть>-<ключ источника>`. Читаемая часть
// — чтобы имя файла было понятно человеку; ключ источника — чтобы оно не
// менялось никогда. Решение владельца 28.08.2026.
//
// ПОЧЕМУ СУФФИКС У ВСЕХ, А НЕ ТОЛЬКО У СТОЛКНУВШИХСЯ. «Добавлять, когда
// нужно» означало бы, что ключ события зависит от его СОСЕДЕЙ: появился
// второй тест — и у первого поехало имя. По той же причине суффикс не
// привязан к виду события: `bahrain` и `jeddah` в 2026 уже сменили вид на
// «отменён», и ключ уехал бы вместе с ним.
//
// ПОРЯДОК ИМЁН НИЧЕГО НЕ ЗНАЧИТ, и это нормально. Ключи митингов не
// хронологичны в принципе: февральские тесты 2026 — 1304 и 1305, мартовский
// Альберт-парк — 1279 (OpenF1 регистрирует тесты позже гонок). Хронология
// живёт в витрине календаря, она и есть оглавление; каталог `data/` —
// хранилище. Существующее семейство штрафов уже лежит как `2026_1, 2026_10,
// 2026_11, 2026_12, 2026_2`, и ни один потребитель от порядка не зависит.

/// Символы, безопасные для имени файла и для пути URL зеркала.
function sanitize(part: string): string {
  return part.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/// Разделитель источника у F1: `meeting_key` OpenF1, а при его отсутствии —
/// осознанно худший вариант с пометкой в самом ключе.
export type F1KeySource =
  | { kind: "meeting"; meetingKey: number }
  /// Курируемый этап (`overrides/calendar.json`): пары в OpenF1 нет вовсе.
  /// Идентичность такому событию задаёт куратор, и она же — дата.
  | { kind: "override"; date: string }
  /// Гонка jolpica без пары в OpenF1. Встречается, когда день гонки накрыт
  /// оверлеем: бэкенд НАМЕРЕННО не отдаёт ей чужой ключ. Раунд дрейфует, но
  /// другого различителя у такого события нет — вызывающий обязан
  /// залогировать это громко (см. F1_KEY_UNSTABLE).
  | { kind: "round"; round: number };

/// Пометка в ключе, по которой видно, что различитель нестабилен.
export const F1_KEY_UNSTABLE = "r";

export function f1SourceSuffix(src: F1KeySource): string {
  switch (src.kind) {
    case "meeting":  return String(src.meetingKey);
    case "override": return `ovr${src.date.replace(/-/g, "")}`;
    case "round":    return `${F1_KEY_UNSTABLE}${src.round}`;
  }
}

/// Ключ события F1: `f1-2026-bahrain-testing-1304`.
export function f1EventKey(season: number, assetSlug: string, src: F1KeySource): string {
  return `f1-${season}-${sanitize(assetSlug)}-${f1SourceSuffix(src)}`;
}

/// Ключ события WEC: `wec-2026-6-hours-of-imola-2026`. Слаг fiawec — путь его
/// собственного URL (`/en/race/<slug>`), то есть уже ключ источника;
/// отдельного суффикса не нужно. Год в слаге дублирует сезон — это дубль
/// источника, не наш, и «чинить» его значило бы завести свой идентификатор.
export function wecEventKey(season: number, slug: string): string {
  return `wec-${season}-${sanitize(slug)}`;
}

/// Ключ события IMSA: `imsa-2026-daytona-international-speedway`,
/// `imsa-2026-daytona-test`. Тесты у IMSA — полноценные события со своим
/// слагом (`round: 0`, свой файл `test_<slug>.json`), поэтому нумерация
/// раундов именем не годится, а слаг годится.
export function imsaEventKey(season: number, slug: string): string {
  return `imsa-${season}-${sanitize(slug)}`;
}

/// Итог сверки набора ключей.
export interface KeyCheck {
  fatal: string[];
  warnings: string[];
}

/// Сторож идентичности. Проверяет ровно две вещи, и обе — про то, чего
/// сегодня не проверяет НИ ОДНО семейство:
///
/// 1. УНИКАЛЬНОСТЬ. Два события с одним ключом — это молчаливая потеря файла:
///    второй перезапишет первый, и заметить это будет негде.
/// 2. НЕИЗМЕННОСТЬ. Ключ события, у которого уже есть файлы, не должен
///    меняться между прогонами. Сменился — значит поехал различитель
///    (переименовали трассу, сменился вид события), и старый файл осиротел, а
///    новый начал историю с нуля. Сопоставляем по `id` витрины: он и есть
///    прежняя идентичность, и меняется реже ключа.
export function checkEventKeys(
  current: { id: string; eventKey: string }[],
  previous: { id: string; eventKey: string }[] | null,
): KeyCheck {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const seen = new Map<string, string>();
  for (const e of current) {
    const clash = seen.get(e.eventKey);
    if (clash) fatal.push(`ключ события не уникален: «${e.eventKey}» у ${clash} и ${e.id}`);
    else seen.set(e.eventKey, e.id);
    if (new RegExp(`-${F1_KEY_UNSTABLE}\\d+$`).test(e.eventKey)) {
      warnings.push(
        `${e.id}: у события нет ключа источника, различитель — раунд (${e.eventKey}); ` +
        `он поедет при отмене этапа — проверь, почему пара в OpenF1 не нашлась`,
      );
    }
  }

  const before = new Map((previous ?? []).map((e) => [e.id, e.eventKey]));
  for (const e of current) {
    const was = before.get(e.id);
    if (was && was !== e.eventKey) {
      fatal.push(`ключ события ДРЕЙФАНУЛ: ${e.id} был «${was}», стал «${e.eventKey}» — ` +
                 `файлы прежнего ключа осиротеют`);
    }
  }
  return { fatal, warnings };
}
