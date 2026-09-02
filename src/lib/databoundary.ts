// Граница «кухня / витрина» — подготовка репо-сплита.
//
// ЗАЧЕМ. Перед публикацией приложения сырьё (зеркала jolpica, OpenF1, HTML
// fiawec, статика FOM) уезжает в приватный репозиторий, наружу остаётся только
// витрина: это единственный реальный механизм закрытия правового риска
// редистрибуции. Но спланировать переезд нельзя, пока не записано, ЧТО именно
// сырьё и — главное — что из сырья ЧИТАЕТ ПРИЛОЖЕНИЕ. Кухня, которую читает
// клиент, и есть то, что блокирует сплит: унеси её, и приложение ослепнет.
//
// Знание это до сих пор жило в прозе плана и в голове. Здесь оно — данные,
// и на них стоит сторож: новый каталог в `data/` обязан получить зону
// осознанно, а не «сам собой».
//
// СОСТОЯНИЕ 31.08.2026, два шага за день.
// 1. Снимок статики FOM (39 МБ) ПЕРЕЕХАЛ в приватный overlap-data-private —
//    читателей у него не было вовсе.
// 2. HTML fiawec (24 МБ) НЕ ПЕРЕЕХАЛ, а ПЕРЕСТАЛ СУЩЕСТВОВАТЬ: продьюсеры
//    разбирают страницы в памяти и кладут факты (0.40 МБ). Переносить было
//    некуда — его читают пять продьюсеров, то есть это вход сборки, а не
//    склад. Отсюда третий вариант и четвёртая зона.
// Осталось в кухне только то, что читает ПРИЛОЖЕНИЕ: `f1/openf1` и
// `f1/jolpica` (31 МБ). Их снимает фаза 6 по мере того, как файл события
// вытесняет посемейственные запросы.

export type Zone =
  /// Сырые ответы источников. Наружу не публикуется после сплита.
  | "кухня"
  /// Извлечённые из источника ФАКТЫ: не сырьё (чужого выражения там нет) и не
  /// витрина (приложение их не читает). Промежуточное состояние сборки,
  /// которое можно держать в открытом репозитории без правового риска.
  | "заготовка"
  /// Публичный контракт: то, что читает приложение.
  | "витрина"
  /// Курируемые справочники — правятся как данные, не как релиз.
  | "справочник";

export interface DataFamily {
  /// Путь относительно `data/`. `<год>` — плейсхолдер четырёх цифр.
  path: string;
  zone: Zone;
  /// Читает ли ПРИЛОЖЕНИЕ этот путь напрямую (не через продьюсера).
  clientReads: boolean;
  /// Читают ли ПРОДЬЮСЕРЫ бэкенда. Признак заведён отдельно, потому что
  /// «клиент не читает» ещё не значит «можно унести»: у `wec/fiawec` нет ни
  /// одного читателя в приложении, но есть ШЕСТЬ в сборке, и переезд без
  /// переноса сборки её остановит.
  producerReads?: boolean;
  note?: string;
}

