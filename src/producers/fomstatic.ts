// Продьюсер проактивного снапшота статики FOM (шаг 5.4 DATA-PLAN). Механика и
// обоснование границ — в шапке lib/fomstatic.ts.
//
// Прогон resume-safe и по бюджету: добирает только ОТСУТСТВУЮЩИЕ файлы и не
// больше FOM_BUDGET за раз. Первые прогоны наливают снимок порциями, дальше
// каждый стоит четыре запроса индексов и выходит.
//
// ЗАПУСКАЕТСЯ ТОЛЬКО РУКАМИ. Не по лени: livetiming.formula1.com отдаёт
// раннерам GitHub 403 (прогон 27.08.2026 — четыре года подряд «индекс
// недоступен», при том что с машины владельца те же URL отдают 200). Крон тут
// не просто бесполезен, а вреден: писал бы маркер свежести и рисовал здоровье
// там, где не снято ни байта. Поэтому продьюсер помечен manual в реестре и
// исключён из расчёта свежести.
//
// Отказ источника прогон НЕ валит: 403 у года — известное состояние архива
// (2017 и 2022 уже так), а не наша поломка.

import { join } from "node:path";
import { runFomSnapshot, snapshotSize, FOM_YEARS } from "../lib/fomstatic.js";

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

  const left = Math.max(0, result.missing - result.fetched);
  console.log(`Done. снято ${result.fetched}, всего файлов ${before} → ${after}, ` +
    `осталось добрать ${left}${result.failed ? `, отказов ${result.failed}` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.warn(`FOM static snapshot: прогон не удался — ${e}`);
  });
}
