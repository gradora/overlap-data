// Продьюсер справочника трасс из английской Википедии: на каждую трассу тянем
// статью и достаём (1) таблицу «Lap records» — рекорды круга по категориям
// (Formula One / LMP1 / LMH / GT3 …), детерминированно, это стандартная
// wikitable; (2) «notable moments» — заметные события с годами из плоского
// текста статьи по ключевым словам. Категории бакетятся в группы
// (formula / endurance / gt / touring / other) — приложение показывает рекорд
// самой быстрой известной категории в группе. Кнопка (i) в UI ведёт на статью.
//
// Выход: data/tracks/index.json — { [slug]: TrackWiki }. Ключ slug ИДЕНТИЧЕН
// canonicalSlug приложения (circuit.id) — иначе деталка не найдёт запись.
// Прогон нечастый (данные почти статичны) — отдельный воркфлоу/ручной запуск.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fetchText, writeIfChanged } from "../lib/mirror.js";

const OUT_PATH = join(process.cwd(), "data", "tracks", "index.json");
const API = "https://en.wikipedia.org/w/api.php";
const PAUSE_MS = 1500; // вежливо к вики между статьями (иначе троттлинг)

// slug (== circuit.id приложения) → заголовок статьи в англ-вики. Значения
// взяты из F1CircuitFactsCatalog.displayNames (они и есть названия статей) плюс
// венусы WEC/IMSA. redirects=1 в API прощает мелкие расхождения написания.
const TRACKS: Record<string, string> = {
  "albert-park": "Albert Park Circuit",
  "bahrain": "Bahrain International Circuit",
  "baku": "Baku City Circuit",
  "barcelona": "Circuit de Barcelona-Catalunya",
  "circuit-of-the-americas": "Circuit of the Americas",
  "daytona": "Daytona International Speedway",
  "detroit": "Detroit street circuit",
  "fuji": "Fuji Speedway",
  "gilles-villeneuve": "Circuit Gilles Villeneuve",
  "hungaroring": "Hungaroring",
  "imola": "Imola Circuit",
  "indianapolis": "Indianapolis Motor Speedway",
  "interlagos": "Autódromo José Carlos Pace",
  "jeddah": "Jeddah Corniche Circuit",
  "laguna-seca": "Laguna Seca Raceway",
  "las-vegas": "Las Vegas Strip Circuit",
  "le-mans": "Circuit de la Sarthe",
  "long-beach": "Long Beach street circuit",
  "losail": "Lusail International Circuit",
  "madrid": "Madring",
  "marina-bay": "Marina Bay Street Circuit",
  "mexico-city": "Autódromo Hermanos Rodríguez",
  "miami": "Miami International Autodrome",
  "monaco": "Circuit de Monaco",
  "monza": "Monza Circuit",
  "mosport": "Canadian Tire Motorsport Park",
  "red-bull-ring": "Red Bull Ring",
  "road-america": "Road America",
  "road-atlanta": "Michelin Raceway Road Atlanta",
  "sebring": "Sebring International Raceway",
  "sepang": "Sepang International Circuit",
  "shanghai": "Shanghai International Circuit",
  "silverstone": "Silverstone Circuit",
  "spa-francorchamps": "Circuit de Spa-Francorchamps",
  "suzuka": "Suzuka Circuit",
  "virginia": "Virginia International Raceway",
  "watkins-glen": "Watkins Glen International",
  "yas-marina": "Yas Marina Circuit",
  "zandvoort": "Circuit Zandvoort",
};

export type TrackBucket = "formula" | "endurance" | "gt" | "touring" | "other";

export interface LapRecord {
  category: string;   // «Formula One», «LMP1», «GT3» …
  bucket: TrackBucket;
  time: string;       // «1:44.701»
  seconds: number;    // для сортировки/выбора самого быстрого
  driver: string;
  vehicle: string;
  event: string;      // «2024 Belgian Grand Prix»
  year: number | null;
}

export interface NotableMoment {
  year: number;
  text: string;
  bucket: TrackBucket;
}

/// Самая длинная гонка трассы (по длительности): «24 Hours of Le Mans».
export interface LongestRace {
  hours: number;
  name: string;   // «24 Hours of Le Mans»
}

