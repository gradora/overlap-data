export const FIA_ORIGIN = "https://www.fia.com";
// Стабильный узел чемпионата F1 («-14» год-инвариантен, в отличие от season-node).
export const CHAMPIONSHIP_URL =
  `${FIA_ORIGIN}/documents/championships/fia-formula-one-world-championship-14`;

// Парс-ядро документов стюардов FIA: типы вывода (зеркалят модель приложения
// FIAPenalties), разбор doc-листа/PDF-текста, классификация решений, сезонные
// хелперы. Чистые функции без сети — их делят продьюсеры fia/wecfia/imsafia
// (раньше wecfia/imsafia импортировали продьюсер fia целиком, тянув его
// module-body). Оркестрация (скрейп, PDF-извлечение, запись) — producers/fia.ts.

// ---- Типы вывода (зеркалят модель приложения FIAPenalties) ----

export type PenaltyType =
  | "grid" | "time" | "dsq" | "reprimand" | "warning" | "fine" | "deleted_laps" | "none" | "other";

export interface FiaPenalty {
  doc: number;                 // номер документа стюардов
  parser?: number;             // версия парсера, которой разобрана ЭТА запись
  car: number;
  driver: string;
  session: string;             // где случилось нарушение (напр. «Free Practice 1»)
  type: PenaltyType;
  gridDrop?: number;           // type=grid: на сколько позиций назад
  seconds?: number;            // type=time: секунд к результату
  pitlane?: boolean;           // type=grid: старт с питлейна
  backOfGrid?: boolean;        // type=grid: старт с конца решётки
  appliesTo: string;           // «race» | «next_race» | «qualifying» | …: к чему применить
  corrected: boolean;          // документ «Corrected Infringement» — заменяет ранний
  carriedFrom?: number;        // перенесён из раунда N (грид-штраф «на следующую гонку»)
  fact?: string;
  decision: string;
  url: string;
  publishedAt?: string;
}

export interface FiaGridEntry {
  position: number;
  car: number;
}

export interface FiaStartingGrid {
  kind: "provisional" | "final";
  doc: number;
  parser?: number;             // версия парсера, которой разобрана эта решётка
  entries: FiaGridEntry[];
  penaltySummary: { car: number; text: string; doc: number }[];
  url: string;
  publishedAt?: string;
}

export interface FiaEvent {
  season: number;
  round: number;
  event: string;
  updated?: string;
  penalties: FiaPenalty[];
  startingGrid?: FiaStartingGrid;
}

export interface DocRef {
  doc: number;
  title: string;
  url: string;
  publishedAt?: string;
}

// ---- Парсинг списка документов (server-rendered HTML) ----

// «18.07.26 17:23» → «2026-07-18 17:23 CET» (сортируемо + читаемо).
export function normalizePublished(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}:\d{2})/);
  if (!m) return undefined;
  return `20${m[3]}-${m[2]}-${m[1]} ${m[4]} CET`;
}

