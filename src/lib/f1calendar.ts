// Витрина календаря F1 — фаза 4 DATA-PLAN: data/f1/calendar/<год>.json.
// Смёрженный календарь сезона (jolpica + оверлей митингов OpenF1 + курируемый
// data/f1/overrides/calendar.json) собирается ОДИН раз бэкендом вместо того,
// чтобы каждый клиент на каждом холодном старте сшивал три источника сам.
//
// Почему именно это: клиентская склейка календаря — самая хитрая логика
// системы с худшей историей багов, и каждый её шрам стоил прод-инцидента
// (Sepang-2026 пропадал из ленты; январский лаг алиаса «current» приклеивал
// результаты ЧУЖОГО сезона; тесты/фантомы утягивали расписание чужого раунда
// round-keyed фетчами). Здесь они переезжают в одно тестируемое место.
//
// Источник правды о СЕМАНТИКЕ — сегодняшний клиент (расхождение с экраном =
// баг фазы, а не улучшение):
//   склейка трёх стейтов      — F1RaceMerger.merge (ключ — ПАРА (season, round));
//   оверлей митингов          — F1RacingDataService.overlayItems (+ fetchF1Overlay);
//   курируемый слой           — F1CalendarOverride.merged/covers/syntheticRace;
//   поля карточки события     — CalendarItem.init(f1:)/init(f1Meeting:)/init(override:);
//   каноника трассы и страны  — RaceLocation (trackName/subtitle/overrides);
//   ключ ассета               — MediaKey.slug + MediaVariant («<трасса>-testing»);
//   слаг бэкенд-пространства  — TrackKey.assetSlug (кросс-чек trackRef).
// Портированные функции помечены «ПАРНО с …»: менять только вместе со
// Swift-стороной, пока клиентский мердж жив (он остаётся live-фолбэком).
//
// Вход — ТОЛЬКО файлы на диске: зеркала f1/jolpica и f1/openf1 (их пишут
// продьюсеры f1.ts и openf1.ts тем же прогоном) + курируемый
// overrides/calendar.json (его тем же прогоном чистит GC f1overrides.ts).
// Сети здесь нет вовсе.
//
// Чего здесь сознательно НЕТ:
//   — расписание уик-энда (FP1..квала, времена сессий): это деталка события,
//     фаза 6 («событие одним файлом»), а не лента;
//   — результаты/победители: у них свои семейства (winners/highlights);
//   — представление (бейджи «R5»/«TBC»/«Race+Sprint», сортировка ленты):
//     восстанавливается из kind+status+round+sprintWeekend чистой функцией на
//     клиенте — по критерию материализации плана вёрстка не материализуется.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envFlag } from "./env.js";
import { isFrozen } from "./freeze.js";
import { mirrorSlug, writeJSONWithEnvelope } from "./mirror.js";
import { loadRefs, pinFor, trackByAlias, type RefsMap } from "./refs.js";
import { checkEventKeys, f1EventKey } from "./eventkey.js";

/// Своя версия у семейства (прецедент 3a/3b: каждая витрина — независимый
/// контракт). Связать её с чужой — значит молча «менять» схему календаря
/// бампом соседнего семейства.
// v2 (01.09.2026): +locality, +circuit (сырое имя jolpica — джойн домашней
// трассы команды живёт на нём), +sessions (времена уик-энда). Этим витрина
// закрывает последний контракт raceDetails и расписания сезона — лента и
// экран события перестают читать кухню jolpica.
export const F1_CALENDAR_SCHEMA_VERSION = 2;

/// Нижняя граница охвата — ПАРНО с SeasonBrowser.earliestYear (2025): раньше
/// приложение сезон просто не показывает (нет derived-карточек, у IMSA нет
/// снапшотов), а лишние годы — это файлы, которые никто не откроет.
export const EARLIEST_SEASON = 2025;

const DAY_MS = 24 * 3600 * 1000;

// MARK: - Типы контракта

/// ПАРНО с EventKind.swift: обычный этап / тестовый уик-энд / отменённый этап.
export type F1EventKind = "race" | "testing" | "cancelled";

/// Подтверждён ли этап основным источником (jolpica отдал ему НОМЕР РАУНДА).
/// `tbc` — этап живёт только в оверлее OpenF1 или в курируемом слое: нумерация
/// провизорная, round у него сентинел 0.
///
/// Бейдж раунда клиента восстанавливается отсюда однозначно (ПАРНО с
/// CalendarItem.roundLabel): confirmed → «R<round>»; tbc и kind=race → «TBC»;
/// tbc и kind=testing|cancelled → бейджа раунда нет вовсе.
export type F1EventStatus = "confirmed" | "tbc";

