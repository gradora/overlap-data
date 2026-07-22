// Общий слой Al Kamel WEC (fiawec.alkamelsystems.com) — один хост держит
// Notice Board (официальные документы стюардов, wecfia.ts) и Results-архив
// (CSV сессий 2011+, продьюсеры highlights/winners/safetycar). Навигация
// одинаковая: GET ?season=<val>&evvent=<val>, значения — из <option
// Value="..."> (атрибут с большой буквы V — обычный регекс по value его
// пропускает), файлы — прямыми href (листинг директорий закрыт, 403).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { raceSlugs } from "./wec.js";

export const ALKAMEL_WEC = "https://fiawec.alkamelsystems.com";

export interface AkOption {
  value: string; // «14_2026», «05_6 Hours of Sao Paulo»
  label: string; // «2026», «6 Hours of Sao Paulo»
}

/// Опции селектора season/evvent из HTML страницы.
export function parseAkOptions(html: string, name: "season" | "evvent"): AkOption[] {
  const m = html.match(new RegExp(`name="${name}"[^>]*>([\\s\\S]*?)</select>`, "i"));
  if (!m) return [];
  const out: AkOption[] = [];
  for (const o of m[1].matchAll(/<option\s+Value="([^"]*)"[^>]*>([^<]*)<\/option>/gi)) {
    out.push({ value: o[1], label: o[2].trim() });
  }
  return out;
}

/// href-ы файлов под корнем (Results_NoticeBoard или Results): каждая ссылка
/// в дереве встречается дважды (href + onclick) — дедуп по URL с сохранением
/// порядка документа.
export function parseFileHrefs(html: string, root: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(new RegExp(`href="(${root}/[^"]+)"`, "g"))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/// CSV Al Kamel: UTF-8 с BOM, разделитель «;», CRLF, хвостовой «;» (пустая
/// последняя колонка), у части заголовков ведущий пробел (« LAPS»).
export function parseAkCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(";").map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(";");
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      if (headers[i]) row[headers[i]] = (cells[i] ?? "").trim();
    }
    out.push(row);
  }
  return out;
}

