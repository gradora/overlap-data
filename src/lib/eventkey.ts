// Стабильный ключ события — имя файла семейства `<series>/events/`.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ КЛЮЧ. Файл события — отдельное семейство, и класть его на
// существующие идентификаторы нельзя: они дрейфуют. Раунд едет при отмене
// этапа, дата — при переносе, слаг трассы совпадает (в 2026 два события
// `bahrain-testing` — предсезонки 11–13 и 18–20 февраля, имя у обеих
// буквально «Pre-Season Testing»).
//
// ФОРМАТ (D-лайт): `f1-<сезон>-<assetSlug>-<n>`, где n — порядковый номер
// ВНУТРИ группы (сезон, assetSlug), присвоенный В МОМЕНТ ЧЕКАНКИ по
// возрастанию meeting_key. До D-лайт суффиксом был сам ключ источника
// (meeting_key / ovr<дата> / r<round>) — из витрины чужие идентификаторы
// ушли, а стабильность теперь держат два механизма вместе:
//   1) НАСЛЕДОВАНИЕ: раз присвоенный ключ переиспользуется на каждом прогоне
//      (сопоставление с прошлым опубликованным файлом по mk, затем по id);
//      свежую нумерацию получают только события, которых прежде не было, и
//      всегда СЛЕДУЮЩИМ номером — номер умершего события не переиспользуется
//      (иначе файлы чужой истории достались бы новичку);
//   2) СТОРОЖ ДРЕЙФА (checkEventKeys): смена ключа у события с файлами —
//      fatal, витрина не пишется.
//
// ПОЧЕМУ СУФФИКС У ВСЕХ, А НЕ ТОЛЬКО У СТОЛКНУВШИХСЯ. «Добавлять, когда
// нужно» означало бы, что ключ события зависит от его СОСЕДЕЙ: появился
// второй тест — и у первого поехало имя. По той же причине суффикс не
// привязан к виду события: `bahrain` и `jeddah` в 2026 уже сменили вид на
// «отменён», и ключ уехал бы вместе с ним.
//
// ПОРЯДОК ИМЁН НИЧЕГО НЕ ЗНАЧИТ, и это нормально: хронология живёт в витрине
// календаря, она и есть оглавление; каталог `data/` — хранилище.

