// Продьюсер решений стюардов FIA WEC (штрафы) — источник официальный Notice
// Board на Al Kamel (fiawec.alkamelsystems.com/noticeBoard.php): fia.com
// WEC-документов НЕ хранит (там только F1/F2/F3). Скрейпит дерево документов
// события, парсит штрафные PDF — шаблон стюардов WEC ≈ F1, но метки с
// двоеточиями и поле пилота одно («N° / Driver: 61 / Martin BERRY» — кто был
// за рулём в момент факта, не весь экипаж). Выход: data/wec/fia/
// <season>_<round>.json в структуре FiaEvent — приложение читает ТОЙ ЖЕ
// моделью, что F1-пенальти. Дат публикации в HTML нет — publishedAt берём из
// Last-Modified PDF (честный UTC, в отличие от «CET»-меток F1).
//
// Раунды: порядок слагов страницы сезона fiawec (как в календаре приложения);
// сверено с «Round N» в шапках PDF (Сан-Паулу 2026 = Round 4 = 4-й слаг).
// Notice Board 2026 начинается с Имолы — Катар (R7) появится своим чередом.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { writeIfChanged } from "./mirror.js";
import { isFrozen } from "./freeze.js";
import {
  appliesTo, classifyDecision, fieldValue,
  type FiaEvent, type FiaPenalty,
} from "./fia.js";
import { ALKAMEL_WEC, matchAkRound, parseAkOptions, parseFileHrefs } from "./alkamelwec.js";
import { eventInfo, raceSlugs } from "./wec.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const NB = `${ALKAMEL_WEC}/noticeBoard.php`;
const OUT_DIR = join(process.cwd(), "data", "wec", "fia");
const MIRROR_DIR = join(process.cwd(), "data", "wec", "fiawec");
const NOW = Date.now();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

// Метки шаблона стюардов WEC — в порядке появления, с двоеточиями (в отличие
// от F1). Механика «значение до ближайшей ПОЗДНЕЙ метки» — общая (fieldValue).
export const WEC_FIELD_LABELS = [
  "N° / Driver:", "Competitor:", "Session:", "Time (fact):",
  "Fact:", "Offence:", "Decision:", "Reason:",
];

export interface WecDocRef {
  doc: number;
  title: string; // «Decision no. 2 AMENDED Time of fact - Car 61»
  url: string;
}

// «Results_NoticeBoard/14_2026/05_…/010_Doc 10 - Decision no. 2 - Car 61.pdf»
// (href URL-encoded) → DocRef. Не-Doc файлы → null.
export function docFromHref(href: string): WecDocRef | null {
  const file = decodeURIComponent(href.split("/").pop() ?? "");
  const m = file.match(/^\d+_Doc\s+(\d+)\s*-\s*(.+?)\.pdf$/i);
  if (!m) return null;
  return { doc: Number(m[1]), title: m[2].trim(), url: `${ALKAMEL_WEC}/${href}` };
}

// Штрафной документ: «Decision no. M [AMENDED …] - Car N». Мульти-решения
// («Decision no. 28-30» без машины) пропускаем: в одном PDF несколько блоков
// полей, первый парс съел бы остальные — честнее лог и скип.
export function isWecPenaltyDoc(title: string): boolean {
  return /^Decision no\.\s*\d+(?!\s*-\s*\d)/i.test(title) && /-\s*Car\s+\d+/i.test(title);
}

