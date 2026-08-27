// Витрина WEC — фаза 3a DATA-PLAN: data/wec/<y>/index.json + standings.json
// вместо клиентского парсинга 25 МБ HTML fiawec. Источник правды о СЕМАНТИКЕ —
// сегодняшние Swift-парсеры и билдеры приложения (расхождение = баг шага):
//   календарь  — WECSeasonParser + WECRacePageParser + WECDataService
//                .assembleCalendar (нумерация раундов ПО ДАТЕ СТАРТА — ключевая
//                цель шага: нумерация наконец одноместная, бэкендная);
//   зачёт      — WECStandingsParser (страница manufacturers-classification) +
//                WECCrewStandingsBuilder (слияние строк машины в экипаж) +
//                WECDriverTeamMatcher.displayTeam (титул-кейс имён команд).
// Все портированные функции помечены «ПАРНО с …» — менять только вместе с
// Swift-стороной, пока парсеры приложения живы (их снос — шаг 3c).
//
// Вход — ТОЛЬКО зеркало data/wec/fiawec (снятое этим же прогоном wec.ts) и
// данные системы (refs, highlights). Сетевых походов здесь нет: прогон
// SEASON=<архивный год> собирает файлы из замороженных зеркал без разморозки.
//
// Единственное разрешённое улучшение против клиента — РЕАЛЬНЫЕ wins вместо
// прокси «макс очков этапа», и только когда они выводимы надёжно (см.
// realWinsByCar); любой изъян надёжности откатывает ВЕСЬ класс на прокси с
// честным winsSource: "maxPointsProxy".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "./freeze.js";
import {
  ISO3_TO_2, ldJsonBlocks, raceSlugs, sessionOptions, testSlugs,
} from "./fiawecsite.js";
import { mirrorSlug, writeJSONWithEnvelope } from "./mirror.js";
import { loadRefs, type RefsMap } from "./refs.js";

// Своя версия на каждый файл (прецедент STANDINGS_SCHEMA_VERSION фазы 1):
// index и standings — независимые контракты, связка версий делала бы бамп
// одного «тихой сменой» схемы другого.
export const WEC_INDEX_SCHEMA_VERSION = 1;
export const WEC_STANDINGS_SCHEMA_VERSION = 1;

/// Клиентское окно «событие завершено»: WECEvent.completedAfter = endDate+24ч.
const COMPLETED_AFTER_MS = 24 * 3600 * 1000;

// MARK: - Типы контракта

export interface WecSessionRef {
  id: number;    // sessionId fiawec (E6)
  label: string; // подпись дропдауна как есть («HYPERPOLE 1 - LMP2 & LMGT3»)
}

export interface WecIndexEvent {
  /// Номер этапа по дате старта; 0 — пролог (существующая конвенция round-
  /// сентинела: тесты вне нумерации, см. testSlugs).
  round: number;
  slug: string;
  /// Имя события после клиентской чистки («WEC …» и хвостовой год срезаны).
  name: string;
  /// Display-строка площадки из JSON-LD — рядом с nullable trackRef
  /// (правило 2 плана: незаматченная трасса деградирует, не ломает экран).
  venue: string;
  trackRef: string | null;
  /// Сырой schema.org-токен, как его видит клиент: EventScheduled /
  /// EventInProgress / EventCompleted; null — статуса нет.
  status: string | null;
  countryCode: string | null; // ISO-2 lowercase («it»)
  /// Сырые ISO-строки JSON-LD c офсетом трассы: клиент берёт из них ЛОКАЛЬНУЮ
  /// календарную дату (день/месяц) — нормализация в UTC сдвинула бы день.
  start: string | null;
  end: string | null;
  /// Путь файла сессий события относительно data/ («wec/2026/01_6-hours-of-
  /// imola-2026.json», шаг 3b). Имя считает ОДНА функция wecEventFileName на
  /// обе стороны: имя, вычисленное клиентом самостоятельно, стало бы вторым
  /// несвязанным TS↔Swift-стыком — ровно тем, что фаза 3 закрывает.
  /// Аддитивное поле схемы v1 (клиент 3a игнорирует незнакомые ключи).
  resultsPath: string;
  sourceIds: {
    fiawec: {
      slug: string;
      raceId: number | null;
      sessions: WecSessionRef[];
    };
  };
}

/// Имя файла сессий события: этап — «NN_<слаг>.json» (образец IMSA), пролог
/// (round 0) — «test_<слаг>.json» (образец imsa/<y>/test_<slug>.json): номера
/// у теста нет, а «00_» притворялось бы этапом.
export function wecEventFileName(round: number, slug: string): string {
  return round >= 1 ? `${String(round).padStart(2, "0")}_${slug}.json` : `test_${slug}.json`;
}

export interface WecSeasonIndexDoc {
  series: "wec";
  season: number;
  /// Сезон закрыт и отстоялся (freeze-окно) — клиенту «кэшируй навсегда».
  frozen: boolean;
  events: WecIndexEvent[];
}

export type WecClassId = "HYPERCAR" | "LMGT3";
export type WecWinsSource = "real" | "maxPointsProxy";
/// Все цифры зачёта — официальная классификация FIA WEC (страница
/// manufacturers-classification). Поле — честное происхождение цифры, как
/// pointsSource фазы 1, а не переключатель.
export type WecPointsSource = "official";

export interface WecCrewEntry {
  position: number;
  carNumber: string;
  team: string;               // после displayTeam; "" — команда неизвестна
  drivers: string[];          // состав как напечатан, порядок появления
  points: number;
  pointsSource: WecPointsSource;
  wins: number;
  /// По этапам, выровнено с rounds документа; null — прочерк (этап не сыгран /
  /// DNS) — клиент рисует дэш, не ноль.
  stagePoints: (number | null)[];
}

/// Сырая строка Drivers-таблицы (НЕ слитая): экраны раскладывают её на
/// отдельных пилотов (подменный пилот живёт отдельной строкой той же машины
/// со своими очками), crewByCarNumber джойнит составы к результатам — без
/// этих строк клиент не смог бы отказаться от HTML зачёта.
export interface WecDriverRow {
  position: number | null;
  carNumber: string | null;
  drivers: string[];
  points: number;
  pointsSource: WecPointsSource;
  stagePoints: (number | null)[];
}

