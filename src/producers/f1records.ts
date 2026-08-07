// Продьюсер «SPORT MILESTONES» — вехи и рекорды F1 для одноимённого блока
// поиска. Источник — карьерная статистика из Jolpica (дешёвые MRData.total).
// Карточки собираются С ГОТОВЫМ ТЕКСТОМ (header/title/note/подписи полоски) —
// формулировки и «вау-углы» живут в бэкенде, приложение только рисует.
//
// Углы (не просто «держит рекорд», а горячая динамика):
//  • event    — рубеж ВЗЯТ на днях: «McLaren’s 200th win came from Lando
//    Norris at the Hungarian Grand Prix». Живёт 14 дней после самой гонки.
//  • near     — АВТОСКАН решётки: кто подошёл к круглой цифре вплотную
//    («One win from 10 — double figures»). Никакой курации: подошёл — попал в
//    блок, взял — карточка сама сменилась на event, потом на следующую цель.
//  • milestone— держатель идёт к красивой круглой цифре: «11 more for a
//    landmark 450, due at the Qatar Grand Prix» (Alonso, Grands Prix).
//  • firstPast— уникальность: «The only driver ever past 100 wins» (Hamilton).
//  • rate     — частота: «On the podium in more than half his races».
//  • chase    — погоня за цифрой легенды: зафиксированной (ушёл — цель стоит)
//    или живой (holderId — цель растёт вместе с держателем).
//
// Автоматика показа/скрытия. Значения пересчитываются каждый прогон, поэтому:
// догнал цель — chase-карточка исчезает; ушёл из решётки — субъект пропадает;
// взял рубеж — near сменяется на event и через 14 дней уступает место
// следующей цели. Ручной каталог нужен только для того, чего в API нет.
//
// Дата рубежа берётся не из истории прогонов, а из самих данных: N-я победа
// лежит по offset N−1 в хронологии results/1 — один запрос даёт гонку и дату.
// Поэтому «рубеж взят» работает и на первом прогоне, и после простоя крона.
//
// Метрики:
//  • starts  — СТАРТЫ, а не записи: MRData.total у /results считает и невыезды
//    (у Алонсо 439 записей против 436 стартов). Юбилеи f1milestones считают
//    старты и живут в том же блоке — расхождение читалось бы как ошибка,
//    поэтому здесь тот же фильтр isStart и та же цифра.
//  • wins/podiums — results/1 и сумма results/1+2+3 (GP, без спринтов). У
//    команды суммируем ВСЕ её исторические id: в 1960–70-е конструктора
//    называли вместе с мотором, и «mclaren» без «mclaren-ford» даёт 200 побед
//    вместо 204 — блок объявил бы юбилей на четыре победы позже, чем он был.
//  • poles   — qualifying/1 с фильтром position === "1". Ни один эндпоинт не
//    годится «как есть»: grid/1/results — это старт с первой позиции, он
//    теряет поул при штрафе на решётку и дарит фантомный тому, кто унаследовал
//    P1 (единственный поул Магнуссена там не виден вовсе, Спа-2023 и Спа-2024
//    уезжают от Ферстаппена к Леклеру); а qualifying/1 подмешивает чужие
//    строки — у Ферстаппена 64 записи при 51 поуле.
//    ВАЖНО: квалификации в базе есть только с 1994 года, поэтому поулы
//    считаем ТОЛЬКО пилотам (самый возрастной на решётке дебютировал в
//    2001-м); у команды цифра была бы обрезана втрое.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged, writeJSONWithEnvelope, scheduleMirrorFile } from "../lib/mirror.js";
import { scheduleSeasonMismatch } from "../lib/season.js";
import { fetchJSON as httpJSON } from "../lib/http.js";
import { isStart } from "../lib/starts.js";
import { JOLPICA } from "../lib/sources.js";
import {
  NEAR, nextLandmark, ordinal, possessive, prevLandmark, singular, type Metric,
} from "../lib/landmarks.js";

const fetchJSON = (url: string) => httpJSON(url, { backoffMs: 8000 });

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const DATA = join(process.cwd(), "data", "f1");
const RECORDS_DIR = join(DATA, "records");
const OUT = join(RECORDS_DIR, `${YEAR}.json`);
const STATE = join(RECORDS_DIR, `_state_${YEAR}.json`);
const JOLPICA_DIR = join(DATA, "jolpica");
const NOW = Date.now();

/// Сколько дней взятый рубеж держится в блоке как новость.
const EVENT_WINDOW_DAYS = 14;
/// Потолок карточек в выдаче: полка показывает первые, категория — все.
const MAX_CARDS = 10;
type Hook =
  | { kind: "milestone"; step: number; flavour?: string } // к следующей круглой цифре
  | { kind: "firstPast"; threshold: number }              // единственный за порогом
  | { kind: "rate"; over: Metric };                       // доля (подиумов от гонок)

/// Курируемые рекорды — в data/f1/records/catalog.json (правится руками без
/// кода); встроенные значения — фолбэк на случай битого/отсутствующего файла.
export interface HeldSpec { stat: string; holder: string; metric: Metric; hook: Hook }
export interface ChaseSpec {
  stat: string;
  metric: Metric;
  holder: string;        // отображаемое имя держателя
  chaser: string;
  record?: number;       // зафиксированная цифра (ушедшая легенда)
  holderId?: string;     // живой держатель — цель считается по нему
}
/// Настройки автоскана — тоже из каталога, чтобы крутить без релиза.
export interface ScanSpec {
  metrics?: Metric[];
  teamMetrics?: Metric[];   // у команд свой набор (см. поулы)
  teams?: boolean;
  near?: Partial<Record<Metric, number>>;
  minTarget?: Partial<Record<Metric, number>>;      // порог значимости у пилотов
  teamMinTarget?: Partial<Record<Metric, number>>;  // …и у команд
  maxNear?: number;
  maxCards?: number;
}
export interface Catalog { held: HeldSpec[]; chases: ChaseSpec[]; scan?: ScanSpec }

