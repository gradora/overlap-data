// Чистые функции страниц fiawec.com: карты стран, парс JSON-LD события,
// нормализация волатильных элементов, перечисление slugs/опций дропдаунов,
// season-guard. Выделены из продьюсера wec.ts: их импортируют alkamelwec и
// wecfia — lib-модуль не должен тянуть module-body продьюсера (SEASON/NOW).

import { mirrorSlug } from "./mirror.js";

// E2 country label (uppercase) → ISO-2 (порт WECDataService.countryNameToISO2).
export const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
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

// fiawec серверно рендерит в каждую страницу два волатильных элемента:
// live-отсчёт (data-countdown, меняется каждую секунду) и таймстамп рендера
// (<!-- YYYY-MM-DD HH:MM:SS --> в конце). writeIfChanged видел «изменение»
// в каждом часовом прогоне — 78–94% строк коммита были чистым шумом, репо
// пухло. Вырезаем оба до сравнения/записи; данные (JSON-LD, таблицы,
// дропдауны) не трогаем — парсеры приложения это не читают.
export function stripCountdown(html: string): string {
  return html
    .replace(/(data-countdown="[^"]*"[^>]*>)\s*\d+/g, "$1")
    .replace(/<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} -->\n?/g, "");
}

// Ожидаемые mirror-файлы race-страниц сезона — для GC осиротевших: fiawec
// умеет перекраивать сезон задним числом (Qatar/Bahrain-2026 уехали в 2027),
// и файлы выбывших этапов иначе замерзают в репо навечно.
export function expectedRaceMirrors(slugs: string[]): Set<string> {
  return new Set(slugs.map((s) => mirrorSlug(`/en/race/${s}`)));
}

// start/endDate (мс) + ISO-2 страны из JSON-LD SportsEvent страницы
// /en/race/<slug>. Экспортирован: wecfia.ts читает те же зеркальные страницы
// для freeze-окон своих этапов.
export function eventInfo(html: string): {
  startMs: number | null;
  endMs: number | null;
  iso2: string | null;
} {
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const body = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
    if (!body.includes("SportsEvent")) continue;
    try {
      const j = JSON.parse(body);
      const startMs = j.startDate ? Date.parse(j.startDate) : NaN;
      const endMs = j.endDate ? Date.parse(j.endDate) : NaN;
      const addr = typeof j.location?.address === "string" ? j.location.address : "";
      const iso3 = (addr.split(",").pop() ?? "").trim().toUpperCase();
      return {
        startMs: Number.isNaN(startMs) ? null : startMs,
        endMs: Number.isNaN(endMs) ? null : endMs,
        iso2: iso3.length === 3 ? ISO3_TO_2[iso3] ?? null : null,
      };
    } catch {
      /* следующий блок */
    }
  }
  return { startMs: null, endMs: null, iso2: null };
}

// MARK: перечисление (порт WECSeasonParser / WECResultsIndexParser)

// Слаги гонок сезона В ПОРЯДКЕ страницы (порядок = раунды этапов; так же
// строит календарь приложение). Экспортирован: wecfia.ts матчит события
// Notice Board к раундам по этому списку.
export function raceSlugs(html: string, year: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(/\/en\/race\/([a-z0-9-]+)/g)) {
    const slug = m[1];
    if (slug.endsWith(`-${year}`) && !slug.includes("prologue") && !slug.includes("test") && !seen.has(slug)) {
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

export const raceOptions = (html: string) => options(html).filter((o) => !isYear(o.label) && !isSession(o.label) && !isClass(o.label));
export const sessionOptions = (html: string) => options(html).filter((o) => isSession(o.label));

// Сезон YEAR уже «начался» (первый этап в пределах недельного окна)? Пока
// нет — дропдаун resultats-1 ещё указывает на raceId ПРОШЛОГО сезона: freeze
// по endMs текущего сезона для них не работает (все даты будущие), и без
// guard'а E5/E6 всех прошлогодних этапов рескрейпились бы каждый час всю зиму.
// Пустая карта endMs (страница сезона недоступна и зеркала нет) — тоже «не
// начался»: решить о заморозке нечем, скрейпить вслепую не надо.
export function seasonStarted(
  ends: number[],
  now: number,
  leadMs = 7 * 24 * 3600 * 1000,
): boolean {
  return ends.length > 0 && Math.min(...ends) <= now + leadMs;
}