export interface WecManufacturerEntry {
  position: number | null;
  name: string;               // как напечатано («TOYOTA»)
  points: number;
  pointsSource: WecPointsSource;
  stagePoints: (number | null)[];
}

export interface WecClassStandings {
  raceClass: WecClassId;
  /// real — победы посчитаны из classWinners highlights (по номеру машины);
  /// maxPointsProxy — клиентский прокси «макс очков этапа» (весь класс сразу:
  /// смешивать происхождения внутри одной колонки нельзя).
  winsSource: WecWinsSource;
  crews: WecCrewEntry[];
  driverRows: WecDriverRow[];
  manufacturers?: WecManufacturerEntry[]; // только HYPERCAR — своя таблица FIA
}

export interface WecStandingsDoc {
  series: "wec";
  season: number;
  frozen: boolean;
  /// Колонки этапов из шапки таблиц (ISO-2 UPPERCASE из flag:XX) — ровно то,
  /// что клиент кладёт в WECStandingTable.rounds. Индекс колонки = round−1.
  rounds: string[];
  classes: WecClassStandings[];
}

// MARK: - Порт WECRacePageParser (страница /en/race/<slug>)

export interface WecRacePageInfo {
  name: string;
  venue: string;
  status: string | null;
  iso2: string | null;
  start: string | null;  // сырые строки JSON-LD
  end: string | null;
  startMs: number | null;
  endMs: number | null;
  raceId: number | null;
  /// Расписание уик-энда (subEvent JSON-LD) — единственный источник времён и
  /// статусов сессий. В index.json НЕ попадает (там сессии живут id-шниками
  /// дропдауна), его потребитель — шаг 3b (wecevents.ts): и лента сессий
  /// события, и экран пролога, у которого протоколов нет вовсе.
  sessions: WecScheduledSession[];
}

/// Одна строка расписания уик-энда. ПАРНО с WECScheduledSession приложения.
export interface WecScheduledSession {
  /// Подпись fiawec с уже срезанным хвостом «- <событие>» («Free Practice 1»,
  /// «Qualifying - HYPERCAR», «MORNING SESSION»).
  name: string;
  /// Сырая ISO-строка с офсетом трассы — как start/end события (нормализация
  /// в UTC сдвинула бы календарный день).
  start: string | null;
  status: string | null; // EventScheduled / EventInProgress / EventCompleted
}

/// «WEC TotalEnergies 6 Hours of Spa-Francorchamps 2026» → ядро имени.
/// ПАРНО с WECRacePageParser.cleanName.
function cleanEventName(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("WEC ")) s = s.slice(4);
  s = s.replace(/\s+\d{4}$/, "");
  return s.trim();
}

/// «https://schema.org/EventCompleted» → «EventCompleted».
/// ПАРНО с WECRacePageParser.statusWord.
function statusWord(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parts = raw.split("/");
  return parts[parts.length - 1] || null;
}

/// «Free Practice 1 - 6 Hours of Imola» → «Free Practice 1»; классовый
/// квалификатор сохраняется («Qualifying - HYPERCAR - 24 Hours of Le Mans» →
/// «Qualifying - HYPERCAR»). ПАРНО с WECRacePageParser.sessionName.
function scheduledSessionName(raw: string): string {
  const s = raw.trim();
  const i = s.indexOf(" - ");           // ПЕРВОЕ вхождение, как range(of:)
  if (i < 0) return s;
  const head = s.slice(0, i);
  const rest = s.slice(i + 3);
  const j = rest.indexOf(" - ");
  if (j >= 0 && isClassTag(rest.slice(0, j))) return `${head} - ${rest.slice(0, j)}`.trim();
  if (isClassTag(rest)) return `${head} - ${rest}`.trim();
  return head.trim();
}

/// ПАРНО с WECRacePageParser.isClassTag.
function isClassTag(s: string): boolean {
  const t = s.trim().toUpperCase();
  return t === "HYPERCAR" || t === "LMGT3" || t === "LMP2"
    || t.includes("LMP2") || t.includes("LMGT3");
}

