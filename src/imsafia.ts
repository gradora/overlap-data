// Продьюсер решений IMSA (RACE CONTROL на странице события) — источник PDF
// «IMSA PENALTY NOTICE» из Notice Board Al Kamel:
// /Results_NoticeBoard/<сезон>/<раунд>/18_Penalties/{TP|SP} YY-N.pdf
// (TP — Technical, SP — Sporting; нумерация сквозная по сезону). В папке
// раунда лежат нотисы всех серий уикенда — фильтруем по полю SERIES: IWSC.
// Сезон-2026 в Notice Board назван «26-2026» (дефис, не подчёркивание).
// Выход: data/imsa/fia/<season>_<round>.json — формат FiaEvent, как f1/wec.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { classifyDecision, type FiaEvent, type FiaPenalty } from "./fia.js";
import { matchImsaTrack } from "./alkamelimsa.js";
import { isFrozen } from "./freeze.js";
import { writeIfChanged } from "./mirror.js";
import { SCHEDULE } from "./schedule.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT_DIR = join(process.cwd(), "data", "imsa", "fia");
const NB_BASE = "https://imsa.results.alkamelcloud.com/Results_NoticeBoard";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const NOW = Date.now();

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// MARK: HTTP (Notice Board живёт вне /Results — свой фетч)

async function nbFetch(segments: string[]): Promise<Response | null> {
  let url = NB_BASE;
  for (const seg of segments) url += "/" + encodeURIComponent(seg);
  if (!segments[segments.length - 1]?.includes(".")) url += "/";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function nbHTML(segments: string[]): Promise<string | null> {
  const res = await nbFetch(segments);
  return res ? await res.text() : null;
}

function nbHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /href="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (href.startsWith("/") || href.startsWith("?") || href.startsWith("#") || href === "../") continue;
    try {
      out.push(decodeURIComponent(href));
    } catch {
      out.push(href);
    }
  }
  return out;
}

// MARK: Разбор PDF

/// «TP 26-11.pdf» → {kind: Technical, doc: 11}; не нотис → null.
export function imsaDocFromName(name: string): { kind: string; doc: number } | null {
  const m = name.match(/^(TP|SP)\s*\d{2}\s*-\s*(\d+)\.pdf$/i);
  if (!m) return null;
  return { kind: m[1].toUpperCase() === "TP" ? "Technical" : "Sporting", doc: Number(m[2]) };
}

const field = (text: string, re: RegExp): string =>
  (re.exec(text)?.[1] ?? "").replace(/\s+/g, " ").trim();

/// Текст «IMSA PENALTY NOTICE» → FiaPenalty. Не-IWSC (Pilot Challenge и
/// младшие серии) и нераспознанные формы → null.
export function parseImsaPenaltyPdf(
  text: string, kind: string, doc: number, url: string, publishedAt?: string,
): FiaPenalty | null {
  // Серия — значение после кластера меток EVENT:/SERIES:/TEAM:.
  const series = /\b(IWSC|IMPC|IMSA WeatherTech)\b/.exec(text)?.[1];
  if (series !== "IWSC" && series !== "IMSA WeatherTech") return null;

  // Номер машины и класс — из бейджа ENTRY, вынесенного к «RETURN TROPHY».
  const entry = /RETURN TROPHY\s+(\w+)\s+((?:GTP|LMP2|LMP3|GTD PRO|GTDPRO|GTD|GSX?|TCR)\b(?:\s*PRO)?)\s+TYPE:/i.exec(text);
  const car = Number(entry?.[1]?.replace(/^0+/, "") ?? NaN);
  if (!Number.isFinite(car)) return null;

  const team = field(text, /\b(?:IWSC|IMPC)\b\s+(.*?)\s+ENTRANT REPRESENTATIVE:/s);
  let driver = field(text, /DRIVER:\s*(.*?)\s*AFFECTED PARTY:/s)
    .replace(/\s*\([^)]*\)\s*$/, "");
  if (!driver) driver = team;

  const fact = field(text, /FACTS:\s*(.*?)\s*PENALTY\s*FINE:/s);
  const fine = field(text, /PENALTY\s*FINE:\s*(.*?)\s*CHANGE:/s);
  const change = field(text, /CHANGE:\s*(.*?)\s*SIGNATURES/s);

  const parts: string[] = [];
  if (change && !/^n\/?a$/i.test(change)) parts.push(change);
  if (fine && !/^n\/?a$/i.test(fine)) parts.push(`Fine of ${fine}`);
  const decision = parts.join(". ") || change || fine;
  if (!decision) return null;

  let cls = classifyDecision(decision);
  if (/lap times? (?:are |is )?invalidated/i.test(decision) && cls.type === "other") {
    cls = { type: "deleted_laps" };
  }

  return {
    doc,
    car,
    driver,
    session: kind, // «Technical» | «Sporting» — сессию нотис не указывает
    ...cls,
    appliesTo: "race",
    corrected: false,
    ...(fact ? { fact } : {}),
    decision,
    url,
    publishedAt,
  };
}

