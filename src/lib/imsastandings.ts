// Зачёт сезона IMSA (data/imsa/<y>/standings.json) — фаза 1 DATA-PLAN.
// Материализация клиентского IMSAStandingsBuilder.swift: бэкенд уже владеет
// всеми входами (index + файлы раундов + points.json), поэтому таблица
// собирается здесь один раз, а не на каждом холодном старте клиента (~20 GET).
//
// Семантика — КАЛЬКА с клиента, не улучшение (расхождение = баг фазы):
//  • раунд считается, когда его «конец» (+24ч, клиентский completedAfter)
//    уже прошёл И есть строки последней race-сессии; live-окно не считается;
//  • per-round очки ВСЕГДА расчётные из места в классе по официальной шкале
//    (снапшот-строки не несут официальных очков — клиент шёл той же веткой);
//  • тоталы/позиции — официальные из points.json, где сматчились: экипажи по
//    (класс, номер), пилоты по ключу «инициал|фамилия» с выбросом коллизий;
//    несматченное остаётся расчётным (позиции могут дублироваться — как у
//    клиента после applyingOfficial);
//  • идентичность: экипаж = (класс, номер машины) на весь сезон, пилот =
//    (класс, имя как напечатано); пилот получает очки машины целиком; пилот в
//    двух машинах класса за раунд — очки суммируются (клиентский add()).
// Сверх клиента — только то, что клиент не мог: реальные wins/podiums из
// финишей в классе (вместо прокси «макс очков этапа» в StandingsColumnsBuilder)
// и completeThroughRound (замена клиентскому гейту hasMidSeasonGap).

import { readFileSync } from "node:fs";
import { writeJSONWithEnvelope } from "./mirror.js";
import type { Driver, OfficialPoints, PointsEntry, RaceClass, ResultRow, Session } from "./types.js";

// Своя версия, а не SCHEMA_VERSION из types.ts: та версионирует семейство
// снапшотов (index/событие/points/tests — один шейп парсинга Al Kamel), а
// standings — derived-вьюха с независимой эволюцией. Свяжи их — и бамп схемы
// события молча «менял» бы схему зачёта (и наоборот) без единого изменения байт.
export const STANDINGS_SCHEMA_VERSION = 1;

/// Клиентское окно «событие завершено»: IMSAEvent.completedAfter = endDate+24ч.
/// end у раунда — старт последней сессии (или полночь дня гонки у upcoming).
const COMPLETED_AFTER_MS = 24 * 3600 * 1000;

export type PointsSource = "official" | "computed";

/// Вход одного раунда расписания: end — из IndexEvent (то же поле читает
/// клиент), raceRows — строки race-классификации или null (данных нет).
export interface StandingsRound {
  round: number;
  slug: string;
  end: string | null;
  raceRows: ResultRow[] | null;
}

export interface ByRoundCell {
  round: number;
  slug: string;
  /// Очки за раунд; null — участие без очков (место вне шкалы). Раунды, где
  /// экипаж не появлялся, в byRound отсутствуют (клиент рисует дэш).
  points: number | null;
  /// Место на финише в классе (classPosition из классификации гонки).
  finish: number;
  /// true — очки раунда расчётные по шкале из места в классе. Снапшоты
  /// официальных per-race очков не несут, поэтому сегодня флаг всегда true;
  /// он здесь как честное происхождение цифры, а не как переключатель.
  computed: boolean;
}

export interface CrewEntry {
  position: number;
  carNumber: string;
  team: string;    // последняя непустая команда экипажа
  chassis: string; // последнее непустое шасси — клиент резолвит марку
  drivers: Driver[]; // уникальные по имени, в порядке появления; nationality — последняя непустая
  points: number;
  pointsSource: PointsSource;
  wins: number;    // финиши P1 в классе — реальные, не прокси
  podiums: number; // финиши P1–P3 в классе
  byRound: ByRoundCell[];
}