export function parseDocList(html: string): DocRef[] {
  // Структурно-агностично: FIA рендерит строки документов в ДВУХ вариантах —
  // верхние (свежие) плоские, старые обёрнуты в Drupal field-дивы
  // (<div class="title"><div class="field…"><div class="field-item even">Doc N…).
  // Поэтому режем на строки по <li class="document-row», снимаем теги и тянем
  // «Doc N - Title» + дату из <span class="date-display-single">.
  const out: DocRef[] = [];
  for (const row of html.split(/<li class="document-row/i).slice(1)) {
    const urlM = row.match(/href="(\/system\/files\/decision-document\/[^"]+\.pdf)"/i);
    if (!urlM) continue;
    const text = row.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const titleM = text.match(/Doc\s+(\d+)\s*-\s*(.+?)\s*(?:Published on|$)/i);
    if (!titleM) continue;
    const dateM =
      row.match(/date-display-single"?\s*>\s*([^<]+?)\s*</i) ??
      text.match(/Published on\s+(\d{2}\.\d{2}\.\d{2}\s+\d{2}:\d{2})/i);
    out.push({
      doc: Number(titleM[1]),
      title: titleM[2].trim(),
      url: FIA_ORIGIN + urlM[1],
      publishedAt: dateM ? normalizePublished(dateM[1]) : undefined,
    });
  }
  return out;
}

// «…/decision-document/2026_belgian_grand_prix_-_infringement…» → «belgian_grand_prix».
// Дефис в классе символов — ради слагов вида «barcelona-catalunya_grand_prix».
export function eventSlugFromUrl(url: string): string | null {
  const m = url.match(/decision-document\/\d{4}_([a-z0-9_-]+?)_-_/i);
  return m ? m[1].toLowerCase() : null;
}

// На странице чемпионата — селектор сезонов со ссылками
// «…/fia-formula-one-world-championship-14/season/season-<year>-<nodeid>».
// Возвращаем URL сезона за `year` (node-id выводится из ЖИВОЙ страницы, не
// хардкод). Regex ЗАЯКОРЕН на путь чемпионата-14: иначе `season-2025-2026`
// (двухлетний сезон Formula E в общей навигации FIA) ложно совпал бы с
// шаблоном season-<year>-<nodeid> и увёл бы на чужой чемпионат.
export function findSeasonUrl(championshipHtml: string, year: number): string | null {
  const m = championshipHtml.match(
    new RegExp(`fia-formula-one-world-championship-14/season/(season-${year}-\\d+)`, "i"),
  );
  return m ? `${CHAMPIONSHIP_URL}/season/${m[1]}` : null;
}

// Штрафной документ по одной машине: тип-решение + «Car N» в заголовке.
// Мульти-машинные (напр. «Free Practice 3 Deleted Lap Times») и Summons/
// Classification/Scrutineering/Notes/Grid — не сюда.
export function isPenaltyDoc(title: string): boolean {
  if (/summons|classification|scrutineer|starting grid|director notes|new pu elements|post-\w+ procedure/i.test(title)) {
    return false;
  }
  return /(infringement|decision|offence|penalty)/i.test(title) && /car\s+\d+/i.test(title);
}

// ---- Парсинг штрафного/Decision PDF (шаблон стюардов) ----

// ВЕРСИЯ ПАРСЕРОВ — БАМПАТЬ ПРИ ЛЮБОЙ СМЫСЛОВОЙ ПРАВКЕ разбора PDF:
// parsePenaltyDoc / classifyDecision / appliesTo / fieldValue / isPenaltyDoc /
// parseStartingGridDoc. Продьюсер fia.ts перестал перекачивать документы,
// которые уже разобраны в файле раунда, — и без бампа правка парсера НЕ ДОЙДЁТ
// до старых решений: они так и останутся с прежней классификацией.
//
// В истории репозитория такое требовалось минимум трижды и каждый раз было
// правильным: «other → fine» (2026_1 doc 41/42), «other → warning» (2026_11
// doc 19), «слот решётки без лаптайма» (2026_10 startingGrid, 21 → 22 записи).
//
// Версия ставится КАЖДОЙ записи (penalty.parser, startingGrid.parser), а не
// файлу целиком. Файловая метка была «всё или ничего»: одна неудачная закачка
// документа, который уже лежит в файле, не давала пометить файл, и следующий
// прогон снова качал ВСЕ полсотни PDF. По истории data/f1/fia/2026_12.json из
// 40 ревизий 13 — прогоны с массовыми отказами, то есть именно на уик-энде
// докач мог не включиться часами; тем же ломался рецепт
// FIA_FORCE=1 FIA_BACKFILL=99 (форсированный прогон с одной осечкой не
// фиксировал прогресс ни по одному документу). Пометка на записи — это правда
// о самой записи: она переживает слияние без бухгалтерии на стороне файла,
// и прогресс идёт подокументно. Цена — по строке «parser» на запись.
//
// Бамп снимает пропуск только там, где раунд вообще перечитывается, то есть
// внутри окна оседания. Замороженную историю пересобирают руками:
//   FIA_FORCE=1 FIA_BACKFILL=99 npm run fia
// v2 — деньги подняты выше выговора и предупреждения в classifyDecision:
// решение с формальным предупреждением И штрафом писалось как «warning», и
// сумма терялась (4 случая в корпусе, включая €10 000 Red Bull).
export const PENALTY_PARSER_VERSION = 2;

const BODY_ANCHOR = "determine the following:";
// Метки полей в порядке появления (Offence — синоним Infringement у части доков).
const FIELD_LABELS = [
  "No / Driver", "Competitor", "Time", "Session", "Fact",
  "Offence", "Infringement", "Decision", "Reason",
];

// Значение поля `label` = текст до ближайшей ПОЗДНЕЙ метки шаблона. Ранние
// метки значение резать не должны: они уже встретились ДО этого поля, а их
// слова живут и внутри текстов — «…on condition that the Competitor…» в
// Decision обрезался на слове Competitor (штраф Хэмилтона, Спа-2026 doc 63),
// «Lap Time» в Fact — на слове Time. Обобщено под список меток: тем же
// механизмом парсится шаблон стюардов WEC (wecfia.ts, метки с двоеточиями).
export function fieldValue(body: string, label: string, labels: string[]): string | null {
  const start = body.indexOf(label + " ");
  if (start < 0) return null;
  const from = start + label.length + 1;
  let end = body.length;
  for (const nl of labels.slice(labels.indexOf(label) + 1)) {
    const i = body.indexOf(" " + nl + " ", from);
    if (i >= 0 && i < end) end = i;
  }
  return body.slice(from, end).trim();
}

function field(body: string, label: string): string | null {
  return fieldValue(body, label, FIELD_LABELS);
}

// Классифицируем поле Decision генерически (от причины не зависит).
//
// Каскад — «первое совпадение выигрывает», а решение может нести НЕСКОЛЬКО
// санкций сразу (в корпусе таких 9 из 442). Значит порядок веток — это не
// стиль, а правило: выше должна стоять более МАТЕРИАЛЬНАЯ санкция, иначе
// младшая молча съедает старшую и та не доезжает до приложения.
//
// Порядок по убыванию материальности:
//   none            — явный отказ от санкции, всегда первым (это отрицание)
//   grid / time     — меняют результат гонки
//   dsq             — снимает результат
//   fine            — деньги: материальная санкция
//   reprimand       — накапливается (три выговора = грид-дроп)
//   warning         — формальность, последствий не несёт
//   deleted_laps    — служит уточнением к квале
//
// Ровно на границе fine/warning каскад и ломался: ветку warning завели в июле
// ВЫШЕ денег, и «Competitor: Formal warning A fine of €5,000 is also imposed»
// (Монако-2026 doc 60, Албон) стал предупреждением — штраф исчезал и из
// карточки RACE CONTROL, где деньги отбираются по type == "fine", и отовсюду.
// В корпусе такая пара встречается 4 раза.
export function classifyDecision(decision: string): {
  type: PenaltyType; gridDrop?: number; seconds?: number; pitlane?: boolean; backOfGrid?: boolean;
} {
  const d = decision.toLowerCase();
  if (/no further action|no penalty|take no further|not to take any/.test(d)) return { type: "none" };
  let m: RegExpMatchArray | null;
  if ((m = d.match(/drop of (\d+) grid position/))) return { type: "grid", gridDrop: Number(m[1]) };
  if ((m = d.match(/(\d+) grid (?:place|position)s? penalty/))) return { type: "grid", gridDrop: Number(m[1]) };
  // «start from the pit lane» и вариант со вставкой сессии: «required to start
  // the Race/Sprint from the pit lane» (Китай-2026, Албон doc 68).
  if (/start(?:ing)?(?: the \w+)? from the pit ?lane|pit ?lane start/.test(d)) return { type: "grid", pitlane: true };
  if (/back of the (?:starting )?grid/.test(d)) return { type: "grid", backOfGrid: true };
  if ((m = d.match(/(\d+)\s*second(?:s)? time penalty/))) return { type: "time", seconds: Number(m[1]) };
  // WEC: «10 seconds added at the next pit stop» — время к следующему питу.
  if ((m = d.match(/(\d+)\s*second(?:s)? added/))) return { type: "time", seconds: Number(m[1]) };
  if (/disqualif|excluded from/.test(d)) return { type: "dsq" };
  // Деньги — ВЫШЕ выговора и предупреждения: решение часто несёт формальное
  // предупреждение вместе со штрафом, и материальна тут именно сумма.
  if (/fine of|fined/.test(d)) return { type: "fine" };
  if (/reprimand/.test(d)) return { type: "reprimand" };
  // «Driver: Warning.» — стюардовское предупреждение (напр. за дельту SC2-SC1);
  // на результат не влияет, но должно доходить до приложения, а не в "other".
  if (/\bwarning\b/.test(d)) return { type: "warning" };
  if (/lap ?time.*delet|deletion of.*lap|deleted lap/.test(d)) return { type: "deleted_laps" };
  return { type: "other" };
}

export function appliesTo(decision: string, session: string): string {
  // Спринт — раньше race-паттернов: «start the Sprint from the pit lane»
  // относится к решётке СПРИНТА, не гонки (Сильверстоун-2026, Албон doc 35).
  if (/the sprint\b|sprint in which/i.test(decision)) return "sprint";
  if (/next race|the race\b|race in which/i.test(decision)) return "race";
  const s = session.toLowerCase();
  if (/qualif/.test(s)) return "qualifying";
  if (/sprint/.test(s)) return "sprint";
  if (/race/.test(s)) return "race";
  return session || "race";
}

export function parsePenaltyDoc(text: string, ref: DocRef): FiaPenalty | null {
  const anchor = text.indexOf(BODY_ANCHOR);
  const body = anchor >= 0 ? text.slice(anchor + BODY_ANCHOR.length) : text;

  const driverLine = field(body, "No / Driver");
  const decision = field(body, "Decision");
  if (!driverLine || !decision) return null;

  const dm = driverLine.match(/^(\d+)\s*-\s*(.+?)\s*$/);
  if (!dm) return null;
  const car = Number(dm[1]);
  const driver = dm[2];
  const session = field(body, "Session") ?? "";
  const fact = field(body, "Fact") ?? undefined;
  const cls = classifyDecision(decision);

  return {
    doc: ref.doc,
    parser: PENALTY_PARSER_VERSION,
    car,
    driver,
    session,
    type: cls.type,
    ...(cls.gridDrop != null ? { gridDrop: cls.gridDrop } : {}),
    ...(cls.seconds != null ? { seconds: cls.seconds } : {}),
    ...(cls.pitlane ? { pitlane: true } : {}),
    ...(cls.backOfGrid ? { backOfGrid: true } : {}),
    appliesTo: appliesTo(decision, session),
    corrected: /corrected/i.test(ref.title),
    fact,
    decision,
    url: ref.url,
    publishedAt: ref.publishedAt,
  };
}

// ---- Парсинг официального Starting Grid PDF ----

export function parseStartingGridDoc(text: string, ref: DocRef): FiaStartingGrid | null {
  const kind: "provisional" | "final" = /provisional starting grid/i.test(text)
    ? "provisional"
    : "final";

  const penIdx = text.search(/\*\s*PENALTIES/i);
  const gridRegion = penIdx >= 0 ? text.slice(0, penIdx) : text;
  const penRegion = penIdx >= 0 ? text.slice(penIdx) : "";

  // Каждый слот решётки: «<поз> <№> Имя ФАМИЛИЯ [*] Команда [<лаптайм>]».
  // Якорь — НАЧАЛО слота «<поз> <№> Имя» (номер+номер+заглавная-строчная имени),
  // НЕ хвост-лаптайм: у машин без времени (штраф/старт с конца, напр. «21 6
  // Isack HADJAR *» без лаптайма) хвостовой якорь «проглатывал» следующий слот
  // (терялся, скажем, Ферстаппен на P2). Из слота берём позицию и номер машины
  // (пилот/команда джойнятся приложением по номеру).
  const entries: FiaGridEntry[] = [];
  const eRe = /(\d{1,2})\s+(\d{1,2})\s+[A-Z][a-zà-ÿ]/g;
  let em: RegExpExecArray | null;
  while ((em = eRe.exec(gridRegion))) {
    entries.push({ position: Number(em[1]), car: Number(em[2]) });
  }
  entries.sort((a, b) => a.position - b.position);

  // Сводка пенальти: «Car N - <текст> - Stewards' document no. NN».
  const penaltySummary: { car: number; text: string; doc: number }[] = [];
  const pRe = /Car\s+(\d+)\s*-\s*(.+?)\s*-\s*Stewards['’]\s*document\s*no\.?\s*(\d+)/gi;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(penRegion))) {
    penaltySummary.push({ car: Number(pm[1]), text: pm[2].trim(), doc: Number(pm[3]) });
  }

  if (!entries.length) return null;
  return {
    kind, doc: ref.doc, parser: PENALTY_PARSER_VERSION,
    entries, penaltySummary, url: ref.url, publishedAt: ref.publishedAt,
  };
}

// ---- Маппинг этап-slug → round (из зеркала расписания Jolpica) ----

export function slugifyRace(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Селектор этапов на странице сезона: option-ссылки «…/season/…/event/<Name>».
// Даёт per-event страницы документов — основа бэкфилла прошлых этапов.
export function parseEventOptions(html: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  const re = /<option value="(\/documents\/championships\/fia-formula-one-world-championship-14\/season\/[^"]+\/event\/[^"]+)"[^>]*>([^<]+)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ url: FIA_ORIGIN + m[1], name: m[2].trim() });
  return out;
}