/// «6 Hours of Sao Paulo» → «6-hours-of-sao-paulo» — для матчинга событий
/// Notice Board/архива со слагами fiawec.com (диакритика São → sao).
export function slugifyAkEvent(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Трасса из метки архива → отличительный токен слага fiawec: события Results
// названы по трассам («LOSAIL», «CIRCUIT OF THE AMERICAS»), а слаги — по
// названиям гонок («qatar-1812km», «lone-star-le-mans»).
const AK_TRACK_ALIASES: Record<string, string> = {
  losail: "qatar",
  "circuit-of-the-americas": "lone-star",
  cota: "lone-star",
};

// Слова без различительной силы в названиях трасс.
const AK_GENERIC_TOKENS = new Set([
  "circuit", "international", "speedway", "autodromo", "nazionale", "di",
  "of", "the", "hours", "hour",
]);

/// Раунд события по порядку слагов сезона fiawec (round = индекс + 1; порядок
/// страницы сезона = порядок этапов — так же строит календарь приложение).
/// Матч тремя ступенями: вхождение слагифицированной метки в слаг
/// («6-hours-of-spa» ⊂ «totalenergies-6-hours-of-spa-francorchamps-2026»),
/// алиас трассы (LOSAIL → qatar), значимые токены («FUJI SPEEDWAY» → fuji).
/// Числовой префикс архива (05_) раундом НЕ является — бывают дыры.
export function matchAkRound(label: string, seasonSlugs: string[]): number | null {
  const key = slugifyAkEvent(label);
  if (!key) return null;
  let i = seasonSlugs.findIndex((s) => s.includes(key));
  if (i >= 0) return i + 1;
  const alias = AK_TRACK_ALIASES[key];
  if (alias) {
    i = seasonSlugs.findIndex((s) => s.includes(alias));
    if (i >= 0) return i + 1;
  }
  const tokens = key.split("-").filter((t) => t.length > 2 && !AK_GENERIC_TOKENS.has(t));
  for (const t of tokens) {
    i = seasonSlugs.findIndex((s) => s.includes(t));
    if (i >= 0) return i + 1;
  }
  return null;
}

/// Финальный гоночный CSV события: из href-ов дерева берём файлы
/// `<kind>_Race…CSV` в сессии `<TS>_Race` (без ByCategory/ByClass/Combined) и
/// выбираем последний час — «Hour N» в новом макете, «NH» в старом; версии
/// без часа (короткие гонки/старый макет) — как есть, последней в дереве.
export function pickRaceCsv(hrefs: string[], kind: "Classification" | "Analysis"): string | null {
  const candidates = hrefs.filter((h) => {
    const f = decodeURIComponent(h);
    return /_Race\//.test(f) && f.endsWith(".CSV") &&
      new RegExp(`(^|_)${kind}_Race`).test(f.split("/").pop() ?? "") &&
      !/ByCategory|ByClass|Combined/i.test(f);
  });
  if (!candidates.length) return null;
  const hour = (h: string): number => {
    const f = decodeURIComponent(h);
    const m = f.match(/Hour\s+(\d+)/i) ?? f.match(/\/(\d+)H\//);
    return m ? Number(m[1]) : 0;
  };
  return candidates.reduce((best, h) => (hour(h) >= hour(best) ? h : best));
}

/// Времена Al Kamel: «1'25.805» / «2:57.046» / «6:00'26.462» / «47.806» →
/// секунды. Разделители часов/минут — и «:», и «'». null — не время.
export function akTimeSeconds(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const parts = s.split(/[:']/);
  if (parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return null;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + Number(p);
  return Number.isFinite(seconds) ? seconds : null;
}

// ---- Сеть (общая для продьюсеров WEC-архива) ----

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

export async function fetchAkText(url: string, timeoutMs = 30000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
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

/// Страница сезона архива с ВАЛИДАЦИЕЙ: сервер под нагрузкой отдаёт дефолтную
/// (текущий сезон) вместо запрошенной — у дефолтной в селекторе SELECTED
/// стоит на другом значении, и события чужого сезона тихо теряются. До 4
/// повторов; результат (включая провал) кэшируется в пределах прогона.
const seasonPageCache = new Map<string, string | null>();

export async function akSeasonPage(seasonValue: string): Promise<string | null> {
  if (seasonPageCache.has(seasonValue)) return seasonPageCache.get(seasonValue) ?? null;
  const marker = `Value="${seasonValue}" SELECTED`;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, 1500 * attempt));
    const html = await fetchAkText(`${ALKAMEL_WEC}/?season=${encodeURIComponent(seasonValue)}`);
    if (html && html.includes(marker)) {
      seasonPageCache.set(seasonValue, html);
      return html;
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  console.warn(`  alkamelwec: страница сезона «${seasonValue}» не отдалась — пропускаем`);
  seasonPageCache.set(seasonValue, null);
  return null;
}

// ---- Контекст сезона для продьюсеров Results-архива ----

export interface AkEvent {
  label: string;   // «SAO PAULO»
  value: string;   // «04_SAO PAULO»
  round: number;   // раунд по порядку слагов fiawec
  slug: string;    // «rolex-6-hours-of-sao-paulo-2026»
}

export interface AkSeasonContext {
  seasonValue: string;                       // «15_2026»
  seasonOptions: AkOption[];                 // все сезоны архива (для истории)
  events: AkEvent[];
  slugs: string[];
}

/// Общий каркас продьюсеров архива: слаги сезона из wec-зеркала + селекторы
/// корня архива + события сезона, сматченные к раундам. null — чего-то нет
/// (зеркала/сезона на архиве) — вызывающий пропускает прогон толерантно.
export async function akSeasonContext(year: number): Promise<AkSeasonContext | null> {
  let seasonHtml: string;
  try {
    seasonHtml = readFileSync(
      join(process.cwd(), "data", "wec", "fiawec", `en_season_${year}`), "utf8");
  } catch {
    console.warn(`alkamelwec: нет зеркала en_season_${year} — пропускаем`);
    return null;
  }
  const slugs = raceSlugs(seasonHtml, year);
  if (!slugs.length) {
    console.warn("alkamelwec: слаги сезона не распарсились — пропускаем");
    return null;
  }

  const root = await fetchAkText(`${ALKAMEL_WEC}/`);
  if (!root) {
    console.warn("alkamelwec: архив недоступен — пропускаем (толерантно)");
    return null;
  }
  const seasonOptions = parseAkOptions(root, "season");
  const seasonOpt = seasonOptions.find((o) => o.label === String(year));
  if (!seasonOpt) {
    console.warn(`alkamelwec: сезона ${year} нет в архиве — переходное окно, пропускаем`);
    return null;
  }
  const seasonPage = await akSeasonPage(seasonOpt.value);
  const options = seasonPage ? parseAkOptions(seasonPage, "evvent") : [];
  if (!options.length) {
    console.warn("alkamelwec: селектор событий сезона пуст — пропускаем");
    return null;
  }
  const events: AkEvent[] = [];
  for (const o of options) {
    const round = matchAkRound(o.label, slugs);
    if (round == null) {
      console.warn(`  «${o.label}»: не сматчилось со слагами сезона — пропускаем`);
      continue;
    }
    events.push({ label: o.label, value: o.value, round, slug: slugs[round - 1] });
  }
  return { seasonValue: seasonOpt.value, seasonOptions, events, slugs };
}

/// Дерево файлов события архива → список href. Сервер НЕДЕТЕРМИНИРОВАННО
/// может отдать дефолтное (последнее) событие сезона вместо запрошенного —
/// первый бэкфилл записал Имоле данные Сан-Паулу, а частые запросы роняются
/// целыми сезонами. Защита: берём только href под папкой запрошенного
/// события; чужая страница → до 4 повторов с растущей паузой, потом пусто
/// (вызывающий пропустит, доберёт следующий крон). Кэш в пределах прогона —
/// winners/safetycar ходят по одним деревьям для разных текущих этапов.
const treeCache = new Map<string, string[]>();

export async function akEventHrefs(seasonValue: string, evventValue: string): Promise<string[]> {
  const cacheKey = `${seasonValue}|${evventValue}`;
  const cached = treeCache.get(cacheKey);
  if (cached) return cached;

  const prefix = `Results/${encodeURIComponent(seasonValue)}/${encodeURIComponent(evventValue)}/`;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, 1500 * attempt));
    const html = await fetchAkText(
      `${ALKAMEL_WEC}/?season=${encodeURIComponent(seasonValue)}&evvent=${encodeURIComponent(evventValue)}`,
    );
    const own = (html ? parseFileHrefs(html, "Results") : []).filter((h) => h.startsWith(prefix));
    if (own.length) {
      treeCache.set(cacheKey, own);
      return own;
    }
    await new Promise((res) => setTimeout(res, 400)); // не дожимать сервер
  }
  console.warn(`  alkamelwec: дерево «${evventValue}» не отдалось (дефолт-страница?) — пропускаем`);
  return [];
}