/// ПАРНО с WECRacePageParser.parse: берётся ПЕРВЫЙ ld+json-блок со словом
/// SportsEvent; не распарсился — null (клиент не перебирает дальше — поэтому
/// здесь не eventInfo из fiawecsite, у того семантика «ищи следующий блок»).
/// Отступление от Swift-порта (осознанное): subEvent без имени просто
/// пропускается, а не роняет разбор всей страницы (у клиента LDSub.name
/// обязателен — один безымянный сабэвент убил бы и даты, и статус события).
export function parseRacePage(html: string): WecRacePageInfo | null {
  const body = ldJsonBlocks(html).find((b) => b.includes("SportsEvent"));
  if (!body) return null;
  let j: any;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof j?.name !== "string") return null;
  const start = typeof j.startDate === "string" ? j.startDate : null;
  const end = typeof j.endDate === "string" ? j.endDate : null;
  const ms = (s: string | null): number | null => {
    if (!s) return null;
    const v = Date.parse(s);
    return Number.isNaN(v) ? null : v;
  };
  const addr = typeof j.location?.address === "string" ? j.location.address : "";
  const iso3 = (addr.split(",").pop() ?? "").trim().toUpperCase();
  const m = /raceIds?&quot;:\[?(\d+)/.exec(html) ?? /"raceIds?":\[?(\d+)/.exec(html);
  const subs = Array.isArray(j.subEvent) ? j.subEvent : [];
  return {
    name: cleanEventName(j.name),
    venue: typeof j.location?.name === "string" ? j.location.name : "",
    status: statusWord(j.eventStatus),
    iso2: iso3.length === 3 ? ISO3_TO_2[iso3] ?? null : null,
    start,
    end,
    startMs: ms(start),
    endMs: ms(end),
    raceId: m ? Number(m[1]) : null,
    sessions: subs
      .filter((s: any) => typeof s?.name === "string")
      .map((s: any) => ({
        name: scheduledSessionName(s.name),
        start: typeof s.startDate === "string" ? s.startDate : null,
        status: statusWord(s.eventStatus),
      })),
  };
}

// MARK: - trackRef (правило 2 плана: nullable ref + display рядом)

/// Канонический слаг трассы для события. Ступени:
///  1) fiawec-алиасы карты — токен алиаса в слаге события (явное знание:
///     «lone-star» → circuit-of-the-americas; ОБЯЗАН идти первым — слаг
///     «lone-star-le-mans» содержит и «le-mans», вторая ступень увела бы
///     событие на чужую трассу);
///  2) слаг трассы как подстрока слага события («spa-francorchamps»,
///     «24-hours-of-le-mans-2025-1» ⊃ «le-mans»); неоднозначность → null;
///  3) venue против слаг/text/wiki-алиасов («Interlagos» = слаг,
///     «Circuit des Amériques» — text, «Fuji Speedway» — wiki).
/// Fail-open: карты нет / не сматчилось → null, display-строка venue рядом.
export function wecTrackRef(
  refs: RefsMap | undefined, slug: string, venue: string,
): string | null {
  if (!refs) return null;
  try {
    const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
    const aliasHits = refs.tracks.filter((t) =>
      (t.aliases.fiawec ?? []).some((a) => a && slug.includes(norm(a))));
    if (aliasHits.length === 1) return aliasHits[0].slug;
    if (aliasHits.length > 1) return null;
    const slugHits = refs.tracks.filter((t) => slug.includes(t.slug));
    if (slugHits.length === 1) return slugHits[0].slug;
    if (slugHits.length > 1) return null;
    const v = norm(venue);
    if (!v) return null;
    const venueHit = refs.tracks.find((t) =>
      t.slug === v ||
      (t.aliases.text ?? []).some((a) => norm(a) === v) ||
      (t.aliases.wiki ?? []).some((a) => norm(a) === v));
    return venueHit?.slug ?? null;
  } catch {
    return null; // битая карта не роняет сборку — трасса просто без ref
  }
}

// MARK: - Календарь (порт WECDataService.assembleCalendar)

interface AssembleInput {
  slug: string;
  page: WecRacePageInfo;
}

/// Хронологическая нумерация раундов — ПАРНО с assembleCalendar: события без
/// даты в хвост, ничья без дат — по слагу. Прологи получают round = 0 и НЕ
/// участвуют в нумерации этапов (конвенция testSlugs). Порядок в файле:
/// прологи по дате, затем этапы по раундам.
export function assembleIndexEvents(
  season: number,
  races: AssembleInput[],
  tests: AssembleInput[],
  refs: RefsMap | undefined,
  sessionsByRaceId: Map<number, WecSessionRef[]>,
): WecIndexEvent[] {
  const toEvent = (e: AssembleInput, round: number): WecIndexEvent => ({
    round,
    slug: e.slug,
    name: e.page.name,
    venue: e.page.venue,
    trackRef: wecTrackRef(refs, e.slug, e.page.venue),
    status: e.page.status,
    countryCode: e.page.iso2,
    start: e.page.start,
    end: e.page.end,
    // Не nullable (в отличие от IMSA): файл события пишется ВСЕГДА — у
    // будущего этапа он несёт расписание уик-энда, ради которого клиент и
    // ходил за 1.5 МБ HTML. Пустой файл невозможен: index собирается только
    // из распарсенных страниц (fail-closed выше).
    resultsPath: `wec/${season}/${wecEventFileName(round, e.slug)}`,
    sourceIds: {
      fiawec: {
        slug: e.slug,
        raceId: e.page.raceId,
        sessions: e.page.raceId !== null ? sessionsByRaceId.get(e.page.raceId) ?? [] : [],
      },
    },
  });
  const byDate = (a: AssembleInput, b: AssembleInput): number => {
    const da = a.page.startMs;
    const db = b.page.startMs;
    if (da !== null && db !== null) return da - db;
    if (da !== null) return -1;
    if (db !== null) return 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  };
  return [
    ...[...tests].sort(byDate).map((e) => toEvent(e, 0)),
    ...[...races].sort(byDate).map((e, i) => toEvent(e, i + 1)),
  ];
}

/// Клиентский предикат lastCompletedEvent: статус EventCompleted ИЛИ конец
/// (+24ч, completedAfter) уже прошёл — статус fiawec редакторский и отстаёт.
export function isCompleted(e: Pick<WecIndexEvent, "status" | "end">, now: number): boolean {
  if (e.status === "EventCompleted") return true;
  const end = e.end ? Date.parse(e.end) : NaN;
  return Number.isFinite(end) && end + COMPLETED_AFTER_MS < now;
}

// MARK: - Порт WECStandingsParser (страница manufacturers-classification)

export type WecTableKind =
  | "hypercarDrivers" | "hypercarManufacturers" | "hypercarTeams"
  | "lmgt3Drivers" | "lmgt3Teams" | "other";

export interface WecStandingRowParsed {
  position: number | null;
  name: string;        // экипаж «A, B, C» / команда / производитель
  carNumber: string | null;
  totalPoints: number;
  stagePoints: (number | null)[];
}

export interface WecStandingTableParsed {
  kind: WecTableKind;
  title: string;
  rounds: string[];    // ISO-2 UPPERCASE из flag:XX шапки
  rows: WecStandingRowParsed[];
}

/// ПАРНО с WECStandingsParser.cleanText (тот же набор сущностей — не больше).
function cleanText(html: string): string {
  let s = html.replace(/<[^>]+>/g, "");
  const entities: Record<string, string> = {
    "&amp;": "&", "&#039;": "'", "&rsquo;": "'", "&quot;": '"', "&nbsp;": " ",
  };
  for (const [k, v] of Object.entries(entities)) s = s.split(k).join(v);
  return s.trim();
}

/// ПАРНО с WECStandingKind.init(title:).
export function tableKind(title: string): WecTableKind {
  const t = title.toLowerCase();
  const isGT3 = t.includes("lmgt3");
  if (t.includes("manufacturer")) return "hypercarManufacturers";
  if (t.includes("team")) return isGT3 ? "lmgt3Teams" : "hypercarTeams";
  if (t.includes("driver")) return isGT3 ? "lmgt3Drivers" : "hypercarDrivers";
  return "other";
}

const leadingInt = (raw: string): number | null => {
  const m = /^\d+/.exec(raw);
  return m ? Number(m[0]) : null;
};

/// Ячейка очков: число / null для «-»/пустых (этап не сыгран или DNS).
/// «36 +1» → 36 (клиентский prefix(while: isNumber)).
const parsePoints = (raw: string): number | null => leadingInt(raw);

/// «A , B , C» → «A, B, C» — ПАРНО с WECStandingsParser.normalizeName.
const normalizeName = (raw: string): string =>
  raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0).join(", ");

