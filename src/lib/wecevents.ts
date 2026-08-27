// Витрина событий WEC — шаг 3b DATA-PLAN: data/wec/<год>/<NN>_<слаг>.json
// вместо ~1.5 МБ HTML и ~520 строк regex-парсинга классификаций НА УСТРОЙСТВЕ
// при каждом открытии события. Формат — копия IMSA (sessions[].rows[]).
//
// Источник правды о СЕМАНТИКЕ — сегодняшние парсеры и билдеры приложения
// (расхождение с экраном = баг шага):
//   классификация сессии — WECResultsParser (маппинг ячеек ПО ИМЕНИ шапки,
//                          выброс картиночной ячейки, «-» гэпа → "");
//   расписание уик-энда  — WECRacePageParser (subEvent JSON-LD; порт живёт в
//                          wecsnapshot.parseRacePage);
//   набор сессий экрана  — WECDataService.eventClassifications + sessionKind
//                          (какая подпись во что превращается, Hyperpole —
//                          отдельная фаза, у Ле-Мана их две);
//   имена экипажей       — WECDataService.crewByCarNumber (джойн по номеру
//                          машины из Drivers-таблиц зачёта — сегодня его
//                          делает клиент, теперь бэкенд).
// Все портированные функции помечены «ПАРНО с …» — менять только вместе со
// Swift-стороной, пока парсеры приложения живы (их снос — шаг 3c).
//
// Вход — ТОЛЬКО уже лежащие на диске файлы: зеркало data/wec/fiawec (снято тем
// же прогоном wec.ts), только что записанные index.json и standings.json.
// Сети здесь нет: прогон SEASON=<архив> собирает события из замороженных
// зеркал.
//
// Чего здесь сознательно НЕТ (см. отчёт шага):
//   — грид: наложение Hyperpole поверх квалы остаётся клиентским (обе сессии
//     лежат в ОДНОМ файле — по критерию материализации плана это чистая
//     функция над одним загруженным файлом; плюс гриду нужны слаги
//     производителей, а они осознанно оставлены картой приложения в 3a);
//   — класс В СТРОКЕ: fiawec никогда не печатает колонку Class и рендерит
//     одну категорию на страницу — класс это свойство СЕССИИ, не строки
//     (в отличие от IMSA, где один файл смешивает классы);
//   — interval/avg/«best lap» гонки: клиентская модель WECResultRow их не
//     несёт, а лишние поля — это байты у каждой из ~2000 строк. Кухня
//     (зеркало) на месте, фаза 6 добавит их аддитивно.

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { envFlag } from "./env.js";
import { isFrozen } from "./freeze.js";
import { mirrorSlug, writeJSONWithEnvelope } from "./mirror.js";
import {
  wecEventFileName, type WecIndexEvent, type WecScheduledSession,
  type WecSeasonIndexDoc, type WecStandingsDoc, parseRacePage,
} from "./wecsnapshot.js";

/// Своя версия у семейства (прецедент 3a: index и standings — независимые
/// контракты; событие — третий).
export const WEC_EVENT_SCHEMA_VERSION = 1;

// MARK: - Типы контракта

/// Бакет сессии. Первые четыре — ровно те, что различает экран события
/// (WECAppSession); warmup и other экран не показывает, но данные о них есть,
/// и прятать их — врать (у пролога вообще ВСЕ сессии other).
export type WecSessionKind =
  | "practice" | "qualifying" | "hyperpole" | "warmup" | "race" | "other";

export interface WecEventResultRow {
  /// null — машина без позиции в протоколе (сход/незачёт): клиент рисует ей
  /// DNF. ПАРНО с WECResultRow.position.
  position: number | null;
  carNumber: string;
  /// Сырое имя команды из таблицы («BMW M TEAM WRT»): титул-кейс
  /// (displayTeam) — представление, его делает экран.
  team: string;
  /// Экипаж, разрезолвленный по номеру машины из зачёта СЕЗОНА события
  /// (см. crewSource документа); [] — источника нет.
  drivers: string[];
  laps: number | null;
  /// Гонка — полное время; практика/квала/хайперполь — лучший круг машины
  /// (у страницы нет колонки Total). ПАРНО с WECResultRow.totalTime.
  totalTime: string;
  /// Отставание от лидера; "" — лидер или прочерк. ПАРНО с gapFirst.
  gapFirst: string;
  /// «classified» ⇔ у строки есть позиция (единственная семантика статуса,
  /// которую несёт fiawec). Клиентский isClassified читает именно её.
  status: "classified" | "retired";
}