const BUILTIN_HELD: HeldSpec[] = [
  { stat: "Grands Prix", holder: "alonso",   metric: "starts", hook: { kind: "milestone", step: 50, flavour: "extending his own all-time record" } },
  { stat: "wins",        holder: "hamilton", metric: "wins",   hook: { kind: "firstPast", threshold: 100 } },
  { stat: "podiums",     holder: "hamilton", metric: "podiums", hook: { kind: "rate", over: "starts" } },
];
const BUILTIN_CHASES: ChaseSpec[] = [
  { stat: "wins",    metric: "wins",    record: 91,  holder: "Michael Schumacher", chaser: "max_verstappen" },
  { stat: "podiums", metric: "podiums", record: 155, holder: "Michael Schumacher", chaser: "max_verstappen" },
];
/// Скан по умолчанию: победы/подиумы/поулы у пилотов и команд. Старты
/// намеренно НЕ сканируем — юбилеи GP уже ведёт f1milestones (канал «Legacy»),
/// автоскан дал бы те же цифры вторым голосом.
///
/// Пороги значимости обязательны. У пилотов десятая победа — новость, десятый
/// подиум — нет. У команд планка выше вдвойне: Jolpica режет историю по
/// constructorId (Racing Point → Aston Martin, Renault → Alpine), поэтому
/// «десятый подиум Астон Мартин» технически верен, но читается как неправда —
/// у бренда их кратно больше. Пускаем только те цифры, где сущность и бренд
/// уже совпали.
/// Поулы у команд не считаем: квалификации в базе Jolpica начинаются с 1994
/// года, и всё, что раньше, просто не существует — у Феррари вышло бы 105
/// поулов вместо примерно 250. У пилотов ограничение безобидно: самый
/// возрастной на решётке дебютировал в 2001-м, вся его карьера внутри окна.
const BUILTIN_SCAN: ScanSpec = {
  metrics: ["wins", "podiums", "poles"],
  teamMetrics: ["wins", "podiums"],
  teams: true,
  minTarget: { wins: 10, podiums: 25, poles: 10 },
  teamMinTarget: { wins: 50, podiums: 100, poles: 50 },
  maxNear: 5,
};

export function loadCatalog(): Catalog {
  try {
    const raw = JSON.parse(readFileSync(join(RECORDS_DIR, "catalog.json"), "utf8"));
    if (Array.isArray(raw?.held) && Array.isArray(raw?.chases)) {
      return { held: raw.held, chases: raw.chases, scan: raw.scan ?? BUILTIN_SCAN };
    }
  } catch { /* fallthrough */ }
  console.log("::warning::records/catalog.json не прочитался — использую встроенный каталог");
  return { held: BUILTIN_HELD, chases: BUILTIN_CHASES, scan: BUILTIN_SCAN };
}

/// Субъект карточки — пилот или команда. Ключ в S: driverId у пилотов,
/// «team:<constructorId>» у команд.
export interface Subject {
  code: string;         // «VER»
  driver: string;       // «M. Verstappen» | «McLaren» — в правый угол шапки
  number: string | null; // у команд null
  teamId: string;       // «red_bull» — цвет полоски
  family?: string;      // «Verstappen» — для притяжательных в тексте
  given?: string;       // «Charles» — подпись зовёт пилота полным именем
  team?: boolean;       // субъект-команда
}

/// Темп метрики: сколько набрано в этом сезоне и когда был первый и последний.
/// Считается из той же хронологии, по которой берётся счётчик, — своих
/// запросов не стоит.
export interface Tempo {
  thisSeason: number;
  firstSeason: number | null;
  lastSeason: number | null;
}

/// Взятый рубеж с точной датой и гонкой — считается из хронологии (offset),
/// а не из истории прогонов.
export interface RecordEvent {
  subject: string;
  metric: Metric;
  stat: string;
  n: number;            // сама круглая цифра / цифра рекорда
  value: number;        // текущее значение метрики
  kind: "landmark" | "chase";
  date: string;         // «2026-07-26»
  race: string;         // «Hungarian Grand Prix»
  by?: string;          // «Lando Norris» — кто привёз командный рубеж
  holder?: string;      // «Michael Schumacher» — чей рекорд пал
  matched?: boolean;    // повторил, а не превзошёл
}

/// Готовая карточка блока — приложение рисует как есть.
export interface RecordCard {
  id: string;
  header: string;       // «LANDMARK» | «CLOSING IN» | «MILESTONE» | «RECORD» | «CHASING» | «RECORD BROKEN»
  driver: string;       // «#14 F. Alonso» | «McLaren» — в правый угол шапки
  title: string;        // «438 GRANDS PRIX»
  note: string;         // сабтайтл
  progress: number;     // заполнение полоски 0…1
  teamId: string;       // цвет полоски
  barLeft: string;      // подпись у левого края полоски («438» | «WINS»)
  barRight: string;     // подпись у правого края («450» | «106»)
  dedupKey?: string;    // «gp-450-alonso» — чтобы клиент не дублировал юбилей
  /// Ключ субъекта («leclerc» / «team:mclaren») — по нему экран команды
  /// отбирает карточки своих пилотов и свои собственные.
  subject?: string;
}

export interface SeasonRecords {
  season: number;
  records: RecordCard[];
}

export interface BuildOpts {
  catalog?: Catalog;
  events?: RecordEvent[];
  schedule?: { completedRounds: number; races: { round: number; raceName: string }[] };
  now?: number;
  maxCards?: number;
  /// «leclerc:poles» → темп метрики. Нет ключа — подпись уйдёт на запасной
  /// угол (место на решётке).
  tempo?: Record<string, Tempo>;
  /// Сезон, который считается «этим» (для темпа). По умолчанию — из YEAR.
  season?: number;
}

const UP = (s: string) => s.toUpperCase();
const val = (V: Record<string, number | null>, subject: string, m: Metric) => V[`${subject}:${m}`];

/// Подпись субъекта в шапке: у пилота с номером — «#14 F. Alonso», у команды
/// и у безномерного пилота — просто имя.
function label(info: Subject): string {
  return info.number ? `#${info.number} ${info.driver}` : info.driver;
}

/// Имя для притяжательных оборотов: фамилия пилота либо название команды.
function ownerName(info: Subject): string {
  return info.family ?? info.driver;
}

/// Имя для подписи: пилота зовём полным («Charles Leclerc»), команду — как
/// есть. Подпись говорит человеческим языком, а не инициалом из шапки.
function fullName(info: Subject): string {
  return info.given && info.family ? `${info.given} ${info.family}` : info.driver;
}

/// Набор метрик автоскана для субъекта — у команд он свой (см. BUILTIN_SCAN).
function metricsFor(scan: ScanSpec, isTeam: boolean): Metric[] {
  return (isTeam ? scan.teamMetrics ?? BUILTIN_SCAN.teamMetrics : scan.metrics ?? BUILTIN_SCAN.metrics)!;
}