export const DATA_FAMILIES: DataFamily[] = [
  // --- Кухня ---
  {
    path: "f1/jolpica", zone: "кухня", clientReads: true, producerReads: true,
    note: "С 01.09.2026 у клиента ТОЛЬКО ФОЛБЭК: расписание — витрина " +
      "календаря v2, зачёты — f1/<год>/standings.json, Last Event — файл " +
      "события. Прямых чтений на горячем пути ноль; clientReads остаётся " +
      "true, пока фолбэки живы.",
  },
  {
    path: "f1/openf1", zone: "кухня", clientReads: true, producerReads: true,
    note: "С 01.09.2026 у клиента в основном ФОЛБЭК: протоколы+стинты — блок " +
      "protocols файла события, рейс-контрол — f1/racecontrol. Прямыми " +
      "остались погодная выгрузка производителя и цепочки для событий без " +
      "файла (архив до 2023).",
  },
  {
    path: "wec/facts", zone: "заготовка", clientReads: false, producerReads: true,
    note: "Извлечённые факты страниц fiawec: слаги сезона, расписание уик-энда, " +
      "id сессий, строки протоколов. ЗАМЕНИЛИ 24 МБ сохранённого HTML 31.08.2026 " +
      "(0.40 МБ, витрина на выходе побайтово та же). Читают 5 продьюсеров через " +
      "3 библиотеки; пишут двое — wec и weclive.",
  },

  // --- Витрина ---
  { path: "f1/calendar", zone: "витрина", clientReads: true },
  { path: "f1/<год>", zone: "витрина", clientReads: true,
    note: "standings.json — оба зачёта сезона одним файлом с раундовыми " +
      "очками, по образцу WEC/IMSA. Заменяет клиенту 7-9 GET к кухне jolpica." },
  { path: "f1/events", zone: "витрина", clientReads: true },
  { path: "f1/entrylist", zone: "витрина", clientReads: false,
    note: "Читается через блок `entry` файла события, не напрямую." },
  { path: "f1/fia", zone: "витрина", clientReads: true },
  { path: "f1/winners", zone: "витрина", clientReads: true },
  { path: "f1/highlights", zone: "витрина", clientReads: true },
  { path: "f1/milestones", zone: "витрина", clientReads: true },
  { path: "f1/weather", zone: "витрина", clientReads: true },
  { path: "f1/racecontrol", zone: "витрина", clientReads: true,
    note: "Классифицированный рейс-контрол по id события (D4). Вербатима нет " +
      "по построению: kind + машина/круг/время/причина, строку собирает клиент." },
  { path: "f1/history", zone: "витрина", clientReads: true },
  { path: "f1/beasts", zone: "витрина", clientReads: true },
  { path: "f1/records", zone: "витрина", clientReads: true },
  { path: "f1/teams", zone: "витрина", clientReads: true },
  { path: "wec/<год>", zone: "витрина", clientReads: true },
  { path: "wec/events", zone: "витрина", clientReads: true,
    note: "Проекция derived серии: штрафы + победители + хайлайты одним файлом. " +
      "Сессии в неё НЕ дублируются — у WEC файл события уже есть." },
  { path: "wec/fia", zone: "витрина", clientReads: true },
  { path: "wec/winners", zone: "витрина", clientReads: true },
  { path: "wec/weather", zone: "витрина", clientReads: false,
    note: "Погода событий из Al Kamel (шаг 5.6): сенсорные ряды по сессиям + " +
      "сводки, время абсолютное. RAIN источника непригоден — дождь не пишется. " +
      "Клиент подключит следующим шагом." },
  { path: "wec/highlights", zone: "витрина", clientReads: true },
  { path: "imsa/<год>", zone: "витрина", clientReads: true },
  { path: "imsa/events", zone: "витрина", clientReads: true,
    note: "То же, что у WEC." },
  { path: "imsa/fia", zone: "витрина", clientReads: true },
  { path: "imsa/winners", zone: "витрина", clientReads: true },
  { path: "imsa/highlights", zone: "витрина", clientReads: true },

  // --- Справочники ---
  { path: "refs", zone: "справочник", clientReads: true },
  { path: "tracks", zone: "справочник", clientReads: true },
  {
    path: "f1/overrides", zone: "справочник", clientReads: true,
    note: "Курируемый календарь; правится руками, читается и клиентом, и GC.",
  },
];

/// Файлы верхнего уровня, у которых нет каталога.
export const DATA_FILES: DataFamily[] = [
  { path: "health.json", zone: "витрина", clientReads: true },
  { path: "README.md", zone: "справочник", clientReads: false },
  { path: "wec/_live_health.json", zone: "витрина", clientReads: false,
    note: "Маркер свежести продьюсера «идущий этап» — читает только health." },
];

const YEAR = /^\d{4}$/;

/// Совпадает ли путь с записью семейства (с учётом плейсхолдера `<год>`).
export function matchesFamily(path: string, family: string): boolean {
  const a = path.split("/");
  const b = family.split("/");
  if (a.length !== b.length) return false;
  return b.every((seg, i) => (seg === "<год>" ? YEAR.test(a[i]) : seg === a[i]));
}

export function classify(path: string): DataFamily | null {
  return [...DATA_FAMILIES, ...DATA_FILES].find((f) => matchesFamily(path, f.path)) ?? null;
}

/// Кухня, которую читает приложение, — это и есть список того, что мешает
/// унести сырьё в приватный репозиторий.
export function splitBlockers(): DataFamily[] {
  return DATA_FAMILIES.filter((f) => f.zone === "кухня" && f.clientReads);
}

/// Кухня, готовая к переезду ПРЯМО СЕЙЧАС: её не читает ни приложение, ни
/// сборка. Пусто — значит всё оставшееся сырьё чем-то держится, и переезд
/// требует не копирования, а изменения топологии.
export function readyToMove(): DataFamily[] {
  return DATA_FAMILIES.filter((f) => f.zone === "кухня" && !f.clientReads && !f.producerReads);
}