export interface F1CalendarEvent {
  /// Идентификатор события — ПАРНО с CalendarItem.id. На нём висит ВЕЧНЫЙ кэш
  /// погоды клиента (`weather.v2.<id>`), поэтому он часть контракта, а не
  /// украшение: «f1-<сезон>-<раунд>» у гонки jolpica, «f1-meeting-<key>» у
  /// оверлея, «f1-override-<дата>» у курируемого этапа (по ДАТЕ, иначе id
  /// столкнулся бы с одноимённым раундом jolpica).
  id: string;
  /// Стабильный ключ файла события (семейство `events/`, фаза 6). Отдельный
  /// от `id`, потому что `id` гонки jolpica содержит РАУНД, а он дрейфует при
  /// отмене этапа. Обоснование формата — в lib/eventkey.ts.
  eventKey: string;
  /// Номер этапа; 0 — СЕНТИНЕЛ «раунда в источнике нет» (тесты, отмены,
  /// курируемые фантомы). Клиентские round-keyed фетчи деталки (сессии,
  /// победители, штрафы, юбилеи) по нулю честно пусты — именно поэтому
  /// провизорный официальный номер сюда НЕ попадает: он совпал бы с чужим
  /// этапом и утянул его расписание.
  round: number;
  kind: F1EventKind;
  status: F1EventStatus;
  /// Имя события как его печатает источник («Bahrain Grand Prix in Malaysia»
  /// у перенесённого этапа) — решение владельца: официальное имя не «чиним».
  name: string;
  /// Display-строка трассы рядом с nullable trackRef (правило 2 плана):
  /// каноничное имя из RaceLocation.trackName — «Albert Park», а не
  /// «Melbourne» и не «Albert Park Grand Prix Circuit».
  venue: string;
  /// Display-страна события (та же унификация форм, что у сабтайтла карточки:
  /// «USA», «UK», «UAE»); у перенесённого этапа — по ТРАССЕ, а не по
  /// протухшему country_name митинга.
  country: string;
  /// Ссылка в карту сущностей data/refs/matching.json; null — карты нет или
  /// трасса ей неизвестна (fail-open, экран живёт на venue).
  trackRef: string | null;
  /// Ключ медиа-ассета события (пространство MediaKey, ТРЕТЬЕ и отдельное от
  /// trackRef): «las-vegas-strip», а у теста — «<трасса>-testing».
  assetSlug: string;
  dates: {
    /// Первый день уик-энда: у гонки jolpica — день гонки −2 (пятница, как
    /// считает карточка), у митинга — день его date_start.
    start: string | null;
    /// День гонки (у теста — последний день теста): ключ сортировки ленты и
    /// проверки «прошло».
    race: string | null;
    /// Время старта гонки как его отдаёт jolpica («04:00:00Z»); null у
    /// оверлея и курируемого слоя — там точного времени нет.
    raceTime: string | null;
  };
  /// Уик-энд со спринтом — ПАРНО с CalendarItem: hasSprint = есть результаты
  /// спринта ИЛИ сессия спринта в расписании.
  sprintWeekend: boolean;
  /// Город трассы — заголовки колонок зачёта (acronym) и фолбэк канона.
  locality?: string;
  /// СЫРОЕ имя трассы источника («Shanghai International Circuit»): джойн
  /// домашней трассы команды (f1/teams) матчится по нему, venue канонизирован.
  circuit?: string;
  /// Времена сессий уик-энда из расписания. Раньше их возил raceDetails
  /// (<год>_<раунд>.json кухни) — ровно шесть блоков и время гонки.
  sessions?: {
    fp1?: F1SessionTime; fp2?: F1SessionTime; fp3?: F1SessionTime;
    sprintQualifying?: F1SessionTime; qualifying?: F1SessionTime;
    sprint?: F1SessionTime;
  };
  /// ПОЛНАЯ карта ключей события во всех источниках. Это не украшение, а
  /// системный кросс-чек, расширяющий guard 0.3 («round файла ↔ round
  /// документов») с одного семейства на стык источников:
  ///  • пара (season, round) jolpica лежит РЯДОМ с сезоном файла — химера
  ///    январского лага («расписание нового года, результаты прошлого»)
  ///    становится видимой в данных, а не только в глазах;
  ///  • meetingKey избавляет продьюсеров OpenF1 от повторного вывода «какой
  ///    митинг соответствует раунду N» по датам: сегодня это правило живёт
  ///    ещё и в openf1.ts (matchMeeting), и разъехаться им нечем помешать;
  ///  • FIA-продьюсеры матчат документы страна-префиксом слага события —
  ///    им нужна не своя таблица, а trackRef + refs.aliases.fiaDocPrefix;
  ///  • override:true честно говорит, что этап держится на курируемой ручке,
  ///    а не на источнике — фазе 6 не придётся угадывать, почему у события
  ///    нет ни одного ключа.
  sourceIds: {
    jolpica: { season: number; round: number } | null;
    openf1: { meetingKey: number } | null;
    override: boolean;
  };
}

export interface F1CalendarDoc {
  series: "f1";
  season: number;
  /// Сезон отгонялся и отстоялся (freeze-окно результатов после последнего
  /// события) — клиенту «кэшируй навсегда», продьюсеру «не пересобирать».
  frozen: boolean;
  events: F1CalendarEvent[];
}

// MARK: - Форма входов (сырые зеркала, ключи как у источника)

export interface JolpicaRace {
  season: string;
  round: string;
  raceName: string;
  Circuit: {
    circuitId?: string;
    circuitName: string;
    Location: { locality: string; country: string };
  };
  date: string;
  time?: string | null;
  Results?: unknown[] | null;
  SprintResults?: unknown[] | null;
  Sprint?: { date: string; time?: string } | null;
  FirstPractice?: { date: string; time?: string } | null;
  SecondPractice?: { date: string; time?: string } | null;
  ThirdPractice?: { date: string; time?: string } | null;
  SprintQualifying?: { date: string; time?: string } | null;
  Qualifying?: { date: string; time?: string } | null;
}

/// Сессия уик-энда в витрине — ровно как отдаёт источник: день + время UTC.
export interface F1SessionTime { date: string; time?: string }

export interface OpenF1MeetingRaw {
  meeting_key: number;
  meeting_name: string;
  date_start: string;
  date_end?: string | null;
  year?: number | null;
  is_cancelled?: boolean | null;
  circuit_short_name?: string | null;
  country_name?: string | null;
  location?: string | null;
}

/// Запись курируемого файла. Структурный двойник OverrideEntry из
/// producers/f1overrides.ts (там же GC) — lib не импортирует продьюсера, но
/// поля обязаны совпадать; парность держит тест.
export interface F1OverrideEntry {
  season: number;
  round: number;
  date: string;
  raceName: string;
  circuitName?: string;
  circuitId?: string;
  locality?: string;
  country?: string;
  kind?: string;
}

// MARK: - Слаги и каноника трасс (порт клиентских таблиц)

/// ПАРНО с String+Slug.swift (`slugified`): диакритика в ASCII, всё
/// не-алфанум — дефис, крайние дефисы отброшены. Отдельно от общего
/// slugify() продьюсеров: у того нет фолдинга диакритики, а имена трасс её
/// несут («Autódromo…»).
export function slugified(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/// ПАРНО с RaceLocation.trackOverrides. Портируется ЦЕЛИКОМ, включая строки
/// WEC/IMSA: ключ здесь — сырое имя из источника, и «сузить до F1» значит
/// завести вторую таблицу, которая разъедется с первой при первом же переносе
/// этапа (ровно так «Kuala Lumpur» и появился в общей карте).
const TRACK_OVERRIDES: Record<string, string> = {
  "Autódromo José Carlos Pace": "Interlagos",
  "Autódromo Hermanos Rodríguez": "Mexico City",
  "Autodromo Nazionale di Monza": "Monza",
  "Autodromo Enzo e Dino Ferrari": "Imola",
  "Circuit Gilles Villeneuve": "Gilles Villeneuve",
  "Circuit Paul Ricard": "Paul Ricard",
  "Circuit Park Zandvoort": "Zandvoort",
  "Circuit de Barcelona-Catalunya": "Barcelona",
  "Baku City Circuit": "Baku",
  "Jeddah Corniche Circuit": "Jeddah",
  "24 Heures du Mans": "Le Mans",
  "Circuit des Amériques": "Circuit of the Americas",
  "WeatherTech Raceway Laguna Seca": "Laguna Seca",
  "Michelin Raceway Road Atlanta": "Road Atlanta",
  "Canadian Tire Motorsport Park": "Mosport",
  "Indianapolis Motor Speedway": "Indianapolis",
  "Kuala Lumpur": "Sepang",
};

/// ПАРНО с RaceLocation.meetingShortNameOverrides: короткое имя OpenF1 (город)
/// → каноническое имя трассы. Применяется ТОЛЬКО к митингам.
const MEETING_SHORT_NAME_OVERRIDES: Record<string, string> = {
  Melbourne: "Albert Park",
  Spielberg: "Red Bull Ring",
  "Monte Carlo": "Monaco",
  Catalunya: "Barcelona",
  Austin: "Circuit of the Americas",
  Montreal: "Gilles Villeneuve",
  Singapore: "Marina Bay",
  "Las Vegas": "Las Vegas Strip",
  Lusail: "Losail",
  Sakhir: "Bahrain",
};

/// ПАРНО с RaceLocation.trackCountryOverrides: страна по ТРАССЕ для митингов с
/// протухшими метаданными (перенесённый Sepang едет с country_name «Bahrain»).
const TRACK_COUNTRY_OVERRIDES: Record<string, string> = { Sepang: "Malaysia" };

/// ПАРНО с RaceLocation.countryAliases.
const COUNTRY_ALIASES: Record<string, string> = {
  "United States": "USA",
  "United States of America": "USA",
  "United Kingdom": "UK",
  "Great Britain": "UK",
  "United Arab Emirates": "UAE",
};

/// ПАРНО с TrackKey.nameAliases (пространство КАНОНИЧНОГО ИМЕНИ).
const NAME_ALIASES: Record<string, string> = {
  losail: "lusail",
  sakhir: "bahrain",
  "las vegas": "las vegas strip",
  madring: "madrid",
  "mosport park": "mosport",
  "streets of long beach": "long beach",
  "mazda raceway laguna seca": "laguna seca",
};

/// ПАРНО с TrackKey.slugOverrides (каноничное имя ≠ имя-через-дефис).
const SLUG_OVERRIDES: Record<string, string> = {
  lusail: "losail",
  "las vegas strip": "las-vegas",
};

const PREFIX_RE =
  /^(Circuit international de |Circuit de la |Circuit de |Circuit du |Autódromo Internacional |Autódromo |Autodromo Internazionale |Autodromo |Circuito de )/i;
const SUFFIX_RE =
  /( Grand Prix Circuit| Circuit| International| Speedway| Raceway| Autodrome| Street)$/;

/// ПАРНО с RaceLocation.computeNormalized: стрип служебных префиксов, затем
/// ИТЕРАТИВНЫЙ стрип суффиксов, пока строка меняется («Losail International
/// Circuit» → «Losail»). Пустой результат откатывается к сырому.
function normalizeTrack(raw: string): string {
  const override = TRACK_OVERRIDES[raw];
  if (override) return override;
  let s = raw.replace(PREFIX_RE, "").trim();
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(SUFFIX_RE, "").trim();
  }
  return s === "" ? raw : s;
}