/// Порог значимости цифры для субъекта: у команд он выше (см. BUILTIN_SCAN).
function floorFor(scan: ScanSpec, metric: Metric, isTeam: boolean): number | undefined {
  return isTeam
    ? scan.teamMinTarget?.[metric] ?? BUILTIN_SCAN.teamMinTarget![metric]
    : scan.minTarget?.[metric] ?? BUILTIN_SCAN.minTarget![metric];
}

// ── Углы (чистые) ───────────────────────────────────────────────────────────

/// Карточка «рубеж только что взят» / «рекорд пал».
function eventCard(e: RecordEvent, S: Record<string, Subject | null>): RecordCard | null {
  const info = S[e.subject];
  if (!info) return null;
  const noun = singular(e.stat);
  const who = ownerName(info);

  if (e.kind === "chase") {
    const verb = e.matched ? "matched" : "passed";
    return {
      id: `event-broken-${e.subject}-${e.metric}-${e.n}`, subject: e.subject,
      header: "RECORD BROKEN", driver: label(info),
      title: UP(`${e.value} ${e.stat}`),
      note: `${who} ${verb} ${possessive(e.holder ?? "the record")} ${e.n} at the ${e.race}.`,
      progress: 1, teamId: info.teamId, barLeft: UP(e.stat), barRight: `${e.value}`,
    };
  }
  const note = e.by
    ? `${possessive(who)} ${ordinal(e.n)} ${noun} came from ${e.by} at the ${e.race}.`
    : `${possessive(who)} ${ordinal(e.n)} ${noun} came at the ${e.race}.`;
  return {
    id: `event-landmark-${e.subject}-${e.metric}-${e.n}`, subject: e.subject,
    header: "LANDMARK", driver: label(info),
    title: UP(`${e.n} ${e.stat}`), note,
    progress: 1, teamId: info.teamId, barLeft: UP(e.stat), barRight: `${e.value}`,
  };
}

/// Место субъекта по метрике среди тех, кто выступает сегодня.
interface GridRank { place: number; ahead: { name: string; value: number }[] }

/// Числительное словом до десяти — с цифры предложение начинать некрасиво,
/// а в середине фразы слово читается мягче.
const WORDS = ["zero", "one", "two", "three", "four", "five",
               "six", "seven", "eight", "nine", "ten"];
function numberWord(n: number, capital = false): string {
  if (n < 1 || n > 10) return `${n}`;
  const w = WORDS[n];
  return capital ? w[0].toUpperCase() + w.slice(1) : w;
}

/// Рейтинг по метрике внутри своей категории (пилоты и команды считаются
/// отдельно — сравнивать их между собой бессмысленно). Впереди — только те,
/// у кого СТРОГО больше: с равным счётом никто никого не догоняет.
function gridRanks(
  V: Record<string, number | null>, S: Record<string, Subject | null>,
  metric: Metric, isTeam: boolean,
): Record<string, GridRank> {
  const rows: { key: string; name: string; value: number }[] = [];
  for (const key of Object.keys(S)) {
    const info = S[key];
    if (!info || (info.team === true) !== isTeam) continue;
    const value = val(V, key, metric);
    if (value == null || value <= 0) continue;
    rows.push({ key, name: fullName(info), value });
  }
  rows.sort((a, b) => b.value - a.value);
  const out: Record<string, GridRank> = {};
  for (const row of rows) {
    const ahead = rows.filter((x) => x.value > row.value).map((x) => ({ name: x.name, value: x.value }));
    out[row.key] = { place: ahead.length + 1, ahead };
  }
  return out;
}

/// Сколько сезонов без нового результата считается засухой. Год назад — это
/// прошлый сезон, а не ожидание: подавать его как драму нечестно.
const DROUGHT_SEASONS = 2;

/// Подпись карточки автоскана. Рубеж и разрыв уже нарисованы заголовком и
/// полоской, поэтому строка НЕ пересказывает их, а добавляет то, чего в
/// цифрах не видно, — и всегда о ТОЙ ЖЕ метрике, иначе теряется, о чём
/// карточка вообще.
///
/// Порядок углов: темп (набирает сейчас / давно стоит) — он и объясняет,
/// близок ли рубеж на самом деле; если темпа нет (подиумы склеены из трёх
/// выборок, единой хронологии у них не существует) — место на решётке.
function nearNote(
  info: Subject, value: number, target: number, stat: string,
  tempo: Tempo | undefined, rank: GridRank | undefined, season: number,
): string {
  const name = fullName(info);
  const noun = singular(stat);
  const grid = info.team ? "among the teams on the grid" : "on the current grid";
  const unit = (n: number) => (n === 1 ? noun : stat);

  if (tempo && tempo.thisSeason > 0) {
    const n = tempo.thisSeason;
    const first = tempo.firstSeason != null && tempo.firstSeason < season
      ? ` — the first of them back in ${tempo.firstSeason}`
      : "";
    return `${numberWord(n, true)} of ${possessive(name)} ${numberWord(value)} ${stat} `
      + `${n === 1 ? "came" : "have come"} this season${first}.`;
  }
  if (tempo?.lastSeason != null && season - tempo.lastSeason >= DROUGHT_SEASONS) {
    const years = season - tempo.lastSeason;
    return `${name} has gone ${numberWord(years)} seasons without one — `
      + `number ${target} has been waiting since ${tempo.lastSeason}.`;
  }
  if (rank) {
    // Своё число не повторяем — оно уже стоит на полоске.
    if (rank.place === 1) {
      return `${name} has more ${stat} than anyone else ${grid}, and the tally is still growing.`;
    }
    if (rank.place === 2) {
      return `Only ${rank.ahead[0].name} has more ${stat} ${grid}, with ${rank.ahead[0].value}.`;
    }
    if (rank.place === 3) {
      return `Only ${rank.ahead[0].name} and ${rank.ahead[1].name} have more ${stat} ${grid}: `
        + `${rank.ahead[0].value} and ${rank.ahead[1].value}.`;
    }
    const nearest = rank.ahead[rank.ahead.length - 1];
    const diff = nearest.value - value;
    return `${name} sits ${ordinal(rank.place)} for ${stat} ${grid}, `
      + `${numberWord(diff)} behind ${nearest.name}.`;
  }
  const gap = target - value;
  return `${numberWord(gap, true)} more ${unit(gap)} for ${name} to reach ${target}.`;
}