// Тестовые уик-энды FIA держит на той же сезонной странице, что и этапы
// («Bahrain Tests Season 2025»), а сопоставление идёт по ПРЕФИКСУ СТРАНЫ —
// иначе не сойдутся имена FIA и Jolpica («Barcelona-Catalunya» против
// «Spanish»). В паре это било насмерть: тест в Бахрейне матчился на R4, guard
// чужого этапа сбрасывал накопленное, а штрафных документов у теста нет — и
// поверх двенадцати решений Гран-при Бахрейна-2025 ложился пустой файл.
const TESTING_SLUG = /(^|_)tests?(_|$)|(^|_)testing(_|$)/;

export function matchRound(
  eventSlug: string,
  races: { round: string; date: string; time?: string; raceName: string }[],
): { round: number; raceDate: string; raceTime?: string } | null {
  if (TESTING_SLUG.test(eventSlug)) return null;   // тест — не этап чемпионата
  const country = eventSlug.split("_")[0];
  for (const r of races) {
    const slug = slugifyRace(r.raceName);
    if (slug === eventSlug || slug.startsWith(country + "_") || slug === country) {
      return { round: Number(r.round), raceDate: r.date, raceTime: r.time };
    }
  }
  return null;
}

// Год из сезонного URL FIA («…/season/season-2026-2072» → 2026) — для guard'а
// протухшего фолбэка.
export function seasonUrlYear(url: string): number | null {
  const m = url.match(/season-(\d{4})-\d+/);
  return m ? Number(m[1]) : null;
}