/// ПАРНО с RaceLocation.track(from:fallback:): пустой/«TBA» источник уводит на
/// фолбэк (у F1 — город, у митинга — страна).
function trackFrom(raw: string, fallback: string): string {
  const source = (raw ?? "").trim();
  if (source === "" || source.toUpperCase() === "TBA") return normalizeTrack(fallback ?? "");
  const nice = TRACK_OVERRIDES[source];
  if (nice) return nice;
  return normalizeTrack(source);
}

/// ПАРНО с RaceLocation.trackName(f1:) — каноничное имя трассы гонки jolpica.
export function trackNameF1(circuitName: string, locality: string): string {
  return trackFrom(circuitName, locality);
}

/// ПАРНО с RaceLocation.trackName(meeting:): сперва карта коротких имён
/// OpenF1 (город → трасса), потом общая нормализация. Без этого оверлей жил бы
/// в своём пространстве имён («Melbourne» вместо «Albert Park»), и у тестов,
/// отмен и переносов не было бы ни обложки, ни привязки к трассе.
export function trackNameMeeting(m: OpenF1MeetingRaw): string {
  const raw = m.circuit_short_name ?? m.location ?? "";
  const canonical = MEETING_SHORT_NAME_OVERRIDES[raw];
  if (canonical) return canonical;
  return trackFrom(raw, m.country_name ?? "");
}

/// ПАРНО с RaceLocation.f1Country: строка jolpica уже человекочитаема, нужна
/// только унификация форм.
export function countryF1(raw: string): string {
  const t = (raw ?? "").trim();
  return COUNTRY_ALIASES[t] ?? t;
}

/// ПАРНО с RaceLocation.meetingCountry: у перенесённого этапа метаданные
/// митинга протухшие, поэтому трек-ключ надёжнее страны источника.
export function countryMeeting(m: OpenF1MeetingRaw, track: string): string {
  return TRACK_COUNTRY_OVERRIDES[track] ?? countryF1(m.country_name ?? "");
}

/// ПАРНО с MediaKey.slug + MediaVariant(kind:): ключ медиа события. Суффикс
/// «-testing» — это конвенция ФАЙЛА в overlap-assets, а не отдельная папка:
/// так тест бесплатно наследует и годовое переопределение, и постер
/// «<файл>-.jpg», а при отсутствии своей обложки откатывается на ролик
/// трассы (цепочка кандидатов остаётся клиентской, AssetSource).
/// Отменённый этап своего варианта не имеет — та же гонка на той же трассе.
export function assetSlugFor(trackName: string, kind: F1EventKind): string {
  const base = slugified(trackName);
  return kind === "testing" ? `${base}-testing` : base;
}

/// ПАРНО с TrackKey.assetSlug(forName:) — слаг ПРОСТРАНСТВА БЭКЕНДА
/// (tracks/index.json, геометрия, SC-каталог), в котором живут и слаги карты
/// refs. Он НЕ равен ключу медиа: «Madring» → media «madring», backend
/// «madrid»; «Las Vegas Strip» → media «las-vegas-strip», backend «las-vegas».
export function builtinTrackSlug(trackName: string): string {
  const lowered = (trackName ?? "").toLowerCase();
  const name = NAME_ALIASES[lowered] ?? lowered;
  return SLUG_OVERRIDES[name] ?? name.replace(/ /g, "-");
}

// MARK: - Дни (день события, а не инстант устройства)

/// День из ISO-строки — БУКВАЛЬНАЯ дата источника («2026-03-08»), а не день
/// инстанта в поясе устройства.
///
/// Это осознанное отличие от клиента и единственное место, где витрина не
/// повторяет его побайтово. Клиент считает окна дедупа через Calendar.current:
/// день у него зависит от часового пояса ТЕЛЕФОНА, поэтому один и тот же
/// митинг «Las Vegas» (гонка в ночь между датами) на московском устройстве
/// схлопывается с этапом jolpica, а на калифорнийском — нет, и этап рисуется
/// дважды. Бэкенд обязан отдать ОДИН ответ на всех, и единственный
/// непроизвольный выбор — календарь самого источника.
export function dayOf(iso: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso ?? ""));
  return m ? m[1] : null;
}

const dayMs = (day: string | null): number | null => {
  if (!day) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
};

const shiftDay = (day: string, days: number): string =>
  new Date((dayMs(day) ?? 0) + days * DAY_MS).toISOString().slice(0, 10);

// MARK: - Склейка jolpica (ПАРНО с F1RaceMerger.swift)

/// Ключ склейки — ПАРА (season, round), а не один раунд. Номера раундов
/// повторяются из года в год, а три стейта грузятся независимо и в переходном
/// окне держат РАЗНЫЕ сезоны (вокруг 1 января источник переключает алиас
/// «current» с лагом). По одному раунду склейка молча приклеивала результаты
/// чужого года к правильным этапам — ошибка без единого признака ошибки.
const raceKey = (r: JolpicaRace): string => `${r.season}/${r.round}`;