/// Текст всех <td>, кроме чисто-картиночных (логотип/иллюстрация машины).
function textCells(rowHTML: string): string[] {
  const out: string[] = [];
  for (const m of rowHTML.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const text = cleanText(m[1]);
    if (text === "" && m[1].toLowerCase().includes("<img")) continue;
    out.push(text);
  }
  return out;
}

/// ПАРНО с WECStandingsParser.makeRow: очки и тотал заякорены СПРАВА, чтобы
/// переменный ведущий блок (с номером машины или без) их не смещал.
function makeStandingRow(cells: string[], roundCount: number): WecStandingRowParsed | null {
  const R = roundCount;
  if (cells.length < R + 2) return null;                 // pos + name + R + total
  const position = leadingInt(cells[0]);
  if (position === null && cells.length < R + 3) return null;

  const total = Number(cells[cells.length - 1].replace(/[^0-9]/g, "")) || 0;
  const stagePoints = cells.slice(cells.length - 1 - R, cells.length - 1).map(parsePoints);
  const leading = cells.slice(0, cells.length - 1 - R);
  if (leading.length < 2) return null;

  let carNumber: string | null = null;
  let name: string;
  if (leading.length >= 3) {
    carNumber = leading[1].replace(/^#+|#+$/g, "");      // pos, «#7», имя
    name = normalizeName(leading.slice(2).join(" "));
  } else {
    name = normalizeName(leading[1]);                    // pos, имя (производители)
  }
  if (!name) return null;
  return { position, name, carNumber, totalPoints: total, stagePoints };
}

/// ПАРНО с WECStandingsParser.parse: четыре таблицы страницы, заголовок
/// чемпионата — ближайший heading/tab-кнопка ПЕРЕД таблицей, колонки этапов —
/// flag:XX в шапке.
export function parseStandingsTables(html: string): WecStandingTableParsed[] {
  // Кандидаты в заголовки: (offset, text) от обоих паттернов, как у клиента.
  const titles: { offset: number; title: string }[] = [];
  const patterns = [
    /<button[^>]*>([^<]*(?:Championship|Trophy)[^<]*)<\/button>/g,
    /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g,
  ];
  for (const pattern of patterns) {
    for (const m of html.matchAll(pattern)) {
      const text = cleanText(m[1]);
      const low = text.toLowerCase();
      if (!low.includes("championship") && !low.includes("trophy")
        && !low.includes("manufacturer") && !low.includes("standings")) continue;
      titles.push({ offset: m.index ?? 0, title: text });
    }
  }
  const nearestTitle = (start: number): string | null => {
    const prior = titles.filter((t) => t.offset < start);
    if (prior.length === 0) return null;
    return prior.reduce((a, b) => (a.offset >= b.offset ? a : b)).title;
  };

  const out: WecStandingTableParsed[] = [];
  for (const m of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const body = m[1];
    const title = nearestTitle(m.index ?? 0) ?? "Standings";
    // Шапка — первый <tr> c <th> (там живут раунд-флаги); нет — вся таблица.
    let header = body;
    for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      if (tr[1].includes("<th")) { header = tr[1]; break; }
    }
    const rounds = [...header.matchAll(/flag:([A-Za-z]{2})/g)].map((f) => f[1].toUpperCase());
    const rows: WecStandingRowParsed[] = [];
    for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      if (!tr[1].includes("<td")) continue;
      const row = makeStandingRow(textCells(tr[1]), rounds.length);
      if (row) rows.push(row);
    }
    if (rows.length === 0) continue;
    out.push({ kind: tableKind(title), title, rounds, rows });
  }
  return out;
}

/// Сезон, которому принадлежат таблицы страницы: год АКТИВНОЙ кнопки
/// season-selector. Страница всегда рендерит ТЕКУЩИЙ сезон (архивных нет —
/// проверено живьём), поэтому это одновременно и season-guard: прогон
/// SEASON=архив не должен записать чужой зачёт в свой файл (класс январских
/// отравлений). null — не распознан (страница перевёрстана) → не пишем.
export function standingsPageSeason(html: string): number | null {
  for (const m of html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>\s*Season\s+(\d{4})\s*<\/button>/g)) {
    const cls = m[1];
    if (cls.includes("season-selector") && !cls.includes("season-selector--link")
      && /\bactive\b/.test(cls)) {
      return Number(m[2]);
    }
  }
  return null;
}

// MARK: - Порт WECDriverTeamMatcher.displayTeam

/// Аббревиатуры, которые обязаны остаться капсом (иначе титул-кейс дал бы
/// «Af», «Wrt»). ПАРНО с WECDriverTeamMatcher.abbreviations.
const TEAM_ABBREVIATIONS = new Set([
  "AF", "ASP", "WRT", "TF", "BMW", "JOTA", "THOR", "DK", "USA", "WEC",
]);

