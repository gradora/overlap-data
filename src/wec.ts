// Зеркало WEC (fiawec.com) — кэширующий прокси. Тянет ТЕ ЖЕ пути, что приложение
// (WECDataService.loadHTML), и кладёт HTML как есть под wec/fiawec/<slug(path)>.
// Приложение (SnapshotMirror.wecPath) читает их первым, при промахе — прямой
// fiawec. Перечисление URL повторяет парсеры приложения: slugs из /en/season,
// raceId из /en/page/resultats-1, sessionId из resultats-1?raceId=.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "./freeze.js";
import { fetchText, mirrorSlug, writeIfChanged } from "./mirror.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const FIAWEC = "https://www.fiawec.com";
const OUT_DIR = join(process.cwd(), "data", "wec", "fiawec");
const NOW = Date.now();

// E2 country label (uppercase) → ISO-2 (порт WECDataService.countryNameToISO2).
const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  ITALY: "it", BELGIUM: "be", FRANCE: "fr", BRAZIL: "br", "UNITED STATES": "us",
  USA: "us", JAPAN: "jp", QATAR: "qa", BAHRAIN: "bh", "GREAT BRITAIN": "gb",
  "UNITED KINGDOM": "gb", CHINA: "cn", PORTUGAL: "pt", SPAIN: "es", GERMANY: "de",
  "SAUDI ARABIA": "sa",
};
// E3 JSON-LD address ISO-3 → ISO-2 (порт WECRacePageParser.iso3to2).
const ISO3_TO_2: Record<string, string> = {
  ITA: "it", BEL: "be", FRA: "fr", BRA: "br", USA: "us", JPN: "jp", QAT: "qa",
  BHR: "bh", GBR: "gb", CHN: "cn", PRT: "pt", ESP: "es", DEU: "de", SAU: "sa", ARE: "ae",
};

// Уже снятый mirror-файл (для freeze-решения без рескрейпа).
function readMirror(path: string): string | null {
  const f = join(OUT_DIR, mirrorSlug(path));
  try {
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  } catch {
    return null;
  }
}

// endDate (мс) + ISO-2 страны из JSON-LD SportsEvent страницы /en/race/<slug>.
function eventInfo(html: string): { endMs: number | null; iso2: string | null } {
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const body = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
    if (!body.includes("SportsEvent")) continue;
    try {
      const j = JSON.parse(body);
      const endMs = j.endDate ? Date.parse(j.endDate) : NaN;
      const addr = typeof j.location?.address === "string" ? j.location.address : "";
      const iso3 = (addr.split(",").pop() ?? "").trim().toUpperCase();
      return {
        endMs: Number.isNaN(endMs) ? null : endMs,
        iso2: iso3.length === 3 ? ISO3_TO_2[iso3] ?? null : null,
      };
    } catch {
      /* следующий блок */
    }
  }
  return { endMs: null, iso2: null };
}

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
  // Оба каркасных запроса null → полный отказ fiawec: валим прогон (exit 1),
  // иначе продьюсер завершится «success» при пустом зеркале и алерт-гейт
  // промолчит при реальном аутэйдже.
  if (!season && !index) {
    console.error("fiawec season+index недоступны — весь прогон бесполезен");
    process.exit(1);
  }
  await mirror(`/en/page/manufacturers-classification`);

  const slugs = season ? raceSlugs(season) : [];
  // E3 (race-страница, JSON-LD): событие с endDate+7д в прошлом ЗАМОРОЖЕНО —
  // не рескрейпим, читаем из зеркала; собираем карту страна(ISO2) → endMs.
  const endByCountry: Record<string, number> = {};
  let frozenEvents = 0;
  for (const slug of slugs) {
    const existing = readMirror(`/en/race/${slug}`);
    const frozen = existing ? isFrozen(eventInfo(existing).endMs, NOW) : false;
    if (frozen) frozenEvents++;
    const html = frozen ? existing! : (await mirror(`/en/race/${slug}`)) ?? existing;
    if (html) {
      const info = eventInfo(html);
      if (info.iso2 && info.endMs !== null) endByCountry[info.iso2] = info.endMs;
    }
  }

  // Per-race результаты (E5 дропдаун сессий) + per-session (E6). Freeze по
  // endDate события (страна E2-лейбла → endMs). Сыгранное окно уже отстоялось →
  // E5/E6 не трогаем. E6 fiawec рендерит только для сыгранных сессий (будущие —
  // пустой HTML): храним только с <table.
  const raceOpts = index ? raceOptions(index) : [];
  let e6 = 0;
  let frozenRaces = 0;
  for (const o of raceOpts) {
    const iso2 = COUNTRY_NAME_TO_ISO2[o.label.toUpperCase()] ?? null;
    const endMs = iso2 ? endByCountry[iso2] ?? null : null;
    if (isFrozen(endMs, NOW)) {
      frozenRaces++;
      continue;
    }
    const e5 = await mirror(`/en/page/resultats-1?raceId=${o.id}`);
    const sessionIds = e5 ? sessionOptions(e5).map((s) => s.id) : [];
    for (const sessionId of sessionIds) {
      const path = `/en/page/resultats-1?raceId=${o.id}&sessionId=${sessionId}`;
      const res = await fetchText(`${FIAWEC}${path}`);
      if (res?.status === 200 && res.text.includes("<table")) {
        if (writeIfChanged(join(OUT_DIR, mirrorSlug(path)), res.text)) e6++;
      }
    }
  }

  console.log(`Done. ${slugs.length} events (${frozenEvents} frozen E3), ${raceOpts.length} raceIds (${frozenRaces} frozen), ${e6} session results updated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