/// Карточка автоскана «вот-вот возьмёт круглую цифру».
function nearCard(
  subject: string, metric: Metric, value: number, info: Subject, opts: BuildOpts,
  rank: GridRank | undefined,
): RecordCard {
  const target = nextLandmark(metric, value);
  const stat = metric === "starts" ? "Grands Prix" : metric;
  const season = opts.season ?? new Date().getUTCFullYear();
  return {
    id: `near-${subject}-${metric}`, subject,
    header: "CLOSING IN", driver: label(info),
    title: UP(`${value} ${stat}`),
    note: nearNote(info, value, target, stat, opts.tempo?.[`${subject}:${metric}`], rank, season),
    progress: value / target, teamId: info.teamId,
    barLeft: `${value}`, barRight: `${target}`,
  };
}

/// Карточка держателя рекорда по «вау-углу».
function heldCard(
  h: HeldSpec,
  V: Record<string, number | null>,
  S: Record<string, Subject | null>,
  opts: BuildOpts,
): RecordCard | null {
  const info = S[h.holder];
  const value = val(V, h.holder, h.metric);
  if (!info || value == null || value <= 0) return null;
  const title = UP(`${value} ${h.stat}`);
  const driver = label(info);

  switch (h.hook.kind) {
    case "milestone": {
      const target = Math.ceil((value + 1) / h.hook.step) * h.hook.step;
      const gap = target - value;
      // Старты растут по одному за гонку — значит рубеж можно назвать по
      // этапу календаря (при полном участии, как и анонсируют юбилеи).
      const venue = h.metric === "starts" ? raceAtGap(opts.schedule, gap) : null;
      const tail = venue
        ? `, due at the ${venue}.`
        : h.hook.flavour ? ` — ${h.hook.flavour}.` : ".";
      return {
        id: `held-${h.holder}-${h.stat}`, subject: h.holder, header: "MILESTONE", driver, title,
        note: `${gap} more for a landmark ${target}${tail}`,
        progress: value / target, teamId: info.teamId,
        barLeft: `${value}`, barRight: `${target}`,
        dedupKey: h.metric === "starts" && info.family
          ? `gp-${target}-${info.family.toLowerCase()}` : undefined,
      };
    }
    case "firstPast":
      return {
        id: `held-${h.holder}-${h.stat}`, subject: h.holder, header: "RECORD", driver, title,
        note: `The only driver in F1 history to pass ${h.hook.threshold} ${h.stat}.`,
        progress: 1, teamId: info.teamId, barLeft: UP(h.stat), barRight: `${value}`,
      };
    case "rate": {
      // Без знаменателя доля не считается: молча подставить 0 значит напечатать
      // «more than half of his 0 Grands Prix» — лучше не показать карточку.
      const races = val(V, h.holder, h.hook.over);
      if (races == null || races <= 0) return null;
      const ratio = value / races;
      const noun = singular(h.stat);
      const note = ratio >= 0.5
        ? `On the podium in more than half of his ${races} Grands Prix.`
        : `A ${noun} roughly every ${(1 / ratio).toFixed(1)} races.`;
      return {
        id: `held-${h.holder}-${h.stat}`, subject: h.holder, header: "RECORD", driver, title, note,
        progress: ratio, teamId: info.teamId, barLeft: UP(h.stat),
        barRight: `${value}/${races}`,
      };
    }
  }
}

/// Гонка, на которую выпадает рубеж через gap стартов (полное участие).
function raceAtGap(schedule: BuildOpts["schedule"], gap: number): string | null {
  if (!schedule || gap <= 0) return null;
  const idx = schedule.completedRounds + gap;
  const race = schedule.races.find((r) => r.round === idx);
  return race?.raceName ?? null;
}

/// Карточка погони: цель либо зафиксирована (ушедшая легенда), либо живая.
function chaseCard(
  c: ChaseSpec,
  V: Record<string, number | null>,
  S: Record<string, Subject | null>,
): RecordCard | null {
  const info = S[c.chaser];
  const value = val(V, c.chaser, c.metric);
  if (!info || value == null || value <= 0) return null;
  const live = c.holderId ? val(V, c.holderId, c.metric) : null;
  const target = live ?? c.record;
  if (target == null || value >= target) return null;   // догнал — карточка уходит
  const gap = target - value;
  return {
    id: `chase-${c.chaser}-${c.stat}`, subject: c.chaser, header: "CHASING", driver: label(info),
    title: UP(`${value} ${c.stat}`),
    note: live != null
      ? `${gap} ${c.stat} behind ${c.holder} — and the target keeps moving.`
      : `${gap} ${c.stat} from passing ${possessive(c.holder)} ${target}.`,
    progress: value / target, teamId: info.teamId,
    barLeft: `${value}`, barRight: `${target}`,
  };
}

// ── Сборка ──────────────────────────────────────────────────────────────────

/// Очередь показа: свежее событие → кто вот-вот возьмёт → курируемая погоня →
/// вечная статика. Внутри яруса — по близости к цели.
const TIER = { event: 0, near: 1, curated: 2, static: 3 } as const;

interface Ranked { card: RecordCard; tier: number; gap: number }