/// Порт Foundation .capitalized (ICU title-case): слово начинает новая
/// последовательность букв — цифры и знаки рвут слово («1ST» → «1St»,
/// «SPA-FRANCORCHAMPS» → «Spa-Francorchamps»), НО апостроф между буквами
/// клеит («D'STATION» → «D'station»). Проверено против реального Swift.
export function capitalizedWord(word: string): string {
  let out = "";
  let newWord = true;
  const chars = [...word];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\p{L}/u.test(c)) {
      out += newWord ? c.toUpperCase() : c.toLowerCase();
      newWord = false;
    } else {
      out += c;
      const glue = c === "'" && i > 0 && /\p{L}/u.test(chars[i - 1])
        && i + 1 < chars.length && /\p{L}/u.test(chars[i + 1]);
      if (!glue) newWord = true;
    }
  }
  return out;
}

/// «51 FERRARI AF CORSE» → «51 Ferrari AF Corse»; здесь зовётся с пустым
/// номером (как клиентский displayTeam(number:"", name:)). ПАРНО с
/// WECDriverTeamMatcher.cleanTeam + String+TeamName.
export function displayTeam(name: string): string {
  const trimmed = name.trim();
  const numMatch = /^\s*(\d+)\s+/.exec(trimmed);
  const rest = numMatch ? trimmed.slice(numMatch[0].length) : trimmed;
  const words = rest.split(" ").filter((w) => w.length > 0).map((w) =>
    TEAM_ABBREVIATIONS.has(w.toUpperCase()) ? w.toUpperCase() : capitalizedWord(w));
  const cleaned = words.join(" ");
  return numMatch ? `${numMatch[1]} ${cleaned}` : cleaned;
}

// MARK: - Минимальный срез E6 (car → team) для команд экипажей

export interface WecRaceTeamRow {
  carNumber: string;
  team: string;      // сырое имя из таблицы («BMW M TEAM WRT»)
  raceClass: string; // из колонки Class; нет колонки → HYPERCAR (класс страницы)
}