/// Символы, безопасные для имени файла и для пути URL зеркала.
function sanitize(part: string): string {
  return part.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/// База ключа события F1 — всё, кроме порядкового суффикса.
export function f1KeyBase(season: number, assetSlug: string): string {
  return `f1-${season}-${sanitize(assetSlug)}`;
}

/// Событие на входе чеканки. `id` — прежняя идентичность витрины (у оверлея
/// её на этапе чеканки ещё нет — id оверлея И ЕСТЬ ключ, допустима пустая
/// строка: наследование у него идёт по mk). `mk` — нейтральный числовой ключ
/// события в семействах кухни; null — ключа нет (курируемый этап, гонка без
/// пары).
export interface F1MintEntry {
  id: string;
  base: string;
  mk: number | null;
}

const parseKey = (key: string): { base: string; n: number } | null => {
  const m = /^(.+)-(\d+)$/.exec(key);
  return m ? { base: m[1], n: Number(m[2]) } : null;
};

/// Чеканка ключей событий F1. Возвращает массив, выровненный со входом.
///
/// Наследование — сперва по mk (митинг не перенумеровывается никогда; ключ
/// переживает и превращение оверлея в подтверждённую гонку), затем по id
/// (курируемый этап и гонка без пары: id у них стабильнее ключа). Прежний
/// ключ с ЧУЖОЙ базой не наследуется — переименование трассы честно дойдёт
/// до сторожа дрейфа fatal-ом, а не спрячется.
///
/// Свежая чеканка — по возрастанию mk (события без mk — после, в порядке
/// входа), каждому — СЛЕДУЮЩИЙ свободный номер базы поверх максимума из
/// прошлого файла: номер умершего события не переиспользуется.
export function mintF1EventKeys(
  entries: F1MintEntry[],
  previous: { id: string; eventKey?: string; mk?: number | null }[] | null,
): string[] {
  const maxN = new Map<string, number>();
  const byMk = new Map<number, string>();
  const byId = new Map<string, string>();
  for (const p of previous ?? []) {
    if (!p.eventKey) continue;
    const parsed = parseKey(p.eventKey);
    if (parsed) maxN.set(parsed.base, Math.max(maxN.get(parsed.base) ?? 0, parsed.n));
    if (p.mk != null) byMk.set(p.mk, p.eventKey);
    if (p.id) byId.set(p.id, p.eventKey);
  }

  const out = new Array<string | null>(entries.length).fill(null);
  entries.forEach((e, i) => {
    const inherited =
      (e.mk != null ? byMk.get(e.mk) : undefined) ?? (e.id ? byId.get(e.id) : undefined);
    if (inherited && parseKey(inherited)?.base === e.base) out[i] = inherited;
  });

  const fresh = entries
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => out[i] === null)
    .sort((a, b) => {
      if (a.e.mk != null && b.e.mk != null && a.e.mk !== b.e.mk) return a.e.mk - b.e.mk;
      if ((a.e.mk == null) !== (b.e.mk == null)) return a.e.mk == null ? 1 : -1;
      return a.i - b.i;
    });
  for (const { e, i } of fresh) {
    const n = (maxN.get(e.base) ?? 0) + 1;
    maxN.set(e.base, n);
    out[i] = `${e.base}-${n}`;
  }
  return out as string[];
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
/// не проверяет НИ ОДНО другое семейство:
///
/// 1. УНИКАЛЬНОСТЬ. Два события с одним ключом — это молчаливая потеря файла:
///    второй перезапишет первый, и заметить это будет негде.
/// 2. НЕИЗМЕННОСТЬ. Ключ события, у которого уже есть файлы, не должен
///    меняться между прогонами. Сменился — значит поехал различитель
///    (переименовали трассу, поехала чеканка), и старый файл осиротел, а
///    новый начал историю с нуля. Сопоставление ДВУМЯ путями:
///    по `id` витрины (прежняя идентичность) и по `mk` (переживает смену id
///    «оверлей стал подтверждённой гонкой» — а вместе с id у оверлея id-шные
///    файлы погоды/прогноза/рейс-контрола, поэтому дрейф ключа при живом mk
///    обязан кричать даже когда id уже другой).
export function checkEventKeys(
  current: { id: string; eventKey: string; mk?: number | null }[],
  previous: { id: string; eventKey: string; mk?: number | null }[] | null,
): KeyCheck {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const seen = new Map<string, string>();
  for (const e of current) {
    const clash = seen.get(e.eventKey);
    if (clash) fatal.push(`ключ события не уникален: «${e.eventKey}» у ${clash} и ${e.id}`);
    else seen.set(e.eventKey, e.id);
  }

  const before = new Map((previous ?? []).map((e) => [e.id, e.eventKey]));
  const beforeByMk = new Map(
    (previous ?? []).flatMap((e) => (e.mk != null ? [[e.mk, e] as const] : [])));
  for (const e of current) {
    const was = before.get(e.id);
    if (was && was !== e.eventKey) {
      fatal.push(`ключ события ДРЕЙФАНУЛ: ${e.id} был «${was}», стал «${e.eventKey}» — ` +
                 `файлы прежнего ключа осиротеют`);
    }
    const wasMk = e.mk != null ? beforeByMk.get(e.mk) : undefined;
    if (wasMk && wasMk.eventKey !== e.eventKey && wasMk.id !== e.id) {
      fatal.push(`ключ события ДРЕЙФАНУЛ (mk ${e.mk}): был «${wasMk.eventKey}» у ${wasMk.id}, ` +
                 `стал «${e.eventKey}» у ${e.id} — файлы прежнего ключа осиротеют`);
    }
  }
  return { fatal, warnings };
}