export interface DriverEntry {
  position: number;
  name: string;        // как напечатано в классификации: «J. Aitken»
  nationality: string; // последняя непустая из классификаций
  team: string;
  chassis: string;
  carNumbers: string[]; // все машины сезона, в порядке появления
  points: number;
  pointsSource: PointsSource;
  wins: number;    // раунды, где машина пилота выиграла класс
  podiums: number;
  byRound: ByRoundCell[];
}

export interface ClassStandings {
  raceClass: RaceClass;
  /// Зачёт экипажей (машин) — головной, как на таблоидах IMSA.
  entries: CrewEntry[];
  /// Зачёт пилотов — второй сегмент того же экрана.
  driverEntries: DriverEntry[];
  /// Тоталы полны по раунд N включительно: каждый уже завершённый раунд ≤ N
  /// дал данные. byRound с round > N — данные за дырой (клиентский
  /// hasMidSeasonGap ⇔ здесь есть byRound за пределами N). Сегодня маркер
  /// один на все классы (раунд без данных слеп для всех), но живёт в классе:
  /// контракт не придётся ломать, когда появится per-class источник.
  completeThroughRound: number;
}

export interface StandingsDoc {
  series: "imsa";
  season: number;
  /// true — сезон закрыт: каждый раунд расписания завершён и дал данные.
  /// Клиенту это «кэшируй навсегда» (сквозное правило конверта DATA-PLAN).
  frozen: boolean;
  classes: ClassStandings[];
}

/// Порядок классов в выдаче — клиентский classOrder: прототипы сверху.
const CLASS_ORDER: RaceClass[] = ["GTP", "LMP2", "GTD"];

// MARK: Шкала очков

/// Официальная шкала IMSA WeatherTech за место в классе — копия клиентской
/// points(forClassPosition:): 350/320/300/280/260, дальше −10 до минимума 10.
export function pointsForClassPosition(position: number): number {
  if (position < 1) return 0;
  const top = [350, 320, 300, 280, 260];
  if (position <= top.length) return top[position - 1];
  return Math.max(10, 260 - (position - 5) * 10);
}

// MARK: Извлечение race-классификации

/// Строки гонки уикенда — калька клиентского выбора (IMSAResultsSource):
/// ПОСЛЕДНЯЯ сессия, чьё имя содержит «race»; нет результатов или строк →
/// null («данных нет»), даже если раньше в списке была race-сессия со
/// строками — клиент ведёт себя ровно так же.
export function raceRowsOf(sessions: Session[]): ResultRow[] | null {
  const race = [...sessions].reverse().find((s) => s.name.toLowerCase().includes("race"));
  if (!race || !race.hasResults || race.rows.length === 0) return null;
  return race.rows;
}

// MARK: Матчинг официальных очков

/// «J. Aitken» / «Jack Aitken» → «j|aitken»; однословные — как есть
/// (клиентский nameKey из applyingOfficial, побайтово та же логика).
export function nameKey(name: string): string {
  const words = name.split(" ").filter((w) => w.length > 0);
  if (words.length < 2) return name.toLowerCase();
  return `${words[0].slice(0, 1).toLowerCase()}|${words[words.length - 1].toLowerCase()}`;
}

/// Официальная таблица пилотов класса → уникальные ключи; коллизию (две записи
/// с одним «инициал|фамилия») не матчим вовсе — лучше расчётное, чем чужое.
export function driverLookup(entries: PointsEntry[]): Map<string, PointsEntry> {
  const byKey = new Map<string, PointsEntry>();
  const collided = new Set<string>();
  for (const entry of entries) {
    const key = nameKey(entry.key);
    if (byKey.has(key)) collided.add(key);
    else byKey.set(key, entry);
  }
  for (const key of collided) byKey.delete(key);
  return byKey;
}

// MARK: Сборка

/// Номера машин — numeric-сравнение («7» < «10»), клиентский .numeric.
const numericCompare = (a: string, b: string): number =>
  a.localeCompare(b, "en", { numeric: true });

/// Имена — как клиентский `a.name < b.name` (по кодовым единицам, не локали).
const plainCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Cell { slug: string; points: number | null; finish: number }