export interface WecEventSession {
  kind: WecSessionKind;
  /// Подпись сессии из расписания страницы события («Free Practice 1»,
  /// «Qualifying - HYPERCAR», «MORNING SESSION»); нет расписания — подпись
  /// дропдауна результатов. Экранные имена («Free practice 1») собирает
  /// клиент из kind+number — представление не материализуем.
  name: string;
  /// Номер практики (FP1..FP4) — null у остальных.
  number: number | null;
  /// Фаза хайперполя: у Ле-Мана их две («HYPERPOLE 1/2»), решётку определяет
  /// ПОСЛЕДНЯЯ — правило выбора остаётся клиентским, данные несут обе.
  phase: number | null;
  /// Класс страницы протокола: квалификатор подписи («HYPERCAR», «LMGT3»,
  /// «LMP2 & LMGT3»), а без него — HYPERCAR (fiawec рендерит категорию по
  /// умолчанию; то же допущение делает клиент, зовущий парсер с .hypercar).
  /// null — протокола у сессии нет вовсе (сессии пролога).
  raceClass: string | null;
  /// Сырая ISO-строка с офсетом трассы из JSON-LD; null — сессии нет в
  /// расписании страницы.
  start: string | null;
  status: string | null; // EventScheduled / EventInProgress / EventCompleted
  sourceIds: { sessionId: number | null };
  rows: WecEventResultRow[];
}

export interface WecEventDoc {
  series: "wec";
  season: number;
  /// Номер этапа из index.json (присвоен по дате старта); 0 — пролог.
  round: number;
  slug: string;
  name: string;
  /// Display-строка площадки рядом с nullable trackRef (правило 2 плана).
  venue: string;
  trackRef: string | null;
  countryCode: string | null;
  status: string | null;
  start: string | null;
  end: string | null;
  /// Событие завершено и отстоялось (freeze-окно результатов) — клиенту
  /// «кэшируй навсегда», продьюсеру «больше не пересобирать».
  frozen: boolean;
  /// Происхождение имён экипажей: «seasonStandings» — Drivers-таблицы зачёта
  /// ЭТОГО сезона; null — источника нет (у архивных сезонов страницы зачёта
  /// не существует, fiawec держит только текущий) и drivers пусты.
  crewSource: "seasonStandings" | null;
  sourceIds: { fiawec: { slug: string; raceId: number | null } };
  sessions: WecEventSession[];
}

// MARK: - Порт WECResultsParser (страница /en/page/resultats-1?raceId&sessionId)

/// ПАРНО с WECResultsParser.cleanText. Набор сущностей СВОЙ (у парсера зачёта
/// он другой: там &rsquo;, здесь &lt;/&gt;) — поэтому функция не общая с
/// wecsnapshot.ts: общая молча подменила бы поведение одного из двух портов.
function cleanText(html: string): string {
  let s = html.replace(/<[^>]+>/g, "");
  const entities: Record<string, string> = {
    "&amp;": "&", "&#039;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&nbsp;": " ",
  };
  for (const [k, v] of Object.entries(entities)) s = s.split(k).join(v);
  return s.trim();
}

/// Первая таблица, чья разметка упоминает и позицию, и команду/участников
/// (навигационные таблицы пропускаются). ПАРНО с WECResultsParser.resultsTable.
function resultsTable(html: string): string | null {
  for (const m of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const low = m[1].toLowerCase();
    if (low.includes(">pos") && (low.includes("competitor") || low.includes(">team"))) return m[1];
  }
  return null;
}

/// Текст всех <td>, кроме чисто-картиночных (логотип бренда + иллюстрация
/// машины под шапкой Competitors). ПАРНО с WECResultsParser.textCells.
function textCells(rowHTML: string): string[] {
  const out: string[] = [];
  for (const m of rowHTML.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const text = cleanText(m[1]);
    if (text === "" && m[1].toLowerCase().includes("<img")) continue;
    out.push(text);
  }
  return out;
}

const leadingInt = (raw: string): number | null => {
  const m = /^\d+/.exec(raw);
  return m ? Number(m[0]) : null;
};

/// Прочерк гэпа на fiawec означает «лидер / гэпа нет» → "".
/// ПАРНО с WECResultsParser.normalizeGap.
const normalizeGap = (raw: string): string => {
  const t = raw.trim();
  return t === "-" || t === "–" ? "" : t;
};