async function fetchPdf(segments: string[]): Promise<{ text: string; publishedAt?: string } | null> {
  const res = await nbFetch(segments);
  if (!res) return null;
  try {
    const buf = new Uint8Array(await res.arrayBuffer());
    const docProxy = await getDocumentProxy(buf);
    const { text } = await extractText(docProxy, { mergePages: true });
    const lm = res.headers.get("last-modified");
    return {
      text,
      ...(lm ? { publishedAt: new Date(lm).toISOString().replace(/\.\d{3}Z$/, ".000Z") } : {}),
    };
  } catch {
    return null;
  }
}

// MARK: Прогон

async function main(): Promise<void> {
  console.log(`IMSA penalties, season ${YEAR}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const schedule = SCHEDULE[YEAR];
  if (!schedule) {
    console.log(`  нет курируемого расписания ${YEAR} — выходим`);
    return;
  }

  // Сезон Notice Board: у 2026 дефис («26-2026»), у прошлых подчёркивание.
  let seasonSeg: string | null = null;
  const rootHTML = await nbHTML([]);
  if (rootHTML) {
    const dirs = nbHrefs(rootHTML).filter((h) => h.endsWith("/")).map((h) => h.slice(0, -1));
    seasonSeg = dirs.find((d) => d === `${YEAR % 100}-${YEAR}` || d === `${YEAR % 100}_${YEAR}`) ?? null;
  }
  if (!seasonSeg) {
    console.log("  сезон в Notice Board не найден — выходим");
    return;
  }
  const seasonHTML = await nbHTML([seasonSeg]);
  if (!seasonHTML) {
    console.log("  листинг сезона не открылся — выходим");
    return;
  }
  const roundDirs = nbHrefs(seasonHTML).filter((h) => h.endsWith("/")).map((h) => h.slice(0, -1));

  let backfill = Number(process.env.IMSA_FIA_BACKFILL ?? 1);

  for (const entry of schedule) {
    const endMs = Date.parse(`${entry.endDate}T23:59:59Z`);
    const started = Date.parse(`${entry.startDate}T00:00:00Z`) - 24 * 3600 * 1000 < NOW;
    if (!started) continue;
    const path = join(OUT_DIR, `${YEAR}_${entry.round}.json`);
    const exists = existsSync(path);
    if (exists && isFrozen(endMs, NOW) && !process.env.IMSA_FIA_FORCE) continue;
    if (!exists && endMs < NOW) {
      if (backfill <= 0) continue;
      backfill--;
    }

    const matched = roundDirs.filter((d) => matchImsaTrack(d, entry.venue));
    const penalties: FiaPenalty[] = [];
    for (const dir of matched) {
      const penHTML = await nbHTML([seasonSeg, dir, "18_Penalties"]);
      if (!penHTML) continue; // папки может не быть — нотисов не выписывали
      for (const name of nbHrefs(penHTML).filter((h) => !h.endsWith("/"))) {
        const ref = imsaDocFromName(name);
        if (!ref) continue;
        const pdf = await fetchPdf([seasonSeg, dir, "18_Penalties", name]);
        if (!pdf) continue;
        const url = `${NB_BASE}/${[seasonSeg, dir, "18_Penalties", name].map(encodeURIComponent).join("/")}`;
        const p = parseImsaPenaltyPdf(pdf.text, ref.kind, ref.doc, url, pdf.publishedAt);
        if (p) penalties.push(p);
        await new Promise((res) => setTimeout(res, 200)); // вежливая пауза
      }
    }
    penalties.sort((a, b) => a.doc - b.doc);

    const updated = penalties
      .map((p) => p.publishedAt)
      .filter((x): x is string => !!x)
      .sort()
      .pop();
    const out: FiaEvent = {
      season: YEAR,
      round: entry.round,
      event: slugify(entry.venue),
      ...(updated ? { updated } : {}),
      penalties,
    };
    writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
    console.log(`  R${entry.round} (${entry.venue}): ${penalties.length} решений (папок: ${matched.length})`);
  }
  console.log("Done.");
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