function firstByKey(list: JolpicaRace[]): Map<string, JolpicaRace> {
  const m = new Map<string, JolpicaRace>();
  for (const r of list) if (!m.has(raceKey(r))) m.set(raceKey(r), r);
  return m;
}

/// ПАРНО с F1RaceMerger.merge: расписание, отсортированное по раунду, с
/// подмешанными результатами и спринт-данными.
export function mergeRaces(
  schedule: JolpicaRace[], allRaces: JolpicaRace[], sprintRaces: JolpicaRace[],
): JolpicaRace[] {
  const results = firstByKey(allRaces);
  const sprints = firstByKey(sprintRaces);
  return [...schedule]
    .sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0))
    .map((scheduled) => {
      const race = results.get(raceKey(scheduled)) ?? scheduled;
      const sprint = sprints.get(raceKey(race));
      if (!sprint) return race;
      // Клиент пересобирает гонку целиком: sprintResults берутся у спринта
      // (даже если их там нет), сессия спринта — «спринт ?? расписание».
      return {
        ...race,
        SprintResults: sprint.SprintResults ?? null,
        Sprint: sprint.Sprint ?? race.Sprint ?? null,
      };
    });
}

/// ПАРНО с F1RacingDataService.loadPaged + mergeResultsPage/mergeSprintPage:
/// одна гонка может разорваться между страницами пагинации, строки клеятся по
/// раунду. Для календаря важен лишь ФАКТ наличия строк, но склейка портируется
/// честно — иначе будущий потребитель получит обрезанный раунд.
export function mergePages(pages: JolpicaRace[][]): JolpicaRace[] {
  const byKey = new Map<string, JolpicaRace>();
  const order: string[] = [];
  for (const page of pages) {
    for (const race of page) {
      const k = raceKey(race);
      const existing = byKey.get(k);
      if (!existing) {
        byKey.set(k, { ...race });
        order.push(k);
        continue;
      }
      existing.Results = [...(existing.Results ?? []), ...(race.Results ?? [])];
      existing.SprintResults = [
        ...(existing.SprintResults ?? []), ...(race.SprintResults ?? []),
      ];
    }
  }
  // Пустые массивы обратно в null: «строк нет» и «поля не было» для клиента
  // одно и то же (optional), а в JSON это разные байты.
  return order.map((k) => {
    const r = byKey.get(k)!;
    if ((r.Results?.length ?? 0) === 0) r.Results = null;
    if ((r.SprintResults?.length ?? 0) === 0) r.SprintResults = null;
    return r;
  });
}

// MARK: - Оверлей OpenF1 (ПАРНО с F1RacingDataService.overlayItems)

/// ПАРНО с OpenF1Meeting.isTesting: распознавание теста ПО ИМЕНИ, регистр не
/// важен (митинги приходят по-разному).
export function isTestingMeeting(name: unknown): boolean {
  return String(name ?? "").toLowerCase().includes("testing");
}

export interface OverlayItem {
  meeting: OpenF1MeetingRaw;
  kind: F1EventKind;
}

/// Оверлей ленты: тесты + отменённые + этапы, которых в jolpica ещё нет.
///
/// Дедуп обычных гонок — ПО ДАТЕ, а не по слагу/имени: OpenF1 зовёт трассы по
/// городу («Melbourne», «Spielberg»), jolpica — по имени трассы («Albert
/// Park», «Red Bull Ring»), слаги не совпадают в принципе. А даты уик-эндов у
/// источников общие, поэтому день гонки jolpica внутри окна митинга
/// однозначно означает тот же этап. Слишком широкий дедуп съедает новый этап
/// (кейс Sepang-2026, ради которого оверлей и появился), слишком узкий — рисует
/// этап дважды; ни то, ни другое не падает и не логируется.
///
/// Порядок проверок — часть контракта: ТЕСТ ПОБЕЖДАЕТ ОТМЕНУ (отменённый тест
/// остаётся тестовым событием и уходит на экран тестов).
export function overlayMeetings(
  meetings: OpenF1MeetingRaw[], jolpicaDays: string[],
): OverlayItem[] {
  const out: OverlayItem[] = [];
  for (const m of meetings) {
    if (isTestingMeeting(m.meeting_name)) {
      out.push({ meeting: m, kind: "testing" });
      continue;
    }
    if (m.is_cancelled === true) {
      out.push({ meeting: m, kind: "cancelled" });
      continue;
    }
    if (!meetingCoveredBy(m, jolpicaDays)) out.push({ meeting: m, kind: "race" });
  }
  return out;
}

/// Попадает ли хоть один день в окно митинга [день старта; день конца]
/// включительно. У клиента верхняя граница полуоткрытая (startOfDay(end) + 1
/// день), что для дней-строк и есть «<= день конца». Даты не распарсились —
/// окна нет, дедуп не срабатывает (митинг выживает: лучше дубль, чем пропажа).
export function meetingCoveredBy(m: OpenF1MeetingRaw, days: string[]): boolean {
  const start = dayOf(m.date_start);
  const end = dayOf(m.date_end ?? m.date_start);
  if (!start || !end) return false;
  return days.some((d) => d >= start && d <= end);
}

// MARK: - Курируемый слой (ПАРНО с F1CalendarOverride.swift)

/// ПАРНО с F1CalendarOverride.covers: день попадает в окно этапа
/// (гонка −2 … +3 дня, верх полуоткрытый). То же окно у GC в f1overrides.ts —
/// менять только вместе.
export function overrideCovers(entryDate: string, day: string): boolean {
  const anchor = dayMs(dayOf(entryDate));
  const d = dayMs(day);
  if (anchor === null || d === null) return false;
  return d >= anchor - 2 * DAY_MS && d < anchor + 3 * DAY_MS;
}

/// ПАРНО с F1CalendarOverride.merged + calendarItem: оставляем только
/// курируемые ГОНКИ (тесты и отмены приходят живым оверлеем OpenF1), чей день
/// ещё НЕ занят источником. В этом самозаживление слоя: как только jolpica или
/// OpenF1 отдадут этап, курируемая запись гаснет сама, без правки файла.
export function overrideEvents(
  entries: F1OverrideEntry[], occupiedDays: string[],
): F1OverrideEntry[] {
  return entries.filter((e) => {
    if ((e.kind ?? "race") !== "race") return false;
    return !occupiedDays.some((d) => overrideCovers(e.date, d));
  });
}

// MARK: - trackRef (правило 2 плана + приоритет фазы 2)

let refsLoaded = false;
let refsOnce: RefsMap | undefined;
function defaultRefs(): RefsMap | undefined {
  if (!refsLoaded) {
    refsLoaded = true; // один раз на прогон
    refsOnce = loadRefs();
  }
  return refsOnce;
}

const warnedRefs = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warnedRefs.has(key)) return;
  warnedRefs.add(key);
  console.warn(msg);
}