/// Строки классификации сессии. ПАРНО с WECResultsParser.parse+makeRow:
/// ячейки маппятся ПО ИМЕНИ заголовка (позиционная раскладка fia.com была
/// хрупкой), строка без команды или без номера машины отбрасывается.
///
/// Важное следствие порта, проверенное на зеркале: у машины без логотипа и
/// без имени команды (2025 Ле-Ман, #199 в сессиях LMP2 & LMGT3) картиночная
/// ячейка НЕ пустая-с-img, а просто пустая — ячейки съезжают на одну, номер
/// уезжает в колонку Team, и строка выпадает из протокола. Это сегодняшнее
/// поведение экрана, и порт обязан его повторить, а не «починить».
export function parseSessionRows(html: string): Omit<WecEventResultRow, "drivers">[] {
  const table = resultsTable(html);
  if (!table) return [];
  let headers: string[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (!tr[1].includes("<th")) continue;
    headers = [...tr[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((h) => cleanText(h[1]));
    break;
  }
  if (headers.length === 0) return [];

  const out: Omit<WecEventResultRow, "drivers">[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (!tr[1].includes("<td")) continue;
    const cells = textCells(tr[1]);
    // Подпись «N°» и спейсеры: строк короче шапки на 1+ ячейку не бывает.
    if (cells.length < headers.length - 1) continue;
    const col = new Map<string, string>();
    headers.forEach((h, i) => {
      if (i < cells.length) col.set(h.toLowerCase(), cells[i]);
    });
    // Первое совпадение по порядку шапки. У Swift здесь Dictionary с
    // НЕОПРЕДЕЛЁННЫМ порядком обхода, но на реальных шапках fiawec каждый
    // набор игл матчит ровно один заголовок — расхождения нет (та же
    // оговорка, что у raceTeamRows в wecsnapshot.ts).
    const value = (needles: string[]): string => {
      for (const [key, val] of col) {
        if (needles.some((n) => key.includes(n))) return val;
      }
      return "";
    };
    const carNumber = value(["competitor", "n°", "no.", "num"]).replace(/^#+|#+$/g, "");
    const team = value(["team"]);
    if (!team || !carNumber) continue;

    const position = leadingInt(value(["pos"]));
    const totalCol = value(["total"]);
    // У гонки есть «Total time»; практику/квалу ранжирует «Best lap», колонки
    // тотала там нет — в totalTime уезжает лучший круг.
    const totalTime = totalCol === "" ? value(["best"]) : totalCol;
    out.push({
      position,
      carNumber,
      team,
      laps: leadingInt(value(["laps"])),
      totalTime,
      gapFirst: normalizeGap(value(["gap"])),
      status: position !== null ? "classified" : "retired",
    });
  }
  return out;
}

// MARK: - Порт sessionKind (WECDataService) + класс страницы

/// Бакет и номера сессии по её подписи. ПАРНО с sessionKind(of:) — с двумя
/// осознанными расширениями, которые НЕ меняют экран:
///  - LMGT3-квалы и LMGT3-хайперполи получают свой kind, а не выбрасываются:
///    класс лежит рядом отдельным полем, и клиент отбирает те же сессии, что
///    сегодня (qualifying+HYPERCAR, hyperpole без LMGT3);
///  - у warm-up появился свой бакет (сегодня он просто nil и не грузится).
export function sessionKindOf(label: string): {
  kind: WecSessionKind; number: number | null; phase: number | null;
} {
  const t = label.toUpperCase();
  const bare = (kind: WecSessionKind) => ({ kind, number: null, phase: null });
  if (t === "RACE") return bare("race");            // ровно «RACE», как у клиента
  const fp = /FREE PRACTICE (\d)/.exec(t);
  if (fp) return { kind: "practice", number: Number(fp[1]), phase: null };
  if (t.includes("HYPERPOLE")) {
    const m = /HYPERPOLE (\d)/.exec(t);
    return { kind: "hyperpole", number: null, phase: m ? Number(m[1]) : null };
  }
  if (t.includes("QUALIFYING")) return bare("qualifying");
  if (t.includes("WARM")) return bare("warmup");
  return bare("other");
}

/// Класс страницы протокола: квалификатор после « - » («QUALIFYING - LMGT3»
/// → «LMGT3»; «HYPERPOLE 1 - LMP2 & LMGT3» → «LMP2 & LMGT3»). Без
/// квалификатора — HYPERCAR: fiawec рендерит категорию по умолчанию, и клиент
/// зовёт парсер ровно с `raceClass: .hypercar`. `inResults` — есть ли у сессии
/// страница протокола вообще (сессии пролога живут только в расписании, класса
/// у них нет — там на трассе весь пелотон).
export function sessionClassOf(label: string, inResults: boolean): string | null {
  const i = label.indexOf(" - ");
  if (i >= 0) {
    const tail = label.slice(i + 3).trim().toUpperCase();
    if (tail) return tail;
  }
  return inResults ? "HYPERCAR" : null;
}

// MARK: - Порт crewByCarNumber (WECDataService)

/// Номер машины → состав экипажа из Drivers-таблиц зачёта (Hypercar + LMGT3),
/// имена в порядке появления, без дублей. ПАРНО с
/// WECDataService.crewByCarNumber — с одной поправкой: зачёт берётся ЗА
/// СЕЗОН СОБЫТИЯ, а не «тот, что сейчас загружен на клиенте» (на архивном
/// событии клиент сегодня подставляет экипажи ТЕКУЩЕГО сезона — это баг, а не
/// семантика; в файл его не увековечиваем).
export function crewByCarNumber(doc: WecStandingsDoc | null): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const cls of doc?.classes ?? []) {
    for (const row of cls.driverRows ?? []) {
      const car = row.carNumber;
      if (!car) continue;
      const crew = map.get(car) ?? [];
      for (const name of row.drivers ?? []) {
        if (name && !crew.includes(name)) crew.push(name);
      }
      map.set(car, crew);
    }
  }
  return map;
}

// MARK: - Сборка документа события

export interface EventBuildInput {
  season: number;
  /// Событие из index.json — единственный источник round/слага/площадки/ref
  /// (нумерация раундов присвоена там же, шаг 3a).
  event: WecIndexEvent;
  /// Расписание со страницы события (subEvent JSON-LD).
  schedule: WecScheduledSession[];
  /// Классификации по sessionId: id → строки протокола ([] — протокола нет).
  rowsBySessionId: Map<number, Omit<WecEventResultRow, "drivers">[]>;
  crewByCar: Map<string, string[]>;
  crewSource: "seasonStandings" | null;
  now: number;
}

/// Ключ сопоставления подписи расписания и подписи дропдауна: регистр и
/// лишние пробелы у fiawec гуляют («Qualifying - Hypercar» в 2025 против
/// «QUALIFYING - HYPERCAR» в дропдауне), всё остальное совпадает побайтово
/// (проверено на всех 18 событиях двух сезонов).
const joinKey = (s: string): string => s.replace(/\s+/g, " ").trim().toUpperCase();

export function buildWecEventDoc(input: EventBuildInput): WecEventDoc {
  const { season, event, schedule, rowsBySessionId, crewByCar, crewSource, now } = input;
  const refs = event.sourceIds.fiawec.sessions;
  const byKey = new Map(refs.map((s) => [joinKey(s.label), s]));

  const make = (
    label: string, name: string, sched: WecScheduledSession | null, sessionId: number | null,
  ): WecEventSession => {
    const rows = sessionId !== null ? rowsBySessionId.get(sessionId) ?? [] : [];
    const { kind, number, phase } = sessionKindOf(label);
    return {
      kind,
      name,
      number,
      phase,
      raceClass: sessionClassOf(label, sessionId !== null),
      start: sched?.start ?? null,
      status: sched?.status ?? null,
      sourceIds: { sessionId },
      rows: rows.map((r) => ({ ...r, drivers: crewByCar.get(r.carNumber) ?? [] })),
    };
  };

  const sessions: WecEventSession[] = [];
  const usedIds = new Set<number>();
  // Костяк — расписание страницы: оно полное (включая warm-up и обе фазы
  // хайперполя) и несёт времена. Дропдаун результатов приклеивается к нему по
  // подписи; расхождений на зеркале двух сезонов нет ни одного.
  for (const s of schedule) {
    const ref = byKey.get(joinKey(s.name)) ?? null;
    if (ref) usedIds.add(ref.id);
    sessions.push(make(ref?.label ?? s.name, s.name, s, ref?.id ?? null));
  }
  // Сессия есть в результатах, но не в расписании (страница перевёрстана /
  // расписание не доехало) — теряться она не должна: протокол важнее времени.
  for (const ref of refs) {
    if (usedIds.has(ref.id)) continue;
    sessions.push(make(ref.label, ref.label, null, ref.id));
  }
  // Хронологический порядок; без времени — в хвост, тай-брейк по sessionId
  // (id fiawec растут хронологически), затем по имени.
  sessions.sort((a, b) => {
    const ta = a.start ? Date.parse(a.start) : NaN;
    const tb = b.start ? Date.parse(b.start) : NaN;
    const va = Number.isFinite(ta);
    const vb = Number.isFinite(tb);
    if (va && vb && ta !== tb) return ta - tb;
    if (va !== vb) return va ? -1 : 1;
    const ia = a.sourceIds.sessionId ?? Number.MAX_SAFE_INTEGER;
    const ib = b.sourceIds.sessionId ?? Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const endMs = event.end ? Date.parse(event.end) : NaN;
  return {
    series: "wec",
    season,
    round: event.round,
    slug: event.slug,
    name: event.name,
    venue: event.venue,
    trackRef: event.trackRef,
    countryCode: event.countryCode,
    status: event.status,
    start: event.start,
    end: event.end,
    frozen: isFrozen(Number.isFinite(endMs) ? endMs : null, now),
    crewSource,
    sourceIds: { fiawec: { slug: event.sourceIds.fiawec.slug, raceId: event.sourceIds.fiawec.raceId } },
    sessions,
  };
}

// MARK: - Предохранители записи (fail-closed, образец imsastandings/3a)

const rowCount = (doc: Pick<WecEventDoc, "sessions">): number =>
  (doc.sessions ?? []).reduce((n, s) => n + (s.rows?.length ?? 0), 0);

const startCount = (doc: Pick<WecEventDoc, "sessions">): number =>
  (doc.sessions ?? []).filter((s) => s.start).length;

const crewedRows = (doc: Pick<WecEventDoc, "sessions">): number =>
  (doc.sessions ?? []).reduce(
    (n, s) => n + (s.rows ?? []).filter((r) => (r.drivers?.length ?? 0) > 0).length, 0);

/// null — писать можно; строка — причина оставить прежний файл. Деградации
/// входов, каждая из которых уже случалась у соседних семейств: дыра в
/// зеркале (сессия/протокол пропали), недоехавшая страница события (пропали
/// времена), не собравшийся зачёт (пропали экипажи).
export function wecEventRegression(
  prev: Pick<WecEventDoc, "sessions"> | null,
  next: Pick<WecEventDoc, "sessions">,
): string | null {
  if (!prev) return null;
  const prevSessions = prev.sessions?.length ?? 0;
  const nextSessions = next.sessions?.length ?? 0;
  if (nextSessions < prevSessions) {
    return `сессий стало меньше (${prevSessions} → ${nextSessions})`;
  }
  const prevRows = rowCount(prev);
  const nextRows = rowCount(next);
  if (nextRows < prevRows) return `строк протоколов стало меньше (${prevRows} → ${nextRows})`;
  const prevStarts = startCount(prev);
  const nextStarts = startCount(next);
  if (nextStarts < prevStarts) {
    return `сессий со временем старта стало меньше (${prevStarts} → ${nextStarts})`;
  }
  const prevCrews = crewedRows(prev);
  if (prevCrews > 0 && crewedRows(next) === 0) {
    return `имена экипажей пропали (${prevCrews} → 0)`;
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

export type EventWriteOutcome = "written" | "unchanged" | "kept-previous" | "frozen";

/// Запись события с предохранителем и заморозкой. Замороженное событие
/// (finish + 7 дней) НЕ пересобирается — образец imsa.ts: история пишется
/// один раз, и её не двигают ни поздний ре-рендер fiawec, ни пополнение
/// экипажей зачётом (составы кумулятивны по сезону — иначе каждая замена
/// пилота переписывала бы все прошлые этапы). Перебить — WEC_EVENTS_FORCE=1.
export function writeWecEvent(path: string, next: WecEventDoc): EventWriteOutcome {
  // Конверт (schemaVersion) читаем вместе с телом: файл прошлой версии схемы
  // обязан пересобраться даже будучи замороженным — иначе смена контракта
  // никогда не доехала бы до истории.
  const prev = readPrev<WecEventDoc & { schemaVersion?: number }>(path);
  if (prev && next.frozen && !envFlag("WEC_EVENTS_FORCE")
    && prev.schemaVersion === WEC_EVENT_SCHEMA_VERSION) {
    return "frozen";
  }
  const regression = wecEventRegression(prev, next);
  if (regression) {
    console.warn(`::warning::wec event ${next.slug}: ${regression} — прежний файл не тронут`);
    return "kept-previous";
  }
  const { series, season, round, slug, name, venue, trackRef, countryCode, status,
    start, end, frozen, crewSource, sourceIds, sessions } = next;
  return writeJSONWithEnvelope(path, {
    series, season, round, slug, name, venue, trackRef, countryCode, status,
    start, end, frozen, crewSource, sourceIds, sessions,
  }, WEC_EVENT_SCHEMA_VERSION) ? "written" : "unchanged";
}

// MARK: - Оркестрация (вызывается из продьюсера wec.ts тем же прогоном)

/// Сборка файлов событий сезона из уже лежащих на диске входов: index.json
/// (состав сезона и номера раундов), standings.json (экипажи по номеру
/// машины), зеркало fiawec (страницы событий и протоколы сессий).
/// Возвращает краткий итог для лога продьюсера.
export function buildWecEventFiles(
  year: number,
  now: number,
  root: string = join(process.cwd(), "data"),
): string {
  const outDir = join(root, "wec", String(year));
  const index = readPrev<WecSeasonIndexDoc>(join(outDir, "index.json"));
  if (!index || index.season !== year || (index.events ?? []).length === 0) {
    return "events: нет index.json сезона — пропуск";
  }
  const mirror = (path: string): string | null => {
    try {
      return readFileSync(join(root, "wec", "fiawec", mirrorSlug(path)), "utf8");
    } catch {
      return null;
    }
  };

  // Экипажи — из зачёта ЭТОГО сезона. Нет файла (архив: страницы зачёта
  // прошлых лет у fiawec не существует) → имена не резолвим и говорим об этом
  // честно полем crewSource, а не подставляем чужой сезон.
  const standings = readPrev<WecStandingsDoc>(join(outDir, "standings.json"));
  const usable = standings && standings.season === year ? standings : null;
  const crewByCar = crewByCarNumber(usable);
  const crewSource = crewByCar.size > 0 ? "seasonStandings" as const : null;

  const counts: Record<EventWriteOutcome, number> = {
    written: 0, unchanged: 0, "kept-previous": 0, frozen: 0,
  };
  const expected = new Set<string>();
  for (const event of index.events) {
    const file = wecEventFileName(event.round, event.slug);
    expected.add(file);
    const html = mirror(`/en/race/${event.slug}`);
    const page = html ? parseRacePage(html) : null;
    const raceId = event.sourceIds.fiawec.raceId;
    const rowsBySessionId = new Map<number, Omit<WecEventResultRow, "drivers">[]>();
    if (raceId !== null) {
      for (const ref of event.sourceIds.fiawec.sessions) {
        const e6 = mirror(`/en/page/resultats-1?raceId=${raceId}&sessionId=${ref.id}`);
        // Зеркала нет — сессия ещё не сыграна (fiawec отдаёт для будущих
        // пустой HTML, и wec.ts такие не сохраняет). Пустой протокол ≠ дыра.
        if (e6) rowsBySessionId.set(ref.id, parseSessionRows(e6));
      }
    }
    const doc = buildWecEventDoc({
      season: year, event, schedule: page?.sessions ?? [],
      rowsBySessionId, crewByCar, crewSource, now,
    });
    counts[writeWecEvent(join(outDir, file), doc)]++;
  }

  // GC осиротевших файлов: fiawec перекраивает сезоны задним числом (Катар и
  // Бахрейн 2026 уехали в 2027), и файл выбывшего этапа иначе замерзает в
  // репозитории навечно — на него уже никто не ссылается (resultsPath индекса
  // перестроен). Тот же приём и то же условие, что у GC зеркал в wec.ts:
  // только при непустом составе сезона (index собран fail-closed).
  let pruned = 0;
  // Сносим только то, что сами и пишем (имя события): случайный курируемый
  // файл в папке сезона GC пережить обязан.
  const isEventFile = (f: string): boolean => /^(\d{2}_|test_).+\.json$/.test(f);
  for (const f of readdirSync(outDir)) {
    if (expected.has(f) || !isEventFile(f)) continue;
    rmSync(join(outDir, f));
    pruned++;
    console.log(`  prune wec/${year}/${f} (событие выбыло из сезона)`);
  }

  const parts = [`${counts.written} written`, `${counts.unchanged} unchanged`];
  if (counts.frozen) parts.push(`${counts.frozen} frozen`);
  if (counts["kept-previous"]) parts.push(`${counts["kept-previous"]} kept-previous`);
  if (pruned) parts.push(`${pruned} pruned`);
  return `events ${year}: ${parts.join(", ")}${crewSource ? "" : "; экипажи не резолвятся (нет зачёта сезона)"}`;
}
