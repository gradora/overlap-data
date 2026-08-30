// Проекция derived-семейств в файл события для WEC и IMSA (фаза 6).
// ЧИСТАЯ деривация из локальных файлов — ноль сетевых запросов.
// Пишет data/<серия>/events/<ключ>.json.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ F1. У этих серий файл события уже существует
// (`<серия>/<год>/NN_<слаг>.json`, путь публикует индекс сезона), поэтому
// проекция несёт ТОЛЬКО derived: штрафы, победителей, хайлайты. Дублировать
// в неё сессии значило бы удвоить 26 МБ; вставить блоки внутрь существующего
// файла нельзя — его пишет продьюсер зеркала, который идёт в снапшоте раньше
// derived-семейств и пересобирает файл по белому списку. Итог для экрана:
// два запроса вместо четырёх.
//
// КЛЮЧ. Слаг этих серий — путь их собственного URL, то есть уже ключ
// источника; суффикс не нужен (обоснование — lib/eventkey.ts). Клиент выводит
// имя файла из слага, который у него и так есть из индекса, поэтому индекс
// править не пришлось.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJSONWithEnvelope } from "./mirror.js";
import { imsaEventKey, wecEventKey } from "./eventkey.js";
import {
  EVENT_FILE_SCHEMA_VERSION, type EventSeries, buildEventFile, eventFilePath,
} from "./eventfile.js";

/// Каталог данных параметром: без него проводку продьюсера не покрыть —
/// мутант «серию не передали» переживает любой тест, зовущий сборку напрямую.
const DEFAULT_DATA_DIR = join(process.cwd(), "data");

function readJSON(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

interface IndexEvent {
  round: number;
  slug: string;
  name?: string;
}

export function readIndex(series: "wec" | "imsa", year: number,
                          dataDir = DEFAULT_DATA_DIR): IndexEvent[] {
  const doc = readJSON(join(dataDir, series, String(year), "index.json"));
  const p = doc?.payload ?? doc;
  const events = p?.events;
  return Array.isArray(events) ? events : [];
}

export function keyFor(series: "wec" | "imsa", year: number, slug: string): string {
  return series === "wec" ? wecEventKey(year, slug) : imsaEventKey(year, slug);
}

export async function run(series: "wec" | "imsa",
                         YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear()),
                         DATA_DIR = DEFAULT_DATA_DIR): Promise<void> {
  console.log(`${series.toUpperCase()} events, season ${YEAR}`);
  const events = readIndex(series, YEAR, DATA_DIR);
  if (!events.length) {
    console.warn(`${series} events: индекса сезона нет — пропускаем прогон`);
    return;
  }

  let written = 0, unchanged = 0, empty = 0;
  for (const e of events) {
    if (!e?.slug) continue;
    const round = Number(e.round);
    // Round-keyed семейства по сентинелу 0 (прологи, тесты) пусты — у таких
    // событий проекции не будет, и это честно.
    const family = (name: string) =>
      Number.isFinite(round) && round >= 1
        ? readJSON(join(DATA_DIR, series, name, `${YEAR}_${round}.json`))
        : null;

    const key = keyFor(series, YEAR, e.slug);
    const file = buildEventFile({
      series: series as EventSeries,
      season: YEAR,
      eventKey: key,
      eventId: e.slug,
      round: Number.isFinite(round) ? round : 0,
      fia: family("fia"),
      winners: family("winners"),
      highlights: family("highlights"),
    });
    if (!file) { empty++; continue; }

    const changed = writeJSONWithEnvelope(
      join(DATA_DIR, series, "events", eventFilePath(key)), file, EVENT_FILE_SCHEMA_VERSION);
    if (changed) written++; else unchanged++;
  }

  console.log(`  событий ${events.length}: записано ${written}, ` +
              `без изменений ${unchanged}, без блоков ${empty}`);
  console.log("Done.");
}