/// Слаг трассы события для карты сущностей. Два независимых мнения:
///  • ВСТРОЕННОЕ — порт TrackKey.assetSlug поверх каноничного имени клиента;
///  • КАРТА — pin (аномалия, привязанная к сезону) → алиас источника.
/// Расхождение → warning, побеждает КАРТА (перещёлк приоритета, решение
/// владельца 28.08.2026: правку факта хочется выкатывать коммитом в данные, а
/// не релизом). Карта недоступна → null: ref nullable, рядом лежит
/// display-строка venue, экран деградирует до сегодняшнего поведения.
/// Встроенный слаг, которого в карте нет, тоже даёт null — висячая ссылка
/// хуже честного «не знаю».
export function trackRefFor(
  refs: RefsMap | undefined,
  source: "jolpica" | "openf1",
  key: string,
  builtin: string,
  season: number,
  pinMatch?: string,
): string | null {
  if (!refs) return null;
  try {
    const known = refs.tracks.some((t) => t.slug === builtin) ? builtin : null;
    const pin = pinMatch ? pinFor(refs, source, pinMatch, season) : undefined;
    const viaMap = pin?.slug ?? trackByAlias(refs, source, key)?.slug ?? null;
    if (known !== null && viaMap !== null && known !== viaMap) {
      warnOnce(`trackRef:${source}:${key}`,
        `  refs: ${source} «${key}» → встроенная таблица даёт «${known}», карта — «${viaMap}»; ` +
        "побеждает карта");
    }
    return viaMap ?? known;
  } catch {
    return null; // битый объект карты не имеет права ронять сборку (fail-open)
  }
}

// MARK: - Сборка документа

export interface BuildInput {
  season: number;
  schedule: JolpicaRace[];
  results: JolpicaRace[];
  sprints: JolpicaRace[];
  meetings: OpenF1MeetingRaw[];
  /// Курируемые записи ИМЕННО этого сезона; пусто — слой не применяется.
  overrides: F1OverrideEntry[];
  now: number;
  /// null — явное «без карты» (тесты), undefined — карта по умолчанию.
  refs?: RefsMap | null;
}

export function buildF1CalendarDoc(input: BuildInput): F1CalendarDoc {
  const { season, now } = input;
  const refs = input.refs === null ? undefined : input.refs ?? defaultRefs();

  const merged = mergeRaces(input.schedule, input.results, input.sprints);
  const jolpicaDays = merged
    .map((r) => dayOf(r.date))
    .filter((d): d is string => d !== null);

  const overlay = overlayMeetings(input.meetings, jolpicaDays);
  // Курируемый слой дедуплится по дням, УЖЕ занятым обоими источниками
  // (jolpica + оверлей) — ПАРНО с fetchF1Overlay.occupiedDays.
  const overlayDays = overlay
    .map((o) => dayOf(o.meeting.date_end ?? o.meeting.date_start))
    .filter((d): d is string => d !== null);
  const overrides = overrideEvents(input.overrides, [...jolpicaDays, ...overlayDays]);

  // Митинг, «съеденный» дедупом, обязан найтись у СВОЕЙ гонки: это и есть
  // кросс-чек ключей. Раздаём ключи по тому же предикату окна, которым дедуп
  // и работал, — иначе «пропал из ленты» и «потерял meeting_key» разъехались
  // бы (а именно на этом стыке жил Sepang-2026).
  const overlayKeys = new Set(overlay.map((o) => o.meeting.meeting_key));
  const dropped = input.meetings.filter((m) => !overlayKeys.has(m.meeting_key));
  const takenKeys = new Set<number>();
  const meetingKeyFor = (raceDay: string | null): number | null => {
    if (!raceDay) return null;
    const hit = dropped.find(
      (m) => !takenKeys.has(m.meeting_key) && meetingCoveredBy(m, [raceDay]));
    if (!hit) return null;
    takenKeys.add(hit.meeting_key);
    return hit.meeting_key;
  };

  /// Времена сессий — ИЗ РАСПИСАНИЯ, не из merged-строки: у сыгранного
  /// раунда merged заменяет строку результатами, а в них сессий нет вовсе
  /// (клиентский merger вёл себя так же — потому и существовал raceDetails).
  const scheduleByKey = new Map(input.schedule.map((r) => [`${r.season}/${r.round}`, r]));
  const sessionsOf = (merged: JolpicaRace) => {
    const race = scheduleByKey.get(`${merged.season}/${merged.round}`) ?? merged;
    const t = (b?: { date: string; time?: string } | null): F1SessionTime | undefined =>
      b ? { date: b.date, ...(b.time ? { time: b.time } : {}) } : undefined;
    const out = {
      ...(t(race.FirstPractice) ? { fp1: t(race.FirstPractice) } : {}),
      ...(t(race.SecondPractice) ? { fp2: t(race.SecondPractice) } : {}),
      ...(t(race.ThirdPractice) ? { fp3: t(race.ThirdPractice) } : {}),
      ...(t(race.SprintQualifying) ? { sprintQualifying: t(race.SprintQualifying) } : {}),
      ...(t(race.Qualifying) ? { qualifying: t(race.Qualifying) } : {}),
      ...(t(race.Sprint) ? { sprint: t(race.Sprint) } : {}),
    };
    return Object.keys(out).length ? out : null;
  };

  const events: F1CalendarEvent[] = [];

  for (const race of merged) {
    const round = Number(race.round) || 0;
    const raceDay = dayOf(race.date);
    const meetingKey = meetingKeyFor(raceDay);
    const venue = trackNameF1(race.Circuit.circuitName, race.Circuit.Location.locality);
    events.push({
      id: `f1-${race.season}-${race.round}`,
      round,
      kind: "race",
      status: "confirmed",
      name: race.raceName,
      venue,
      country: countryF1(race.Circuit.Location.country),
      trackRef: trackRefFor(refs, "jolpica", race.Circuit.circuitId ?? "",
        builtinTrackSlug(venue), season, race.raceName),
      assetSlug: assetSlugFor(venue, "race"),
      dates: {
        start: raceDay ? shiftDay(raceDay, -2) : null,
        race: raceDay,
        raceTime: race.time ?? null,
      },
      // ПАРНО с CalendarItem.init(f1:): спринт-уик-энд = есть результаты
      // спринта ИЛИ сессия спринта в расписании.
      sprintWeekend: (race.SprintResults ?? null) !== null || (race.Sprint ?? null) !== null,
      locality: race.Circuit.Location.locality,
      circuit: race.Circuit.circuitName,
      ...((): { sessions?: NonNullable<F1CalendarEvent["sessions"]> } => {
        const sess = sessionsOf(race);
        return sess ? { sessions: sess } : {};
      })(),
      sourceIds: {
        jolpica: { season: Number(race.season) || season, round },
        openf1: meetingKey === null ? null : { meetingKey },
        override: false,
      },
      eventKey: f1EventKey(season, assetSlugFor(venue, "race"),
        meetingKey === null ? { kind: "round", round } : { kind: "meeting", meetingKey }),
    });
  }

  for (const { meeting, kind } of overlay) {
    const venue = trackNameMeeting(meeting);
    const startDay = dayOf(meeting.date_start);
    const endDay = dayOf(meeting.date_end ?? meeting.date_start);
    events.push({
      id: `f1-meeting-${meeting.meeting_key}`,
      // Раунда у оверлея нет — сентинел 0 (round-keyed фетчи его не дёргают).
      round: 0,
      kind,
      status: "tbc",
      name: meeting.meeting_name,
      venue,
      country: countryMeeting(meeting, venue),
      trackRef: trackRefFor(refs, "openf1", meeting.circuit_short_name ?? meeting.location ?? "",
        builtinTrackSlug(venue), season, meeting.circuit_short_name ?? undefined),
      assetSlug: assetSlugFor(venue, kind),
      dates: { start: startDay, race: endDay ?? startDay, raceTime: null },
      sprintWeekend: false,
      sourceIds: {
        jolpica: null,
        openf1: { meetingKey: meeting.meeting_key },
        override: false,
      },
      eventKey: f1EventKey(season, assetSlugFor(venue, kind),
                           { kind: "meeting", meetingKey: meeting.meeting_key }),
    });
  }

  for (const entry of overrides) {
    const venue = trackNameF1(entry.circuitName ?? "", entry.locality ?? "");
    const raceDay = dayOf(entry.date);
    events.push({
      // id по ДАТЕ, а не по раунду: официальный номер записи провизорный и
      // совпал бы с чужим этапом jolpica (два «R16» в ленте).
      id: `f1-override-${entry.date}`,
      round: 0,
      kind: "race",
      status: "tbc",
      name: entry.raceName,
      venue,
      country: countryF1(entry.country ?? ""),
      trackRef: trackRefFor(refs, "jolpica", entry.circuitId ?? "",
        builtinTrackSlug(venue), season, entry.raceName),
      assetSlug: assetSlugFor(venue, "race"),
      dates: {
        start: raceDay ? shiftDay(raceDay, -2) : null,
        race: raceDay,
        raceTime: null,
      },
      sprintWeekend: false,
      // jolpica-ключа НЕТ намеренно: провизорный round записи ключом не
      // является, а сентинел 0 в источнике не существует.
      sourceIds: { jolpica: null, openf1: null, override: true },
      // Пары в OpenF1 у курируемого этапа нет вовсе — различитель задаёт
      // куратор, и это дата, та же что в `id`.
      eventKey: f1EventKey(season, assetSlugFor(venue, "race"),
                           { kind: "override", date: entry.date }),
    });
  }

  events.sort(compareEvents);

  return { series: "f1", season, frozen: seasonFrozen(events, now), events };
}

