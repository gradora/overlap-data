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
import { runFomSnapshot, snapshotSize, resolveFomDataDir, FOM_YEARS }
  from "../lib/fomstatic.js";

// Куда пишется снимок и почему это не строчка здесь, а функция под тестом —
// см. resolveFomDataDir в lib/fomstatic.ts.

async function main() {
  const years = process.env.SEASON
    ? [Number(process.env.SEASON)]
    : FOM_YEARS;
  const budget = Number(process.env.FOM_BUDGET ?? 400);

  console.log(`FOM static snapshot: годы ${years.join(", ")}, бюджет ${budget} файлов`);

  const target = resolveFomDataDir(process.env, process.cwd());
  if ("error" in target) { console.error(target.error); process.exit(1); }
  const DATA_DIR = target.dir;
  console.log(`каталог снимка: ${DATA_DIR}`);

  const before = snapshotSize(DATA_DIR);
  const result = await runFomSnapshot({ dataDir: DATA_DIR, years, budget });
  const after = snapshotSize(DATA_DIR);

  const left = Math.max(0, result.missing - result.fetched);
  console.log(`Done. снято ${result.fetched}, всего файлов ${before} → ${after}, ` +
    `осталось добрать ≥${left}${result.failed ? `, отказов ${result.failed}` : ""}`);
  // «≥» не педантизм: недостача считается по годам, до которых дошёл бюджет,
  // и на пустом каталоге занижена в разы.

  // Продьюсер ручной, и коммитить за владельца он не будет — но снятое и не
  // закоммиченное теряется молча, а восстановить его неоткуда: источник уже
  // терял 2017 и 2022. Поэтому конец прогона всегда говорит, что делать.
  if (result.fetched > 0) {
    console.log(`\nСНЯТОЕ ЕЩЁ НЕ СОХРАНЕНО. Закоммить и запушь:\n` +
      `  git -C ${join(DATA_DIR, "..")} add data/f1/fom\n` +
      `  git -C ${join(DATA_DIR, "..")} commit -m "fomstatic: +${result.fetched} срезов"\n` +
      `  git -C ${join(DATA_DIR, "..")} push`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // Нулевой код на провале врал бы обёрткам: `npm run fomstatic && git push`
    // отработал бы по несостоявшемуся прогону.
    console.error(`FOM static snapshot: прогон не удался — ${e}`);
    process.exitCode = 1;
  });
}
