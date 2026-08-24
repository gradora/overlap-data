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
  if (/reprimand/.test(d)) return { type: "reprimand" };
  // «Driver: Warning.» — стюардовское предупреждение (напр. за дельту SC2-SC1);
  // на результат не влияет, но должно доходить до приложения, а не в "other".
  if (/\bwarning\b/.test(d)) return { type: "warning" };
  if (/fine of|fined/.test(d)) return { type: "fine" };
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
  return { kind, doc: ref.doc, entries, penaltySummary, url: ref.url, publishedAt: ref.publishedAt };
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

export function matchRound(
  eventSlug: string,
  races: { round: string; date: string; time?: string; raceName: string }[],
): { round: number; raceDate: string; raceTime?: string } | null {
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
export function markNextRace(penalties: FiaPenalty[], wall: string | null): FiaPenalty[] {
  if (!wall) return penalties;
  return penalties.map((p) => {
    if (p.type !== "grid" || !p.publishedAt) return p;
    return p.publishedAt.slice(0, 16) >= wall ? { ...p, appliesTo: "next_race" } : p;
  });
}

// ---- Слияние прогона с уже собранным файлом раунда ----

/// Итог ОДНОГО прогона скрейпа раунда — вход слияния.
export interface FiaScrape {
  penalties: FiaPenalty[];        // разобранные в ЭТОМ прогоне решения раунда
  carried: FiaPenalty[];          // перенос из предыдущего раунда (carryOver)
  startingGrid?: FiaStartingGrid; // распарсенная в этом прогоне решётка (если далась)
  listedDocs: number[];           // номера ВСЕХ штрафных доков в списке FIA сейчас
  complete: boolean;              // список прочитан целиком, без единой осечки
}

export interface FiaMerge {
  penalties: FiaPenalty[];
  startingGrid?: FiaStartingGrid;
  updated?: string;
  kept: number;      // решений взято из прежнего файла (в прогоне не дались)
  dropped: number;   // решений убрано: документ исчез со страницы FIA (отозван)
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
// * удаление доверяем только ЧИСТОМУ прогону (complete): отозванный документ
//   исчезает со страницы FIA, но отличить отзыв от сетевой осечки можно, лишь
//   когда прочитано всё;
// * решётка не теряется при осечке PDF и НЕ откатывается final → provisional.
export function mergeFiaEvent(prev: FiaEvent | null, fresh: FiaScrape): FiaMerge {
  const listed = new Set(fresh.listedDocs);
  const byKey = new Map<string, FiaPenalty>();
  let dropped = 0;

  for (const p of prev?.penalties ?? []) {
    if (p.carriedFrom != null) continue;          // переносы — ниже, из свежего carryOver
    if (fresh.complete && !listed.has(p.doc)) {   // документ отозван — отпускаем
      dropped++;
      continue;
    }
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
    dropped,
  };
}

// Перенос из предыдущего раунда: его next_race-грид-штрафы становятся
// обычными race-штрафами текущего, с пометкой carriedFrom (по ней приложение
// не считает их «поздними» — doc-номера разных уик-эндов несравнимы, а FIA
// заведомо учтёт перенос при составлении решётки нового этапа).
export function carryOver(prev: FiaEvent | null): FiaPenalty[] {
  if (!prev) return [];
  return prev.penalties
    .filter((p) => p.type === "grid" && p.appliesTo === "next_race")
    .map((p) => ({ ...p, appliesTo: "race", carriedFrom: prev.round }));
}