// Номер машины из заголовка («- Car 007» → 7) — фолбэк, когда поле пилота в
// PDF отсутствует или не распарсилось.
export function carFromTitle(title: string): number | null {
  const m = title.match(/-\s*Car\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

export function parseWecPenaltyDoc(
  text: string,
  ref: WecDocRef,
  publishedAt?: string,
): FiaPenalty | null {
  const L = WEC_FIELD_LABELS;
  const decision = fieldValue(text, "Decision:", L);
  if (!decision) return null;

  const driverLine = fieldValue(text, "N° / Driver:", L);
  const dm = driverLine?.match(/^(\d+)\s*\/\s*(.+?)\s*$/);
  const car = dm ? Number(dm[1]) : carFromTitle(ref.title);
  if (car == null) return null;
  // Решения против команды (без пилота) — представляем компетитором.
  const driver = dm?.[2] ?? fieldValue(text, "Competitor:", L) ?? "";

  const session = fieldValue(text, "Session:", L) ?? "";
  const fact = fieldValue(text, "Fact:", L) ?? undefined;
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
    corrected: /AMENDED/i.test(ref.title),
    fact,
    decision,
    url: ref.url,
    ...(publishedAt ? { publishedAt } : {}),
  };
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

/// PDF → текст + Last-Modified (ISO). Ошибки → null (толерантно, как fia.ts).
async function fetchPdf(url: string): Promise<{ text: string; publishedAt?: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    const lm = res.headers.get("last-modified");
    const buf = new Uint8Array(await res.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    const publishedAt = lm && !Number.isNaN(Date.parse(lm))
      ? new Date(lm).toISOString()
      : undefined;
    return { text, ...(publishedAt ? { publishedAt } : {}) };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Зеркальная страница гонки (кладёт wec.ts) — freeze-окна этапа.
function raceMirror(slug: string): string | null {
  // mirrorSlug("/en/race/<slug>") без импорта: та же схема «не-алфанум → _».
  const key = `en_race_${slug.replace(/[^a-z0-9.]+/gi, "_")}`;
  try {
    return readFileSync(join(MIRROR_DIR, key), "utf8");
  } catch {
    return null;
  }
}

// ---- Продьюсер ----

async function main() {
  console.log(`WEC FIA decisions, season ${YEAR}`);

  // Каркас раундов — страница сезона из wec-зеркала (сезон файла = YEAR, так
  // что season-guard тут структурный: нет файла сезона — нечего матчить).
  let seasonHtml: string;
  try {
    seasonHtml = readFileSync(join(MIRROR_DIR, `en_season_${YEAR}`), "utf8");
  } catch {
    console.warn(`wecfia: нет зеркала en_season_${YEAR} — пропускаем прогон`);
    return;
  }
  const slugs = raceSlugs(seasonHtml, YEAR);
  if (!slugs.length) {
    console.warn("wecfia: слаги сезона не распарсились — пропускаем");
    return;
  }

  // Notice Board: значение сезона из селектора по лейблу-году.
  const nbHome = await fetchHtml(NB);
  if (!nbHome) {
    console.warn("wecfia: Notice Board недоступен — пропускаем (толерантно)");
    return;
  }
  const seasonOpt = parseAkOptions(nbHome, "season").find((o) => o.label === String(YEAR));
  if (!seasonOpt) {
    // Гонка флипов: YEAR уже новый, а Notice Board сезон ещё не завёл.
    console.warn(`wecfia: сезона ${YEAR} нет на Notice Board — переходное окно, пропускаем`);
    return;
  }
  const seasonPage = await fetchHtml(`${NB}?season=${encodeURIComponent(seasonOpt.value)}`);
  const events = seasonPage ? parseAkOptions(seasonPage, "evvent") : [];
  if (!events.length) {
    console.warn("wecfia: селектор событий пуст — пропускаем");
    return;
  }

  // Бюджет бэкфилла (вежливость: у события до ~50 штрафных PDF).
  let backfill = Number(process.env.WEC_FIA_BACKFILL ?? 1);
  const ACTIVE_LEAD_MS = 4 * 24 * 3600 * 1000;

  for (const ev of events) {
    const round = matchAkRound(ev.label, slugs);
    if (round == null) {
      console.warn(`  «${ev.label}»: не сматчилось со слагами сезона — пропускаем`);
      continue;
    }
    const pageHtml = raceMirror(slugs[round - 1]);
    const dates = pageHtml ? eventInfo(pageHtml) : { startMs: null, endMs: null, iso2: null };
    const frozen = isFrozen(dates.endMs, NOW);
    const exists = existsSync(join(OUT_DIR, `${YEAR}_${round}.json`));
    const started = dates.startMs != null && dates.startMs < NOW;
    const isActive = !frozen && dates.startMs != null &&
      NOW >= dates.startMs - ACTIVE_LEAD_MS && started;
    const needsBackfill = (process.env.WEC_FIA_FORCE === "1" || !exists) && started;
    if (frozen && exists && process.env.WEC_FIA_FORCE !== "1") continue;
    if (!isActive && !needsBackfill) continue;
    if (!isActive) {
      if (backfill <= 0) continue;
      backfill--;
      console.log(`  backfill R${round} (${ev.label})`);
    }

    const docsHtml = await fetchHtml(
      `${NB}?season=${encodeURIComponent(seasonOpt.value)}&evvent=${encodeURIComponent(ev.value)}`,
    );
    if (!docsHtml) {
      console.warn(`  R${round}: страница документов недоступна`);
      continue;
    }
    const refs = parseFileHrefs(docsHtml, "Results_NoticeBoard")
      .map(docFromHref)
      .filter((d): d is WecDocRef => !!d);
    if (!refs.length) {
      console.log(`  R${round}: документов нет`);
      continue;
    }
    await produceEvent(refs, round, ev.label, slugs[round - 1]);
  }
  console.log("Done.");
}

async function produceEvent(refs: WecDocRef[], round: number, label: string, slug: string) {
  console.log(`  ${label} → R${round}, ${refs.length} документов`);

  const penalties: FiaPenalty[] = [];
  for (const ref of refs) {
    if (!isWecPenaltyDoc(ref.title)) {
      if (/^Decision no\./i.test(ref.title)) {
        console.log(`  Doc ${ref.doc}: мульти-решение «${ref.title}» — пропускаем`);
      }
      continue;
    }
    const pdf = await fetchPdf(ref.url);
    if (!pdf) {
      console.log(`  Doc ${ref.doc}: PDF недоступен/не распарсился`);
      continue;
    }
    const p = parseWecPenaltyDoc(pdf.text, ref, pdf.publishedAt);
    if (p) penalties.push(p);
    await new Promise((res) => setTimeout(res, 200)); // вежливая пауза
  }
  penalties.sort((a, b) => a.doc - b.doc);

  const updated = penalties
    .map((p) => p.publishedAt)
    .filter((x): x is string => !!x)
    .sort()
    .pop();

  const out: FiaEvent = {
    season: YEAR,
    round,
    event: slug,
    ...(updated ? { updated } : {}),
    penalties,
  };
  const path = join(OUT_DIR, `${YEAR}_${round}.json`);
  const changed = writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
  console.log(`  ${penalties.length} штрафов → ${changed ? "записано" : "без изменений"}`);
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
