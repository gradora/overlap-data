// Продьюсер «победители прошлых лет» WEC (PAST WINNERS на About Race) —
// источник финальные Race Classification CSV из Results-архива Al Kamel:
// для каждого этапа текущего сезона собираются абсолютные победители той же
// трассы за прошлые сезоны (метки событий архива — имена трасс, стабильны
// между сезонами). Выход: data/wec/winners/<season>_<round>.json — последние
// 5 побед до текущего сезона + кумулятив «×N Overall» по команде на трассе.
// История неизменна → файл пишется один раз (как f1winners).
//
// Суперсезоны «2018-2019»/«2019-2020» пропускаются: одному событию там могут
// соответствовать два издания (два Ле-Мана в одном сезоне) — честный маппинг
// год↔издание без дат не построить, а для «последних 5» хватает 2021+.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./mirror.js";
import {
  akEventHrefs, akSeasonContext, akSeasonPage, ALKAMEL_WEC, fetchAkText,
  parseAkCsv, parseAkOptions, pickRaceCsv, slugifyAkEvent, type AkOption,
} from "./alkamelwec.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT_DIR = join(process.cwd(), "data", "wec", "winners");
const FIRST_SEASON = 2012; // WEC-эра архива

export interface WecPastWinner {
  year: number;
  name: string;        // «MAGNUSSEN / MARCIELLO / VANTHOOR»
  constructor: string; // команда
  vehicle?: string;    // «BMW M Hybrid V8»
  winsHere: number;    // побед команды на этой трассе к этому году включительно
}

export interface WecRoundWinners {
  season: number;
  round: number;
  circuit: string;     // метка трассы архива («SAO PAULO»)
  winners: WecPastWinner[];
}

/// Фамилии экипажа из строки классификации: у Al Kamel фамилия капсом
/// («Alessandro PIER GUIDI» → «PIER GUIDI»); DRIVER_1..5, пустые — мимо.
export function crewSurnames(row: Record<string, string>): string {
  const names: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const full = (row[`DRIVER_${i}`] ?? "").trim();
    if (!full) continue;
    const caps = full.split(/\s+/).filter((w) => w.length > 1 && w === w.toUpperCase());
    names.push(caps.length ? caps.join(" ") : full.split(/\s+/).pop()!);
  }
  return names.join(" / ");
}

/// Абсолютный победитель гонки из строк классификации (общая таблица
/// отсортирована сквозь классы — топ-класс сверху).
export function overallWinner(rows: Record<string, string>[]): Record<string, string> | null {
  return rows.find((r) => (r.POSITION ?? "").trim() === "1") ?? null;
}

/// Последние 5 побед до `beforeYear` с кумулятивом по команде (как
/// buildWinners у F1, но ключ — команда).
export function buildWecWinners(
  rows: { year: number; name: string; team: string; vehicle?: string }[],
  beforeYear: number,
): WecPastWinner[] {
  const sorted = [...rows].sort((a, b) => a.year - b.year);
  const tally = new Map<string, number>();
  const all: WecPastWinner[] = [];
  for (const r of sorted) {
    const n = (tally.get(r.team) ?? 0) + 1;
    tally.set(r.team, n);
    all.push({
      year: r.year, name: r.name, constructor: r.team,
      ...(r.vehicle ? { vehicle: r.vehicle } : {}),
      winsHere: n,
    });
  }
  return all.filter((w) => w.year < beforeYear).slice(-5).reverse();
}

/// Сезоны архива с одиночным годом (спаны «2018-2019» — мимо).
export function singleYearSeasons(options: AkOption[]): { year: number; value: string }[] {
  return options
    .filter((o) => /^\d{4}$/.test(o.label))
    .map((o) => ({ year: Number(o.label), value: o.value }));
}

async function main() {
  console.log(`WEC past winners, season ${YEAR}`);
  const ctx = await akSeasonContext(YEAR);
  if (!ctx) return;

  const pastSeasons = singleYearSeasons(ctx.seasonOptions)
    .filter((s) => s.year >= FIRST_SEASON && s.year < YEAR);

  let backfill = Number(process.env.WEC_WINNERS_BACKFILL ?? 1);

  for (const ev of ctx.events) {
    const path = join(OUT_DIR, `${YEAR}_${ev.round}.json`);
    if (existsSync(path)) continue;   // история неизменна — пишем один раз
    if (backfill <= 0) continue;
    backfill--;

    const trackKey = slugifyAkEvent(ev.label);
    const rows: { year: number; name: string; team: string; vehicle?: string }[] = [];
    for (const past of pastSeasons) {
      // События прошлого сезона: метки трасс стабильны — матч по равенству.
      const pastPage = await akSeasonPage(past.value);
      if (!pastPage) continue;
      const pastEvent = parseAkOptions(pastPage, "evvent")
        .find((o) => slugifyAkEvent(o.label) === trackKey);
      if (!pastEvent) continue;   // трассы не было в том сезоне

      const hrefs = await akEventHrefs(past.value, pastEvent.value);
      const csvHref = pickRaceCsv(hrefs, "Classification");
      if (!csvHref) continue;
      const csv = await fetchAkText(`${ALKAMEL_WEC}/${csvHref}`, 60000);
      if (!csv) continue;
      const winner = overallWinner(parseAkCsv(csv));
      if (!winner || !winner.TEAM) continue;
      rows.push({
        year: past.year,
        name: crewSurnames(winner),
        team: winner.TEAM.trim(),
        ...(winner.VEHICLE ? { vehicle: winner.VEHICLE.trim() } : {}),
      });
      await new Promise((res) => setTimeout(res, 300));   // вежливая пауза
    }

    const out: WecRoundWinners = {
      season: YEAR,
      round: ev.round,
      circuit: ev.label,
      winners: buildWecWinners(rows, YEAR),
    };
    writeIfChanged(path, JSON.stringify(out, null, 2) + "\n");
    console.log(`  R${ev.round} (${ev.label}): ${out.winners.length} победителей (${rows.length} сезонов)`);
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
