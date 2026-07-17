// Зеркало WEC (fiawec.com) — кэширующий прокси. Тянет ТЕ ЖЕ пути, что приложение
// (WECDataService.loadHTML), и кладёт HTML как есть под wec/fiawec/<slug(path)>.
// Приложение (SnapshotMirror.wecPath) читает их первым, при промахе — прямой
// fiawec. Перечисление URL повторяет парсеры приложения: slugs из /en/season,
// raceId из /en/page/resultats-1, sessionId из resultats-1?raceId=.

import { join } from "node:path";
import { fetchText, mirrorSlug, writeIfChanged } from "./mirror.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const FIAWEC = "https://www.fiawec.com";
const OUT_DIR = join(process.cwd(), "data", "wec", "fiawec");

// Тянем fiawec-относительный путь, кладём под wec/fiawec/<slug(path)>. HTML или null.
async function mirror(path: string): Promise<string | null> {
  const res = await fetchText(`${FIAWEC}${path}`);
  if (!res || res.status !== 200 || !res.text) {
    console.log(`  MISS  ${path} (${res?.status ?? "net"})`);
    return null;
  }
  const changed = writeIfChanged(join(OUT_DIR, mirrorSlug(path)), res.text);
  console.log(`  ${changed ? "write" : "same "} ${path}`);
  return res.text;
}

// MARK: перечисление (порт WECSeasonParser / WECResultsIndexParser)

function raceSlugs(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(/\/en\/race\/([a-z0-9-]+)/g)) {
    const slug = m[1];
    if (slug.endsWith(`-${YEAR}`) && !slug.includes("prologue") && !slug.includes("test") && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

interface Opt { id: number; label: string; }

function options(html: string): Opt[] {
  const out: Opt[] = [];
  for (const m of html.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)) {
    const idM = /value="(\d+)"/.exec(m[1]);
    const label = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
    if (idM && label) out.push({ id: Number(idM[1]), label });
  }
  return out;
}

const isYear = (s: string) => /^\d{4}$/.test(s);
const isSession = (s: string) => {
  const t = s.toUpperCase();
  return t.includes("PRACTICE") || t.includes("QUALIFYING") || t.includes("HYPERPOLE")
    || t.includes("WARM") || t === "RACE" || t.startsWith("RACE");
};
const isClass = (s: string) => ["HYPERCAR", "LMGT3", "LMP2"].includes(s.toUpperCase());

const raceOptions = (html: string) => options(html).filter((o) => !isYear(o.label) && !isSession(o.label) && !isClass(o.label));
const sessionOptions = (html: string) => options(html).filter((o) => isSession(o.label));

async function main() {
  console.log(`WEC mirror, season ${YEAR}`);

  // Каркас: сезон (slugs), индекс результатов (raceId), зачёт производителей.
  const season = await mirror(`/en/season/${YEAR}`);
  const index = await mirror(`/en/page/resultats-1`);
  await mirror(`/en/page/manufacturers-classification`);

  const slugs = season ? raceSlugs(season) : [];
  for (const slug of slugs) await mirror(`/en/race/${slug}`);

  // Per-race страница результатов (E5, дропдаун сессий) + per-session (E6).
  // E6 fiawec рендерит таблицу только для СЫГРАННЫХ сессий; будущие отдают
  // пустой HTML (~88КБ) — их не храним (гард «есть <table»), иначе зря
  // тянем/держим большие пустышки каждый прогон.
  const raceIds = index ? raceOptions(index).map((o) => o.id) : [];
  let e6 = 0;
  for (const raceId of raceIds) {
    const e5 = await mirror(`/en/page/resultats-1?raceId=${raceId}`);
    const sessionIds = e5 ? sessionOptions(e5).map((o) => o.id) : [];
    for (const sessionId of sessionIds) {
      const path = `/en/page/resultats-1?raceId=${raceId}&sessionId=${sessionId}`;
      const res = await fetchText(`${FIAWEC}${path}`);
      if (res?.status === 200 && res.text.includes("<table")) {
        if (writeIfChanged(join(OUT_DIR, mirrorSlug(path)), res.text)) e6++;
      }
    }
  }

  console.log(`Done. ${slugs.length} events, ${raceIds.length} raceIds, ${e6} session results.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