/// Чистая сборка блока: события, автоскан, курируемые углы — отсортированные
/// по «горячести» и обрезанные до потолка.
export function buildCards(
  V: Record<string, number | null>,
  S: Record<string, Subject | null>,
  opts: BuildOpts = {},
): RecordCard[] {
  const catalog = opts.catalog ?? loadCatalog();
  const scan = { ...BUILTIN_SCAN, ...(catalog.scan ?? {}) };
  const now = opts.now ?? NOW;
  const ranked: Ranked[] = [];
  // Субъект+метрика, о которых уже есть карточка: второй голос о том же
  // рекорде в одной карусели — шум.
  const covered = new Set<string>();

  // 1. Взятые рубежи — пока свежие.
  for (const e of opts.events ?? []) {
    // Возраст новости считаем от НАЧАЛА гоночного дня: результаты приезжают
    // через пару часов после финиша, и карточка должна успеть в тот же вечер, а
    // не назавтра. Отрицательный возраст — дата из будущего, то есть мусор.
    const age = (now - Date.parse(`${e.date}T00:00:00Z`)) / 86_400_000;
    if (age < 0 || age > EVENT_WINDOW_DAYS) continue;
    if (covered.has(`${e.subject}:${e.metric}`)) continue;
    // Порог значимости тот же, что у автоскана: если «десятая победа команды»
    // не годится в цель, то и как новость она не годится.
    const info = S[e.subject];
    if (!info) continue;
    if (e.kind === "landmark") {
      const floor = floorFor(scan, e.metric, info.team === true);
      if (floor != null && e.n < floor) continue;
    }
    const card = eventCard(e, S);
    if (!card) continue;
    ranked.push({ card, tier: TIER.event, gap: age });
    covered.add(`${e.subject}:${e.metric}`);
  }

  // 2. Курируемые углы. Держатели и погони идут раньше автоскана: это
  // всё-таки all-time рекорды, а не круглая цифра середняка.
  for (const h of catalog.held) {
    const card = heldCard(h, V, S, opts);
    if (!card) {
      // Тихое исчезновение карточки — сигнал курировать каталог (держатель
      // ушёл из зачёта), а не норма.
      console.log(`::warning::records: held-карточка «${h.stat}» (${h.holder}) не построилась — обнови catalog.json`);
      continue;
    }
    if (covered.has(`${h.holder}:${h.metric}`)) continue;
    covered.add(`${h.holder}:${h.metric}`);
    // Статике (firstPast/rate) двигаться некуда — она всегда в хвосте.
    const gap = h.hook.kind === "milestone"
      ? Number(card.barRight) - Number(card.barLeft) : Number.MAX_SAFE_INTEGER;
    ranked.push({
      card,
      tier: h.hook.kind === "milestone" ? TIER.curated : TIER.static,
      gap: Number.isFinite(gap) ? gap : Number.MAX_SAFE_INTEGER,
    });
  }
  for (const c of catalog.chases) {
    const card = chaseCard(c, V, S);
    if (!card) continue;   // догнал или ушёл — это норма, автоскан подхватит
    if (covered.has(`${c.chaser}:${c.metric}`)) continue;
    covered.add(`${c.chaser}:${c.metric}`);
    ranked.push({
      card, tier: TIER.curated,
      gap: Number(card.barRight) - Number(card.barLeft),
    });
  }

  // 3. Автоскан — кто подошёл вплотную. Держим под квотой: в горячую неделю
  // «вот-вот» набирается десяток, и блок из одних только них теряет глубину.
  const near: Ranked[] = [];
  // Рейтинги считаем один раз на метрику и категорию, а не в каждой карточке.
  const ranks = new Map<string, Record<string, GridRank>>();
  const rankOf = (metric: Metric, isTeam: boolean, subject: string): GridRank | undefined => {
    const key = `${metric}:${isTeam}`;
    if (!ranks.has(key)) ranks.set(key, gridRanks(V, S, metric, isTeam));
    return ranks.get(key)![subject];
  };
  for (const subject of Object.keys(S).sort()) {
    const info = S[subject];
    if (!info) continue;
    if (info.team && scan.teams === false) continue;
    for (const metric of metricsFor(scan, info.team === true)) {
      if (covered.has(`${subject}:${metric}`)) continue;
      const value = val(V, subject, metric);
      if (value == null || value <= 0) continue;
      const target = nextLandmark(metric, value);
      const floor = floorFor(scan, metric, info.team === true);
      if (floor != null && target < floor) continue;
      const gap = target - value;
      if (gap > (scan.near?.[metric] ?? NEAR[metric])) continue;
      covered.add(`${subject}:${metric}`);
      near.push({
        card: nearCard(subject, metric, value, info, opts,
                       rankOf(metric, info.team === true, subject)),
        tier: TIER.near, gap,
      });
    }
  }
  near.sort((a, b) => a.gap - b.gap || b.card.progress - a.card.progress || a.card.id.localeCompare(b.card.id));
  ranked.push(...near.slice(0, scan.maxNear ?? BUILTIN_SCAN.maxNear));

  ranked.sort((a, b) =>
    a.tier - b.tier ||
    a.gap - b.gap ||
    b.card.progress - a.card.progress ||
    a.card.id.localeCompare(b.card.id));
  return ranked.slice(0, opts.maxCards ?? scan.maxCards ?? MAX_CARDS).map((r) => r.card);
}

// ── Сеть и состояние ────────────────────────────────────────────────────────

/// Версия семантики кэша. Меняется, когда метрика начинает считаться иначе
/// (поулы переехали с grid/1 на фильтрованный qualifying/1) — старые цифры и
/// датировки в этом случае не «устарели», а неверны, и должны быть выброшены.
const STATE_VERSION = 3;

interface ProbeHit { date: string; race: string; season: number; round: number; by?: string }
interface State {
  version: number;
  season: number;
  fingerprint: string;
  raw: Record<string, number>;      // «leclerc:p1» → 9
  tempo: Record<string, Tempo>;     // «leclerc:poles» → темп для подписи
  probes: Record<string, ProbeHit>; // «leclerc:poles:25» → когда и где взял
  groups?: Record<string, string[]>; // «mclaren» → ["mclaren","mclaren-ford",…]
}

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8"));
    if (s?.season === YEAR && s?.raw && s?.version === STATE_VERSION) {
      return {
        version: STATE_VERSION, season: YEAR, fingerprint: String(s.fingerprint ?? ""),
        raw: s.raw, tempo: s.tempo ?? {}, probes: s.probes ?? {}, groups: s.groups,
      };
    }
  } catch { /* нет файла — соберём с нуля */ }
  return { version: STATE_VERSION, season: YEAR, fingerprint: "", raw: {}, tempo: {}, probes: {} };
}

/// Короткий отпечаток строки (FNV-1a) — чтобы вектор очков не раздувал файл.
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

async function total(path: string): Promise<number | null> {
  const d = await fetchJSON(`${JOLPICA}/${path}.json?limit=1`);
  const n = Number(d?.MRData?.total);
  return Number.isFinite(n) ? n : null;
}

