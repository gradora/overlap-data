// Общие сборщики «прошлых победителей» из архивов Al Kamel: типы карточек,
// фамилии экипажа из CSV-строк, абсолютный победитель, кумулятив побед и
// выбор главного события трассы. Делят продьюсеры wecwinners / wechighlights /
// imsawinners / imsahighlights (раньше импортировали друг друга напрямую,
// включая кросс-серийный imsawinners → wecwinners).

import { type AkOption } from "./alkamelwec.js";
import { imsaRaceStage, type ImsaDriverRef } from "./alkamelimsa.js";

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
  for (let i = 1; i <= 6; i++) {
    const full = (row[`DRIVER_${i}`] ?? "").trim();
    if (full) {
      const caps = full.split(/\s+/).filter((w) => w.length > 1 && w === w.toUpperCase());
      names.push(caps.length ? caps.join(" ") : full.split(/\s+/).pop()!);
      continue;
    }
    // Старый макет CSV (встречается в архиве, напр. Спа-2024): колонки
    // DRIVER1_FIRSTNAME / DRIVER1_SECONDNAME — фамилия уже отдельно и капсом.
    const surname = (row[`DRIVER${i}_SECONDNAME`] ?? "").trim();
    if (surname) names.push(surname);
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

export interface ResultsClassificationRow {
  position?: number | string;
  team?: string;
  vehicle?: string;
  drivers?: ImsaDriverRef[];
}

/// Победитель гонки из финального Results JSON: position 1 общей таблицы
/// (классы отсортированы сквозь — топ-класс сверху).
export function imsaOverallWinner(json: unknown): ResultsClassificationRow | null {
  const rows = (json as { classification?: ResultsClassificationRow[] })?.classification;
  if (!Array.isArray(rows)) return null;
  return rows.find((r) => String(r.position ?? "").trim() === "1") ?? null;
}

/// Лучшее из событий-кандидатов трассы за сезон: max Hour-папок, затем позднее.
export async function bestTrackStage(
  season: string,
  candidates: string[],
): Promise<{ stage: Awaited<ReturnType<typeof imsaRaceStage>>; round: string } | null> {
  let best: { stage: NonNullable<Awaited<ReturnType<typeof imsaRaceStage>>>; round: string } | null = null;
  for (const round of candidates) {
    const stage = await imsaRaceStage(season, round);
    if (!stage) continue;
    if (!best || stage.hours > best.stage.hours ||
        (stage.hours === best.stage.hours && stage.stamp > best.stage.stamp)) {
      best = { stage, round };
    }
  }
  return best;
}