/// Порядок файла — по дню события, затем по раунду, затем по id: лента всё
/// равно сортирует сама, но детерминированный порядок держит git тихим.
function compareEvents(a: F1CalendarEvent, b: F1CalendarEvent): number {
  const da = a.dates.race ?? "9999-99-99";
  const db = b.dates.race ?? "9999-99-99";
  if (da !== db) return da < db ? -1 : 1;
  if (a.round !== b.round) return a.round - b.round;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/// Сезон заморожен: события есть, у всех известен день, и последний из них
/// отстоялся freeze-окно результатов.
function seasonFrozen(events: F1CalendarEvent[], now: number): boolean {
  if (events.length === 0) return false;
  const days = events.map((e) => e.dates.race);
  if (days.some((d) => d === null)) return false;
  const last = (days as string[]).reduce((max, d) => (d > max ? d : max), "0000-00-00");
  return isFrozen(Date.parse(`${last}T23:59:59Z`), now);
}

// MARK: - Кросс-чек ключей (расширение guard 0.3 на стык источников)

export interface CrossCheck {
  /// Структурная порча документа: писать НЕЛЬЗЯ (fail-closed).
  fatal: string[];
  /// Подозрительное покрытие: пишем, но говорим вслух. Блокировать нельзя —
  /// одна странность источника заморозила бы весь остальной календарь.
  warnings: string[];
}

/// Проверяем ровно то, что раньше было видно только глазами на ленте:
///  • id уникальны (дубль id = недетерминированный ForEach и общий вечный
///    кэш погоды у двух событий);
///  • пара (season, round) jolpica уникальна и её СЕЗОН совпадает с сезоном
///    файла — материализованная защита от химеры январского лага;
///  • confirmed ⇔ round ≥ 1, tbc ⇔ round == 0 (сентинел не «улучшается»);
///  • meeting_key не выдан дважды;
///  • каждый митинг сезона представлен: либо своим оверлей-событием, либо
///    ключом у гонки. Непредставленный митинг — это ровно класс Sepang-2026
///    («был у источника, исчез из ленты»), только теперь он кричит.
export function crossCheckCalendar(
  doc: F1CalendarDoc, meetings: OpenF1MeetingRaw[],
  /// Прежде опубликованная витрина — нужна ТОЛЬКО сторожу ключей события:
  /// дрейф ключа виден лишь в сравнении с тем, под каким именем файлы уже
  /// лежат. Нет предыдущей (первый сбор сезона) — проверяется одна
  /// уникальность.
  prev?: { events: { id: string; eventKey?: string }[] } | null,
): CrossCheck {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const ids = new Set<string>();
  const jolpicaKeys = new Set<string>();
  const meetingKeys = new Set<number>();
  for (const e of doc.events) {
    if (ids.has(e.id)) fatal.push(`дубль id «${e.id}»`);
    ids.add(e.id);

    if (e.sourceIds.jolpica) {
      const k = `${e.sourceIds.jolpica.season}/${e.sourceIds.jolpica.round}`;
      if (jolpicaKeys.has(k)) fatal.push(`дубль ключа jolpica ${k}`);
      jolpicaKeys.add(k);
      if (e.sourceIds.jolpica.season !== doc.season) {
        fatal.push(`${e.id}: ключ jolpica за сезон ${e.sourceIds.jolpica.season}, ` +
          `а файл — за ${doc.season} (химера сезонов)`);
      }
      if (e.sourceIds.jolpica.round !== e.round) {
        fatal.push(`${e.id}: round ${e.round} ≠ round ключа jolpica ${e.sourceIds.jolpica.round}`);
      }
    }

    if (e.status === "confirmed" && e.round < 1) {
      fatal.push(`${e.id}: confirmed без номера раунда`);
    }
    if (e.status === "tbc" && e.round !== 0) {
      fatal.push(`${e.id}: tbc с раундом ${e.round} — сентинел 0 потерян`);
    }
    if (e.status === "confirmed" && !e.sourceIds.jolpica) {
      fatal.push(`${e.id}: confirmed без ключа jolpica`);
    }

    const mk = e.sourceIds.openf1?.meetingKey;
    if (mk !== undefined) {
      if (meetingKeys.has(mk)) fatal.push(`meeting_key ${mk} выдан двум событиям`);
      meetingKeys.add(mk);
    }
  }

  for (const m of meetings) {
    if (!meetingKeys.has(m.meeting_key)) {
      warnings.push(`митинг ${m.meeting_key} «${m.meeting_name}» ` +
        `(${dayOf(m.date_start) ?? "?"}) не представлен ни одним событием`);
    }
  }

  // Сторож идентичности файла события (фаза 6): уникальность и неизменность
  // ключа. До него ни одно семейство не проверяло ни того, ни другого —
  // перенумерация раундов сломала бы четыре сразу и молча.
  const keys = checkEventKeys(
    doc.events.map((e) => ({ id: e.id, eventKey: e.eventKey })),
    prev ? prev.events.flatMap((e) => (e.eventKey ? [{ id: e.id, eventKey: e.eventKey }] : []))
         : null,
  );
  fatal.push(...keys.fatal);
  warnings.push(...keys.warnings);

  return { fatal, warnings };
}

// MARK: - Предохранитель и запись (fail-closed, образец 3a/3b)

const countBy = (doc: Pick<F1CalendarDoc, "events">,
  pred: (e: F1CalendarEvent) => boolean): number => (doc.events ?? []).filter(pred).length;

/// null — писать можно; строка — причина оставить прежний файл. Деградации,
/// каждая из которых уже случалась у соседних семейств: пропало зеркало
/// (событий стало меньше), не доехал jolpica (гонки схлопнулись), не доехал
/// OpenF1 (тесты/отмены и привязка meeting_key исчезли).
export function f1CalendarRegression(
  prev: Pick<F1CalendarDoc, "events"> | null,
  next: Pick<F1CalendarDoc, "events">,
): string | null {
  if (!prev) return null;
  const prevAll = (prev.events ?? []).length;
  const nextAll = (next.events ?? []).length;
  if (nextAll < prevAll) return `событий стало меньше (${prevAll} → ${nextAll})`;

  // Сжатие числа confirmed-этапов — НЕ всегда деградация: при отмене раунда
  // jolpica снимает его из расписания, и это ровно тот класс событий, ради
  // которого заведён kind: cancelled (в 2026 у jolpica 23 раунда против 25
  // гоночных митингов OpenF1 — Бахрейн и Джидда уже вычеркнуты). Слепой счёт
  // морозил витрину НАВСЕГДА: kept-previous каждый час, F1_CALENDAR_FORCE до
  // этой проверки не доходит (он про freeze), а клиент при этом тихо уходит
  // на живой мердж — выигрыш фазы испаряется без единого сигнала.
  //
  // Поэтому смотрим ПОИМЁННО: этап, пропавший из confirmed, обязан быть
  // объяснён отменой. Идентичность при этом СМЕНИТСЯ — у раунда jolpica id
  // «f1-<сезон>-<раунд>», а у оставшегося вместо него митинга OpenF1
  // «f1-meeting-<key>», — поэтому сверяем по ДНЮ гонки: отменённое событие
  // обязано стоять на том же дне. Пропажа без такой замены — деградация
  // (не доехало зеркало jolpica), и витрину мы не трогаем.
  const nextIds = new Set((next.events ?? []).map((e) => e.id));
  const cancelledDays = new Set(
    (next.events ?? []).filter((e) => e.kind === "cancelled")
      .flatMap((e) => [e.dates.race, e.dates.start].filter((d): d is string => d != null)));
  const vanished = (prev.events ?? [])
    .filter((e) => e.status === "confirmed" && !nextIds.has(e.id))
    .filter((e) => !(e.dates.race != null && cancelledDays.has(e.dates.race)));
  if (vanished.length > 0) {
    const ids = vanished.map((e) => e.id);
    return `этапы исчезли из витрины неотменёнными (${ids.slice(0, 3).join(", ")}` +
      `${ids.length > 3 ? `, +${ids.length - 3}` : ""})`;
  }
  const prevLinked = countBy(prev, (e) => e.sourceIds?.openf1 != null);
  if (prevLinked > 0 && countBy(next, (e) => e.sourceIds?.openf1 != null) === 0) {
    return `привязка к митингам OpenF1 пропала (${prevLinked} → 0)`;
  }
  return null;
}

export type CalendarWriteOutcome = "written" | "unchanged" | "kept-previous" | "frozen";

export function readPrev<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null; // файла нет или он бит — прежнего хорошего состояния нет
  }
}