interface Acc {
  team: string;
  chassis: string;
  nationality: string;
  /// crews: имена пилотов; drivers: номера машин — уникальные, в порядке
  /// появления (клиентский addUnique).
  members: string[];
  /// Информация о пилотах экипажа (nationality по имени) — только у crews.
  driverNationality: Map<string, string>;
  cells: Map<number, Cell>;
}

const newAcc = (): Acc => ({
  team: "", chassis: "", nationality: "", members: [],
  driverNationality: new Map(), cells: new Map(),
});

function update(acc: Acc, team: string, chassis: string, nationality = ""): void {
  if (team) acc.team = team;
  if (chassis) acc.chassis = chassis;
  if (nationality) acc.nationality = nationality;
}

function addUnique(acc: Acc, member: string): void {
  if (!acc.members.includes(member)) acc.members.push(member);
}

/// Очки суммируются при втором появлении в раунде (пилот в двух машинах класса)
/// — клиентский add(); финиш — лучший из появлений.
function addCell(acc: Acc, round: number, slug: string, points: number | null, finish: number): void {
  const prev = acc.cells.get(round);
  if (!prev) {
    acc.cells.set(round, { slug, points, finish });
    return;
  }
  if (points !== null) prev.points = (prev.points ?? 0) + points;
  if (finish >= 1 && (prev.finish < 1 || finish < prev.finish)) prev.finish = finish;
}

const totalOf = (acc: Acc): number =>
  [...acc.cells.values()].reduce((sum, c) => sum + (c.points ?? 0), 0);

const byRoundOf = (acc: Acc): ByRoundCell[] =>
  [...acc.cells.entries()]
    .sort(([a], [b]) => a - b)
    .map(([round, c]) => ({ round, slug: c.slug, points: c.points, finish: c.finish, computed: true }));

const winsOf = (acc: Acc): number =>
  [...acc.cells.values()].filter((c) => c.finish === 1).length;

const podiumsOf = (acc: Acc): number =>
  [...acc.cells.values()].filter((c) => c.finish >= 1 && c.finish <= 3).length;