function hitOf(r: any, drv: any): ProbeHit {
  return {
    date: String(r.date), race: String(r.raceName),
    season: Number(r.season), round: Number(r.round),
    by: drv ? `${drv.givenName} ${drv.familyName}` : undefined,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Хронология событий по нескольким путям сразу, отсортированная по времени.
/// Нужна там, где счётчик MRData.total врать не должен, а врёт: у qualifying/1
/// в выдачу подмешиваются чужие строки, у команды история разрезана по id.
/// `keep` возвращает пилота события либо null, если строка не считается.
async function chronology(
  paths: string[], keep: (race: any) => any | null,
): Promise<ProbeHit[] | null> {
  const rows: ProbeHit[] = [];
  for (const path of paths) {
    let offset = 0;
    while (true) {
      const d = await fetchJSON(`${JOLPICA}/${path}.json?limit=100&offset=${offset}`);
      const races = d?.MRData?.RaceTable?.Races;
      if (!Array.isArray(races)) return null;   // сеть/лимит — не портим цифру
      for (const r of races) {
        const drv = keep(r);
        if (drv !== null) rows.push(hitOf(r, drv));
      }
      const totalRows = Number(d?.MRData?.total ?? 0);
      offset += 100;
      if (offset >= totalRows) break;
      await sleep(400);
    }
    await sleep(400);
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.round - b.round);
  return rows;
}

/// Строка засчитывается как СТАРТ (фильтр общий с юбилеями f1milestones).
const keepStart = (r: any) => {
  const res = r?.Results?.[0];
  return isStart(String(res?.status ?? ""), String(res?.positionText ?? "")) ? res?.Driver : null;
};
/// Строка засчитывается как ПОУЛ. Фильтр обязателен: jolpica отдаёт по
/// drivers/<id>/qualifying/1 не только первые места (у Ферстаппена 64 строки
/// при 51 поуле — приезжают позиции 15, 9, 2). Именно поул, а не старт с
/// первой позиции: grid/1/results теряет поул при штрафе на решётку и дарит
/// фантомный тому, кто унаследовал P1 (единственный поул Магнуссена в
/// Сан-Паулу-2022 по grid/1 не виден вовсе, а Спа-2023 и Спа-2024 уезжают от
/// Ферстаппена к Леклеру).
const keepPole = (r: any) => {
  const q = r?.QualifyingResults?.[0];
  return q?.position === "1" ? q?.Driver : null;
};
/// Победа — выборка results/1 однородна, фильтровать нечего.
const keepWin = (r: any) => r?.Results?.[0]?.Driver ?? null;

// Старты, поулы и победы считаются ПОСТРОЧНО. У стартов и поулов счётчику
// total верить нельзя (старты включают невыезды, поулы — чужие строки), а
// победы выкачиваем ради ТЕМПА: подпись карточки говорит, сколько их пришло в
// этом сезоне и когда была первая, — это видно только из хронологии. Побочно
// оттуда же бесплатно берётся дата взятого рубежа, без отдельных запросов.
/// Метрики, у которых рубеж можно датировать. Подиумы — сумма трёх выборок,
/// единой хронологии у них нет. Старты не датируем намеренно: «N-й Гран-при» —
/// это канал юбилеев f1milestones, вторая карточка про то же была бы дублем.
const DATABLE: Metric[] = ["wins", "poles"];

/// Исторические id одной команды. В 1960–70-е конструктора называли вместе с
/// мотором, и Jolpica хранит эти имена раздельно: у «mclaren» 200 побед, а с
/// «mclaren-ford» — 204. Без склейки блок объявил бы 200-ю победу на четыре
/// победы позже, чем она случилась. Группируем по префиксу id.
export function groupById(ids: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const id of ids) {
    if (id.includes("-")) continue;             // сам по себе id-с-мотором
    const family = ids.filter((x) => x === id || x.startsWith(`${id}-`));
    if (family.length > 1) groups[id] = family;
  }
  return groups;
}

async function constructorGroups(state: State): Promise<Record<string, string[]>> {
  if (state.groups) return state.groups;
  const ids: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const d = await fetchJSON(`${JOLPICA}/constructors.json?limit=100&offset=${offset}`);
    const list = d?.MRData?.ConstructorTable?.Constructors;
    if (!Array.isArray(list)) return {};        // не склеим — лучше без групп
    ids.push(...list.map((c: any) => String(c.constructorId)));
    if (offset + 100 >= Number(d?.MRData?.total ?? 0)) break;
    await sleep(400);
  }
  return groupById(ids);
}