export interface TrackWiki {
  wikiTitle: string;
  wikiURL: string;
  layout: string | null;                 // подпись текущего лейаута рекордов
  records: LapRecord[];                   // все распарсенные, быстрые первыми
  fastest: Partial<Record<TrackBucket, LapRecord>>; // самый быстрый в группе
  longestRace: LongestRace | null;        // самая длинная гонка (по длительности)
  notable: NotableMoment[];               // заметные события, свежие первыми
}

// MARK: - Бакетинг категории

const BUCKET_RULES: Array<[TrackBucket, RegExp]> = [
  // Порядок важен: endurance/gt проверяем до formula (у прототипов нет «formula»).
  ["endurance", /\b(lmp1|lmp2|lmp3|lmh|lmdh|lmgtp|gtp|dpi|hypercar|group c|group 6|le mans prototype|sports?car|can-?am|proto)\b/i],
  ["gt", /\b(gte|gt1|gt2|gt3|gt4|fia gt|blancpain|gt world|grand tourer|super gt|gt500|gt300)\b/i],
  ["touring", /\b(wtcc|wtcr|btcc|dtm|touring|tcr|v8 supercar|nascar|stock car)\b/i],
  ["formula", /\b(formula one|formula 1|f1|formula 2|formula 3|formula 4|fia f2|fia f3|f2|f3|f4|f3000|formula two|formula three|formula 3000|formula renault|formula regional|euroformula|gp2|gp3|indycar|indy car|champ car|super formula|a1 ?gp|auto gp|superleague|world series|nippon)\b/i],
];

export function bucketFor(category: string): TrackBucket {
  for (const [bucket, re] of BUCKET_RULES) if (re.test(category)) return bucket;
  return "other";
}

// MARK: - Очистка вики-разметки ячейки