// Финальный раунд сезона по существующим файлам «<season>_<round>.json» —
// источник кросс-сезонного carryOver для R1 (перенос «на следующую гонку»
// через межсезонье).
export function finalRoundFile(files: string[], season: number): string | null {
  let best: number | null = null;
  for (const f of files) {
    const m = f.match(new RegExp(`^${season}_(\\d+)\\.json$`));
    if (m) best = Math.max(best ?? 0, Number(m[1]));
  }
  return best != null ? `${season}_${best}.json` : null;
}

// ---- «Эта гонка vs следующая»: классификация по времени публикации ----

// Старт гонки (UTC из Jolpica) → парижский wall-clock «YYYY-MM-DD HH:mm».
// publishedAt у FIA — женевские/парижские часы с меткой «CET» круглый год
// (лейбл неточен летом), поэтому сравниваем ИМЕННО wall-clock с wall-clock
// лексикографически — смещение CET/CEST выпадает из уравнения.
export function raceStartWall(raceDate: string, raceTime?: string): string | null {
  if (!raceTime) return null;
  const d = new Date(`${raceDate}T${raceTime}`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("sv-SE", { timeZone: "Europe/Paris" }).slice(0, 16);
}

// Грид-штраф, опубликованный ПОСЛЕ старта гонки, к этой гонке физически
// неприменим (решётка отработана) — это перенос «на следующую гонку, в которой
// пилот участвует». Помечаем appliesTo=next_race: приложение не применяет его
// к решётке текущего этапа, а продьюсер следующего раунда заберёт (carryOver).
// Без publishedAt / без времени гонки — не трогаем (толерантно, как раньше).
//
// Применяется к ИТОГУ слияния, а не к разобранному за прогон: с докачом решения
// из файла больше не перечитываются, и разовая классификация «на момент первого
// разбора» зафиксировалась бы навсегда. Типичный сбой: у Jolpica ещё нет
// raceTime → raceStartWall = null → функция no-op → грид-штраф остался «race» и
// не переехал в следующий раунд.
//
// Метка ставится В ОБЕ СТОРОНЫ — иначе «самолечение» одностороннее. Пока PDF
// перепарсивался каждый прогон, ошибочный next_race сам исчезал при следующем
// разборе; с докачом функция работает по записи ИЗ ФАЙЛА, и раннее (или
// плейсхолдерное) время старта у Jolpica заклинивало бы пометку навсегда:
// время потом исправляли, а штраф так и уезжал carryOver'ом в следующий раунд.
// Двусторонний пересчёт от wall делает результат функцией только входа —
// идемпотентно и с откатом.
//
/// Публиковать ли ПЕРВЫЙ сбор раунда, или лучше не создавать файл вовсе.
///
/// Слияние спасает только то, что уже лежит в файле. Когда файла нет, осечка
/// закачки — это дыра, которую запись увековечивает: бэкфилл смотрит ровно на
/// существование файла, поэтому у ЗАМОРОЖЕННОГО раунда второго шанса не будет
/// никогда (R11 Hungarian 2026: 5 из 13 PDF отдали 503 → в файл легли 8
/// решений, доки 19, 21, 36, 54, 57 потеряны насовсем).
///
/// Но блокировать можно ТОЛЬКО по возвратным осечкам. Документ, чей шаблон
/// парсер не знает, не дастся никогда — по таким раунд не собрался бы вовсе
/// (в 2026 их 14 на шести раундах), а рецепт «удали файл и прогони заново»
/// стал бы разрушительным. Их лечит бамп PENALTY_PARSER_VERSION, а не повтор.
export function skipFirstWrite(hasExisting: boolean, retriableFailures: number): boolean {
  return !hasExisting && retriableFailures > 0;
}

// Трогаем ТОЛЬКО appliesTo ∈ {race, next_race}: это одно и то же «к какой гонке
// применить», и переключать между ними безопасно. Всё остальное — чужие
// пространства решений; в первую очередь «sprint» (в истории 18 записей —
// грид-штрафы решётки СПРИНТА), который иначе затёрся бы в next_race.
//
// Переносы (carriedFrom) исключены: carryOver уже перевёл их в appliesTo=race
// для ТЕКУЩЕГО раунда, и щелчок обратно в next_race гнал бы их дальше вечно.
export function markNextRace(penalties: FiaPenalty[], wall: string | null): FiaPenalty[] {
  if (!wall) return penalties;
  return penalties.map((p) => {
    if (p.carriedFrom != null || p.type !== "grid" || !p.publishedAt) return p;
    if (p.appliesTo !== "race" && p.appliesTo !== "next_race") return p;
    const applies = p.publishedAt.slice(0, 16) >= wall ? "next_race" : "race";
    return applies === p.appliesTo ? p : { ...p, appliesTo: applies };
  });
}

// ---- Инкрементальный докач: какие PDF можно не перекачивать ----

// Раньше файл раунда пересобирался заново каждый прогон, поэтому и качать
// приходилось ВСЁ: 19 штрафных PDF Зандфорта + решётка = ~20 закачек в час,
// ~80/час на уик-энде. С mergeFiaEvent файл накапливается, и прогон может
// тянуть только те документы, которых в нём ещё нет.
//
// Пропуск безопасен, потому что он ничего не РЕШАЕТ: файл только накапливается,
// удалений нет вовсе (см. mergeFiaEvent). Пропущенный документ остаётся в файле
// таким, каким был разобран, и худшее, что делает ошибочный пропуск, — задержку
// обновления записи до следующей смены отпечатка или бампа версии парсера.
//
// Отпечаток документа — бесплатный, целиком из списка: url + publishedAt +
// «Corrected» в заголовке. По всей истории репозитория ни один уже записанный
// документ не менял ни url, ни publishedAt — ложных перекачек отпечаток не даёт,
// но будущую подмену по тому же URL ловит даром.
//
// Версия парсера сверяется У КАЖДОЙ ЗАПИСИ (p.parser), а не у файла: см.
// PENALTY_PARSER_VERSION — файловая метка делала бутстрап «всё или ничего».
//
// Фильтр carriedFrom == null — не косметика: перенос R11 doc 60 и собственный
// doc 60 текущего этапа живут в разных ключевых пространствах (penaltyKey), и
// без фильтра перенос подавил бы закачку собственного документа с тем же номером.

export interface FetchPlan {
  fetch: DocRef[];        // качаем и парсим
  reused: FiaPenalty[];   // не качаем: эквивалент уже лежит в файле
  restamp: number;        // из fetch: лежат в файле, но разобраны другой версией парсера
}

const sameDoc = (p: FiaPenalty, d: DocRef): boolean =>
  p.url === d.url && p.publishedAt === d.publishedAt && p.corrected === /corrected/i.test(d.title);

/// Разложить штрафные документы списка на «качать» и «взять из файла».
/// force (FIA_FORCE=1) отключает пропуск целиком; смена версии парсера — для
/// тех записей, которые разобраны прежней версией.
export function planPenaltyFetches(
  prev: FiaEvent | null,
  listed: DocRef[],
  force: boolean,
): FetchPlan {
  const plan: FetchPlan = { fetch: [], reused: [], restamp: 0 };
  const known = new Map<number, FiaPenalty>();
  if (prev) for (const p of prev.penalties) if (p.carriedFrom == null) known.set(p.doc, p);
  for (const d of listed) {
    const p = known.get(d.doc);
    if (!force && p && p.parser === PENALTY_PARSER_VERSION && sameDoc(p, d)) {
      plan.reused.push(p);
      continue;
    }
    if (!force && p && p.parser !== PENALTY_PARSER_VERSION) plan.restamp++;
    plan.fetch.push(d);
  }
  return plan;
}

// Решётка. «Стало final — больше не качаем» НЕПРАВИЛЬНО: на спринтовых уик-эндах
// final→final под другим номером — норма (2026_12: provisional 25 спринта →
// final 32 спринта → final 61 гонки), и такое правило заморозило бы в файле
// спринтовую решётку. Provisional→Final тоже всегда меняет номер документа,
// поэтому ключ по номеру покрывает апгрейд, а отпечаток — переиздание.
//
// Версия парсера — у самой решётки (g.parser): решётка живёт в файле рядом со
// штрафами, но качается и стареет отдельно от них.
export function canReuseGrid(
  prev: FiaEvent | null,
  gridDoc: DocRef | null | undefined,
  force: boolean,
): boolean {
  const g = prev?.startingGrid;
  if (force || !g || !gridDoc || g.parser !== PENALTY_PARSER_VERSION) return false;
  return g.doc === gridDoc.doc && g.url === gridDoc.url && g.publishedAt === gridDoc.publishedAt;
}

// ---- Слияние прогона с уже собранным файлом раунда ----

/// Итог ОДНОГО прогона скрейпа раунда — вход слияния.
export interface FiaScrape {
  penalties: FiaPenalty[];        // разобранные в ЭТОМ прогоне решения раунда
  carried: FiaPenalty[];          // перенос из предыдущего раунда (carryOver)
  startingGrid?: FiaStartingGrid; // распарсенная в этом прогоне решётка (если далась)
  // Номера штрафных доков, которые СЕЙЧАС видны на странице FIA. Ничего не
  // авторизуют — нужны ровно для того, чтобы заметить и громко залогировать
  // пропажу документа, который в файле уже есть (см. FiaMerge.missing).
  listedDocs: number[];
}

export interface FiaMerge {
  penalties: FiaPenalty[];
  startingGrid?: FiaStartingGrid;
  updated?: string;
  kept: number;        // решений взято из прежнего файла (в прогоне не перечитывались)
  missing: number[];   // есть в файле, но пропали со страницы FIA — ОСТАВЛЕНЫ, только лог
}

// Ключ решения. Переносы (carriedFrom) живут в своём пространстве: doc-номера
// разных уик-эндов совпадают запросто, и перенос R11 doc 60 не должен
// затирать собственный doc 60 текущего этапа.
const penaltyKey = (p: FiaPenalty): string => `${p.carriedFrom ?? "self"}#${p.doc}`;

// Файл раунда НАКАПЛИВАЕТСЯ, а не перезаписывается итогом последнего прогона:
// FIA держит на этапе полсотни PDF, и осечка на девяти из них (Zandvoort-2026,
// R12: 11 решений → 2) стирала уже собранные штрафы прямо во время уик-энда.
//
// Правила:
// * решения свои (не переносы) сливаются по номеру документа — свежий разбор
//   побеждает для того же doc (так «Corrected …» под тем же номером обновляет
//   запись), а не прочитанное в этом прогоне остаётся из файла;
// * дубли «Infringement + Corrected Infringement» под РАЗНЫМИ номерами живут
//   в файле оба, как и раньше: их схлопывает приложение (FIAPenaltyApplier);
// * переносы всегда пересобираются свежим carryOver — он читает локальный файл
//   предыдущего раунда, сеть тут ни при чём, стареть нечему;
// * СВОИ решения не удаляются НИКОГДА — только накапливаются (см. ниже);
// * решётка не теряется при осечке PDF и НЕ откатывается final → provisional.
//
// Почему удаления нет вовсе. Правило «документ пропал со страницы FIA → он
// отозван, убираем» решало несуществующую задачу: по всей истории репозитория
// НЕ БЫЛО НИ ОДНОГО настоящего отзыва документа. Все 220 случаев исчезновения
// решения из файла — следы прежнего бага с перезаписью (18→0, 11→1, 12→0),
// а не действия FIA. Цена же — катастрофический отказ: страница этапа,
// отдавшая 3 строки из 19 (деградация fia.com, смена вёрстки, частичный парс),
// авторизовала бы удаление 16 собранных решений; раньше от этого случайно
// защищали неудачные закачки PDF, а с докачом качать может быть нечего вообще,
// и «прогон без осечек» стал выполняться тривиально.
// Поэтому пропажа теперь только ГРОМКО ЛОГИРУЕТСЯ (missing) — разбирается
// глазами. Если документ и правда отозван, вычистить его можно ТОЛЬКО удалив
// файл раунда и прогнав продьюсер заново: FIA_FORCE=1 перекачивает документы,
// но сюда не доходит вовсе — слияние сохраняет всё из prev.penalties
// безусловно, и фантомная запись пережила бы любой форсированный прогон.
export function mergeFiaEvent(prev: FiaEvent | null, fresh: FiaScrape): FiaMerge {
  const listed = new Set(fresh.listedDocs);
  const byKey = new Map<string, FiaPenalty>();
  const missing: number[] = [];

  for (const p of prev?.penalties ?? []) {
    if (p.carriedFrom != null) continue;          // переносы — ниже, из свежего carryOver
    if (!listed.has(p.doc)) missing.push(p.doc);  // пропал со страницы — но остаётся в файле
    byKey.set(penaltyKey(p), p);
  }
  const fromFile = [...byKey.keys()];
  const freshKeys = new Set(fresh.penalties.map(penaltyKey));
  for (const p of fresh.penalties) byKey.set(penaltyKey(p), p);
  const kept = fromFile.filter((k) => !freshKeys.has(k)).length;   // пережили прогон «как были»

  const own = [...byKey.values()].sort((a, b) => a.doc - b.doc);
  const penalties = [...own, ...fresh.carried];

  // Решётка: свежая берётся, только если это не откат final → provisional
  // (Final публикуется после Provisional и учитывает штрафы — он финальнее).
  const prevGrid = prev?.startingGrid;
  const downgrade = prevGrid?.kind === "final" && fresh.startingGrid?.kind === "provisional";
  const startingGrid = downgrade ? prevGrid : (fresh.startingGrid ?? prevGrid);

  const updated = [...penalties.map((p) => p.publishedAt), startingGrid?.publishedAt]
    .filter((x): x is string => !!x)
    .sort()
    .pop();

  return {
    penalties,
    ...(startingGrid ? { startingGrid } : {}),
    ...(updated ? { updated } : {}),
    kept,
    missing: missing.sort((a, b) => a - b),
  };
}

// Перенос из предыдущего раунда: его next_race-грид-штрафы становятся
// обычными race-штрафами текущего, с пометкой carriedFrom (по ней приложение
// не считает их «поздними» — doc-номера разных уик-эндов несравнимы, а FIA
// заведомо учтёт перенос при составлении решётки нового этапа).
//
// Перенос идёт ТОЛЬКО в раунд, старт которого позже публикации решения.
// Безусловный перенос был безопасен, пока раунд замерзал через 7 дней: поздний
// вердикт просто не попадал в файл. Со стюардским окном 14 дней он попадает, и
// на back-to-back парах (в календаре-2026 их девять) гонка N+1 к этому моменту
// уже проехана — штраф лёг бы на решётку ВЧЕРАШНЕЙ гонки. Сравнение то же, что
// у markNextRace: wall-clock с wall-clock (Париж), лексикографически.
//
// `late` — то, что не перенеслось: продьюсер логирует его громко, потому что
// дальше R+2 такой вердикт сам не уедет (carryOver смотрит ровно на один
// предыдущий файл) — это случай для ручного разбора.
export interface CarryOverPlan {
  carried: FiaPenalty[];   // переносим в текущий раунд
  late: FiaPenalty[];      // вердикт опубликован уже ПОСЛЕ старта текущего раунда
}

export function carryOver(prev: FiaEvent | null, targetStartWall: string | null): CarryOverPlan {
  const plan: CarryOverPlan = { carried: [], late: [] };
  if (!prev) return plan;
  for (const p of prev.penalties) {
    if (p.type !== "grid" || p.appliesTo !== "next_race") continue;
    // Нет времени старта или даты публикации — переносим (толерантно, как
    // раньше): выдумывать порядок событий по неполным данным хуже.
    const tooLate = targetStartWall != null && p.publishedAt != null &&
      p.publishedAt.slice(0, 16) >= targetStartWall;
    if (tooLate) plan.late.push(p);
    else plan.carried.push({ ...p, appliesTo: "race", carriedFrom: prev.round });
  }
  return plan;
}

// ---- Докач и слияние для WEC/IMSA (свои ключи решений) ----

// mergeFiaEvent сюда не переиспользуется намеренно: он несёт F1-специфику
// (переносы carryOver, решётка, ключ приколочен к номеру документа), которой
// у WEC/IMSA нет, а КЛЮЧ решения у серий разный по фактическому устройству
// данных: WEC нумерует доки внутри раунда (ключ — doc), у IMSA нумерация TP
// и SP сквозная по сезону и НЕЗАВИСИМАЯ — «TP 26-11» и «SP 26-11» это разные
// нотисы одного уик-энда (ключ — session#doc). Поэтому обе функции ниже
// параметризованы ключом. Политика та же, что у mergeFiaEvent: файл раунда
// только НАКАПЛИВАЕТСЯ, автоматических удалений нет вовсе, пропажа документа
// из листинга — громкий лог и ручной разбор (обоснование — у mergeFiaEvent).

/// Документ из листинга Notice Board — вход планировщика докача.
export interface StewardsListedDoc {
  key: string;        // ключ решения в пространстве серии (см. выше)
  url: string;
  corrected: boolean; // переиздание (AMENDED в имени файла) — часть отпечатка
}

export interface StewardsFetchPlan<D extends StewardsListedDoc> {
  fetch: D[];             // качаем и парсим
  reused: FiaPenalty[];   // не качаем: эквивалент уже лежит в файле
  restamp: number;        // из fetch: лежат в файле, но разобраны другой версией парсера
}

/// Разложить документы листинга на «качать» и «взять из файла» — аналог
/// planPenaltyFetches. Отпечаток здесь без publishedAt: дерево Notice Board,
/// в отличие от листинга fia.com, дат не отдаёт, но имя файла (а значит и url)
/// при переиздании меняется, и AMENDED-переиздание приходит отдельным доком —
/// смена url ловит подмену не хуже. Обходы пропуска те же два, что у fia.ts:
/// force (env) и бамп версии парсера серии — версия сверяется У КАЖДОЙ записи.
export function planStewardsFetches<D extends StewardsListedDoc>(
  prev: FiaPenalty[],
  listed: D[],
  keyOf: (p: FiaPenalty) => string,
  version: number,
  force: boolean,
): StewardsFetchPlan<D> {
  const plan: StewardsFetchPlan<D> = { fetch: [], reused: [], restamp: 0 };
  const known = new Map(prev.map((p) => [keyOf(p), p]));
  for (const d of listed) {
    const p = known.get(d.key);
    if (!force && p && p.parser === version && p.url === d.url && p.corrected === d.corrected) {
      plan.reused.push(p);
      continue;
    }
    if (!force && p && p.parser !== version) plan.restamp++;
    plan.fetch.push(d);
  }
  return plan;
}

export interface StewardsMerge {
  penalties: FiaPenalty[];
  updated?: string;    // max(publishedAt) итога — как считали оба продьюсера
  kept: number;        // решений взято из прежнего файла (в прогоне не перечитывались)
  missing: string[];   // есть в файле, но пропали из листинга — ОСТАВЛЕНЫ, только лог
}

/// Слияние прогона с файлом раунда: прогон ДОПОЛНЯЕТ, свежий разбор побеждает
/// для того же ключа, удалений нет никогда (политика mergeFiaEvent).
export function mergeStewardsPenalties(
  prev: FiaPenalty[],
  fresh: FiaPenalty[],
  listedKeys: Iterable<string>,
  keyOf: (p: FiaPenalty) => string,
): StewardsMerge {
  const listed = new Set(listedKeys);
  const byKey = new Map<string, FiaPenalty>();
  const missing: string[] = [];
  for (const p of prev) {
    if (!listed.has(keyOf(p))) missing.push(keyOf(p));
    byKey.set(keyOf(p), p);
  }
  const fromFile = [...byKey.keys()];
  const freshKeys = new Set(fresh.map(keyOf));
  for (const p of fresh) byKey.set(keyOf(p), p);
  const kept = fromFile.filter((k) => !freshKeys.has(k)).length;  // пережили прогон «как были»

  // Порядок прежний (по номеру дока — так лежат все существующие файлы);
  // ключ — детерминированный тай-брейк для композитных пространств IMSA.
  const penalties = [...byKey.values()]
    .sort((a, b) => a.doc - b.doc || keyOf(a).localeCompare(keyOf(b)));
  const updated = penalties
    .map((p) => p.publishedAt)
    .filter((x): x is string => !!x)
    .sort()
    .pop();
  return {
    penalties,
    ...(updated ? { updated } : {}),
    kept,
    missing: missing.sort(),
  };
}
