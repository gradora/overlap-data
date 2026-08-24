// Продьюсер экрана команды (макет «team page final» 1424:95036). Собирает то,
// чего нет ни в одном зачёте: разбивку сезона на Гран-при и спринты, форму
// пилотов по этапам, домашнюю трассу и всевременные итоги.
//
// Почему не из зачёта: constructorStandings знает только место и сумму очков.
// Поулы, подиумы, быстрые круги и спринтовая часть считаются построчно из
// результатов сезона — по одному запросу на выборку, а не на гонку.
//
// Ловушки Jolpica, на которые уже наступали:
//  • qualifying/1 отдаёт МУСОР — у Феррари-2026 приезжают позиции 4, 4, 4, 2.
//    Поулы считаем фильтром position === "1" по полной выборке квалификаций.
//  • история команды разрезана по constructorId (mclaren / mclaren-ford):
//    всевременные победы суммируем по всем историческим id, как в f1records.
//  • титулов одним запросом не отдают (constructorStandings/1 требует season).
//    Берём чемпиона каждого сезона по одному запросу на год и кэшируем
//    НАВСЕГДА: прошлый чемпион не меняется, за год добавляется одна строка.
//  • 429 прилетает КАЖДЫЙ прогон: любая страница выборки может не ответить.
//    Поэтому прогон ДОПОЛНЯЕТ прежний файл, а не перезаписывает его тем, что
//    наскрёб, — см. блок «Дополнение прежнего файла» ниже.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mirrorSlug, writeIfChanged, writeJSONWithEnvelope } from "../lib/mirror.js";
import { scheduleSeasonMismatch } from "../lib/season.js";
import { fetchJSON as httpJSON } from "../lib/http.js";
import { JOLPICA } from "../lib/sources.js";
import { groupById } from "./f1records.js";