export function cleanCell(s: string): string {
  return s
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{cvt\|([^}|]+)[^}]*\}\}/gi, "$1") // {{cvt|7.004|km|…}} → 7.004
    .replace(/\{\{[^{}]*\}\}/g, "")                 // прочие шаблоны → выкинуть
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")    // [[a|b]] → b
    .replace(/\[\[([^\]]*)\]\]/g, "$1")             // [[a]] → a
    .replace(/'''?/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// «1:44.701» → 104.701; «44.701» → 44.701. NaN если не время (голый год «2024»
// без ':'/'.'  — не время).
export function timeToSeconds(t: string): number {
  if (!/[:.]/.test(t)) return NaN;
  const m = t.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return NaN;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

// MARK: - Парс таблицы Lap records

/// Секция рекордов круга — от подходящего заголовка до следующего заголовка
/// того же/высшего уровня. Заголовок варьируется между статьями: «Lap records»,
/// «Race lap records», «Official record race lap times», «Circuit lap records».
export function lapRecordsSection(wt: string): string | null {
  const headingRe = /(^|\n)(==+)\s*([^=\n]+?)\s*\2(?!=)/g;
  let m: RegExpExecArray | null;
  let start = -1, level = 0;
  while ((m = headingRe.exec(wt))) {
    if (/(lap\s*record|record\s*lap|lap\s*time|fastest\s*lap)/i.test(m[3])) {
      start = m.index + m[0].length;
      level = m[2].length;
      break;
    }
  }
  if (start < 0) return null;
  const rest = wt.slice(start);
  const next = rest.search(new RegExp(`\\n={2,${level}}[^=]`));
  return next >= 0 ? rest.slice(0, next) : rest;
}

/// Все таблицы секции (не вложенные — у таблиц рекордов вложенности нет).
function allTables(section: string): string[] {
  const out: string[] = [];
  let idx = 0;
  for (;;) {
    const s = section.indexOf("{|", idx);
    if (s < 0) break;
    const e = section.indexOf("|}", s);
    if (e < 0) break;
    out.push(section.slice(s, e + 2));
    idx = e + 2;
  }
  return out;
}

/// Разбор рекордов: перебираем ВСЕ таблицы секции и берём ту, где больше
/// валидных строк-рекордов (в Monaco/Laguna первая таблица — история лейаутов,
/// а не рекорды). Строки-`|-`, ячейки-`||`; `! colspan` — подпись лейаута,
/// берём только рекорды текущего (первого) лейаута.
export function parseLapRecords(wt: string): { layout: string | null; records: LapRecord[] } {
  const section = lapRecordsSection(wt);
  if (!section) return { layout: null, records: [] };
  // ПЕРВАЯ таблица с рекордами (не самая большая): у части статей первая
  // таблица — история лейаутов (0 рекордов → пропускаем), а «простыня всех
  // серий» ниже сводной таблицы топ-серий не должна её вытеснять.
  for (const table of allTables(section)) {
    const parsed = parseRecordTable(table);
    if (parsed.records.length) return parsed;
  }
  return { layout: null, records: [] };
}

// Ячейка категории: начинается с названия серии/класса (якорь — чтобы не
// путать с конфигурацией лейаута «Grand Prix Circuit …»).
const CATEGORY_HINT = /^(formula|f[1-4]\b|ftwo|fthree|gp[0-9]|indy|champ car|lmp|lmh|lmdh|lm ?gt|lmgt|gtp|dpi|gt[1-4e]?\b|gte|super ?gt|super formula|world|euroformula|auto gp|touring|tcr|wtc|dtm|nascar|stock car|sports?car|prototype|group [c6]|s5000|nippon|moto|superbike|proto|renault|nissan)/i;

/// Снимает атрибуты ячейки («align=left | X», «style="…" | X» → X). Отличаем
/// разделитель-атрибут от «|» внутри вики-ссылки [[a|b]] по «=»/ключевым словам
/// в левой части.
function stripAttrs(cell: string): string {
  const i = cell.indexOf("|");
  if (i > 0 && /(=|^\s*(align|style|scope|class|colspan|rowspan|width|bgcolor|valign)\b)/i.test(cell.slice(0, i))) {
    return cell.slice(i + 1);
  }
  return cell;
}

/// Разбор одной таблицы в записи-рекорды. Колонки определяем ДИНАМИЧЕСКИ (порядок
/// между статьями разный: Spa — Category|Time|…, Monaco — …|Time|Driver|…):
/// ячейка-время ищется по виду, водитель — следующая за ней, категория — первая
/// «похожая на класс». Так же переживаем rowspan (лишние ведущие ячейки).
function parseRecordTable(table: string): { layout: string | null; records: LapRecord[] } {
  // Снимаем <ref>…</ref> ДО сплита: внутри бывают многострочные {{cite web
  // |title=…\n|url=…}}, чей «\n|» иначе рвёт строку на ячейки и теряет рекорд
  // (LMP1/LMP2/LMH/GTE у Spa именно так и пропадали).
  table = table.replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  const rows = table.split(/\n\|-/).map((r) => r.trim());
  const records: LapRecord[] = [];
  let firstLayout: string | null = null;
  let layoutCount = 0; // сколько colspan-подписей встретили

  for (const row of rows) {
    // Подпись лейаута: «! colspan=5 | <текст>». Их несколько (историч.
    // конфигурации) — берём рекорды только текущего (первого) лейаута.
    const noteM = row.match(/^!\s*colspan=?"?\d+"?\s*\|\s*([\s\S]+)/i);
    if (noteM) {
      const note = cleanCell(stripAttrs(noteM[1]));
      if (note) { layoutCount++; if (firstLayout === null) firstLayout = note; }
      continue;
    }
    if (layoutCount > 1) continue; // за пределами первого лейаута — история
    // Строка данных: начинается с «|» или «!» (rowspan-ячейка Monaco — «!»).
    if (!/^[|!]/.test(row) || /^\{\|/.test(row)) continue;
    const body = row.replace(/^[|!]/, "");
    const cells = body.split(/\|\||\n\s*[|!]/).map((c) => cleanCell(stripAttrs(c))).filter((x) => x !== "");
    if (cells.length < 3) continue;

    // Время — первая ячейка с валидным временем круга (20–900 c).
    const timeIdx = cells.findIndex((c) => { const s = timeToSeconds(c); return isFinite(s) && s > 20 && s < 900; });
    if (timeIdx < 0) continue;
    const time = cells[timeIdx];
    const seconds = timeToSeconds(time);
    // Категория — первая «класс-подобная» ячейка до времени (иначе cells[0]).
    const catIdx = cells.findIndex((c, i) => i < timeIdx && CATEGORY_HINT.test(c));
    const category = cells[catIdx >= 0 ? catIdx : 0];
    if (!category || CATEGORY_HINT.test(time)) continue;
    // Отбрасываем мусор нестандартных таблиц (Le Mans: колонки Years|Distance|
    // AvgSpeed…): категория-«год-диапазон», измерение или пусто — не гоночный
    // класс, а «время» на деле распарсенная средняя скорость.
    if (/^\d{4}(\s*[-–—]\s*(?:\d{2,4}|present))?$/i.test(category)
        || /^(since|from|before|until|c\.|circa)\b/i.test(category)
        || /\b(km|mi|mph|km\/h|kmh)\b/i.test(category)
        || category.length < 2) continue;
    const driver = cells[timeIdx + 1] ?? "";
    const vehicle = cells[timeIdx + 2] ?? "";
    // Событие — ячейка с одиночным годом, НЕ диапазон-конфиг лейаута
    // («(2015–present)», «(2003–2014)» до времени не должны подменять год гонки).
    const isRange = (c: string) => /present|[-–—]\s*(?:present|\d{4})|\d{4}\s*[-–—]/i.test(c);
    const event = cells.find((c) => /\b(19|20)\d\d\b/.test(c) && !isRange(c))
      ?? cells[cells.length - 1] ?? "";
    const yearM = event.match(/\b(19|20)\d\d\b/);
    records.push({
      category, bucket: bucketFor(category), time, seconds,
      driver, vehicle, event, year: yearM ? Number(yearM[0]) : null,
    });
  }

  records.sort((a, b) => a.seconds - b.seconds);
  return { layout: firstLayout, records };
}

// MARK: - Wikitext → плоский текст (для notable; тот же контент, что уже пришёл)

/// Грубое, но достаточное снятие разметки: таблицы/шаблоны/сноски/файлы прочь,
/// вики-ссылки → текст. Прозе секций History этого хватает для extractNotable.
export function wikitextToPlain(wt: string): string {
  let s = wt;
  s = s.replace(/\{\|[\s\S]*?\|\}/g, " ");                       // таблицы
  for (let i = 0; i < 6 && s.includes("{{"); i++) s = s.replace(/\{\{[^{}]*\}\}/g, " "); // шаблоны (вложенность)
  s = s.replace(/<ref[^>]*\/>/gi, "")
       .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
       .replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, " ");          // файлы/картинки
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")               // [[a|b]] → b
       .replace(/\[\[([^\]]*)\]\]/g, "$1");                       // [[a]] → a
  s = s.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1")           // [url label] → label
       .replace(/\[https?:\/\/\S+\]/g, "");
  s = s.replace(/'''?/g, "").replace(/<[^>]+>/g, " ");
  s = s.replace(/^=+\s*(.*?)\s*=+\s*$/gm, "$1. ");                // заголовки → «Текст.»
  s = s.replace(/^[*#:;]+\s*/gm, "");                             // маркеры списков
  return s.replace(/&nbsp;/g, " ");
}

// MARK: - Notable moments из плоского текста

const NOTABLE_KEYWORDS = /\b(killed|fatal|fatally|died|death|deaths|crash|collision|inaugural|first held|first race|opened|reopened|redesign|rebuilt|remodel|resurfac|boycott|banned|abandoned|dropped|returned|comeback|record|renamed|renovat|reconfigur|expanded|controvers|dramatic|famous|iconic|worst|tragic|disqualif|protest|red-flag|red flag|shortened|lengthened|chicane added)\b/i;
const FORMULA_HINT = /\b(formula one|formula 1|f1|grand prix|formula 2|formula 3|gp2|gp3)\b/i;
const ENDURANCE_HINT = /\b(le mans|24 hours|6 hours|endurance|wec|lmp|lmh|lmdh|sportscar|world sportscar|group c)\b/i;

/// Заметные события: предложения с годом и «сильным» словом-маркером. Год —
/// якорь и для сортировки; группа — по хинтам серий (иначе other).
export function extractNotable(plain: string, limit = 8): NotableMoment[] {
  // Режем на предложения; чистим сноски-цифры и лишние пробелы.
  const text = plain.replace(/\[\d+\]/g, "").replace(/\s+/g, " ");
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  const out: NotableMoment[] = [];
  const seen = new Set<string>();

  for (const raw of sentences) {
    const s = raw.trim();
    if (s.length < 25 || s.length > 320) continue;
    // Предложения про сам рекорд круга — не «момент» (у нас есть таблица).
    if (/\b(lap record|fastest lap|record lap|track record|all-time)\b/i.test(s)) continue;
    // Merge-артефакт стрип-разметки (внутренняя точка + строчная) — обрывки.
    if (/[.:]\s+[a-z]/.test(s)) continue;
    // Описание геометрии трассы, не событие.
    if (/^(this|it|which|here)\b/i.test(s) && /\b(corner|hairpin|straight|turn|chicane|bend|downhill|uphill|section)\b/i.test(s)) continue;
    const yearM = s.match(/\b(18|19|20)\d\d\b/);
    if (!yearM || !NOTABLE_KEYWORDS.test(s)) continue;
    const year = Number(yearM[0]);
    if (year < 1900 || year > 2100) continue;
    const key = year + "|" + s.slice(0, 40).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket: TrackBucket = ENDURANCE_HINT.test(s) ? "endurance"
      : FORMULA_HINT.test(s) ? "formula" : "other";
    out.push({ year, text: s, bucket });
  }
  out.sort((a, b) => b.year - a.year);
  return out.slice(0, limit);
}

// MARK: - Longest race (из прозы: «24 Hours of Le Mans», «12 Hours of Sebring»)

// Правдоподобные длительности эндуранс-гонок (часы) — отсекает опечатки вроде
// «25 Hours» из прозы.
const ENDURO_HOURS = new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 24]);

