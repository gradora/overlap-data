// Продьюсер SC/FCY-статистики трасс WEC (строка в F1/серийных MILESTONES на
// About Race) — источник колонка FLAG_AT_FL полап-ового Analysis CSV гонок
// прошлых сезонов: SF = полноценный сейфти-кар, FCY = full course yellow.
// Эра — с 2022 (Hypercar; глубже старые макеты и другой регламент жёлтых).
// Выход: data/wec/safetycar/<season>_<round>.json с раскладкой по годам —
// крон дописывает только свежий год, историю не перекачивает (Analysis
// гонок — мегабайтные файлы).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./mirror.js";
import {
  akEventHrefs, akSeasonContext, akSeasonPage, ALKAMEL_WEC, fetchAkText,
  parseAkCsv, parseAkOptions, pickRaceCsv, slugifyAkEvent,
} from "./alkamelwec.js";
import { eventInfo } from "./wec.js";
import { singleYearSeasons } from "./wecwinners.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT_DIR = join(process.cwd(), "data", "wec", "safetycar");
const MIRROR_DIR = join(process.cwd(), "data", "wec", "fiawec");
const NOW = Date.now();
const SINCE = 2022; // эра покрытия: Hypercar + единый регламент жёлтых

export interface WecYearFlags {
  sc: boolean;   // был полноценный SC (флаг SF)
  fcy: boolean;  // была FCY-нейтрализация
}

export interface WecCircuitSafetyCar {
  season: number;
  round: number;
  sinceYear: number;
  years: Record<string, WecYearFlags>;
  races: number;
  withSafetyCar: number;
  withFCY: number;
}

/// Флаги гонки из строк Analysis: SC — хоть один круг под SF, FCY — под FCY.
export function raceFlags(rows: Record<string, string>[]): WecYearFlags {
  let sc = false;
  let fcy = false;
  for (const r of rows) {
    const f = (r.FLAG_AT_FL ?? "").trim().toUpperCase();
    if (f === "SF") sc = true;
    else if (f === "FCY") fcy = true;
    if (sc && fcy) break;
  }
  return { sc, fcy };
}

/// Сводка из карты годов.
export function summarize(
  season: number, round: number, years: Record<string, WecYearFlags>,
): WecCircuitSafetyCar {
  const list = Object.values(years);
  return {
    season, round, sinceYear: SINCE, years,
    races: list.length,
    withSafetyCar: list.filter((y) => y.sc).length,
    withFCY: list.filter((y) => y.fcy).length,
  };
}

function readExisting(path: string): WecCircuitSafetyCar | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function raceMirror(slug: string): string | null {
  const key = `en_race_${slug.replace(/[^a-z0-9.]+/gi, "_")}`;
  try {
    return readFileSync(join(MIRROR_DIR, key), "utf8");
  } catch {
    return null;
  }
}

async function main() {
  console.log(`WEC safety car stats, season ${YEAR} (since ${SINCE})`);
  const ctx = await akSeasonContext(YEAR);
  if (!ctx) return;

  const seasons = singleYearSeasons(ctx.seasonOptions)
    .filter((s) => s.year >= SINCE && s.year <= YEAR);

  let backfill = Number(process.env.WEC_SC_BACKFILL ?? 1);

  for (const ev of ctx.events) {
    const path = join(OUT_DIR, `${YEAR}_${ev.round}.json`);
    const existing = readExisting(path);
    const years: Record<string, WecYearFlags> = { ...(existing?.years ?? {}) };
    const trackKey = slugifyAkEvent(ev.label);

    // Годы, которых не хватает: история (не в карте) + свежая гонка текущего
    // сезона (учитываем после финиша — флаги финальны с клетчатым).
    const missing = seasons.filter((s) => {
      if (years[String(s.year)]) return false;
      if (s.year < YEAR) return true;
      const page = raceMirror(ev.slug);
      const endMs = page ? eventInfo(page).endMs : null;
      return endMs != null && endMs < NOW;
    });
    if (!missing.length) continue;
    if (!existing && backfill <= 0) continue;   // полный сбор — бюджетируем
    if (!existing) backfill--;

    for (const s of missing) {
      const page = await akSeasonPage(s.value);
      if (!page) continue;
      const pastEvent = s.year === YEAR
        ? ev
        : parseAkOptions(page, "evvent").find((o) => slugifyAkEvent(o.label) === trackKey);
      if (!pastEvent) continue;   // трассы не было в том сезоне
      const hrefs = await akEventHrefs(
        s.year === YEAR ? ctx.seasonValue : s.value,
        pastEvent.value,
      );
      const csvHref = pickRaceCsv(hrefs, "Analysis");
      if (!csvHref) continue;
      const csv = await fetchAkText(`${ALKAMEL_WEC}/${csvHref}`, 90000);
      if (!csv) continue;
      years[String(s.year)] = raceFlags(parseAkCsv(csv));
      await new Promise((res) => setTimeout(res, 300));   // вежливая пауза
    }

    if (!Object.keys(years).length) {
      console.log(`  R${ev.round} (${ev.label}): истории нет — не пишем`);
      continue;
    }
    const out = summarize(YEAR, ev.round, years);
    const changed = writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
    console.log(
      `  R${ev.round} (${ev.label}): SC ${out.withSafetyCar}/${out.races}, FCY ${out.withFCY}/${out.races} → ${changed ? "записано" : "без изменений"}`,
    );
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
