// Продьюсер решений стюардов FIA (штрафы) для F1 — источник fia.com/documents.
// Скрейпит server-rendered список документов текущего этапа, парсит штрафные
// PDF (шаблон стюардов: поля No/Driver, Session, Decision …) и официальный
// «Starting Grid», кладёт структурный data/f1/fia/<season>_<round>.json.
// Приложение читает его и прикрепляет пенальти к квале/гриду.
//
// Извлечение текста PDF — через unpdf (обёртка pdf.js). Текстовый слой у
// FIA-PDF чистый (не сканы). Продьюсер ТОЛЕРАНТЕН (как openf1): недоступность
// fia.com / сбой парсинга одного PDF не валит крон.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { writeIfChanged } from "./mirror.js";
import { isFrozen } from "./freeze.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
// Сезонная страница документов F1. Node-id сезона (season-2026-2072) меняется
// раз в год → СЕЗОННОЕ ОБСЛУЖИВАНИЕ (как курируемое расписание в schedule.ts).
const SEASON_URL =
  "https://www.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2026-2072";
const FIA_ORIGIN = "https://www.fia.com";
const OUT_DIR = join(process.cwd(), "data", "f1", "fia");
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const NOW = Date.now();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

// ---- Типы вывода (зеркалят модель приложения FIAPenalties) ----

export type PenaltyType =
  | "grid" | "time" | "dsq" | "reprimand" | "fine" | "deleted_laps" | "none" | "other";

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
  appliesTo: string;           // «race» | «qualifying» | …: к чему применить
  corrected: boolean;          // документ «Corrected Infringement» — заменяет ранний
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

interface DocRef {
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
export function eventSlugFromUrl(url: string): string | null {
  const m = url.match(/decision-document\/\d{4}_([a-z0-9_]+?)_-_/i);
  return m ? m[1].toLowerCase() : null;
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

// Значение поля `label` = текст до ближайшей следующей метки.
function field(body: string, label: string): string | null {
  const start = body.indexOf(label + " ");
  if (start < 0) return null;
  const from = start + label.length + 1;
  let end = body.length;
  for (const nl of FIELD_LABELS) {
    if (nl === label) continue;
    const i = body.indexOf(" " + nl + " ", from);
    if (i >= 0 && i < end) end = i;
  }
  return body.slice(from, end).trim();
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
  if (/start(?:ing)? from the pit ?lane|pit ?lane start/.test(d)) return { type: "grid", pitlane: true };
  if (/back of the (?:starting )?grid/.test(d)) return { type: "grid", backOfGrid: true };
  if ((m = d.match(/(\d+)\s*second(?:s)? time penalty/))) return { type: "time", seconds: Number(m[1]) };
  if (/disqualif|excluded from/.test(d)) return { type: "dsq" };
  if (/reprimand/.test(d)) return { type: "reprimand" };
  if (/fine of|fined/.test(d)) return { type: "fine" };
  if (/lap ?time.*delet|deletion of.*lap|deleted lap/.test(d)) return { type: "deleted_laps" };
  return { type: "other" };
}

function appliesTo(decision: string, session: string): string {
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

function slugifyRace(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function matchRound(
  eventSlug: string,
  races: { round: string; date: string; raceName: string }[],
): { round: number; raceDate: string } | null {
  const country = eventSlug.split("_")[0];
  for (const r of races) {
    const slug = slugifyRace(r.raceName);
    if (slug === eventSlug || slug.startsWith(country + "_") || slug === country) {
      return { round: Number(r.round), raceDate: r.date };
    }
  }
  return null;
}

function jolpicaRaces(): { round: string; date: string; raceName: string }[] {
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
    return d?.MRData?.RaceTable?.Races ?? [];
  } catch {
    return [];
  }
}

// ---- Сеть ----

async function fetchHtml(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchPdfText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- Продьюсер ----

async function main() {
  console.log(`FIA decisions, season ${YEAR}`);
  const html = await fetchHtml(SEASON_URL);
  if (!html) {
    console.warn("FIA страница недоступна — пропускаем прогон (толерантно)");
    return;
  }
  const docs = parseDocList(html);
  if (!docs.length) {
    console.warn("FIA: документы не распарсились — пропускаем");
    return;
  }
  const eventSlug = docs.map((d) => eventSlugFromUrl(d.url)).find((s): s is string => !!s);
  if (!eventSlug) {
    console.warn("FIA: не извлёк event-slug — пропускаем");
    return;
  }
  const matched = matchRound(eventSlug, jolpicaRaces());
  if (!matched) {
    console.warn(`FIA: не сматчил round для ${eventSlug} (нет в расписании Jolpica) — пропускаем`);
    return;
  }
  const { round, raceDate } = matched;
  // Замораживаем этап через окно оседания после гонки (штрафы могут корректировать
  // до ~7д). Позже — не рескрейпим PDF (вежливо к fia.com; файл остаётся).
  if (isFrozen(Date.parse(`${raceDate}T23:59:59Z`), NOW)) {
    console.log(`  ${eventSlug} (R${round}): frozen`);
    return;
  }
  console.log(`  ${eventSlug} → R${round}, ${docs.length} документов`);

  // Штрафы.
  const penalties: FiaPenalty[] = [];
  for (const d of docs.filter((x) => isPenaltyDoc(x.title))) {
    const text = await fetchPdfText(d.url);
    if (!text) {
      console.log(`  Doc ${d.doc}: PDF недоступен/не распарсился`);
      continue;
    }
    const p = parsePenaltyDoc(text, d);
    if (p) penalties.push(p);
  }
  penalties.sort((a, b) => a.doc - b.doc);

  // Официальная стартовая решётка (Final приоритетнее Provisional).
  const gridDocs = docs.filter((d) => /starting grid/i.test(d.title));
  const gridDoc =
    gridDocs.find((d) => /final/i.test(d.title)) ?? gridDocs.find((d) => /provisional/i.test(d.title));
  let startingGrid: FiaStartingGrid | undefined;
  if (gridDoc) {
    const text = await fetchPdfText(gridDoc.url);
    if (text) startingGrid = parseStartingGridDoc(text, gridDoc) ?? undefined;
  }

  const updated = [...penalties.map((p) => p.publishedAt), startingGrid?.publishedAt]
    .filter((x): x is string => !!x)
    .sort()
    .pop();

  const out: FiaEvent = {
    season: YEAR,
    round,
    event: eventSlug,
    ...(updated ? { updated } : {}),
    penalties,
    ...(startingGrid ? { startingGrid } : {}),
  };
  const path = join(OUT_DIR, `${YEAR}_${round}.json`);
  const changed = writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `  ${penalties.length} штрафов, грид: ${startingGrid ? startingGrid.kind : "нет"} → ${changed ? "записано" : "без изменений"}`,
  );
  console.log("Done.");
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