/// Собирает standings-документ. Чистая функция: раунды расписания по
/// возрастанию round, official — распарсенный points.json (null — нет), now —
/// момент прогона (гейт клиентского completedAfter).
export function buildStandings(
  season: number,
  rounds: StandingsRound[],
  official: OfficialPoints | null,
  now: number,
): StandingsDoc {
  const asc = [...rounds].sort((a, b) => a.round - b.round);
  const due = (r: StandingsRound): boolean => {
    if (r.end === null) return false;
    const end = Date.parse(r.end);
    return Number.isFinite(end) && end + COMPLETED_AFTER_MS < now;
  };
  // Считаются ровно раунды клиентского фильтра completed: завершён + данные.
  const counted = asc.filter((r) => due(r) && r.raceRows !== null && r.raceRows.length > 0);

  // Накопители; Map держит порядок появления → детерминированные тай-брейки.
  type CrewAcc = Acc & { carNumber: string; raceClass: RaceClass };
  type DriverAcc = Acc & { name: string; raceClass: RaceClass };
  const crews = new Map<string, CrewAcc>();
  const drivers = new Map<string, DriverAcc>();

  for (const r of counted) {
    for (const row of r.raceRows!) {
      const derived = pointsForClassPosition(row.classPosition);
      const points = derived > 0 ? derived : null;

      const crewKey = `${row.raceClass}|${row.carNumber}`;
      let crew = crews.get(crewKey);
      if (!crew) {
        crew = { ...newAcc(), carNumber: row.carNumber, raceClass: row.raceClass };
        crews.set(crewKey, crew);
      }
      addCell(crew, r.round, r.slug, points, row.classPosition);
      update(crew, row.team, row.chassis);

      for (const d of row.drivers) {
        if (!d.name) continue;
        addUnique(crew, d.name);
        if (d.nationality) crew.driverNationality.set(d.name, d.nationality);

        const driverKey = `${row.raceClass}|${d.name}`;
        let driver = drivers.get(driverKey);
        if (!driver) {
          driver = { ...newAcc(), name: d.name, raceClass: row.raceClass };
          drivers.set(driverKey, driver);
        }
        // Пилот получает очки машины целиком (практика IMSA).
        addCell(driver, r.round, r.slug, points, row.classPosition);
        update(driver, row.team, row.chassis, d.nationality);
        addUnique(driver, row.carNumber);
      }
    }
  }

  // Официальный оверлей — клиентский applyingOfficial: несматченные записи
  // остаются расчётными (позиции при этом могут дублироваться — как у клиента).
  interface CrewDraft { acc: CrewAcc; position: number; points: number; source: PointsSource }
  interface DriverDraft { acc: DriverAcc; position: number; points: number; source: PointsSource }
  const crewDrafts = new Map<RaceClass, CrewDraft[]>();
  const driverDrafts = new Map<RaceClass, DriverDraft[]>();

  for (const cls of CLASS_ORDER) {
    // Расчётные позиции: очки по убыванию; тай-брейк — номер numeric / имя.
    const clsCrews = [...crews.values()]
      .filter((c) => c.raceClass === cls)
      .sort((a, b) => totalOf(b) - totalOf(a) || numericCompare(a.carNumber, b.carNumber));
    crewDrafts.set(cls, clsCrews.map((acc, i) => ({
      acc, position: i + 1, points: totalOf(acc), source: "computed" as PointsSource,
    })));

    const clsDrivers = [...drivers.values()]
      .filter((d) => d.raceClass === cls)
      .sort((a, b) => totalOf(b) - totalOf(a) || plainCompare(a.name, b.name));
    driverDrafts.set(cls, clsDrivers.map((acc, i) => ({
      acc, position: i + 1, points: totalOf(acc), source: "computed" as PointsSource,
    })));
  }

  // Клиентский guard overrodeAny (official отброшен целиком, если не
  // сматчилось ничего) здесь эквивалентен отсутствию действий: несматченные
  // драфты и так расчётные, отдельная ветка не нужна.
  if (official) {
    for (const cls of CLASS_ORDER) {
      const teamTable = official.teams[cls] ?? [];
      for (const draft of crewDrafts.get(cls)!) {
        const entry = teamTable.find((e) => e.key === draft.acc.carNumber);
        if (!entry) continue;
        draft.points = entry.points;
        draft.position = entry.position;
        draft.source = "official";
      }
      const lookup = driverLookup(official.drivers[cls] ?? []);
      for (const draft of driverDrafts.get(cls)!) {
        const entry = lookup.get(nameKey(draft.acc.name));
        if (!entry) continue;
        draft.points = entry.points;
        draft.position = entry.position;
        draft.source = "official";
      }
    }
  }

  // completeThroughRound: идём по расписанию, пока раунды дают данные;
  // будущий/live-раунд останавливает (дальше только будущее), завершённый без
  // данных — дыра (клиентский gap). Данные за дырой в тоталы всё равно входят
  // — как у клиента; неполноту сигналит сам маркер (< последнего byRound).
  let completeThrough = 0;
  for (const r of asc) {
    if (!due(r)) break;
    if (r.raceRows === null || r.raceRows.length === 0) break;
    completeThrough = r.round;
  }

  const classes: ClassStandings[] = CLASS_ORDER.map((cls) => ({
    raceClass: cls,
    entries: crewDrafts.get(cls)!
      .sort((a, b) => a.position - b.position || numericCompare(a.acc.carNumber, b.acc.carNumber))
      .map((d) => ({
        position: d.position,
        carNumber: d.acc.carNumber,
        team: d.acc.team,
        chassis: d.acc.chassis,
        drivers: d.acc.members.map((name) => ({
          name, nationality: d.acc.driverNationality.get(name) ?? "",
        })),
        points: d.points,
        pointsSource: d.source,
        wins: winsOf(d.acc),
        podiums: podiumsOf(d.acc),
        byRound: byRoundOf(d.acc),
      })),
    driverEntries: driverDrafts.get(cls)!
      .sort((a, b) => a.position - b.position || plainCompare(a.acc.name, b.acc.name))
      .map((d) => ({
        position: d.position,
        name: d.acc.name,
        nationality: d.acc.nationality,
        team: d.acc.team,
        chassis: d.acc.chassis,
        carNumbers: d.acc.members,
        points: d.points,
        pointsSource: d.source,
        wins: winsOf(d.acc),
        podiums: podiumsOf(d.acc),
        byRound: byRoundOf(d.acc),
      })),
    completeThroughRound: completeThrough,
  }));

  // frozen: каждый раунд расписания завершён и дал данные — сезон закрыт,
  // клиент может кэшировать навсегда.
  const frozen = asc.length > 0 && asc.every((r) => due(r) && r.raceRows !== null && r.raceRows.length > 0);

  return { series: "imsa", season, frozen, classes };
}