const fetchJSON = (url: string) => httpJSON(url, { backoffMs: 8000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const DATA = join(process.cwd(), "data", "f1");
const TEAMS_DIR = join(DATA, "teams");
const OUT = join(TEAMS_DIR, `${YEAR}.json`);
const STATE = join(TEAMS_DIR, `_state_${YEAR}.json`);
const JOLPICA_DIR = join(DATA, "jolpica");

/// Первый сезон чемпионата конструкторов — раньше титулов не существовало.
const FIRST_CONSTRUCTOR_SEASON = 1958;
const STATE_VERSION = 1;

// ── Форма выдачи ────────────────────────────────────────────────────────────

export interface TeamTally {
  starts: number;      // выходов на старт (машино-стартов)
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  points: number;
}

/// Результат пилота на этапе для полоски формы. `position` — nil у сходов;
/// `status` оставляем как есть («Finished», «Accident», «+1 Lap»).
export interface FormResult {
  round: number;
  race: string;
  position: number | null;
  status: string;
}

export interface TeamDriverForm {
  driverId: string;
  code: string;
  number: string | null;
  name: string;        // «C. Leclerc»
  results: FormResult[];
  /// Победы в спринтах и число квалификаций, выигранных у напарника, — строки
  /// расширенной карточки дуэли. Считаются из тех же выборок, что и всё
  /// остальное, своих запросов не стоят.
  sprintWins: number;
  qualiWins: number;
}

/// Лучшее достижение пилота за сезон — строка карточек камбэка и пит-стопа.
export interface TeamBeast {
  driverId: string;
  code: string;
  name: string;
  value: string;      // «P19 → P7» | «2.006»
  detail?: string;    // «12» — прирост позиций (только камбэк)
  event: string;      // «Silverstone Grand Prix»
}

export interface TeamPage {
  constructorId: string;
  name: string;
  base?: { country: string; city: string };
  /// Место и очки в зачёте конструкторов; null — зачёт ещё не открыт.
  position: number | null;
  points: number;
  gp: TeamTally;
  sprint: TeamTally;
  form: TeamDriverForm[];
  /// Домашняя трасса и всевременные итоги команды НА НЕЙ.
  home?: { circuitId: string; name: string; wins: number; poles: number };
  /// Другие серии бренда: наши (wec, imsa) и внешние (formulae, indycar).
  alsoIn: string[];
  /// Первый сезон команды в чемпионате — подпись «From 1950» в рекордах.
  firstSeason: number | null;
  allTime: { wins: number; titles: number };
  /// Рекорды нынешних пилотов В ЭТОЙ команде — вторая половина блока RECORDS.
  driverRecords: { driverId: string; name: string; wins: number }[];
  /// Лучший камбэк и лучший пит каждого пилота — карточки секции дуэли.
  comebacks: TeamBeast[];
  pits: TeamBeast[];
}

/// Раунд календаря с трёхбуквенным кодом — подпись пустой ячейки полоски
/// формы («ABU», «QAT»). Своего кода Jolpica не отдаёт, ведём картой.
export interface SeasonRound {
  round: number;
  code: string;
  race: string;
}

export interface SeasonTeams {
  season: number;
  rounds: SeasonRound[];
  teams: TeamPage[];
}

/// Коды этапов — по конвенции самой Формулы-1 (венесуэльский «ABU» — город,
/// «QAT» — страна). Незнакомая трасса деградирует в первые три буквы слага.
const ROUND_CODES: Record<string, string> = {
  albert_park: "AUS", shanghai: "CHN", suzuka: "JPN", miami: "MIA",
  villeneuve: "CAN", monaco: "MON", catalunya: "ESP", red_bull_ring: "AUT",
  silverstone: "GBR", spa: "BEL", hungaroring: "HUN", zandvoort: "NED",
  monza: "ITA", madring: "MAD", baku: "AZE", sepang: "MAL", marina_bay: "SIN",
  americas: "USA", rodriguez: "MEX", interlagos: "SAO", vegas: "LVG",
  losail: "QAT", yas_marina: "ABU", imola: "EMI", jeddah: "SAU", bahrain: "BHR",
  ricard: "FRA", portimao: "POR", istanbul: "TUR", nurburgring: "NUR",
  mugello: "MUG", sochi: "RUS",
};

const roundCode = (circuitId: string): string =>
  ROUND_CODES[circuitId] ?? circuitId.replace(/[^a-z]/g, "").slice(0, 3).toUpperCase();

const emptyTally = (): TeamTally =>
  ({ starts: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, points: 0 });

// ── Чистый разбор ───────────────────────────────────────────────────────────

/// Свод по строкам результатов (гонки или спринты). Строка = одна машина на
/// одном этапе, поэтому starts считает машино-старты: у двухмашинной команды
/// за уик-энд их два — так же, как очки начисляются обеим машинам.
export function tallyResults(races: any[], key: "Results" | "SprintResults"): TeamTally {
  const out = emptyTally();
  for (const race of races) {
    for (const row of race?.[key] ?? []) {
      const pos = Number(row?.position);
      out.starts += 1;
      out.points += Number(row?.points ?? 0);
      if (pos === 1) out.wins += 1;
      if (pos >= 1 && pos <= 3) out.podiums += 1;
      if (row?.FastestLap?.rank === "1") out.fastestLaps += 1;
      // Поул спринта отдельной выборкой не отдают: старт с первой позиции в
      // спринте и есть результат спринт-квалификации.
      if (key === "SprintResults" && Number(row?.grid) === 1) out.poles += 1;
    }
  }
  return out;
}

/// Поулы сезона: qualifying/1 у Jolpica подмешивает чужие строки, поэтому
/// берём полную выборку квалификаций и считаем настоящие первые места.
export function countPoles(races: any[]): number {
  let n = 0;
  for (const race of races) {
    for (const row of race?.QualifyingResults ?? []) {
      if (row?.position === "1") n += 1;
    }
  }
  return n;
}

/// Полоска формы: по пилоту — его результат на каждом этапе в порядке раундов.
export function buildForm(races: any[]): TeamDriverForm[] {
  const byDriver = new Map<string, TeamDriverForm>();
  for (const race of races) {
    for (const row of race?.Results ?? []) {
      const d = row?.Driver;
      if (!d?.driverId) continue;
      if (!byDriver.has(d.driverId)) {
        byDriver.set(d.driverId, {
          driverId: d.driverId,
          code: d.code ?? String(d.familyName ?? "").slice(0, 3).toUpperCase(),
          number: d.permanentNumber ?? null,
          name: `${String(d.givenName ?? "").slice(0, 1)}. ${d.familyName ?? ""}`.trim(),
          results: [],
          sprintWins: 0,
          qualiWins: 0,
        });
      }
      const pos = Number(row?.position);
      byDriver.get(d.driverId)!.results.push({
        round: Number(race.round),
        race: String(race.raceName ?? ""),
        position: Number.isFinite(pos) && pos > 0 ? pos : null,
        status: String(row?.status ?? ""),
      });
    }
  }
  for (const form of byDriver.values()) form.results.sort((a, b) => a.round - b.round);
  // Порядок пилотов — по числу этапов: основной состав раньше подменных.
  return [...byDriver.values()].sort((a, b) => b.results.length - a.results.length);
}

/// Победы в спринтах — по тем же строкам, что и свод спринтов.
export function applySprintWins(form: TeamDriverForm[], sprints: any[]): void {
  const byId = new Map(form.map((f) => [f.driverId, f]));
  for (const race of sprints) {
    for (const row of race?.SprintResults ?? []) {
      if (Number(row?.position) === 1) {
        const f = byId.get(row?.Driver?.driverId);
        if (f) f.sprintWins += 1;
      }
    }
  }
}

/// Квали-дуэль: на каждом этапе сравниваем позиции напарников и засчитываем
/// победу тому, кто впереди. Этапы, где выехал только один, не считаем — это
/// не дуэль, а отсутствие соперника.
export function applyQualiDuel(form: TeamDriverForm[], quali: any[]): void {
  const byId = new Map(form.map((f) => [f.driverId, f]));
  for (const race of quali) {
    const rows = (race?.QualifyingResults ?? [])
      .map((r: any) => ({ id: r?.Driver?.driverId, pos: Number(r?.position) }))
      .filter((r: any) => r.id && Number.isFinite(r.pos));
    if (rows.length < 2) continue;
    const best = rows.reduce((a: any, b: any) => (b.pos < a.pos ? b : a));
    const f = byId.get(best.id);
    if (f) f.qualiWins += 1;
  }
}

/// Раунды, на которых пилот ехал ИМЕННО ЗА ЭТУ команду. Полоска формы собрана
/// из выборки команды, чужих этапов в ней нет, — значит её раунды и есть
/// принадлежность пилота команде по этапам. Нужно всему, что ходит за пределы
/// выборки (питы из OpenF1), и как страховка тому, что внутри неё.
export function roundsByDriver(form: TeamDriverForm[]): Map<string, Set<number>> {
  return new Map(form.map((f) => [f.driverId, new Set(f.results.map((r) => r.round))]));
}

/// Финишные статусы Jolpica: доехал сам либо в круге позади. Всё остальное
/// («Retired», «Accident», «Disqualified», «Did not start», …) — не финиш.
/// Белый список, а не чёрный: причин схода десятки и новые появляются, а
/// способов доехать ровно два.
const FINISH_STATUS = /^(finished|lapped|\+\d+\s+laps?)$/i;

/// Классифицирован ли автомобиль в протоколе. Две проверки, потому что два
/// разных факта:
///  • `positionText` нечисловой («R», «D», «W», «E», «N», «F») — машина вне
///    классификации. Смотреть на `position` бесполезно: он есть ВСЕГДА, это
///    порядок в протоколе, и сошедший получает номер следом за финишировавшими
///    (R12 2026: Боттас grid 21 → position 18 при positionText «R»).
///  • статус — финишный. Сход, накрутивший 90% дистанции, попадает в
///    классификацию с НОМЕРОМ (positionText «17») и статусом «Retired»: в
///    протоколе он есть, но машина стоит, камбэком это не считается.
export function isClassifiedFinish(row: any): boolean {
  if (!/^\d+$/.test(String(row?.positionText ?? ""))) return false;
  return FINISH_STATUS.test(String(row?.status ?? "").trim());
}

/// Лучший камбэк каждого пилота: максимальный прирост позиций старт→финиш.
/// Считается из тех же результатов сезона — стартовая позиция там есть.
export function buildComebacks(form: TeamDriverForm[], races: any[]): TeamBeast[] {
  const own = roundsByDriver(form);
  const best = new Map<string, TeamBeast & { gain: number }>();
  for (const race of races) {
    const round = Number(race?.round);
    for (const row of race?.Results ?? []) {
      const id = row?.Driver?.driverId;
      const grid = Number(row?.grid);
      const pos = Number(row?.position);
      // Старт с пит-лейна (grid 0) прирост не считает.
      if (!id || !Number.isFinite(grid) || !Number.isFinite(pos) || grid <= 0 || pos <= 0) continue;
      // Не доехал — не камбэк, каким бы номером его ни поставили в протокол.
      if (!isClassifiedFinish(row)) continue;
      // Тот же барьер, что у питов: этап чужой команды в карточку не идёт.
      // Выборка `${YEAR}/constructors/<id>/results` чужих строк не отдаёт,
      // так что здесь это страховка — но она стоит одной проверки и ловит
      // подмешанную строку молча, а не через ложный факт на экране.
      if (!own.get(id)?.has(round)) continue;
      const gain = grid - pos;
      if (gain <= 0) continue;
      const prev = best.get(id);
      if (prev && prev.gain >= gain) continue;
      const f = form.find((x) => x.driverId === id);
      best.set(id, {
        driverId: id, code: f?.code ?? "", name: f?.name ?? "",
        value: `P${grid} → P${pos}`, detail: `${gain}`,
        event: String(race?.raceName ?? ""), gain,
      });
    }
  }
  return form.map((f) => best.get(f.driverId)).filter((x): x is TeamBeast & { gain: number } => !!x)
    .map(({ gain: _gain, ...rest }) => rest);
}

/// Лучший пит-стоп КАЖДОГО пилота. highlights хранят только самый быстрый пит
/// этапа — одну строку на гонку, поэтому команда, чей пилот ни разу не был
/// лучшим, оставалась без карточки. Берём исходник: зеркало OpenF1 держит все
/// питы гонки со `stop_duration` — стационарным временем, той же метрикой, что
/// показывают highlights (у Jolpica в `pitstops` лежит полное время в
/// пит-лейне, 18–27 секунд, — это про другое).
///
/// null — зеркало OpenF1 недоступно: это «не знаем», а не «питов нет», и
/// вызывающий переносит карточки из прежнего файла.
export function buildPits(
  form: TeamDriverForm[], rounds: SeasonRound[], year: number,
  raceDates: Map<number, string>,
  read: (relative: string) => any | null = readOpenF1,
): TeamBeast[] | null {
  const meetings = read(`meetings?year=${year}`);
  if (!Array.isArray(meetings)) return null;
  const byNumber = new Map(form.filter((f) => f.number).map((f) => [Number(f.number), f]));
  if (!byNumber.size) return [];
  // Номер машины переезжает вместе с пилотом: у сменившего команду по ходу
  // сезона (Лоусон 2026: rb → red_bull) один и тот же номер стоит в форме
  // ОБЕИХ команд. Без этой карты пит с этапа прежней команды попадал в
  // карточки и той, и другой — ложный факт на экране.
  const own = roundsByDriver(form);
  const best = new Map<string, TeamBeast & { seconds: number }>();

  for (const r of rounds) {
    const date = raceDates.get(r.round);
    if (!date) continue;
    const meeting = matchMeeting(meetings, date);
    if (!meeting) continue;
    const sessions = read(`sessions?meeting_key=${meeting.meeting_key}`);
    if (!Array.isArray(sessions)) continue;
    for (const session of sessions) {
      // Только гоночные сессии: в свободных заездах пит-стоп ничего не значит.
      if (!/race|sprint/i.test(String(session.session_name ?? ""))) continue;
      const pits = read(`pit?session_key=${session.session_key}`);
      if (!Array.isArray(pits)) continue;
      for (const row of pits) {
        const seconds = row?.stop_duration;
        if (typeof seconds !== "number" || seconds <= 0) continue;
        const f = byNumber.get(Number(row?.driver_number));
        if (!f) continue;
        if (!own.get(f.driverId)?.has(r.round)) continue;
        const prev = best.get(f.driverId);
        if (prev && prev.seconds <= seconds) continue;
        best.set(f.driverId, {
          driverId: f.driverId, code: f.code, name: f.name,
          value: seconds.toFixed(3), event: r.race, seconds,
        });
      }
    }
  }
  return form.map((f) => best.get(f.driverId)).filter((x): x is TeamBeast & { seconds: number } => !!x)
    .map(({ seconds: _s, ...rest }) => rest);
}

/// Зеркало OpenF1 лежит по слагу запроса — тем же, что пишет продьюсер openf1.
function readOpenF1(relative: string): any | null {
  try {
    return JSON.parse(readFileSync(join(DATA, "openf1", mirrorSlug(relative)), "utf8"));
  } catch {
    return null;
  }
}

/// Митинг OpenF1, накрывающий день гонки (та же логика, что в highlights).
function matchMeeting(meetings: any[], raceDate: string): any | undefined {
  const dayStart = Date.parse(`${raceDate}T00:00:00Z`);
  const dayEnd = dayStart + 86_400_000;
  return meetings.find((m) => {
    const s = Date.parse(m.date_start);
    if (Number.isNaN(s)) return String(m.date_start ?? "").startsWith(raceDate);
    const e = Date.parse(m.date_end ?? m.date_start);
    return s < dayEnd && (Number.isNaN(e) ? s : e) > dayStart;
  });
}

// ── Дополнение прежнего файла ───────────────────────────────────────────────
//
// Прогон ДОПОЛНЯЕТ data/f1/teams/<season>.json, а не перезаписывает его тем,
// что наскрёб. Причина — тот же класс отказа, из-за которого файл штрафов
// накапливается (mergeFiaEvent): Jolpica отдаёт 429 на любой странице
// выборки, allRaces возвращает null, и `?? []` превращал отказ в ПУСТЫЕ
// данные — свод Гран-при обнулялся, полоска формы пустела, камбэки, питы и
// рекорды пилотов исчезали. Ноль уходил в файл и коммитился: шаг зелёный
// (исключения не было), health success, алерт-гейт молчит — пустая выборка
// неотличима от «команда ещё не выступала». В приложении пустая форма убирает
// блок «On graph» целиком. До подключения к крону экспозиция была нулевой,
// теперь это ~20–25 шансов в сутки.
//
// Правило: у каждого поля карточки ОДИН источник. Источник не ответил — поле
// берём из прежнего файла и пишем об этом в лог (::warning::, видно в логе
// шага). Взять неоткуда — файла ещё нет или команда в нём новая — файл не
// переписываем ВОВСЕ: неполный первый сбор хуже отсутствия файла. Приложение
// переживает 404 (экран просто не откроется), но обнулённую команду показывает
// как факт: «0 побед, формы нет». Команду из выдачи при этом НЕ выкидываем —
// пропавшая команда стоила бы экрану целой секции.
//
// Отказ приходит не только кодом ответа. Jolpica отдаёт и ПУСТОЙ 200
// (`Races: []`) — для allRaces это успех, а по последствиям ровно то же
// обнуление: rb теряет 24 старта и 62 очка, mercedes — 10 поулов и всю
// квали-дуэль. Отличить отказ от факта можно только по прежнему файлу:
// непустое значение там + пустая выборка сейчас = регресс источника (команда
// не может «разъехаться» до нуля стартов), и поле переносим. Обратное —
// команда НОВАЯ (её нет в прежнем файле) или начало сезона (прежнее тоже
// пусто) — законная пустая выборка: ноль там честен и остаётся нулём.
//
// Единственное, чем первый сбор блокировать нельзя, — поля с честным «не
// знаем» в самой схеме: `position: number | null` и `points: 0` читаются как
// «зачёт ещё не открыт». В январе на переходе сезона зеркала зачёта нет ни у
// кого, и требовать для него прежнее значение — значит не создать файл вовсе.

/// Части карточки, которые за прогон собрать НЕ удалось. Флаг = свой источник.
export interface StaleParts {
  /// Зеркало зачёта конструкторов — место и очки.
  standings?: boolean;
  /// teams/catalog.json — база, домашняя трасса, другие серии бренда.
  facts?: boolean;
  /// `<год>/constructors/<id>/results` — весь сезонный блок карточки.
  results?: boolean;
  /// `<год>/constructors/<id>/sprint` — свод спринтов и победы в спринтах.
  sprints?: boolean;
  /// `<год>/constructors/<id>/qualifying` — поулы и квали-дуэль.
  quali?: boolean;
  /// Зеркало OpenF1 (или расписание, без которого не найти митинги) — питы.
  pits?: boolean;
  /// Всевременные победы: и сами счётчики, и список исторических id.
  allTime?: boolean;
  /// Чемпион какого-то из прошлых сезонов не вытянулся — титулы недосчитаны.
  titles?: boolean;
  /// Победы и поулы на домашней трассе.
  home?: boolean;
  /// Первый сезон команды в чемпионате.
  firstSeason?: boolean;
  /// Победы нынешних пилотов в этой команде.
  driverWins?: boolean;
}

export interface CarriedPage {
  page: TeamPage;
  /// Что взято из прежнего файла — уходит в лог прогона.
  carried: string[];
  /// Чего взять неоткуда. Непустой список = писать файл нельзя.
  missing: string[];
}

/// Счётчик дуэли из прежней карточки по driverId. Новых пилотов в прежнем
/// файле нет — у них остаётся свежий ноль (это не потеря: они и не ездили).
function withCounter(
  form: TeamDriverForm[], prev: TeamDriverForm[], key: "sprintWins" | "qualiWins",
): TeamDriverForm[] {
  const byId = new Map(prev.map((f) => [f.driverId, f]));
  return form.map((f) => {
    const p = byId.get(f.driverId);
    return p ? { ...f, [key]: p[key] } : f;
  });
}

/// Сезонные выборки прогона: null — отказ (allRaces не увидел массива).
export interface Selections {
  results: any[] | null;
  sprints: any[] | null;
  quali: any[] | null;
}

/// Пустые выборки, пустыми быть НЕ имеющие права. Пустой 200 (`Races: []`) для
/// allRaces — успех, а по последствиям ровно отказ: свод обнуляется, форма
/// пустеет, поулы и квали-дуэль уходят в ноль. Отличить отказ от факта можно
/// только по прежнему файлу, и это работает, потому что сезонные счётчики
/// МОНОТОННЫ: стартов, поулов и побед в дуэли за сезон не убывает. Было
/// непусто, стало пусто — регресс источника. Прежнего непустого нет (команда
/// НОВАЯ либо сезон только начался) — пустая выборка законна, ноль честен.
/// Каждая выборка судится по СВОЕМУ следу в карточке: у результатов это форма,
/// у спринтов — машино-старты спринтов, у квалификаций — поулы или дуэль
/// (команда без поулов их и не имела, но дуэль есть у всех, кто ездил).
export function emptiedSelections(
  fresh: Selections, prev: TeamPage | undefined,
): { results: boolean; sprints: boolean; quali: boolean; labels: string[] } {
  const labels: string[] = [];
  const gone = (selection: any[] | null, hadBefore: boolean, what: string): boolean => {
    if (selection == null || selection.length > 0 || !hadBefore) return false;
    labels.push(what);
    return true;
  };
  return {
    results: gone(fresh.results, !!prev?.form.length, "результаты"),
    sprints: gone(fresh.sprints, !!prev && prev.sprint.starts > 0, "спринты"),
    quali: gone(
      fresh.quali,
      !!prev && (prev.gp.poles > 0 || prev.form.some((f) => f.qualiWins > 0)),
      "квалификации",
    ),
    labels,
  };
}

/// Свежая карточка + прежняя = карточка, в которой не собранное заменено
/// прежними значениями. Чистая функция: ни сети, ни файлов.
export function carryStale(
  fresh: TeamPage, prev: TeamPage | undefined, stale: StaleParts,
): CarriedPage {
  const page: TeamPage = {
    ...fresh, gp: { ...fresh.gp }, sprint: { ...fresh.sprint }, allTime: { ...fresh.allTime },
  };
  const carried: string[] = [];
  const missing: string[] = [];
  /// Обязательный перенос: прежнего значения нет — поле уходит в `missing` и
  /// файл не пишется. Так закрыто всё, чьё пустое значение НЕ отличить от
  /// факта на экране: «0 побед», «0 стартов», пустая форма.
  const take = (what: string, from: (p: TeamPage) => boolean) => {
    if (prev && from(prev)) carried.push(what);
    else missing.push(what);
  };
  /// Необязательный перенос: у поля есть честное «не знаем» прямо в схеме, и
  /// первый сбор им блокировать нельзя. Пока есть прежнее значение — берём
  /// его (оно точнее), нет — оставляем свежее «не знаем».
  const takeOptional = (what: string, from: (p: TeamPage) => boolean) => {
    if (prev && from(prev)) carried.push(what);
  };

  if (stale.standings) {
    // `position: null` + `points: 0` — задокументированное «зачёт ещё не
    // открыт», а не ложный факт. Единственное поле карточки с таким свойством,
    // поэтому единственное, которое не блокирует первый сбор: иначе в начале
    // сезона (зеркала зачёта ещё нет ни у одной команды) файл не создался бы
    // вовсе — и экран команды не открылся бы весь январь.
    takeOptional("место и очки", (p) => { page.position = p.position; page.points = p.points; return true; });
  }
  if (stale.facts) {
    take("факты каталога", (p) => {
      page.base = p.base;
      page.alsoIn = p.alsoIn;
      page.home = p.home ? { ...p.home } : undefined;
      return true;
    });
  }

  if (stale.results) {
    // Выборка результатов — источник ВСЕГО сезонного блока, поэтому он
    // переносится целиком, даже если спринты и квалификации ответили. Свежий
    // свод спринтов рядом с прошлогодней формой читается как поломка данных;
    // цена самосогласованности — один прогон отставания у пары чисел.
    take("сезонный блок (свод, форма, камбэки, питы, рекорды пилотов)", (p) => {
      if (!p.form.length) return false;
      page.gp = { ...p.gp };
      page.sprint = { ...p.sprint };
      page.form = p.form;
      page.comebacks = p.comebacks;
      page.pits = p.pits;
      page.driverRecords = p.driverRecords;
      return true;
    });
  } else {
    if (stale.sprints) {
      take("свод спринтов", (p) => {
        page.sprint = { ...p.sprint };
        page.form = withCounter(page.form, p.form, "sprintWins");
        return true;
      });
    }
    if (stale.quali) {
      take("поулы и квали-дуэль", (p) => {
        page.gp.poles = p.gp.poles;
        page.form = withCounter(page.form, p.form, "qualiWins");
        return true;
      });
    }
    if (stale.pits) {
      take("питы", (p) => { page.pits = p.pits; return true; });
    }
    if (stale.driverWins) {
      take("рекорды пилотов", (p) => {
        const byId = new Map(p.driverRecords.map((d) => [d.driverId, d.wins]));
        if (!page.driverRecords.every((d) => byId.has(d.driverId))) return false;
        page.driverRecords = page.driverRecords.map((d) => ({ ...d, wins: byId.get(d.driverId)! }));
        return true;
      });
    }
  }

  if (stale.allTime) {
    take("всевременные победы", (p) => { page.allTime.wins = p.allTime.wins; return true; });
  }
  if (stale.titles) {
    take("титулы", (p) => { page.allTime.titles = p.allTime.titles; return true; });
  }
  // При отказе каталога домашняя трасса уже перенесена целиком (вместе с
  // circuitId), отдельного переноса цифр не нужно.
  if (stale.home && !stale.facts) {
    take("статистика домашней трассы", (p) => {
      if (!page.home || p.home?.circuitId !== page.home.circuitId) return false;
      page.home = { ...page.home, wins: p.home.wins, poles: p.home.poles };
      return true;
    });
  }
  if (stale.firstSeason) {
    take("первый сезон", (p) => { page.firstSeason = p.firstSeason; return true; });
  }
  return { page, carried, missing };
}

/// Итог прогона. `file === null` — оставить на диске то, что есть (в том числе
/// НЕ создавать файл на первом сборе): хоть у одной команды поле закрыть
/// нечем, а публиковать нули нельзя.
export function assembleSeason(
  season: number, rounds: SeasonRound[], pages: CarriedPage[],
): { file: SeasonTeams | null; blocked: string[]; carried: string[] } {
  const blocked: string[] = [];
  const carried: string[] = [];
  for (const p of pages) {
    if (p.missing.length) blocked.push(`${p.page.constructorId}: ${p.missing.join(", ")}`);
    else if (p.carried.length) carried.push(`${p.page.constructorId}: ${p.carried.join(", ")}`);
  }
  if (!pages.length || blocked.length) return { file: null, blocked, carried };
  return { file: { season, rounds, teams: pages.map((p) => p.page) }, blocked, carried };
}

/// Прежний снапшот: карточки по constructorId и полоска раундов. `exists`
/// разводит «файла нет» (первый сбор) и «файл есть, но команда в нём новая».
function loadPrevious(): { exists: boolean; rounds: SeasonRound[]; teams: Map<string, TeamPage> } {
  try {
    const raw = JSON.parse(readFileSync(OUT, "utf8"));
    const list: TeamPage[] = Array.isArray(raw?.teams) ? raw.teams : [];
    return {
      exists: true,
      rounds: Array.isArray(raw?.rounds) ? raw.rounds : [],
      teams: new Map(list.map((t) => [String(t.constructorId), t])),
    };
  } catch {
    return { exists: false, rounds: [], teams: new Map() };
  }
}

// ── Сеть ────────────────────────────────────────────────────────────────────

/// Все страницы выборки (у команды за сезон это одна-две сотни строк).
async function allRaces(path: string): Promise<any[] | null> {
  const out: any[] = [];
  for (let offset = 0; ; offset += 100) {
    const d = await fetchJSON(`${JOLPICA}/${path}.json?limit=100&offset=${offset}`);
    const races = d?.MRData?.RaceTable?.Races;
    if (!Array.isArray(races)) return null;
    out.push(...races);
    if (offset + 100 >= Number(d?.MRData?.total ?? 0)) return out;
    await sleep(400);
  }
}

async function total(path: string): Promise<number | null> {
  const d = await fetchJSON(`${JOLPICA}/${path}.json?limit=1`);
  const n = Number(d?.MRData?.total);
  return Number.isFinite(n) ? n : null;
}

interface Catalog {
  ok: boolean;
  teams: Record<string, {
    base?: { country: string; city: string };
    home?: string;
    alsoIn?: string[];
  }>;
}

function loadCatalog(): Catalog {
  try {
    const raw = JSON.parse(readFileSync(join(TEAMS_DIR, "catalog.json"), "utf8"));
    if (raw?.teams) return { ok: true, teams: raw.teams };
  } catch { /* fallthrough */ }
  console.log("::warning::teams/catalog.json не прочитался — база, домашняя трасса и другие серии берутся из прежнего файла");
  return { ok: false, teams: {} };
}

/// Состояние прогона. В файле рядом лежит ещё `blocked` — список команд, из-за
/// которых файл не обновлён; его пишет main() и читает health.ts, самому
/// продьюсеру он не нужен (пересобирается каждый прогон), поэтому здесь его нет.
interface State {
  version: number;
  fingerprint: string;
  /// Чемпион каждого сезона — прошлые не меняются, кэш вечный.
  champions: Record<string, string>;
  /// Всевременные победы и домашняя статистика: пересчитываются только после
  /// гонки, между прогонами живут здесь.
  raw: Record<string, number>;
}

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8"));
    if (s?.version === STATE_VERSION) {
      return {
        version: STATE_VERSION, fingerprint: String(s.fingerprint ?? ""),
        champions: s.champions ?? {}, raw: s.raw ?? {},
      };
    }
  } catch { /* нет файла — соберём с нуля */ }
  return { version: STATE_VERSION, fingerprint: "", champions: {}, raw: {} };
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

async function main() {
  console.log(`F1 teams, season ${YEAR}`);

  // Прежний снапшот читаем ПЕРВЫМ: он источник для всего, что не соберётся.
  //
  // Счётчиков отказов ДВА, и путать их нельзя:
  //  • `failed` — сколько источников не ответило за прогон. Нужен только логу:
  //    строка «N источник(ов) не ответили» + перенос значений ниже.
  //  • `rawFailed` — отказы внутри cached(), то есть промахи КЭША raw. Только
  //    они решают, штамповать ли отпечаток: отпечаток описывает наполненность
  //    raw, а не удачу прогона целиком. Считать по общему счётчику нельзя —
  //    выборки, расписание, зачёт и титулы тянутся каждый прогон независимо от
  //    отпечатка, и любая их осечка (429 прилетает КАЖДЫЙ прогон, см. шапку)
  //    навсегда оставляла бы отпечаток прежним: fresh === false → все 69
  //    ключей кэша заново → ещё больше 429. Самоусиливающаяся петля.
  const previous = loadPrevious();
  let failed = 0;
  let rawFailed = 0;

  // Season guard — как у остальных продьюсеров: в переходном окне зеркало
  // расписания ещё про прошлый сезон, и писать нечего. Оттуда же берём имена
  // трасс: у домашней трассы этап может быть ещё не проехан, и в результатах
  // команды его просто нет.
  const circuitNames = new Map<string, string>();
  let rounds: SeasonRound[] = [];
  const raceDates = new Map<number, string>();
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
    const table = d?.MRData?.RaceTable;
    const season = table?.season ?? null;
    if (season && scheduleSeasonMismatch(season, YEAR)) {
      console.warn(`teams: зеркало расписания за сезон ${season}, YEAR=${YEAR} — переходное окно, пропускаем`);
      return;
    }
    for (const race of table?.Races ?? []) {
      const c = race?.Circuit;
      if (c?.circuitId && c?.circuitName) circuitNames.set(String(c.circuitId), String(c.circuitName));
      const round = Number(race?.round);
      if (c?.circuitId && Number.isFinite(round)) {
        rounds.push({ round, code: roundCode(String(c.circuitId)), race: String(race?.raceName ?? "") });
        if (race?.date) raceDates.set(round, String(race.date));
      }
    }
    rounds.sort((a, b) => a.round - b.round);
  } catch { /* нет зеркала — раунды переносим из прежнего файла ниже */ }

  // Без расписания нет ни полоски раундов, ни дат гонок — а без дат не найти
  // митинги OpenF1, то есть и питов. Пустая полоска уехала бы в файл так же
  // тихо, как пустая форма, поэтому: раунды из прежнего файла, питы прежние.
  const roundsStale = rounds.length === 0;
  if (roundsStale) {
    failed++;
    rounds = previous.rounds;
    console.log("::warning::teams: расписание сезона не прочиталось — раунды и питы из прежнего файла");
  }

  // Зачёт конструкторов даёт и состав, и место с очками, и отпечаток для кэша.
  let rows: any[] = [];
  let fingerprint = "";
  try {
    const st = JSON.parse(readFileSync(join(JOLPICA_DIR, "current_constructorStandings.json"), "utf8"));
    const list = st?.MRData?.StandingsTable?.StandingsLists?.[0];
    rows = list?.ConstructorStandings ?? [];
    if (rows.length) {
      const vector = rows.map((r: any) => `${r?.Constructor?.constructorId}:${r?.points}:${r?.wins}`);
      fingerprint = `${list?.season}-${list?.round}-${hash(vector.sort().join("|"))}`;
    }
  } catch { /* нет зеркала — соберём состав из API ниже */ }
  // Зачёта нет: состав ещё соберём из API, но места и очков там нет — их
  // возьмём из прежнего файла, а не обнулим (в начале сезона прежних тоже
  // нет, и null/0 там честны).
  const standingsStale = rows.length === 0;
  if (standingsStale) {
    const d = await fetchJSON(`${JOLPICA}/${YEAR}/constructors.json?limit=40`);
    const list = d?.MRData?.ConstructorTable?.Constructors ?? [];
    if (!list.length) {
      console.warn("teams: состав сезона недоступен — пропускаем");
      return;
    }
    rows = list.map((c: any) => ({ Constructor: c, position: null, points: "0" }));
    failed++;
    console.log("::warning::teams: нет зеркала зачёта — место и очки из прежнего файла (у кого прежнего нет — null/0, «зачёт ещё не открыт»)");
  }

  const state = loadState();
  const fresh = fingerprint !== "" && state.fingerprint === fingerprint;
  const raw: Record<string, number> = fresh ? { ...state.raw } : {};
  const catalog = loadCatalog();
  // Список конструкторов рвётся страницей: неполный список молча ТЕРЯЕТ
  // исторические id (mclaren без mclaren-ford — 201 победа вместо 205),
  // поэтому отказ помечаем, а всевременные цифры берём прежние. Пустой список
  // (тот же пустой 200) — такой же отказ: полный справочник конструкторов
  // пустым не бывает, а с ним пропадают ВСЕ исторические id разом.
  const constructorIds = await allConstructorIds();
  const idsBroken = !constructorIds?.length;
  const groups = idsBroken ? {} : groupById(constructorIds!);
  if (idsBroken) {
    failed++;
    console.log("::warning::teams: список конструкторов не вытянулся — всевременные победы из прежнего файла");
  }
  let fetched = 0;
  const live = new Set<string>();
  /// Число из кэша/сети. null — источник не ответил и прежнего значения нет
  /// нигде: вызывающий пометит поле как несобранное. Прежнее значение из
  /// состояния возвращаем И кладём обратно в raw — иначе GC состояния выкинет
  /// его, и опубликованный файл разойдётся с кэшем.
  const cached = async (key: string, get: () => Promise<number | null>): Promise<number | null> => {
    live.add(key);
    if (raw[key] != null) return raw[key];
    const n = await get();
    if (n == null) {
      failed++;
      // Промах кэша: значение под ключом так и не добыто (даже если ниже
      // подставим прошлое из состояния — оно не перепроверено). Отпечаток
      // штамповать нельзя, иначе прошлое число замрёт до следующей гонки.
      rawFailed++;
      const memo = state.raw[key];
      if (memo == null) return null;
      raw[key] = memo;
      return memo;
    }
    raw[key] = n;
    fetched++;
    return n;
  };

  // Чемпионы по сезонам — вечный кэш, добираем только недостающие годы.
  // Не ответивший ПРОШЛЫЙ сезон — недосчитанный титул у его чемпиона (и
  // тишина: ни исключения, ни пустого поля), поэтому титулы помечаем прежними.
  let titlesStale = false;
  for (let season = FIRST_CONSTRUCTOR_SEASON; season <= YEAR; season++) {
    if (state.champions[season] != null) continue;
    const d = await fetchJSON(`${JOLPICA}/${season}/constructorStandings/1.json`);
    const champ = d?.MRData?.StandingsTable?.StandingsLists?.[0]
      ?.ConstructorStandings?.[0]?.Constructor?.constructorId;
    await sleep(400);
    // Текущий сезон не дописываем: чемпион ещё не определён.
    if (champ && season < YEAR) state.champions[season] = String(champ);
    else if (champ) console.log(`  сезон ${season} идёт — лидер ${champ}, титул не засчитан`);
    else if (d == null && season < YEAR) {
      titlesStale = true;
      failed++;
    }
  }

  const pages: CarriedPage[] = [];
  for (const row of rows) {
    const c = row?.Constructor;
    const id = String(c?.constructorId ?? "");
    if (!id) continue;
    const facts = catalog.teams[id];
    const ids = groups[id] ?? [id];
    const prev = previous.teams.get(id);

    const seasonRaces = await allRaces(`${YEAR}/constructors/${id}/results`);
    await sleep(400);
    const sprints = await allRaces(`${YEAR}/constructors/${id}/sprint`);
    await sleep(400);
    const quali = await allRaces(`${YEAR}/constructors/${id}/qualifying`);
    await sleep(400);
    // `?? []` ниже — не «данных нет», а заглушка: несобранное заменит
    // carryStale прежними значениями, а нечем заменить — файл не пишем.
    for (const selection of [seasonRaces, sprints, quali]) if (selection == null) failed++;

    // Пустой 200 — тоже отказ, только молчаливый: allRaces вернул массив, а не
    // null, и без этой проверки ноль уехал бы в файл как факт (см. шапку
    // emptiedSelections).
    const emptied = emptiedSelections({ results: seasonRaces, sprints, quali }, prev);
    if (emptied.labels.length) {
      failed += emptied.labels.length;
      console.log(`::warning::teams: ${id} — источник отдал ПУСТУЮ выборку (${emptied.labels.join(", ")}) там, где в прежнем файле были данные: считаем отказом, значения из прежнего файла`);
    }

    const gp = tallyResults(seasonRaces ?? [], "Results");
    gp.poles = countPoles(quali ?? []);
    const sprint = tallyResults(sprints ?? [], "SprintResults");

    // Всевременные победы — по всем историческим id команды. Один не
    // ответивший id делает несобранной ВСЮ сумму: частичная сумма — просто
    // меньшее число, на экране её от правды не отличить.
    let allWins = 0;
    let allTimeStale = idsBroken;
    for (const historic of ids) {
      const n = await cached(`${historic}:wins`, async () => {
        const wins = await total(`constructors/${historic}/results/1`);
        await sleep(400);
        return wins;
      });
      if (n == null) allTimeStale = true;
      else allWins += n;
    }
    const titles = Object.values(state.champions).filter((x) => ids.includes(x)).length;

    let home: TeamPage["home"];
    let homeStale = false;
    if (facts?.home) {
      const circuit = facts.home;
      const wins = await cached(`${id}:home:${circuit}:wins`, async () => {
        const n = await total(`constructors/${id}/circuits/${circuit}/results/1`);
        await sleep(400);
        return n;
      });
      const poles = await cached(`${id}:home:${circuit}:poles`, async () => {
        const races = await allRaces(`constructors/${id}/circuits/${circuit}/qualifying`);
        await sleep(400);
        return races == null ? null : countPoles(races);
      });
      homeStale = wins == null || poles == null;
      // Имя — из расписания сезона: этап домашней трассы может быть впереди,
      // и в результатах команды его ещё нет.
      const name = circuitNames.get(circuit)
        ?? seasonRaces?.find((r: any) => r?.Circuit?.circuitId === circuit)?.Circuit?.circuitName;
      home = { circuitId: circuit, name: String(name ?? circuit), wins: wins ?? 0, poles: poles ?? 0 };
    }

    // Первый сезон — вечный факт, спрашиваем один раз.
    const firstSeason = await cached(`${id}:firstSeason`, async () => {
      const d = await fetchJSON(`${JOLPICA}/constructors/${id}/seasons.json?limit=1`);
      await sleep(400);
      const y = Number(d?.MRData?.SeasonTable?.Seasons?.[0]?.season);
      return Number.isFinite(y) ? y : null;
    });

    const form = buildForm(seasonRaces ?? []);
    applySprintWins(form, sprints ?? []);
    applyQualiDuel(form, quali ?? []);
    const driverRecords: TeamPage["driverRecords"] = [];
    let driverWinsStale = false;
    for (const d of form) {
      const wins = await cached(`${id}:driver:${d.driverId}:wins`, async () => {
        const n = await total(`drivers/${d.driverId}/constructors/${id}/results/1`);
        await sleep(400);
        return n;
      });
      if (wins == null) driverWinsStale = true;
      driverRecords.push({ driverId: d.driverId, name: d.name, wins: wins ?? 0 });
    }

    const pits = buildPits(form, rounds, YEAR, raceDates);
    if (pits == null) {
      failed++;
      console.log(`::warning::teams: ${id} — зеркало OpenF1 не прочиталось, питы из прежнего файла`);
    }

    const merged = carryStale({
      constructorId: id,
      name: String(c?.name ?? id),
      base: facts?.base,
      position: Number(row?.position) || null,
      points: Number(row?.points ?? 0),
      gp, sprint,
      form,
      home,
      alsoIn: facts?.alsoIn ?? [],
      comebacks: buildComebacks(form, seasonRaces ?? []),
      pits: pits ?? [],
      firstSeason: firstSeason || null,
      allTime: { wins: allWins, titles },
      driverRecords,
    }, prev, {
      standings: standingsStale,
      facts: !catalog.ok,
      results: seasonRaces == null || emptied.results,
      sprints: sprints == null || emptied.sprints,
      quali: quali == null || emptied.quali,
      pits: pits == null || roundsStale,
      allTime: allTimeStale,
      titles: titlesStale,
      home: homeStale,
      firstSeason: firstSeason == null,
      driverWins: driverWinsStale,
    });
    // Ключи перенесённых пилотов держим живыми: иначе GC состояния выкинет их
    // после первой же осечки и следующий прогон пойдёт за ними в сеть.
    for (const d of merged.page.driverRecords) live.add(`${id}:driver:${d.driverId}:wins`);
    pages.push(merged);
  }

  if (!pages.length) {
    console.warn("teams: нечего писать — пропускаем");
    return;
  }

  const { file, blocked, carried } = assembleSeason(YEAR, rounds, pages);

  // Состояние пишем в любом случае: это кэш запросов, и выбрасывать уже
  // добытое из-за чужой осечки — лишняя нагрузка на источник. Отпечаток
  // штампуем по промахам КЭША (rawFailed), а не по общему счётчику отказов:
  // он описывает наполненность raw, и осечка выборки или расписания к нему
  // отношения не имеет. Иначе один флапающий источник держал бы fresh ===
  // false вечно и каждый прогон перетягивал бы весь кэш заново.
  const stamped = rawFailed === 0 ? fingerprint : state.fingerprint;
  const kept = Object.fromEntries(Object.entries(raw).filter(([k]) => live.has(k)));
  writeIfChanged(STATE, JSON.stringify(
    // `blocked` — след устойчивого отказа для health.ts: шаг при fail-closed
    // зелёный (исключения нет), и без этой записи единственным сигналом
    // остаётся строка в логе прогона.
    { version: STATE_VERSION, fingerprint: stamped, blocked, champions: state.champions, raw: kept },
    null, 2) + "\n");
  if (failed) console.log(`::warning::teams: ${failed} источник(ов) не ответили — см. перенос значений ниже`);

  for (const line of carried) console.log(`::warning::teams: прежние значения — ${line}`);
  if (!file) {
    console.log(`::warning::teams: ФАЙЛ НЕ ОБНОВЛЁН (${OUT}) — у ${blocked.length} команд(ы) поле нечем закрыть: ${blocked.join("; ")}. ${previous.exists
      ? "На диске остаётся прежний файл: экран команды показывает данные прошлого прогона, обнулять команду нельзя"
      : "Файл не создан: неполный первый сбор хуже отсутствия файла"}`);
    console.log("Done.");
    return;
  }
  const changed = writeJSONWithEnvelope(OUT, file);
  console.log(
    `  ${file.teams.length} команд, запросов ${fetched} (кэш ${fresh ? "свежий" : "сброшен"}), титулов в базе ${Object.keys(state.champions).length} → ${changed ? "записано" : "без изменений"}`,
  );
  console.log("Done.");
}

/// Полный список конструкторов — для склейки исторических id (mclaren-ford).
/// null — страница не ответила: неполный список молча теряет исторические id,
/// а с ними и часть всевременных побед.
async function allConstructorIds(): Promise<string[] | null> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const d = await fetchJSON(`${JOLPICA}/constructors.json?limit=100&offset=${offset}`);
    const list = d?.MRData?.ConstructorTable?.Constructors;
    if (!Array.isArray(list)) return null;
    ids.push(...list.map((c: any) => String(c.constructorId)));
    if (offset + 100 >= Number(d?.MRData?.total ?? 0)) return ids;
    await sleep(400);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
