// Общий слой Al Kamel WEC (fiawec.alkamelsystems.com) — один хост держит
// Notice Board (официальные документы стюардов, wecfia.ts) и Results-архив
// (CSV сессий 2011+, продьюсеры highlights/winners/safetycar). Навигация
// одинаковая: GET ?season=<val>&evvent=<val>, значения — из <option
// Value="..."> (атрибут с большой буквы V — обычный регекс по value его
// пропускает), файлы — прямыми href (листинг директорий закрыт, 403).

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

/// Раунд события по порядку слагов сезона fiawec (round = индекс + 1; порядок
/// страницы сезона = порядок этапов — так же строит календарь приложение).
/// Матч — вхождение слагифицированного названия в слаг («6-hours-of-spa» ⊂
/// «totalenergies-6-hours-of-spa-francorchamps-2026»). Числовой префикс
/// Notice Board (05_) раундом НЕ является — там бывают дыры в нумерации.
export function matchAkRound(label: string, seasonSlugs: string[]): number | null {
  const key = slugifyAkEvent(label);
  if (!key) return null;
  const i = seasonSlugs.findIndex((s) => s.includes(key));
  return i >= 0 ? i + 1 : null;
}