/// НЕ порт WECResultsParser (классификации сессий — шаг 3b): из таблицы
/// результатов гонки берутся ровно car+team+class — то, что клиентский
/// WECCrewStandingsBuilder.teamByCar достаёт из классификации последней гонки
/// для команд экипажей Hypercar (своей Teams-таблицы у Hypercar на странице
/// зачёта нет). Выбор таблицы/колонок — как у клиента: первая таблица с
/// >pos + competitor/team в шапке, маппинг ячеек по ИМЕНИ заголовка.
export function raceTeamRows(html: string): WecRaceTeamRow[] {
  let table: string | null = null;
  for (const m of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const low = m[1].toLowerCase();
    if (low.includes(">pos") && (low.includes("competitor") || low.includes(">team"))) {
      table = m[1];
      break;
    }
  }
  if (!table) return [];
  let headers: string[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (!tr[1].includes("<th")) continue;
    headers = [...tr[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((h) => cleanText(h[1]));
    break;
  }
  if (headers.length === 0) return [];

  const out: WecRaceTeamRow[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (!tr[1].includes("<td")) continue;
    const cells = textCells(tr[1]);
    if (cells.length === 0 || cells.length < headers.length - 1) continue; // «N°»-подпись и спейсеры
    const col = new Map<string, string>();
    headers.forEach((h, i) => {
      if (i < cells.length) col.set(h.toLowerCase(), cells[i]);
    });
    const value = (needles: string[]): string => {
      for (const [key, val] of col) {
        if (needles.some((n) => key.includes(n))) return val;
      }
      return "";
    };
    const carNumber = value(["competitor", "n°", "no.", "num"]).replace(/^#+|#+$/g, "");
    const team = value(["team"]);
    if (!carNumber || !team) continue;
    const rawClass = value(["class"]).trim().toUpperCase();
    out.push({
      carNumber,
      team,
      raceClass: rawClass === "HYPERCAR" || rawClass === "LMGT3" || rawClass === "LMP2"
        ? rawClass
        : "HYPERCAR",
    });
  }
  return out;
}

// MARK: - Экипажи (порт WECCrewStandingsBuilder)

/// Слияние строк одной машины (зачётные категории пилотов, подмены) в экипаж:
/// состав — объединение имён в порядке появления; очки — максимум по строкам
/// (у подменного меньше); по этапам — поэлементный максимум непустых.
/// Позиции — очки по убыванию, тай-брейк по номеру numeric (клиентский
/// localizedStandardCompare). ПАРНО с WECCrewStandingsBuilder.crews.
export function buildCrews(
  raceClass: WecClassId,
  tables: WecStandingTableParsed[],
  classificationRows: WecRaceTeamRow[],
): Omit<WecCrewEntry, "wins">[] {
  const driversKind: WecTableKind = raceClass === "HYPERCAR" ? "hypercarDrivers" : "lmgt3Drivers";
  const teamsKind: WecTableKind = raceClass === "LMGT3" ? "lmgt3Teams" : "hypercarTeams";
  const driversTable = tables.find((t) => t.kind === driversKind);
  if (!driversTable) return [];

  // car → команда: Teams-таблица класса, затем классификация последней гонки
  // (только строки СВОЕГО класса; первая непустая побеждает — как у клиента).
  const teamByCar = new Map<string, string>();
  const teamsTable = tables.find((t) => t.kind === teamsKind);
  for (const row of teamsTable?.rows ?? []) {
    if (row.carNumber) teamByCar.set(row.carNumber, row.name);
  }
  for (const row of classificationRows) {
    if (row.raceClass !== raceClass || !row.carNumber || !row.team) continue;
    if (!teamByCar.has(row.carNumber)) teamByCar.set(row.carNumber, row.team);
  }

  const rowsByCar = new Map<string, WecStandingRowParsed[]>();
  const order: string[] = [];
  for (const row of driversTable.rows) {
    if (!row.carNumber) continue;
    if (!rowsByCar.has(row.carNumber)) {
      rowsByCar.set(row.carNumber, []);
      order.push(row.carNumber);
    }
    rowsByCar.get(row.carNumber)!.push(row);
  }

  const crews = order.map((car) => {
    const rows = rowsByCar.get(car) ?? [];
    const drivers: string[] = [];
    for (const row of rows) {
      for (const nm of row.name.split(",").map((p) => p.trim())) {
        if (nm && !drivers.includes(nm)) drivers.push(nm);
      }
    }
    const total = Math.max(0, ...rows.map((r) => r.totalPoints));
    const width = Math.max(0, ...rows.map((r) => r.stagePoints.length));
    const stagePoints: (number | null)[] = [];
    for (let i = 0; i < width; i++) {
      const vals = rows
        .map((r) => (i < r.stagePoints.length ? r.stagePoints[i] : null))
        .filter((v): v is number => v !== null);
      stagePoints.push(vals.length ? Math.max(...vals) : null);
    }
    return {
      position: 0,
      carNumber: car,
      team: displayTeam(teamByCar.get(car) ?? "").trim(),
      drivers,
      points: total,
      pointsSource: "official" as const,
      stagePoints,
    };
  });

  const numeric = new Intl.Collator("en", { numeric: true });
  crews.sort((a, b) => b.points - a.points || numeric.compare(a.carNumber, b.carNumber));
  return crews.map((c, i) => ({ ...c, position: i + 1 }));
}

// MARK: - Wins

/// Клиентский прокси: победа этапа = максимум очков колонки (>0), ничьи
/// плюсуются всем. ПАРНО со StandingsColumnsBuilder.wins.
export function proxyWins(stages: (number | null)[][]): number[] {
  const roundCount = Math.max(0, ...stages.map((s) => s.length));
  const out = stages.map(() => 0);
  for (let r = 0; r < roundCount; r++) {
    const col = stages.map((s) => (r < s.length ? s[r] ?? 0 : 0));
    const best = Math.max(0, ...col);
    if (best <= 0) continue;
    col.forEach((v, i) => {
      if (v === best) out[i]++;
    });
  }
  return out;
}

/// Победители класса по раундам: round → номер машины (из classWinners
/// highlights — единственный источник системы, знающий победителей ЭТОГО
/// сезона; winners/<y>_<r>.json несут только прошлые годы трассы и без
/// номеров машин — см. отчёт шага).
export type WinnerCarByRound = Map<number, string>;

/// Реальные wins по экипажам или null, если вывод ненадёжен — тогда ВЕСЬ класс
/// уходит на прокси. Условия надёжности (все обязательны):
///  1) у КАЖДОГО завершённого раунда известен победитель класса;
///  2) каждый победитель матчится ровно в ОДИН экипаж по номеру машины;
///  3) сыгранные колонки таблицы = ровно завершённые раунды (страница зачёта
///     не отстаёт и не опережает календарь — иначе цифры Wins и Points
///     оказались бы из разных моментов сезона).
export function realWinsByCar(
  crews: { carNumber: string; stagePoints: (number | null)[] }[],
  completedRounds: number[],
  winners: WinnerCarByRound,
): Map<string, number> | null {
  const scored = new Set<number>();
  for (const c of crews) {
    c.stagePoints.forEach((v, i) => {
      if (v !== null && v > 0) scored.add(i + 1);
    });
  }
  const completed = new Set(completedRounds);
  if (scored.size !== completed.size || [...scored].some((r) => !completed.has(r))) return null;

  const wins = new Map<string, number>();
  for (const r of completedRounds) {
    const car = winners.get(r);
    if (!car) return null;
    const matched = crews.filter((c) => c.carNumber === car);
    if (matched.length !== 1) return null;
    wins.set(car, (wins.get(car) ?? 0) + 1);
  }
  return wins;
}

// MARK: - Сборка standings-документа

export interface StandingsBuildInput {
  season: number;
  tables: WecStandingTableParsed[];
  /// car+team+class из классификации последней завершённой гонки (E6) —
  /// команды экипажей Hypercar; пусто — команды остаются "" (как у клиента
  /// до загрузки классификаций).
  classificationRows: WecRaceTeamRow[];
  /// Номера завершённых раундов по индексу (клиентский completedAfter).
  completedRounds: number[];
  /// Победители по классам: class → (round → car). Отсутствие → прокси.
  winnersByClass: Partial<Record<WecClassId, WinnerCarByRound>>;
}

/// null — собирать нечего/опасно (нет таблиц или шапки таблиц разъехались по
/// колонкам — страница битая, лучше не трогать прежний файл).
export function buildWecStandings(input: StandingsBuildInput): WecStandingsDoc | null {
  const { season, tables, classificationRows, completedRounds, winnersByClass } = input;
  if (tables.length === 0) return null;
  const rounds = tables[0].rounds;
  if (rounds.length === 0) return null;
  // Все таблицы страницы обязаны нести одну и ту же шапку этапов: это один
  // сезон одного рендера. Расхождение — полурендер/перевёрстка → fail-closed.
  if (!tables.every((t) => t.rounds.length === rounds.length
    && t.rounds.every((f, i) => f === rounds[i]))) return null;

  const classes: WecClassStandings[] = [];
  for (const raceClass of ["HYPERCAR", "LMGT3"] as WecClassId[]) {
    const driversKind: WecTableKind = raceClass === "HYPERCAR" ? "hypercarDrivers" : "lmgt3Drivers";
    const driversTable = tables.find((t) => t.kind === driversKind);
    if (!driversTable) continue;

    const bare = buildCrews(raceClass, tables, classificationRows);
    const real = realWinsByCar(bare, completedRounds, winnersByClass[raceClass] ?? new Map());
    const proxy = proxyWins(bare.map((c) => c.stagePoints));
    const crews: WecCrewEntry[] = bare.map((c, i) => ({
      ...c,
      wins: real ? real.get(c.carNumber) ?? 0 : proxy[i],
    }));

    const driverRows: WecDriverRow[] = driversTable.rows.map((r) => ({
      position: r.position,
      carNumber: r.carNumber,
      drivers: r.name.split(",").map((p) => p.trim()).filter((p) => p.length > 0),
      points: r.totalPoints,
      pointsSource: "official",
      stagePoints: r.stagePoints,
    }));

    const cls: WecClassStandings = {
      raceClass,
      winsSource: real ? "real" : "maxPointsProxy",
      crews,
      driverRows,
    };
    if (raceClass === "HYPERCAR") {
      const mfr = tables.find((t) => t.kind === "hypercarManufacturers");
      if (mfr) {
        cls.manufacturers = mfr.rows.map((r) => ({
          position: r.position,
          name: r.name,
          points: r.totalPoints,
          pointsSource: "official",
          stagePoints: r.stagePoints,
        }));
      }
    }
    classes.push(cls);
  }
  if (classes.length === 0) return null;

  // frozen: каждый раунд календаря завершён И сыгран в каждом классе — сезон
  // закрыт, клиент может кэшировать навсегда (сквозное правило конверта).
  const allScored = classes.every((cls) => {
    const scored = new Set<number>();
    for (const c of cls.crews) {
      c.stagePoints.forEach((v, i) => {
        if (v !== null && v > 0) scored.add(i);
      });
    }
    return scored.size === rounds.length;
  });
  const frozen = completedRounds.length === rounds.length && allScored;

  return { series: "wec", season, frozen, rounds, classes };
}

// MARK: - Предохранители записи (fail-closed, образец imsastandings)

/// Сыгранные раунды документа — по stagePoints экипажей всех классов.
function scoredRounds(doc: Pick<WecStandingsDoc, "classes">): number {
  const scored = new Set<number>();
  for (const cls of doc.classes ?? []) {
    for (const c of cls.crews ?? []) {
      (c.stagePoints ?? []).forEach((v, i) => {
        if (v !== null && v > 0) scored.add(i);
      });
    }
  }
  return scored.size;
}

function teamsKnown(doc: Pick<WecStandingsDoc, "classes">): number {
  let n = 0;
  for (const cls of doc.classes ?? []) {
    for (const c of cls.crews ?? []) if (c.team) n++;
  }
  return n;
}

/// null — писать можно; строка — причина оставить прежний файл. Деградации:
/// сыгранных раундов стало меньше (полурендер страницы), класс исчез, экипажи
/// класса схлопнулись, команды пропали разом (дыра зеркала классификации).
export function wecStandingsRegression(
  prev: Pick<WecStandingsDoc, "classes"> | null,
  next: Pick<WecStandingsDoc, "classes">,
): string | null {
  if (!prev) return null;
  const prevScored = scoredRounds(prev);
  const nextScored = scoredRounds(next);
  if (nextScored < prevScored) {
    return `сыгранных раундов стало меньше (${prevScored} → ${nextScored})`;
  }
  for (const prevCls of prev.classes ?? []) {
    const nextCls = (next.classes ?? []).find((c) => c.raceClass === prevCls.raceClass);
    if (!nextCls) return `класс ${prevCls.raceClass} исчез`;
    const prevCrews = prevCls.crews?.length ?? 0;
    const nextCrews = nextCls.crews?.length ?? 0;
    if (nextCrews < prevCrews) {
      return `экипажей ${prevCls.raceClass} стало меньше (${prevCrews} → ${nextCrews})`;
    }
  }
  const prevTeams = teamsKnown(prev);
  if (prevTeams > 0 && teamsKnown(next) === 0) {
    return `команды экипажей пропали (${prevTeams} → 0)`;
  }
  return null;
}

function readPrev<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null; // файла нет или бит — прежнего хорошего состояния нет
  }
}

/// Запись зачёта с предохранителем: деградация входов не затирает прежний файл
/// целиком (kept-previous), рост и правки пишутся, повтор — unchanged.
export function writeWecStandings(
  path: string, next: WecStandingsDoc,
): "written" | "unchanged" | "kept-previous" {
  const prev = readPrev<WecStandingsDoc>(path);
  const regression = wecStandingsRegression(prev, next);
  if (regression) {
    console.warn(`::warning::wec standings: ${regression} — прежний standings.json не тронут`);
    return "kept-previous";
  }
  const payload = {
    series: next.series, season: next.season, frozen: next.frozen,
    rounds: next.rounds, classes: next.classes,
  };
  return writeJSONWithEnvelope(path, payload, WEC_STANDINGS_SCHEMA_VERSION)
    ? "written" : "unchanged";
}

/// Запись индекса. Полноту входов (страница каждого слага распарсилась)
/// гарантирует вызывающий ДО сборки — здесь только конверт и idempotency.
/// Сжатие состава сезона НЕ блокируется: страница сезона — источник правды,
/// fiawec перекраивает сезоны задним числом (Катар/Бахрейн-2026 → 2027), и GC
/// зеркала уже следует за ней; блокировка заморозила бы выбывшие этапы в файле
/// навечно. Логируем предупреждением — сжатие видно в прогоне.
export function writeWecIndex(
  path: string, next: WecSeasonIndexDoc,
): "written" | "unchanged" {
  const prev = readPrev<WecSeasonIndexDoc>(path);
  const prevRaces = (prev?.events ?? []).filter((e) => e.round >= 1).length;
  const nextRaces = next.events.filter((e) => e.round >= 1).length;
  if (prevRaces > 0 && nextRaces < prevRaces) {
    console.warn(`::warning::wec index: этапов стало меньше (${prevRaces} → ${nextRaces}) — сезон перекроен fiawec?`);
  }
  const payload = {
    series: next.series, season: next.season, frozen: next.frozen, events: next.events,
  };
  return writeJSONWithEnvelope(path, payload, WEC_INDEX_SCHEMA_VERSION)
    ? "written" : "unchanged";
}

// MARK: - Оркестрация (вызывается из продьюсера wec.ts тем же прогоном)

/// Победители сезона по данным системы: data/wec/highlights/<y>_<r>.json →
/// classWinners (класс, НОМЕР машины). Битый/отсутствующий файл — просто нет
/// победителя раунда (realWinsByCar откатит класс на прокси).
function loadWinners(
  root: string, season: number, roundsList: number[],
): Partial<Record<WecClassId, WinnerCarByRound>> {
  const out: Partial<Record<WecClassId, WinnerCarByRound>> = {
    HYPERCAR: new Map(), LMGT3: new Map(),
  };
  for (const r of roundsList) {
    const doc = readPrev<{ classWinners?: { class?: string; car?: string }[] }>(
      join(root, "wec", "highlights", `${season}_${r}.json`));
    for (const w of doc?.classWinners ?? []) {
      const cls = (w.class ?? "").toUpperCase();
      if ((cls === "HYPERCAR" || cls === "LMGT3") && w.car) {
        out[cls as WecClassId]!.set(r, String(w.car));
      }
    }
  }
  return out;
}

/// Сборка витрины сезона из зеркала. Никакой сети: читает то, что wec.ts
/// только что снял (или снял когда-то — для замороженных сезонов). Возвращает
/// краткий итог для лога продьюсера.
export function buildWecSnapshot(
  year: number,
  now: number,
  root: string = join(process.cwd(), "data"),
): string {
  const mirror = (path: string): string | null => {
    try {
      return readFileSync(join(root, "wec", "fiawec", mirrorSlug(path)), "utf8");
    } catch {
      return null;
    }
  };

  const seasonHtml = mirror(`/en/season/${year}`);
  if (!seasonHtml) return `snapshot: нет зеркала сезона ${year} — пропуск`;
  const slugs = raceSlugs(seasonHtml, year);
  if (slugs.length === 0) return `snapshot: сезон ${year} без этапов — пропуск`;
  const tests = testSlugs(seasonHtml, year);

  const pageOf = (slug: string): WecRacePageInfo | null => {
    const html = mirror(`/en/race/${slug}`);
    return html ? parseRacePage(html) : null;
  };
  const racePages = slugs.map((slug) => ({ slug, page: pageOf(slug) }));
  // Прологи — мягко, как у клиента (buildTestEvents compactMap): пролог без
  // страницы в нумерацию не входит и ничего не смещает.
  const testPages = tests
    .map((slug) => ({ slug, page: pageOf(slug) }))
    .filter((e): e is AssembleInput => e.page !== null);

  // Fail-closed: этап без страницы/JSON-LD сдвинул бы нумерацию всех
  // последующих (клиент в этой ситуации живёт минуту, файл — навсегда).
  const missing = racePages.filter((e) => e.page === null).map((e) => e.slug);
  if (missing.length > 0) {
    console.warn(`::warning::wec snapshot: нет страниц [${missing.join(", ")}] — index/standings не трогаем`);
    return `snapshot: неполные страницы сезона ${year} — файлы не тронуты`;
  }
  const races = racePages as AssembleInput[];

  // Дропдауны сессий (E5) — по raceId со страниц событий.
  const sessionsByRaceId = new Map<number, WecSessionRef[]>();
  for (const e of [...races, ...testPages]) {
    const raceId = e.page.raceId;
    if (raceId === null || sessionsByRaceId.has(raceId)) continue;
    const e5 = mirror(`/en/page/resultats-1?raceId=${raceId}`);
    sessionsByRaceId.set(raceId, e5 ? sessionOptions(e5) : []);
  }

  const refs = loadRefs();
  const events = assembleIndexEvents(year, races, testPages, refs, sessionsByRaceId);
  const raceEvents = events.filter((e) => e.round >= 1);
  const ends = raceEvents
    .map((e) => (e.end ? Date.parse(e.end) : NaN))
    .filter((v) => Number.isFinite(v));
  const indexDoc: WecSeasonIndexDoc = {
    series: "wec",
    season: year,
    // Заморожен = завершён и отстоялся (freeze-окно результатов).
    frozen: raceEvents.length > 0
      && raceEvents.every((e) => isCompleted(e, now))
      && ends.length === raceEvents.length
      && isFrozen(Math.max(...ends), now),
    events,
  };
  const outDir = join(root, "wec", String(year));
  const indexOutcome = writeWecIndex(join(outDir, "index.json"), indexDoc);

  // --- Зачёт ---
  const mcHtml = mirror("/en/page/manufacturers-classification");
  if (!mcHtml) return `snapshot ${year}: index ${indexOutcome}; standings: нет зеркала зачёта`;
  const pageSeason = standingsPageSeason(mcHtml);
  if (pageSeason !== year) {
    // Страница зачёта всегда несёт ТЕКУЩИЙ сезон; архивных fiawec не хранит.
    // Season-guard: чужой сезон в свой файл не пишем (январские отравления).
    return `snapshot ${year}: index ${indexOutcome}; standings: страница зачёта за ${pageSeason ?? "?"} — пропуск`;
  }
  const tables = parseStandingsTables(mcHtml);

  // Классификация последней завершённой гонки — команды экипажей Hypercar
  // (порт цепочки lastCompletedEvent → RACE-сессия → таблица E6).
  const completedRaces = raceEvents.filter((e) => isCompleted(e, now));
  const last = completedRaces[completedRaces.length - 1]; // события уже по датам
  let classificationRows: WecRaceTeamRow[] = [];
  if (last && last.sourceIds.fiawec.raceId !== null) {
    const raceId = last.sourceIds.fiawec.raceId;
    const raceSession = (sessionsByRaceId.get(raceId) ?? [])
      .find((s) => s.label.toUpperCase() === "RACE");
    if (raceSession) {
      const e6 = mirror(`/en/page/resultats-1?raceId=${raceId}&sessionId=${raceSession.id}`);
      if (e6) classificationRows = raceTeamRows(e6);
    }
  }

  const completedRounds = completedRaces.map((e) => e.round);
  const standingsDoc = buildWecStandings({
    season: year,
    tables,
    classificationRows,
    completedRounds,
    winnersByClass: loadWinners(root, year, completedRounds),
  });
  if (!standingsDoc) {
    console.warn(`::warning::wec snapshot: зачёт ${year} не собрался (страница пуста/битая) — standings.json не тронут`);
    return `snapshot ${year}: index ${indexOutcome}; standings: не собрался — файл не тронут`;
  }
  const standingsOutcome = writeWecStandings(join(outDir, "standings.json"), standingsDoc);
  return `snapshot ${year}: index ${indexOutcome}; standings ${standingsOutcome}`;
}