/// Запись с заморозкой и предохранителем. Замороженный сезон не
/// пересобирается (write-once истории), но файл ПРОШЛОЙ версии схемы
/// пересобрать обязан — иначе смена контракта никогда не доехала бы до
/// архива. Перебить руками — F1_CALENDAR_FORCE=1.
export function writeF1Calendar(
  path: string, next: F1CalendarDoc, crossCheck?: CrossCheck,
): CalendarWriteOutcome {
  const prev = readPrev<F1CalendarDoc & { schemaVersion?: number }>(path);
  if (prev && next.frozen && !envFlag("F1_CALENDAR_FORCE")
    && prev.schemaVersion === F1_CALENDAR_SCHEMA_VERSION) {
    return "frozen";
  }
  if (crossCheck && crossCheck.fatal.length > 0) {
    for (const problem of crossCheck.fatal) {
      console.warn(`::warning::f1 calendar ${next.season}: ${problem}`);
    }
    console.warn(`::warning::f1 calendar ${next.season}: кросс-чек ключей не пройден` +
      " — прежний файл не тронут");
    return "kept-previous";
  }
  const regression = f1CalendarRegression(prev, next);
  if (regression) {
    console.warn(`::warning::f1 calendar ${next.season}: ${regression} — прежний файл не тронут`);
    return "kept-previous";
  }
  const { series, season, frozen, events } = next;
  return writeJSONWithEnvelope(path, { series, season, frozen, events },
    F1_CALENDAR_SCHEMA_VERSION) ? "written" : "unchanged";
}

// MARK: - Оркестрация (вызывается из продьюсера f1overrides.ts тем же прогоном)

/// Все входы лежат на диске, поэтому сборка сезонов — чистая вьюха: ни одного
/// сетевого запроса, порядок гарантирован проводкой в snapshot.yml (f1 →
/// openf1 → … → f1overrides).
///
/// Ключи зеркал берём ГОД-ИМЕНОВАННЫЕ («2026.json», «2026_results…»), а не
/// «current»-алиас. Это второй рубеж против январского отравления: имя
/// год-именованной копии f1.ts выводит из САМОГО ответа (yearEquivalent), то
/// есть сезон файла совпадает с именем по построению. Проверку season всё
/// равно делаем — дёшево, и ровно этот класс ошибок фаза и материализует.
export function readJolpicaSeason(
  root: string, year: number,
): { schedule: JolpicaRace[]; results: JolpicaRace[]; sprints: JolpicaRace[] } | null {
  const dir = join(root, "f1", "jolpica");
  const doc = readPrev<any>(join(dir, mirrorSlug(`${year}.json`)));
  const table = doc?.MRData?.RaceTable;
  if (!table) return null;
  if (String(table.season ?? "") !== String(year)) {
    console.warn(`::warning::f1 calendar ${year}: расписание зеркала за сезон ` +
      `${table.season ?? "?"} — season-guard, сезон пропущен`);
    return null;
  }
  const races: JolpicaRace[] = table.Races ?? [];
  if (races.length === 0) return null; // календарь ещё не опубликован
  return {
    schedule: races,
    results: mergePages(readPagedMirror(dir, year, "results")),
    sprints: mergePages(readPagedMirror(dir, year, "sprint")),
  };
}