// MARK: Предохранитель записи (fail-closed)

/// Сколько раундов дало данные в документе (по byRound всех записей).
function countedRounds(doc: Pick<StandingsDoc, "classes">): number {
  const rounds = new Set<number>();
  for (const cls of doc.classes ?? []) {
    for (const list of [cls.entries ?? [], cls.driverEntries ?? []]) {
      for (const e of list) for (const c of e.byRound ?? []) rounds.add(c.round);
    }
  }
  return rounds.size;
}

/// Сколько записей несут официальные тоталы.
function officialCount(doc: Pick<StandingsDoc, "classes">): number {
  let n = 0;
  for (const cls of doc.classes ?? []) {
    for (const list of [cls.entries ?? [], cls.driverEntries ?? []]) {
      for (const e of list) if (e.pointsSource === "official") n++;
    }
  }
  return n;
}

/// null — писать можно; строка — причина, по которой прежний файл лучше нового.
/// Деградации ловим две: пропали файлы раундов (byRound-покрытие сжалось) и
/// пропал points.json (official-тоталы схлопнулись в computed при том же
/// покрытии). Чистая функция — предохранитель проверяется тестами напрямую.
export function standingsRegression(
  prev: Pick<StandingsDoc, "classes"> | null,
  next: Pick<StandingsDoc, "classes">,
): string | null {
  if (!prev) return null;
  const prevRounds = countedRounds(prev);
  const nextRounds = countedRounds(next);
  if (nextRounds < prevRounds)
    return `раундов с данными стало меньше (${prevRounds} → ${nextRounds})`;
  const prevOfficial = officialCount(prev);
  if (prevOfficial > 0 && officialCount(next) === 0)
    return `официальные тоталы пропали (${prevOfficial} записей → 0)`;
  return null;
}

/// Запись с предохранителем. Выбор конструкции — целиковый keep прежнего файла
/// (а не пофрагментный carryStale, как в f1teams): зачёт — одна связная вьюха,
/// перенос кусков смешал бы раунды разных прогонов; и вход здесь локальный
/// (файлы на диске, которые этот же прогон и держит), а не сеть — деградация
/// значит «файлы исчезли/побились», и правильный ответ — не трогать хорошее.
/// skipFirstWrite не подходит: первый прогон сезона обязан создать файл.
export function writeStandings(path: string, next: StandingsDoc): "written" | "unchanged" | "kept-previous" {
  let prev: StandingsDoc | null = null;
  try {
    prev = JSON.parse(readFileSync(path, "utf8")) as StandingsDoc;
  } catch {
    /* файла нет или он битый — прежнего хорошего состояния нет, пишем */
  }
  const regression = standingsRegression(prev, next);
  if (regression) {
    console.warn(`::warning::imsa standings: ${regression} — прежний standings.json не тронут`);
    return "kept-previous";
  }
  const payload = { series: next.series, season: next.season, frozen: next.frozen, classes: next.classes };
  return writeJSONWithEnvelope(path, payload, STANDINGS_SCHEMA_VERSION) ? "written" : "unchanged";
}
