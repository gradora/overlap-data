// Продьюсер проактивного снапшота статики FOM (шаг 5.4 DATA-PLAN). Механика и
// обоснование границ — в шапке lib/fomstatic.ts.
//
// Прогон resume-safe и по бюджету: добирает только ОТСУТСТВУЮЩИЕ файлы и не
// больше FOM_BUDGET за раз. Первые прогоны наливают снимок порциями, дальше
// каждый стоит четыре запроса индексов и выходит.
//
// Отказ источника прогон НЕ валит. 403 у года — известное состояние архива
// (2017 и 2022 уже так), а не наша поломка; письмо владельцу тут бесполезно,
// делать с этим нечего. Сигнал «продьюсер вообще перестал бегать» приходит
// через маркер свежести, как у tracks и weclive.

import { join } from "node:path";
import { writeIfChanged } from "../lib/mirror.js";
import { runFomSnapshot, snapshotSize, FOM_YEARS } from "../lib/fomstatic.js";
import { FOMSTATIC_MARKER } from "../lib/producers.js";
import { utcDay } from "../lib/freshness.js";

const DATA_DIR = join(process.cwd(), "data");

async function main() {
  const years = process.env.SEASON
    ? [Number(process.env.SEASON)]
    : FOM_YEARS;
  const budget = Number(process.env.FOM_BUDGET ?? 400);

  console.log(`FOM static snapshot: годы ${years.join(", ")}, бюджет ${budget} файлов`);
  const before = snapshotSize(DATA_DIR);
  const result = await runFomSnapshot({ dataDir: DATA_DIR, years, budget });
  const after = snapshotSize(DATA_DIR);

  // Маркер — ДНЁМ и всегда: «добирать нечего» это норма (снимок полон), а не
  // простой, и единственный интересный вопрос — бежит ли продьюсер вообще.
  writeIfChanged(join(DATA_DIR, FOMSTATIC_MARKER),
                 JSON.stringify({ lastSuccess: utcDay(new Date()), files: after }) + "\n");

  const left = Math.max(0, result.missing - result.fetched);
  console.log(`Done. снято ${result.fetched}, всего файлов ${before} → ${after}, ` +
    `осталось добрать ${left}${result.failed ? `, отказов ${result.failed}` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.warn(`FOM static snapshot: прогон не удался — ${e}`);
  });
}