/// Самая длинная по длительности гонка в тексте: «24 Hours of Le Mans». Топоним
/// — только последовательность слов с заглавной (обрезает хвост «… automobile
/// race»). Скан event'ов рекордов даёт гонки ИМЕННО этой трассы; проза — фолбэк
/// (ловит Le Mans/Daytona 24h, чью таблицу не распарсить), но может подхватить
/// чужую гонку из текста, потому вторична.
export function parseLongestRace(text: string): LongestRace | null {
  const re = /\b(\d{1,2})\s*(?:-|–|—)?\s*Hours?\s+of\s+([A-ZÀ-Þ][A-Za-zÀ-ÿ'’.\-]*(?:[ -][A-ZÀ-Þ][A-Za-zÀ-ÿ'’.\-]*)*)/g;
  let m: RegExpExecArray | null;
  let best: LongestRace | null = null;
  while ((m = re.exec(text))) {
    const hours = Number(m[1]);
    if (!ENDURO_HOURS.has(hours)) continue;
    if (!best || hours > best.hours) best = { hours, name: `${hours} Hours of ${m[2].trim()}` };
  }
  return best;
}

// Ключевые слова-топонимы трассы из slug/title — чтобы проза-фолбэк не подхватил
// чужую гонку («24 Hours of Daytona» в статье Laguna Seca).
const PLACE_STOP = new Set(["circuit", "international", "raceway", "speedway",
  "motor", "park", "street", "strip", "city", "autodromo", "autódromo",
  "grand", "prix", "the", "and", "sports", "car", "complex"]);