/// Страницы пагинации из зеркала: offset += 100, пока файлы есть. Страница
/// чужого сезона отбрасывается целиком (тот же season-guard).
function readPagedMirror(dir: string, year: number, kind: "results" | "sprint"): JolpicaRace[][] {
  const pages: JolpicaRace[][] = [];
  for (let offset = 0; ; offset += 100) {
    const file = join(dir, mirrorSlug(`${year}/${kind}.json?limit=100&offset=${offset}`));
    if (!existsSync(file)) break;
    const doc = readPrev<any>(file);
    const table = doc?.MRData?.RaceTable;
    if (!table) break;
    if (String(table.season ?? "") !== String(year)) {
      console.warn(`::warning::f1 calendar ${year}: страница ${kind}@${offset} за сезон ` +
        `${table.season ?? "?"} — пропущена`);
      continue;
    }
    pages.push(table.Races ?? []);
  }
  return pages;
}

/// Митинги сезона из зеркала OpenF1. Нет файла — оверлея в этом прогоне нет
/// (fail-open на чтении); если он был раньше, схлопывание поймает
/// предохранитель записи (fail-closed на записи).
export function readMeetings(root: string, year: number): OpenF1MeetingRaw[] {
  const raw = readPrev<OpenF1MeetingRaw[]>(
    join(root, "f1", "openf1", mirrorSlug(`meetings?year=${year}`)));
  if (!Array.isArray(raw)) return [];
  return raw.filter((m) => {
    if (m?.meeting_key == null) return false;
    // Кросс-чек ключей на входе: файл ключуется годом в URL, поэтому митинг с
    // ЧУЖИМ year — это порча зеркала, а не данные сезона.
    if (m.year != null && Number(m.year) !== year) {
      console.warn(`::warning::f1 calendar ${year}: митинг ${m.meeting_key} несёт год ` +
        `${m.year} — пропущен`);
      return false;
    }
    return true;
  });
}

/// Все валидные курируемые записи файла — без привязки к году.
export function allOverrides(root: string): F1OverrideEntry[] {
  const raw = readPrev<F1OverrideEntry[]>(join(root, "f1", "overrides", "calendar.json"));
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => Number.isFinite(Number(e?.season)) && typeof e?.date === "string");
}

/// Курируемые записи сезона. Слой не применяется к ПРОШЛЫМ сезонам: он
/// существует ради этапа, которого источник ЕЩЁ не опубликовал, а в закрытом
/// сезоне публиковать уже нечего (ПАРНО с seasonOverlay клиента, который
/// осознанно не подмешивает override в архив).
///
/// А вот сезон N+1 — ЗАКОННЫЙ адресат, и раньше отсекался вместе с прошлым.
/// Цена ошибки была ровно обратной задуманной: ручка владельца существует ради
/// межсезонья («новый этап, которого ещё нет в источниках»), и правка,
/// заведённая в декабре на следующий год, тихо не делала НИЧЕГО — ни на
/// витрине, ни в логе. Отсекаем только прошлое и всегда говорим вслух.
export function readOverrides(root: string, year: number, currentYear: number): F1OverrideEntry[] {
  const mine = allOverrides(root).filter((e) => Number(e.season) === year);
  if (year < currentYear) {
    if (mine.length > 0) {
      console.warn(`::warning::f1 calendar ${year}: курируемых записей ${mine.length}, ` +
        `но сезон уже закрыт — слой не применяется`);
    }
    return [];
  }
  return mine;
}

/// Записи, которые не достались НИ ОДНОМУ собранному сезону: опечатка в
/// `season`, год без зеркала расписания, запись из далёкого будущего. Молча
/// такое лежать не должно — это ручка владельца, и её холостой ход обязан быть
/// виден в логе прогона.
export function orphanOverrides(root: string, seasons: number[]): F1OverrideEntry[] {
  const built = new Set(seasons);
  return allOverrides(root).filter((e) => !built.has(Number(e.season)));
}

/// Сезоны охвата: от нижней границы приложения до следующего года
/// включительно — год попадает в сборку ровно тогда, когда у него есть
/// расписание в зеркале (тем же признаком приложение открывает год в
/// переключателе сезонов: SeasonBrowser.probeNextYear).
export function coveredSeasons(root: string, currentYear: number): number[] {
  const dir = join(root, "f1", "jolpica");
  const out: number[] = [];
  for (let y = EARLIEST_SEASON; y <= currentYear + 1; y++) {
    if (existsSync(join(dir, mirrorSlug(`${y}.json`)))) out.push(y);
  }
  return out;
}

/// Сборка всех охваченных сезонов. Возвращает краткий итог для лога продьюсера.
export function buildF1CalendarFiles(
  now: number, root: string = join(process.cwd(), "data"),
): string {
  const currentYear = new Date(now).getUTCFullYear();
  const seasons = coveredSeasons(root, currentYear);
  if (seasons.length === 0) return "calendar: нет зеркал расписаний — пропуск";
  const parts: string[] = [];
  // Сезоны, для которых документ РЕАЛЬНО собран. Не «охваченные»: год с пустым
  // расписанием попадает в охват (файл-заглушка есть), но пропускается — и
  // курируемая запись на него без этого списка снова уезжала бы в тишину.
  const built: number[] = [];
  for (const season of seasons) {
    const jolpica = readJolpicaSeason(root, season);
    if (!jolpica) {
      parts.push(`${season}: нет расписания`);
      continue;
    }
    built.push(season);
    const meetings = readMeetings(root, season);
    const doc = buildF1CalendarDoc({
      season,
      schedule: jolpica.schedule,
      results: jolpica.results,
      sprints: jolpica.sprints,
      meetings,
      overrides: readOverrides(root, season, currentYear),
      now,
    });
    const calendarPath = join(root, "f1", "calendar", `${season}.json`);
    const published = readPrev<{ payload?: F1CalendarDoc } & F1CalendarDoc>(calendarPath);
    const check = crossCheckCalendar(doc, meetings, published?.payload ?? published ?? null);
    for (const w of check.warnings) console.warn(`::warning::f1 calendar ${season}: ${w}`);
    const outcome = writeF1Calendar(calendarPath, doc, check);
    parts.push(`${season}: ${outcome} (${doc.events.length} событий${doc.frozen ? ", frozen" : ""})`);
  }
  for (const e of orphanOverrides(root, built)) {
    console.warn(`::warning::f1 calendar: курируемая запись ${e.season}/${e.date} ` +
      `(${e.raceName ?? "без имени"}) не попала ни в один собранный сезон`);
  }
  return `calendar — ${parts.join("; ")}`;
}
