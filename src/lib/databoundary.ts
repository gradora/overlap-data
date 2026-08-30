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
// ЗАМЕРЕНО 30.08.2026: кухня 93 МБ из 105, из них клиент читает 31 МБ
// (`f1/openf1` и `f1/jolpica`). Остальные 62 МБ — снимок FOM и HTML fiawec —
// не читаются приложением вовсе и могут переехать хоть сегодня.

export type Zone =
  /// Сырые ответы источников. Наружу не публикуется после сплита.
  | "кухня"
  /// Публичный контракт: то, что читает приложение.
  | "витрина"
  /// Курируемые справочники — правятся как данные, не как релиз.
  | "справочник";

export interface DataFamily {
  /// Путь относительно `data/`. `<год>` — плейсхолдер четырёх цифр.
  path: string;
  zone: Zone;
  /// Читает ли ПРИЛОЖЕНИЕ этот путь напрямую (не через продьюсера).
  /// У кухни это и есть признак блокера сплита.
  clientReads: boolean;
  note?: string;
}

export const DATA_FAMILIES: DataFamily[] = [
  // --- Кухня ---
  {
    path: "f1/jolpica", zone: "кухня", clientReads: true,
    note: "Все вызовы jolpica у клиента идут mirror-first (F1RacingDataService, " +
      "SeasonBrowser). Блокер сплита: снимаем только вместе с переездом " +
      "расписаний/зачётов/протоколов в витрину.",
  },
  {
    path: "f1/openf1", zone: "кухня", clientReads: true,
    note: "OpenF1Service ходит mirror-first по сессиям, протоколам и " +
      "рейс-контролу. Блокер сплита; фаза 6 постепенно его снимает.",
  },
  {
    path: "wec/fiawec", zone: "кухня", clientReads: false,
    note: "HTML fiawec. Клиентских читателей НЕ осталось — каскад удалён шагом " +
      "3c. Может переехать в приватный репозиторий немедленно.",
  },
  {
    path: "f1/fom", zone: "кухня", clientReads: false,
    note: "Страховочный срез статики FOM 2018–2021, продьюсер ручной. " +
      "Потребителей нет ни на клиенте, ни на бэкенде — чистый архивный вход.",
  },

  // --- Витрина ---
  { path: "f1/calendar", zone: "витрина", clientReads: true },
  { path: "f1/events", zone: "витрина", clientReads: true },
  { path: "f1/entrylist", zone: "витрина", clientReads: false,
    note: "Читается через блок `entry` файла события, не напрямую." },
  { path: "f1/fia", zone: "витрина", clientReads: true },
  { path: "f1/winners", zone: "витрина", clientReads: true },
  { path: "f1/highlights", zone: "витрина", clientReads: true },
  { path: "f1/milestones", zone: "витрина", clientReads: true },
  { path: "f1/weather", zone: "витрина", clientReads: true },
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