export function placeKeywords(slug: string, title: string): string[] {
  const words = [...slug.split("-"), ...title.toLowerCase().split(/[^a-zà-ÿ]+/)]
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !PLACE_STOP.has(w));
  return [...new Set(words)];
}

// MARK: - Сборка записи из уже загруженного контента (без сети — тестируемо)

export function buildTrack(slug: string, title: string, wt: string): TrackWiki {
  const { layout, records } = parseLapRecords(wt);
  const plain = wikitextToPlain(wt);
  const notable = extractNotable(plain);
  // Длиннейшая гонка: приоритет — event'ы рекордов (гонки ИМЕННО этой трассы,
  // без фильтра). Фолбэк — проза (для Le Mans/Daytona, чьи таблицы особые), но
  // только если топоним совпадает с трассой (иначе подхватит чужую гонку).
  let longestRace = parseLongestRace(records.map((r) => r.event ?? "").join(" \n "));
  if (!longestRace) {
    const p = parseLongestRace(plain);
    const kw = placeKeywords(slug, title);
    if (p && kw.some((k) => p.name.toLowerCase().includes(k))) longestRace = p;
  }
  const fastest: Partial<Record<TrackBucket, LapRecord>> = {};
  for (const r of records) if (!fastest[r.bucket]) fastest[r.bucket] = r; // records отсортированы
  return {
    wikiTitle: title,
    wikiURL: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    layout, records, fastest, longestRace, notable,
  };
}