/// Межсезонье: пилотов нового года ещё нет, а all-time рекорды не протухают —
/// переносим прошлогодний блок, выкинув новости (они привязаны к дате).
function carryForward(): boolean {
  try {
    const old = JSON.parse(readFileSync(join(RECORDS_DIR, `${YEAR - 1}.json`), "utf8"));
    const records = (old?.records ?? []).filter((r: RecordCard) => !r.id.startsWith("event-"));
    if (!records.length) return false;
    const changed = writeJSONWithEnvelope(OUT, { season: YEAR, records });
    console.log(`  сезон ${YEAR} ещё не открыт — перенесли ${records.length} карточек из ${YEAR - 1} → ${changed ? "записано" : "без изменений"}`);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`F1 records, season ${YEAR}`);

  // Расписание — для season-guard и для «рубеж выпадает на такой-то этап».
  let races: { round: number; raceName: string; date: string }[] = [];
  let scheduleSeason: string | null = null;
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, scheduleMirrorFile(YEAR)), "utf8"));
    const table = d?.MRData?.RaceTable;
    races = (table?.Races ?? []).map((r: any) => ({
      round: Number(r.round), raceName: String(r.raceName), date: String(r.date),
    }));
    scheduleSeason = table?.season ?? null;
  } catch {
    // Без расписания не работает ни season-guard, ни привязка к этапу — это
    // не норма, а сломанное зеркало.
    console.log("::warning::records: нет зеркала расписания — без season-guard и без привязки рубежа к этапу");
  }
  // Гонка флипов: расписание чужого сезона — переходное окно, не пишем.
  if (scheduleSeason && scheduleSeasonMismatch(scheduleSeason, YEAR)) {
    console.warn(`records: зеркало расписания за сезон ${scheduleSeason}, YEAR=${YEAR} — переходное окно, пропускаем`);
    return;
  }

  const driversResp = await fetchJSON(`${JOLPICA}/${YEAR}/drivers.json?limit=40`);
  const drivers = driversResp?.MRData?.DriverTable?.Drivers ?? [];
  if (!drivers.length) {
    if (carryForward()) return;
    console.warn("records: пилоты сезона недоступны — пропускаем");
    return;
  }
  await sleep(500);
  const teamsResp = await fetchJSON(`${JOLPICA}/${YEAR}/constructors.json?limit=40`);
  const constructors = teamsResp?.MRData?.ConstructorTable?.Constructors ?? [];

  // Команда пилота — из зеркала driverStandings (без сети). Оттуда же
  // отпечаток: очки меняются ровно тогда, когда приезжают новые результаты, а
  // значит и карьерные тоталы имеет смысл перечитывать только тогда. Считаем
  // ВЕКТОР очков и побед, а не сумму: апелляция может переставить двух пилотов
  // местами (сумма та же, а победа переехала).
  const teamOf = new Map<string, string>();
  let fingerprint = "";           // пусто = кэшу верить нельзя
  let standingsRound: number | null = null;
  try {
    const st = JSON.parse(readFileSync(join(JOLPICA_DIR, "current_driverStandings.json"), "utf8"));
    const list = st?.MRData?.StandingsTable?.StandingsLists?.[0];
    const rows = list?.DriverStandings ?? [];
    const vector: string[] = [];
    for (const row of rows) {
      const id = row?.Driver?.driverId, tid = row?.Constructors?.[0]?.constructorId;
      if (id && tid) teamOf.set(id, tid);
      if (id) vector.push(`${id}:${row?.points ?? 0}:${row?.wins ?? 0}`);
    }
    if (rows.length) {
      fingerprint = `${list?.season}-${list?.round}-${hash(vector.sort().join("|"))}`;
      standingsRound = Number(list?.round);
    }
  } catch { /* нет зеркала — цвет фолбэкнется в приложении */ }
  if (!fingerprint) {
    console.log("::warning::records: нет зеркала зачёта — кэш тоталов отключён, прогон полный");
  }

  // Сколько раундов РЕАЛЬНО отсчитано. Берём из зачёта, а не из календаря:
  // карьерные тоталы приезжают вместе с зачётом, и если считать по датам, то
  // в воскресенье вечером прогноз «рубеж на таком-то этапе» уезжает на гонку
  // вперёд — до того, как Jolpica опубликует результат.
  const completedRounds = standingsRound
    ?? races.filter((r) => Date.parse(`${r.date}T23:59:59Z`) < NOW).length;

  const S: Record<string, Subject | null> = {};
  for (const d of drivers) {
    S[d.driverId] = {
      code: d.code ?? d.familyName.slice(0, 3).toUpperCase(),
      driver: `${d.givenName[0]}. ${d.familyName}`,
      number: d.permanentNumber ?? null,
      teamId: teamOf.get(d.driverId) ?? "",
      family: d.familyName,
      given: d.givenName,
    };
  }
  for (const c of constructors) {
    S[`team:${c.constructorId}`] = {
      code: c.constructorId, driver: c.name, number: null,
      teamId: c.constructorId, family: c.name, team: true,
    };
  }

  const catalog = loadCatalog();
  const scan = { ...BUILTIN_SCAN, ...(catalog.scan ?? {}) };

  // Что нужно посчитать: автоскан по всей решётке + курируемые субъекты.
  const need = new Map<string, Set<Metric>>();
  const add = (id: string, m: Metric) => {
    if (!S[id]) return;                       // субъект не в сезоне — пропустим
    need.set(id, (need.get(id) ?? new Set()).add(m));
  };
  for (const subject of Object.keys(S)) {
    const info = S[subject];
    if (!info) continue;
    if (info.team && scan.teams === false) continue;
    for (const m of metricsFor(scan, info.team === true)) add(subject, m);
  }
  for (const h of catalog.held) { add(h.holder, h.metric); if (h.hook.kind === "rate") add(h.holder, h.hook.over); }
  for (const c of catalog.chases) {
    add(c.chaser, c.metric);
    if (c.holderId) {
      if (S[c.holderId]) add(c.holderId, c.metric);
      // Живой держатель ушёл из решётки — цель считать не по чему, и погоня
      // молча исчезнет. Лечится в каталоге: заменить holderId на record.
      else console.log(`::warning::records: держатель «${c.holder}» (${c.holderId}) не в сезоне — погоня «${c.stat}» пропала, зафиксируй record в catalog.json`);
    }
  }

  const state = loadState();
  const groups = await constructorGroups(state);
  /// Пути Jolpica субъекта: у команды — все её исторические id.
  const basesOf = (subject: string): string[] => {
    if (!subject.startsWith("team:")) return [`drivers/${subject}`];
    const id = subject.slice(5);
    return (groups[id] ?? [id]).map((x) => `constructors/${x}`);
  };

  // Сырые счётчики (кэш переживает прогон: тоталы меняются только после гонки).
  const fresh = fingerprint !== "" && state.fingerprint === fingerprint;
  const raw: Record<string, number> = fresh ? { ...state.raw } : {};
  // Хронологии этого прогона: из них берётся и счётчик, и дата рубежа.
  const chrono = new Map<string, ProbeHit[]>();
  let fetched = 0;
  let failed = 0;
  // Что реально понадобилось этому прогону — по этому списку кэш и обрежется:
  // ушёл пилот из решётки, сменился набор метрик — строки не должны копиться.
  const live = new Set<string>();
  const cached = async (
    subject: string, key: string, get: () => Promise<number | null>,
  ): Promise<number | null> => {
    const k = `${subject}:${key}`;
    live.add(k);
    if (raw[k] != null) return raw[k];
    const n = await get();
    if (n == null) {
      // Сетевой отказ не должен стирать цифру: прошлая (максимум на гонку
      // устаревшая) честнее, чем пропавшая карточка.
      failed++;
      if (state.raw[k] != null) raw[k] = state.raw[k];
      return raw[k] ?? null;
    }
    raw[k] = n;
    fetched++;
    return n;
  };
  /// Сумма тоталов по всем историческим id субъекта.
  const rawSum = (subject: string, key: string, leaf: string) =>
    cached(subject, key, async () => {
      let sum = 0;
      for (const base of basesOf(subject)) {
        const n = await total(`${base}/${leaf}`);
        await sleep(500);
        if (n == null) return null;
        sum += n;
      }
      return sum;
    });
  /// Хронология метрики с кэшем в памяти прогона. Попутно считает темп —
  /// подпись карточки живёт именно на нём, а второй раз выкачивать не за чем.
  const tempo: Record<string, Tempo> = fresh ? { ...state.tempo } : {};
  const chronoOf = async (subject: string, metric: Metric): Promise<ProbeHit[] | null> => {
    const key = `${subject}:${metric}`;
    if (chrono.has(key)) return chrono.get(key)!;
    const leaf = metric === "starts" ? "results" : metric === "poles" ? "qualifying/1" : "results/1";
    const keep = metric === "starts" ? keepStart : metric === "poles" ? keepPole : keepWin;
    const rows = await chronology(basesOf(subject).map((b) => `${b}/${leaf}`), keep);
    if (rows) {
      chrono.set(key, rows);
      tempo[key] = {
        thisSeason: rows.filter((r) => r.season === YEAR).length,
        firstSeason: rows[0]?.season ?? null,
        lastSeason: rows[rows.length - 1]?.season ?? null,
      };
    }
    return rows;
  };

  for (const [subject, metrics] of need) {
    const isTeam = S[subject]?.team === true;
    // Старты у команды — это записи ВСЕХ её машин, а не гонки: как «Grands
    // Prix» такую цифру показывать нельзя.
    if (metrics.has("starts") && !isTeam) {
      await cached(subject, "starts", async () => (await chronoOf(subject, "starts"))?.length ?? null);
    }
    if (metrics.has("poles")) {
      await cached(subject, "poles", async () => (await chronoOf(subject, "poles"))?.length ?? null);
    }
    if (metrics.has("wins")) {
      // Победы — построчно: даёт темп для подписи, дату взятого рубежа и
      // правильную склейку исторических id команды одним махом.
      await cached(subject, "p1", async () => (await chronoOf(subject, "wins"))?.length ?? null);
    } else if (metrics.has("podiums")) {
      await rawSum(subject, "p1", "results/1");
    }
    if (metrics.has("podiums")) {
      await rawSum(subject, "p2", "results/2");
      await rawSum(subject, "p3", "results/3");
    }
  }

  // Метрики из сырых счётчиков.
  const V: Record<string, number | null> = {};
  for (const [subject, metrics] of need) {
    const r = (k: string) => raw[`${subject}:${k}`];
    for (const m of metrics) {
      if (m === "starts") V[`${subject}:starts`] = r("starts") ?? null;
      if (m === "wins") V[`${subject}:wins`] = r("p1") ?? null;
      if (m === "poles") V[`${subject}:poles`] = r("poles") ?? null;
      if (m === "podiums") {
        const [a, b, c] = [r("p1"), r("p2"), r("p3")];
        V[`${subject}:podiums`] = a != null && b != null && c != null ? a + b + c : null;
      }
    }
  }

  // Датируем недавно взятые рубежи.
  // n — цифра для текста, probeN — позиция в хронологии, по которой берём
  // гонку и дату. У рубежа они совпадают; у павшего рекорда текст называет
  // цифру легенды, а датирует его следующая по счёту победа преследователя.
  interface Wanted {
    subject: string; metric: Metric; n: number; probeN: number; slack: number;
    kind: "landmark" | "chase"; holder?: string; value: number; matched?: boolean;
  }
  const wanted: Wanted[] = [];
  for (const [subject, metrics] of need) {
    for (const m of metrics) {
      if (!DATABLE.includes(m)) continue;
      const value = V[`${subject}:${m}`];
      if (value == null || value <= 0) continue;
      const n = prevLandmark(m, value);
      // Рубеж далеко позади — датировать нечего, гонка была давно. Мелкий для
      // этого субъекта — карточки всё равно не будет, запрос не тратим.
      if (n <= 0 || value - n > 3) continue;
      const floor = floorFor(scan, m, S[subject]?.team === true);
      if (floor != null && n < floor) continue;
      wanted.push({ subject, metric: m, n, probeN: n, slack: value - n, kind: "landmark", value });
    }
  }
  for (const c of catalog.chases) {
    if (!DATABLE.includes(c.metric) || c.record == null || c.holderId) continue;
    const value = V[`${c.chaser}:${c.metric}`];
    if (value == null || value < c.record || value - c.record > 3) continue;
    const matched = value === c.record;
    wanted.push({
      subject: c.chaser, metric: c.metric, n: c.record,
      probeN: matched ? c.record : c.record + 1,
      slack: value - c.record, kind: "chase", holder: c.holder, value, matched,
    });
  }
  wanted.sort((a, b) => a.slack - b.slack);

  const events: RecordEvent[] = [];
  for (const w of wanted) {
    const key = `${w.subject}:${w.metric}:${w.probeN}`;
    let hit = state.probes[key];
    if (!hit) {
      // Обе датируемые метрики построчные — гонка и дата берутся из уже
      // выкачанной хронологии, отдельного запроса рубеж не стоит.
      const rows = await chronoOf(w.subject, w.metric);
      const got = rows?.[w.probeN - 1];
      if (!got) continue;
      hit = got;
      state.probes[key] = got;
    }
    events.push({
      subject: w.subject, metric: w.metric,
      stat: w.metric === "starts" ? "Grands Prix" : w.metric,
      n: w.n, value: w.value, kind: w.kind, date: hit.date, race: hit.race,
      by: S[w.subject]?.team ? hit.by : undefined,
      holder: w.holder, matched: w.matched,
    });
  }

  // Состояние пишем до карточек: тоталы и датировки достались дорого, терять
  // их из-за пустой сборки незачем. Отпечаток продвигаем только при полном
  // сборе — иначе дыра от разового 429 законсервируется до следующей гонки.
  const stamped = failed === 0 ? fingerprint : state.fingerprint;
  const kept = Object.fromEntries(Object.entries(raw).filter(([k]) => live.has(k)));
  writeIfChanged(STATE, JSON.stringify(
    { version: STATE_VERSION, season: YEAR, fingerprint: stamped, raw: kept, tempo,
      probes: state.probes, groups },
    null, 2) + "\n");
  if (failed) {
    console.log(`::warning::records: ${failed} запросов не ответили — часть карточек может не построиться`);
  }

  const records = buildCards(V, S, {
    catalog, events, now: NOW, tempo, season: YEAR,
    schedule: races.length ? { completedRounds, races } : undefined,
  });
  if (!records.length) {
    console.warn("records: нет карточек (данные недоступны) — пропускаем");
    return;
  }
  const changed = writeJSONWithEnvelope(OUT, { season: YEAR, records } satisfies SeasonRecords);
  console.log(
    `  запросов: ${fetched} счётчиков (кэш ${fresh ? "свежий" : "сброшен"}${failed ? `, отказов ${failed}` : ""}), субъектов: ${need.size}`,
  );
  console.log(
    `  ${records.length} карточек: ${records.map((r) => `${r.header[0]}:${r.title}`).join(", ")} → ${changed ? "записано" : "без изменений"}`,
  );
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