// MARK: - Батч-загрузка из вики

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/// GET с ретраями: вики троттлит («too many requests» отдаётся телом при 200) —
/// повторяем с растущей паузой. Батчинг снижает число запросов до пары.
async function getJSON(url: string, tries = 5): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    const r = await fetchText(url + "&maxlag=5");
    if (r && r.status === 200 && r.text.trimStart().startsWith("{")) {
      try { return JSON.parse(r.text); } catch { /* повтор */ }
    }
    await sleep(2000 * (i + 1)); // 2s, 4s, 6s …
  }
  return null;
}

interface PageContent { title: string; wt: string; }

/// Проводит запрошенный заголовок через цепочки normalized→redirects к тому,
/// под которым лежит страница в ответе.
function resolveTitle(requested: string, j: any): string {
  const hop = (t: string, arr: any[]) => arr?.find((x) => x.from === t)?.to ?? t;
  let t = hop(requested, j?.query?.normalized ?? []);
  t = hop(t, j?.query?.redirects ?? []);
  t = hop(t, j?.query?.normalized ?? []); // redirect может дать ненормализованное
  return t;
}

// MARK: - Прогон

async function main() {
  const only = process.env.TRACKS_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
  const entries = Object.entries(TRACKS).filter(([slug]) => !only || only.includes(slug));

  const index: Record<string, TrackWiki> = {};
  let ok = 0, empty = 0, failed = 0;
  const CHUNK = 20;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const url = `${API}?action=query&prop=revisions&rvprop=content&rvslots=main`
      + `&redirects=1&format=json`
      + `&titles=${chunk.map(([, t]) => encodeURIComponent(t)).join("%7C")}`;
    const j = await getJSON(url);
    const byTitle = new Map<string, PageContent>();
    for (const p of Object.values<any>(j?.query?.pages ?? {})) {
      if (p.missing !== undefined) continue;
      byTitle.set(p.title, { title: p.title, wt: p.revisions?.[0]?.slots?.main?.["*"] ?? "" });
    }
    for (const [slug, title] of chunk) {
      const resolved = resolveTitle(title, j);
      const page = byTitle.get(resolved) ?? byTitle.get(title);
      if (!page || !page.wt) { console.warn(`  ✗ ${slug} (${title}) — не загрузилась`); failed++; continue; }
      const t = buildTrack(slug, page.title, page.wt);
      index[slug] = t;
      const nf = Object.keys(t.fastest).length;
      console.log(`  ✓ ${slug}: ${t.records.length} рекордов (${nf} групп), ${t.notable.length} moments`);
      t.records.length ? ok++ : empty++;
    }
    if (i + CHUNK < entries.length) await sleep(PAUSE_MS);
  }

  mkdirSync(join(process.cwd(), "data", "tracks"), { recursive: true });
  const wrote = writeIfChanged(OUT_PATH, JSON.stringify(index, null, 2) + "\n");
  console.log(`tracks: ${ok} с рекордами, ${empty} без рекордов, ${failed} не загрузились; файл ${wrote ? "обновлён" : "без изменений"}`);
}

// Запуск только как producer (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
